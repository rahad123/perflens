import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { docker, Runner } from './process';
import { CliError } from '../utils/errors';
import { otlpTracesEndpoint } from './workspace';

type Service = Record<string, any>;
type Compose = { name?: string; services?: Record<string, Service> };
const BASE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OVERRIDE_FILES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml'];
const runtimePattern = /\b(?:node|npm|npx|pnpm|yarn|bun|tsx|ts-node(?:-dev)?|nodemon)\b/i;
const CONTAINER_PRELOAD = '/opt/perflens/runtime/perflens-preload.cjs';

export interface RuntimeActivationOptions {
  projectDirectory: string;
  baseUrl: string;
  probePath?: string;
  serviceName: string;
  approveRestart: (service: string) => Promise<boolean>;
  selectService?: (services: string[]) => Promise<string | undefined>;
  write?: (line: string) => void;
  run?: Runner;
  probeTarget?: (url: string) => Promise<boolean>;
}
export interface RuntimeActivationResult { mode: 'host' | 'docker'; service?: string; restarted: boolean; endpoint: string }

function yaml(value: string): string { return JSON.stringify(value); }
function composeFilesFromEnvironment(cwd: string, env = process.env): string[] | null {
  let list = env.COMPOSE_FILE;
  if (!list) {
    try { list = /^\s*COMPOSE_FILE\s*=\s*([^\r\n#]+)\s*$/m.exec(require('node:fs').readFileSync(join(cwd, '.env'), 'utf8'))?.[1]?.trim(); }
    catch { /* optional Compose dotenv */ }
  }
  if (!list) return null;
  return list.split(env.COMPOSE_PATH_SEPARATOR || delimiter).filter(Boolean).map(file => resolve(cwd, file));
}
async function findComposeFiles(cwd: string): Promise<string[] | null> {
  const explicit = composeFilesFromEnvironment(cwd);
  if (explicit) {
    for (const file of explicit) await access(file).catch(() => { throw new CliError('The consumer Compose file could not be found.', `Check COMPOSE_FILE entry ${basename(file)}. PerfLens did not modify the application.`); });
    return explicit;
  }
  const base = BASE_FILES.find(file => { try { require('node:fs').accessSync(join(cwd, file)); return true; } catch { return false; } });
  if (!base) return null;
  const files = [join(cwd, base)];
  const prefix = base.startsWith('docker-compose') ? 'docker-compose' : 'compose';
  const matchingOverride = OVERRIDE_FILES.find(file => file.startsWith(prefix) && (() => { try { require('node:fs').accessSync(join(cwd, file)); return true; } catch { return false; } })());
  if (matchingOverride) files.push(join(cwd, matchingOverride));
  return files;
}
function parseJson(raw: string, label: string): any {
  try { return JSON.parse(raw); }
  catch { throw new CliError(`Could not inspect consumer ${label}.`, 'Check that Docker Compose is available and the local project configuration is valid. PerfLens did not print or persist resolved environment values.'); }
}
function commandText(service: Service): string {
  const values = [service.command, service.entrypoint, service.image, service.build?.dockerfile].flatMap(value => Array.isArray(value) ? value : [value]);
  return values.filter(value => typeof value === 'string').join(' ');
}
export function isSupportedNodeCommand(command: string): boolean { return runtimePattern.test(command); }
function portMatches(service: Service, port: number): boolean {
  return (service.ports ?? []).some((item: any) => {
    if (typeof item === 'string') return Number(item.split(':').at(-2)?.split('/')[0]) === port || Number(item.split(':')[0]) === port;
    return Number(item.published) === port;
  });
}
function environmentValue(service: Service, name: string): string | undefined {
  const env = service.environment;
  if (Array.isArray(env)) return env.find((entry: unknown) => typeof entry === 'string' && entry.startsWith(`${name}=`))?.slice(name.length + 1);
  const value = env?.[name];
  return typeof value === 'string' ? value : undefined;
}
function isSupportedLocalTraceEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/v1/traces';
  } catch { return false; }
}
async function candidatePackage(cwd: string, service: Service): Promise<{ express: boolean; node: boolean }> {
  const rawContext = typeof service.build === 'string' ? service.build : service.build?.context;
  if (!rawContext) return { express: false, node: false };
  const context = resolve(cwd, rawContext);
  const workdir = typeof service.working_dir === 'string' && !isAbsolute(service.working_dir) ? resolve(context, service.working_dir) : context;
  for (const file of [join(workdir, 'package.json'), join(context, 'package.json')]) {
    try {
      const pkg = JSON.parse(await readFile(file, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
      return { express: Boolean(deps.express), node: Boolean(pkg.scripts || deps.express || deps['@perflens/cli'] || deps['ts-node'] || deps.tsx) };
    } catch { /* build context may be remote or package file may be elsewhere */ }
  }
  return { express: false, node: false };
}
async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const current = await readFile(file);
    if (Buffer.from(current).equals(Buffer.from(data))) return;
  } catch { /* first write or stale/missing runtime asset */ }
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
  await rename(tmp, file);
}

function tokenizeNodeOptions(input: string): string[] {
  const tokens: string[] = [];
  let value = '', quote = '', escaped = false;
  for (const char of input) {
    if (escaped) { value += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; else value += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (value) { tokens.push(value); value = ''; } continue; }
    value += char;
  }
  if (escaped) value += '\\';
  if (quote) throw new CliError('The Node service has malformed NODE_OPTIONS.', 'Close any unmatched quotes in NODE_OPTIONS, then rerun audit.');
  if (value) tokens.push(value);
  return tokens;
}

function mergePreload(nodeOptions: string): string {
  const tokens = tokenizeNodeOptions(nodeOptions), preserved: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--require' || token === '-r') {
      const target = tokens[index + 1];
      if (target && (target === '@perflens/cli/preload' || target === CONTAINER_PRELOAD || /(?:^|\/)perflens(?:-docker)?-preload\.cjs$/.test(target))) { index++; continue; }
      preserved.push(token);
      if (target) preserved.push(tokens[++index]);
      continue;
    }
    if (token.startsWith('--require=')) {
      const target = token.slice('--require='.length);
      if (target === '@perflens/cli/preload' || target === CONTAINER_PRELOAD || /(?:^|\/)perflens(?:-docker)?-preload\.cjs$/.test(target)) continue;
    }
    preserved.push(token);
  }
  preserved.push('--require', CONTAINER_PRELOAD);
  return preserved.map(value => /\s|["']/.test(value) ? JSON.stringify(value) : value).join(' ');
}

/** Activate the package-owned preload for exactly one already-running local Compose service. */
export async function activateComposeInstrumentation(options: RuntimeActivationOptions): Promise<RuntimeActivationResult> {
  const cwd = resolve(options.projectDirectory), run = options.run ?? docker, write = options.write ?? (() => undefined);
  const containerEndpoint = await otlpTracesEndpoint(join(cwd, '.perflens', 'infra'), 'container');
  const hostPort = Number(new URL(containerEndpoint).port);
  const files = await findComposeFiles(cwd);
  if (!files) return { mode: 'host', restarted: false, endpoint: await otlpTracesEndpoint(join(cwd, '.perflens', 'infra')) };
  const args = ['compose', ...(files.flatMap(file => ['-f', file])), '--project-directory', cwd];
  const config = parseJson(await run([...args, 'config', '--format', 'json'], { cwd }), 'Compose project') as Compose;
  if (!config.name || !config.services || typeof config.services !== 'object') throw new CliError('Consumer Compose project identity is unavailable.', 'Set a valid project name in the consumer Compose configuration. PerfLens will not select services by name alone.');
  const serviceEntries = Object.entries(config.services);
  const runningText = await run([...args, 'ps', '--services', '--status', 'running'], { cwd });
  const running = new Set(runningText.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const candidates: string[] = [];
  for (const [name, service] of serviceEntries) {
    if (!running.has(name) || !portMatches(service, Number(new URL(options.baseUrl).port || (new URL(options.baseUrl).protocol === 'https:' ? 443 : 80)))) continue;
    const packageInfo = await candidatePackage(cwd, service);
    if (packageInfo.node || runtimePattern.test(commandText(service))) candidates.push(name);
  }
  // No Compose service publishes this port: the target is host-run (or managed
  // by another runtime). Leave it untouched; telemetry preflight will accept
  // an already-instrumented process and otherwise provide the host preload path.
  if (!candidates.length) return { mode: 'host', restarted: false, endpoint: await otlpTracesEndpoint(join(cwd, '.perflens', 'infra')) };
  let serviceName = candidates[0];
  if (candidates.length > 1) {
    serviceName = await options.selectService?.(candidates) ?? '';
    if (!candidates.includes(serviceName)) throw new CliError('More than one running Node service could serve the configured target.', `Candidates: ${candidates.join(', ')}. Select the backend service for the configured target; no service was restarted.`);
  }
  if (!serviceName) return { mode: 'host', restarted: false, endpoint: await otlpTracesEndpoint(join(cwd, '.perflens', 'infra')) };
  const service = config.services[serviceName];
  const serviceIdRaw = await run([...args, 'ps', '-q', serviceName], { cwd });
  const containerId = serviceIdRaw.trim().split(/\r?\n/)[0];
  if (!containerId) throw new CliError(`The Node service ${serviceName} is not running.`, 'Start the consumer development service and rerun audit. No application process was started by PerfLens.');
  const envRaw = await run(['inspect', '--format', '{{json .Config.Env}}', containerId]);
  const actualEnv = parseJson(envRaw, 'runtime metadata') as string[];
  const actual = new Map(actualEnv.filter(value => typeof value === 'string').map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)]; }));
  const runtimeAsset = join(cwd, '.perflens', 'runtime', 'perflens-docker-preload.cjs');
  let packagedAsset: string;
  try { packagedAsset = require.resolve('@perflens/cli/docker-preload'); }
  catch { throw new CliError('PerfLens could not locate its Docker instrumentation bundle.', 'Reinstall the packed @perflens/cli package and rerun audit. No application files were modified.'); }
  const runtimeBundle = await readFile(packagedAsset);
  const runtimeHash = createHash('sha256').update(runtimeBundle).digest('hex');
  await atomicWrite(runtimeAsset, runtimeBundle);
  const runtimeMarkers = ['NODE_ENV', 'DEPLOYMENT_ENVIRONMENT', 'APP_ENV', 'ENVIRONMENT']
    .map(key => actual.get(key) ?? environmentValue(service, key)).filter((value): value is string => Boolean(value));
  if (runtimeMarkers.some(value => /^(?:prod|production|staging|stage)$/i.test(value.trim()))) {
    throw new CliError(`PerfLens will not restart ${serviceName} because its runtime environment is marked production or staging.`, 'Use a clearly local development Compose project. PerfLens did not modify or restart the service.');
  }
  const endpoint = containerEndpoint;
  // Reuse only when the current package bundle, dynamic exporter endpoint,
  // service identity, and mounted preload are all present in the running app.
  const nodeOptions = actual.get('NODE_OPTIONS') ?? environmentValue(service, 'NODE_OPTIONS') ?? '';
  const active = actual.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') === endpoint
    && actual.get('OTEL_SERVICE_NAME') === options.serviceName
    && nodeOptions.includes(CONTAINER_PRELOAD)
    && actual.get('PERFLENS_RUNTIME_BUNDLE_SHA256') === runtimeHash;
  if (active) return { mode: 'docker', service: serviceName, restarted: false, endpoint };
  const currentExporterEndpoint = actual.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ?? environmentValue(service, 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
  if (currentExporterEndpoint && !isSupportedLocalTraceEndpoint(currentExporterEndpoint)) {
    throw new CliError(`The ${serviceName} service has an explicit non-local OTLP traces endpoint.`, 'PerfLens will not replace an external telemetry destination. Configure the consumer to use the project-local PerfLens Collector endpoint, then rerun audit.');
  }
  const desiredNodeOptions = mergePreload(nodeOptions);

  // Prove the module is available from the actual Node application working directory before asking to restart.
  const override = join(cwd, '.perflens', 'runtime', 'instrumentation.compose.yaml');
  const environment = {
    NODE_OPTIONS: desiredNodeOptions,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
    OTEL_SERVICE_NAME: options.serviceName,
    PERFLENS_RUNTIME_BUNDLE_SHA256: runtimeHash,
  };
  const yamlText = `services:\n  ${JSON.stringify(serviceName)}:\n    environment:\n${Object.entries(environment).map(([key, value]) => `      ${key}: ${yaml(value)}\n`).join('')}    volumes:\n      - type: bind\n        source: ${yaml(runtimeAsset)}\n        target: ${CONTAINER_PRELOAD}\n        read_only: true\n`;
  await atomicWrite(override, yamlText);
  write(`Node/Express service detected: ${serviceName}`);
  write(`PerfLens instrumentation endpoint: ${endpoint}`);
  if (!await options.approveRestart(serviceName)) throw new CliError(`Instrumentation activation requires restarting ${serviceName}.`, `Rerun interactively and approve restarting only this local service. No other Compose service was changed.`);
  const activationArgs = [...args, '-f', override, '--project-name', config.name, 'up', '-d', '--no-deps', '--force-recreate', serviceName];
  await run(activationArgs, { cwd, stream: true, timeout: 600000 });
  const target = new URL(options.probePath ?? '/', options.baseUrl).toString();
  const probe = options.probeTarget ?? (async (url: string) => {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      return true;
    } catch { return false; }
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !await probe(target)) await new Promise(resolve => setTimeout(resolve, 250));
  if (!await probe(target)) throw new CliError(`The ${serviceName} service was recreated for instrumentation but the target did not become reachable.`, 'Check the selected service logs and verify its startup command/port. No load was started; the application service and its original Compose files remain available.');
  return { mode: 'docker', service: serviceName, restarted: true, endpoint };
}
