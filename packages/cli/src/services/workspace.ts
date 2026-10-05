import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { CliError } from '../utils/errors';
export const INFRA_SERVICES = ['otel-collector', 'tempo', 'prometheus', 'grafana'] as const;
export const LABELS: Record<string, string> = { 'otel-collector': 'OTel Collector', tempo: 'Tempo', prometheus: 'Prometheus', grafana: 'Grafana' };
const packagedAssets = [resolve(__dirname, '../../assets/infra'), resolve(__dirname, '../assets/infra')].find(existsSync) ?? resolve(__dirname, '../assets/infra');
const required = ['docker-compose.yml', '.env', 'otel-collector.yaml', 'tempo.yaml', 'prometheus.yml', 'grafana/provisioning/datasources/datasources.yaml', 'grafana/provisioning/dashboards/dashboards.yaml', 'grafana/dashboards/perflens-performance.json'];

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolvePort(false);
      else rejectPort(new CliError(`Cannot check local port ${port}.`, `Allow PerfLens to test loopback ports and retry. Technical error: ${error.message}`));
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolvePort(true)));
  });
}
async function selectPort(preferred: number, reserved: Set<number>, probePort = portAvailable): Promise<number> {
  for (let port = preferred; port < preferred + 100; port++) {
    if (reserved.has(port)) continue;
    let available: boolean;
    try { available = await probePort(port); }
    catch (error) {
      if (error instanceof CliError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(`Cannot check local port ${port}.`, `Allow PerfLens to test loopback ports and retry. Technical error: ${detail}`);
    }
    if (available) { reserved.add(port); return port; }
  }
  throw new CliError(`No available local port near ${preferred}.`, 'Free an audit infrastructure port and retry. PerfLens will not stop another service.');
}


export async function installInfrastructureAssets(cwd = process.cwd(), baseUrl = 'http://localhost:3000', probePort = portAvailable): Promise<string> {
  const root = join(resolve(cwd), '.perflens', 'infra');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const project = `perflens-${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 10)}`;
  // Restore missing packaged files without replacing consumer-owned/customized assets.
  for (const file of required.filter(item => item !== '.env')) {
    const target = join(root, file);
    try { await access(target); }
    catch {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (file === 'docker-compose.yml') {
        const compose = await readFile(join(packagedAssets, file), 'utf8');
        await writeFile(target, compose.replace('__PERFLENS_COMPOSE_NAME__', project), { flag: 'wx', mode: 0o600 });
      } else await cp(join(packagedAssets, file), target, { errorOnExist: true, force: false });
    }
  }
  const envPath = join(root, '.env');
  let envContent = await readFile(envPath, 'utf8').catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : Promise.reject(error));
  const portDefaults: Record<string, number> = { GRAFANA_PORT: 3001, PROMETHEUS_PORT: 9090, TEMPO_PORT: 3200, OTLP_GRPC_PORT: 4317, OTLP_HTTP_PORT: 4318, OTEL_HEALTH_PORT: 13133 };
  const reserved = new Set<number>();
  for (const [key, preferred] of Object.entries(portDefaults)) {
    const existing = new RegExp(`^${key}=(.*)$`, 'm').exec(envContent)?.[1];
    if (existing !== undefined) {
      const port = Number(existing);
      if (!/^\d+$/.test(existing) || !Number.isInteger(port) || port < 1 || port > 65535 || reserved.has(port)) throw new CliError(`Invalid or duplicate ${key} in local infrastructure configuration.`, 'Repair .perflens/infra/.env without changing ports used by a running stack.');
      reserved.add(port);
    } else {
      const port = await selectPort(preferred, reserved, probePort);
      envContent += `${envContent && !envContent.endsWith('\n') ? '\n' : ''}${key}=${port}\n`;
    }
  }
  if (envContent) await writeFile(envPath, envContent, { mode: 0o600 });
  await chmod(envPath, 0o600);
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

export async function otlpTracesEndpoint(root: string, mode: 'host' | 'container' = 'host'): Promise<string> {
  const environment = await readFile(join(root, '.env'), 'utf8').catch(() => {
    throw new CliError('PerfLens infrastructure port configuration is missing.', 'Run perflens init or repair .perflens/infra/.env before starting the target.');
  });
  const match = /^OTLP_HTTP_PORT=(\d+)$/m.exec(environment);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError('PerfLens OTLP HTTP port is invalid.', 'Set OTLP_HTTP_PORT to a local TCP port in .perflens/infra/.env, then restart PerfLens infrastructure.');
  }
  return `http://${mode === 'container' ? 'host.docker.internal' : '127.0.0.1'}:${port}/v1/traces`;
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
