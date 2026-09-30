import { createServer } from 'node:net';
import { join } from 'node:path';
import { CliError } from '../utils/errors';
import { docker, Runner } from './process';
import { INFRA_SERVICES, LABELS } from './workspace';

export interface Container { Service: string; State: string; Health?: string; ExitCode?: number; Publishers?: { PublishedPort: number; URL: string }[] }
interface ServiceConfig { ports?: { host_ip?: string; published?: string; target: number }[] }
export interface ComposeConfig { name: string; services: Record<string, ServiceConfig> }
export function parseContainers(raw: string): Container[] {
  if (!raw.trim()) return [];
  const value = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.trim().split('\n').map(line => JSON.parse(line));
  return Array.isArray(value) ? value : [value];
}
export async function assertLocalDocker(run: Runner = docker): Promise<void> {
  const context = JSON.parse(await run(['context', 'inspect']));
  const endpoint = process.env.DOCKER_CONTEXT ? context[0]?.Endpoints?.docker?.Host : process.env.DOCKER_HOST || context[0]?.Endpoints?.docker?.Host;
  if (typeof endpoint !== 'string' || !(/^(unix|npipe):/.test(endpoint) || /^tcp:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(endpoint))) {
    throw new CliError('PerfLens requires a local Docker endpoint.', 'Select a local Docker context and remove remote DOCKER_HOST/DOCKER_CONTEXT overrides.');
  }
}
export async function availablePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(new CliError(`Cannot check port ${port}.`, error.message)));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
export class Infrastructure {
  constructor(readonly root: string, readonly run: Runner = docker, readonly portAvailable = availablePort) {}
  compose(args: string[], stream = false, timeout = 20000) {
    return this.run(['compose', '--project-directory', this.root, '--env-file', join(this.root, '.env'), '-f', join(this.root, 'docker-compose.yml'), ...args], { cwd: this.root, stream, timeout });
  }
  async configuration(): Promise<ComposeConfig> {
    const config: ComposeConfig = JSON.parse(await this.compose(['config', '--format', 'json']));
    for (const service of INFRA_SERVICES) {
      if (!config.services[service]) throw new CliError(`Missing Compose service: ${service}.`, 'Use the PerfLens Phase 1 Compose file.');
      for (const port of config.services[service].ports ?? []) {
        if (!['127.0.0.1', '::1'].includes(port.host_ip ?? '')) throw new CliError(`Non-local port binding for ${service}.`, 'Bind audit infrastructure ports to 127.0.0.1 or ::1.');
      }
    }
    return config;
  }
  async containers(): Promise<Container[]> { return parseContainers(await this.compose(['ps', '--all', '--format', 'json', ...INFRA_SERVICES])); }
  async probe(service: string): Promise<void> {
    // Prometheus includes wget; no app container or additional helper image needed.
    const endpoints: Record<string, string> = { 'otel-collector': 'http://otel-collector:13133/', tempo: 'http://tempo:3200/ready', prometheus: 'http://127.0.0.1:9090/-/ready', grafana: 'http://grafana:3000/api/health' };
    await this.compose(['exec', '-T', 'prometheus', 'wget', '-q', '-T', '3', '-O', '/dev/null', endpoints[service]], false, 5000);
  }
  async status(): Promise<{ service: string; state: string; ready: boolean; failed: boolean }[]> {
    const containers = await this.containers();
    return Promise.all(INFRA_SERVICES.map(async service => {
      const container = containers.find(c => c.Service === service);
      if (!container) return { service, state: 'not created', ready: false, failed: false };
      if (container.State !== 'running') return { service, state: container.State, ready: false, failed: !['exited', 'created'].includes(container.State) || Boolean(container.ExitCode) };
      try {
        if (container.Health && container.Health !== 'healthy') throw new Error('healthcheck');
        await this.probe(service);
        return { service, state: 'ready', ready: true, failed: false };
      } catch { return { service, state: `running, not ready${container.Health ? ` (${container.Health})` : ''}`, ready: false, failed: true }; }
    }));
  }
  async checkPorts(config: ComposeConfig): Promise<string[]> {
    const containers = await this.containers();
    const checks: string[] = [];
    const seen = new Set<string>();
    for (const service of INFRA_SERVICES) {
      for (const binding of config.services[service].ports ?? []) {
        if (!binding.published) continue;
        const port = Number(binding.published), host = binding.host_ip ?? '127.0.0.1';
        if (!Number.isInteger(port) || port < 1 || port > 65535 || seen.has(`${host}:${port}`)) throw new CliError('Invalid or duplicate infrastructure port mapping.', 'Choose distinct numeric host ports in .env.');
        seen.add(`${host}:${port}`);
        const owned = containers.some(c => c.Service === service && c.State === 'running' && c.Publishers?.some(p => p.PublishedPort === port && p.URL === host));
        if (owned) checks.push(`Port ${port} used by this PerfLens ${LABELS[service]} container`);
        else if (await this.portAvailable(port, host)) checks.push(`Port ${port} available`);
        else throw new CliError(`Port ${port} is occupied by another process.`, 'Stop that process or change GRAFANA_PORT, PROMETHEUS_PORT, or TEMPO_PORT in the infrastructure .env.');
      }
    }
    return checks;
  }
  async up(readinessTimeout = 120000): Promise<ComposeConfig> {
    const config = await this.configuration();
    await this.checkPorts(config);
    await this.compose(['up', '-d', '--wait', '--wait-timeout', '120', ...INFRA_SERVICES], true, 600000);
    const deadline = Date.now() + readinessTimeout;
    let states = await this.status();
    while (!states.every(s => s.ready) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      states = await this.status();
    }
    if (!states.every(s => s.ready)) throw new CliError('PerfLens infrastructure did not become ready.', `Inspect docker compose logs in ${this.root}.\n${states.map(s => `${LABELS[s.service]}: ${s.state}`).join('\n')}`);
    return config;
  }
  async down(): Promise<void> {
    // Stop only our allowlisted services. Never compose down -v or stop the target.
    await this.compose(['stop', '--timeout', '30', ...INFRA_SERVICES], true, 180000);
    if ((await this.containers()).some(c => !['exited', 'created'].includes(c.State))) throw new CliError('Some infrastructure containers did not stop.', 'Inspect perflens infra status and Docker logs. Persistent volumes were preserved.');
  }
}
