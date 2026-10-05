import { createServer } from 'node:net';
import { join } from 'node:path';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CliError } from '../utils/errors';
import { docker, Runner } from './process';
import { INFRA_SERVICES, infrastructureProjectName, LABELS } from './workspace';

export interface Container { Service: string; Project?: string; State: string; Health?: string; ExitCode?: number; Publishers?: { PublishedPort: number; TargetPort?: number; URL: string; Protocol?: string }[] }
interface ServiceConfig { ports?: { host_ip?: string; published?: string; target: number }[] }
export interface ComposeConfig { name: string; services: Record<string, ServiceConfig> }
export type ServiceReadiness = { service: string; state: string; ready: boolean; failed: boolean };
/** Fail closed: missing, duplicate, unknown, or unhealthy services are never ready. */
export function infrastructureReady(states: readonly Pick<ServiceReadiness, 'service' | 'ready'>[]): boolean {
  return states.length === INFRA_SERVICES.length
    && new Set(states.map(state => state.service)).size === INFRA_SERVICES.length
    && INFRA_SERVICES.every(service => states.some(state => state.service === service && state.ready))
    && states.every(state => (INFRA_SERVICES as readonly string[]).includes(state.service) && state.ready);
}
type HealthProbe = (url: string) => Promise<boolean>;
const HEALTH_ENDPOINT: Record<string, { target: number; path: string }> = {
  'otel-collector': { target: 13133, path: '/' }, tempo: { target: 3200, path: '/ready' },
  prometheus: { target: 9090, path: '/-/ready' }, grafana: { target: 3000, path: '/api/health' },
};
const PORT_ENV: Record<string, string> = {
  'otel-collector:4317': 'OTLP_GRPC_PORT', 'otel-collector:4318': 'OTLP_HTTP_PORT', 'otel-collector:13133': 'OTEL_HEALTH_PORT',
  'tempo:3200': 'TEMPO_PORT', 'prometheus:9090': 'PROMETHEUS_PORT', 'grafana:3000': 'GRAFANA_PORT',
};
const DEFAULT_PORTS: Record<string, number> = { OTLP_GRPC_PORT: 4317, OTLP_HTTP_PORT: 4318, OTEL_HEALTH_PORT: 13133, TEMPO_PORT: 3200, PROMETHEUS_PORT: 9090, GRAFANA_PORT: 3001 };
const localHost = (host: string | undefined) => host === '::1' ? '::1' : '127.0.0.1';
async function probeHttp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
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
  constructor(readonly root: string, readonly run: Runner = docker, readonly portAvailable = availablePort, readonly healthProbe: HealthProbe = probeHttp) {}
  async compose(args: string[], stream = false, timeout = 20000) {
    // Always override ambient COMPOSE_PROJECT_NAME and legacy Compose `name:` values.
    // Every operation (including config, ps, up, stop) uses this consumer identity.
    const envFile = await readFile(join(this.root, '.env'), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    const env: NodeJS.ProcessEnv = {};
    const unsetEnv = [...new Set(Object.values(PORT_ENV))];
    for (const key of unsetEnv) {
      const match = new RegExp(`^${key}=(\\d+)$`, 'm').exec(envFile);
      if (!match) continue;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`Invalid local infrastructure port ${key}.`, 'Repair the project-local .perflens/infra/.env values and retry.');
      env[key] = String(port);
    }
    return this.run(['compose', '--project-name', infrastructureProjectName(this.root), '--project-directory', this.root, '--env-file', join(this.root, '.env'), '-f', join(this.root, 'docker-compose.yml'), ...args], { cwd: this.root, stream, timeout, env, unsetEnv });
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
  private hasExpectedBindings(container: Container, expected: { host_ip?: string; published?: string; target: number }[]): boolean {
    const actual = container.Publishers ?? [];
    return expected.every(binding => Boolean(binding.published) && actual.some(port =>
      Number(port.PublishedPort) === Number(binding.published)
      && Number(port.TargetPort) === Number(binding.target)
      && localHost(port.URL) === localHost(binding.host_ip)
      && (!port.Protocol || port.Protocol === 'tcp')));
  }
  async status(): Promise<{ service: string; state: string; ready: boolean; failed: boolean }[]> {
    const config = await this.configuration();
    const expectedProject = infrastructureProjectName(this.root);
    if (config.name !== expectedProject) throw new CliError('PerfLens Compose project identity did not resolve to this consumer project.', `Expected ${expectedProject} but Compose resolved ${config.name}. All infrastructure commands must target the consumer's project-local stack.`);
    const containers = await this.containers();
    return Promise.all(INFRA_SERVICES.map(async service => {
      const matching = containers.filter(c => c.Project === expectedProject && c.Service === service);
      if (matching.length > 1) return { service, state: 'duplicate service containers found', ready: false, failed: true };
      const container = matching[0];
      if (!container) return { service, state: 'not created', ready: false, failed: false };
      if (container.State !== 'running') return { service, state: container.State, ready: false, failed: !['exited', 'created'].includes(container.State) || Boolean(container.ExitCode) };
      const expected = config.services[service].ports ?? [];
      if (!expected.length || !this.hasExpectedBindings(container, expected)) return { service, state: 'running with stale or missing published ports', ready: false, failed: true };
      try {
        if (container.Health && container.Health !== 'healthy') throw new Error('healthcheck');
        const health = HEALTH_ENDPOINT[service];
        const binding = expected.find(port => port.target === health.target);
        if (!binding?.published) throw new Error('health endpoint port is not published');
        const host = binding.host_ip === '::1' ? '[::1]' : binding.host_ip ?? '127.0.0.1';
        if (!await this.healthProbe(`http://${host}:${binding.published}${health.path}`)) throw new Error('host health endpoint is unreachable');
        return { service, state: 'ready', ready: true, failed: false };
      } catch (error) { return { service, state: `running, not ready${container.Health ? ` (${container.Health})` : ''}: ${error instanceof Error ? error.message : String(error)}`, ready: false, failed: true }; }
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
        const owned = containers.some(c => c.Project === config.name && c.Service === service && c.State === 'running' && c.Publishers?.some(p => p.PublishedPort === port && localHost(p.URL) === localHost(host)));
        if (owned) checks.push(`Port ${port} used by this PerfLens ${LABELS[service]} container`);
        else if (await this.portAvailable(port, host)) checks.push(`Port ${port} available`);
        else throw new CliError(`Port ${port} is occupied by another process.`, 'Free this local port and retry, or rerun audit so PerfLens can select another available infrastructure port.');
      }
    }
    return checks;
  }
  private async repairUnavailablePorts(config: ComposeConfig): Promise<void> {
    const envPath = join(this.root, '.env');
    let content = await readFile(envPath, 'utf8');
    const containers = await this.containers();
    const reserved = new Set<number>();
    let changed = false;
    for (const service of INFRA_SERVICES) for (const binding of config.services[service].ports ?? []) {
      if (!binding.published) continue;
      const key = PORT_ENV[`${service}:${binding.target}`];
      if (!key) continue;
      const configured = Number(binding.published);
      const samePort = reserved.has(configured);
      const owned = containers.some(container => container.Project === config.name && container.Service === service && container.State === 'running'
        && container.Publishers?.some(port => Number(port.PublishedPort) === configured && Number(port.TargetPort) === Number(binding.target) && localHost(port.URL) === localHost(binding.host_ip)));
      let unavailable = false;
      if (!samePort && !owned) unavailable = !await this.portAvailable(configured, localHost(binding.host_ip));
      if (samePort || unavailable) {
        let replacement: number | undefined;
        const preferred = DEFAULT_PORTS[key] ?? configured;
        for (let candidate = Math.max(preferred, configured) + 1; candidate < Math.max(preferred, configured) + 101; candidate++) {
          if (reserved.has(candidate)) continue;
          if (await this.portAvailable(candidate, localHost(binding.host_ip))) { replacement = candidate; break; }
        }
        if (!replacement) throw new CliError(`No available replacement port for ${key}.`, 'Free a local port or stop only the process known to own the conflicting port; PerfLens will not stop unrelated services.');
        const expression = new RegExp(`^${key}=\\d+$`, 'm');
        if (!expression.test(content)) throw new CliError(`Infrastructure port setting ${key} is missing.`, 'Repair the project-local .perflens/infra/.env file and retry.');
        content = content.replace(expression, `${key}=${replacement}`);
        reserved.add(replacement); changed = true;
      } else reserved.add(configured);
    }
    if (changed) {
      const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, envPath);
    }
  }
  async up(readinessTimeout = 120000, forceRecreate = false): Promise<ComposeConfig> {
    await this.repairUnavailablePorts(await this.configuration());
    const config = await this.configuration();
    await this.checkPorts(config);
    await this.compose(['up', '-d', ...(forceRecreate ? ['--force-recreate'] : []), '--wait', '--wait-timeout', '120', ...INFRA_SERVICES], true, 600000);
    const deadline = Date.now() + readinessTimeout;
    let states = await this.status();
    while (!infrastructureReady(states) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      states = await this.status();
    }
    if (!infrastructureReady(states)) throw new CliError('PerfLens infrastructure did not become ready.', `Inspect the current project's Docker Compose logs in ${this.root}.\n${states.map(s => `${LABELS[s.service] ?? s.service}: ${s.state}`).join('\n')}`);
    return config;
  }
  async down(): Promise<void> {
    // Stop only our allowlisted services. Never compose down -v or stop the target.
    await this.compose(['stop', '--timeout', '30', ...INFRA_SERVICES], true, 180000);
    const project = infrastructureProjectName(this.root);
    if ((await this.containers()).some(c => c.Project === project && !['exited', 'created'].includes(c.State))) throw new CliError('Some current-project infrastructure containers did not stop.', 'Inspect perflens infra status and Docker logs. Persistent volumes were preserved.');
  }
}
