import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '../utils/errors';
export const INFRA_SERVICES = ['otel-collector', 'tempo', 'prometheus', 'grafana'] as const;
export const LABELS: Record<string, string> = { 'otel-collector': 'OTel Collector', tempo: 'Tempo', prometheus: 'Prometheus', grafana: 'Grafana' };
const packagedAssets = [resolve(__dirname, '../../assets/infra'), resolve(__dirname, '../assets/infra')].find(existsSync) ?? resolve(__dirname, '../assets/infra');
const required = ['docker-compose.yml', '.env', 'otel-collector.yaml', 'tempo.yaml', 'prometheus.yml', 'grafana/provisioning/datasources/datasources.yaml', 'grafana/provisioning/dashboards/dashboards.yaml', 'grafana/dashboards/perflens-performance.json'];

async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolvePort => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolvePort(error.code === 'EADDRINUSE' ? false : true));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolvePort(true)));
  });
}
async function selectPort(preferred: number, reserved: Set<number>): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (!reserved.has(port) && await portAvailable(port)) { reserved.add(port); return port; }
  }
  throw new CliError(`No available local port near ${preferred}.`, 'Free an audit infrastructure port and retry. PerfLens will not stop another service.');
}


export async function installInfrastructureAssets(cwd = process.cwd(), baseUrl = 'http://localhost:3000'): Promise<string> {
  const root = join(resolve(cwd), '.perflens', 'infra');
  try { await access(join(root, 'docker-compose.yml')); }
  catch {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await cp(packagedAssets, root, { recursive: true, errorOnExist: true, force: false });
    const project = `perflens-${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 10)}`;
    const compose = await readFile(join(root, 'docker-compose.yml'), 'utf8');
    await writeFile(join(root, 'docker-compose.yml'), compose.replace('__PERFLENS_COMPOSE_NAME__', project), { flag: 'w', mode: 0o600 });
    const ports = new Set<number>();
    const grafana = await selectPort(3001, ports), prometheus = await selectPort(9090, ports), tempo = await selectPort(3200, ports);
    const grpc = await selectPort(4317, ports), http = await selectPort(4318, ports), health = await selectPort(13133, ports);
    await writeFile(join(root, '.env'), `GRAFANA_PORT=${grafana}\nPROMETHEUS_PORT=${prometheus}\nTEMPO_PORT=${tempo}\nOTLP_GRPC_PORT=${grpc}\nOTLP_HTTP_PORT=${http}\nOTEL_HEALTH_PORT=${health}\n`, { flag: 'wx', mode: 0o600 });
  }
  const url = new URL(baseUrl);
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'host.docker.internal' : url.hostname;
  const source = join(root, 'prometheus.yml');
  const current = await readFile(source, 'utf8');
  if (current.includes('__PERFLENS_METRICS_HOST__') || current.includes('# PerfLens generated target:')) {
    const template = await readFile(join(packagedAssets, 'prometheus.yml'), 'utf8');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    await writeFile(source, `# PerfLens generated target: ${host}:${port}\n${template.replace('__PERFLENS_METRICS_HOST__', host).replace('__PERFLENS_METRICS_PORT__', port)}`, { mode: 0o600 });
  }
  return root;
}

export async function infrastructureRoot(explicit?: string, cwd = process.cwd(), baseUrl?: string): Promise<string> {
  // Installed asset templates are copied into the consumer's ignored working directory.
  const root = explicit ? resolve(explicit) : await installInfrastructureAssets(cwd, baseUrl);
  const legacy = explicit ? await access(join(root, 'infra', 'otel-collector', 'config.yaml')).then(() => true, () => false) : false;
  const files = legacy
    ? ['docker-compose.yml', '.env', 'infra/otel-collector/config.yaml', 'infra/tempo/tempo.yaml', 'infra/prometheus/prometheus.yml', 'infra/grafana/provisioning/datasources/datasources.yaml']
    : required;
  for (const file of files) {
    try { await access(join(root, file)); }
    catch { throw new CliError(`Required infrastructure file is missing: ${join(root, file)}`, 'Run perflens init or use --infra-dir to select a compatible local infrastructure directory.'); }
  }
  return root;
}
