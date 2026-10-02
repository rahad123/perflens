import { AuditConfig, validateAudit } from '../audit/config';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError } from '../utils/errors';
export const CONFIG_NAME = 'perflens.config.json';
export interface ProjectConfig {
  audit?: AuditConfig;
  project: { name: string };
  target: { baseUrl: string; headers?: Record<string, string> };
  observability: { serviceName: string };
}
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new CliError(`Invalid ${label} configuration.`, `Expected only: ${keys.join(', ')}.`, 2);
  }
  return value as Record<string, unknown>;
}
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) {
    throw new CliError(`Invalid ${label}.`, 'Use 1–100 letters, digits, dots, underscores, or hyphens, starting with a letter or digit.', 2);
  }
  return value;
}
export function validateConfig(value: unknown): ProjectConfig {
  const root = object(value, ['project', 'target', 'observability', 'audit'], 'PerfLens');
  const project = object(root.project, ['name'], 'project');
  const target = object(root.target, ['baseUrl', 'headers'], 'target');
  const observability = object(root.observability, ['serviceName'], 'observability');
  let url: URL;
  try { url = new URL(String(target.baseUrl)); } catch { throw new CliError('Invalid target.baseUrl.', 'Provide an absolute local HTTP(S) URL.', 2); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new CliError('Unsafe target.baseUrl.', 'PerfLens permits loopback HTTP(S) URLs only, without credentials, query strings, or fragments.', 2);
  }
  let headers: Record<string, string> | undefined;
  if (target.headers !== undefined) {
    if (!target.headers || typeof target.headers !== 'object' || Array.isArray(target.headers)) throw new CliError('Invalid target.headers.', 'Provide a small object of HTTP header names and values.', 2);
    headers = {};
    for (const [header, raw] of Object.entries(target.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(header) || typeof raw !== 'string' || raw.length > 4096 || /[\r\n]/.test(raw)) throw new CliError(`Invalid request header configuration: ${header}.`, 'Header names/values must be valid, single-line HTTP values. Use ${ENV_VAR} references for secrets.', 2);
      const sensitiveName = /authorization|cookie|password|secret|token|api[_-]?key|credential/i.test(header);
      const references = [...raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)];
      if (raw.replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, '').includes('${')) throw new CliError(`Invalid environment-variable reference in target.headers.${header}.`, 'Use ${ENV_VAR} with an uppercase environment variable name.', 2);
      if (sensitiveName && !references.length) throw new CliError(`Sensitive header ${header} must use an environment-variable reference.`, 'For example: "Authorization": "Bearer ${PERFLENS_AUTH_TOKEN}". Do not put credential values in the config.', 2);
      headers[header] = raw;
    }
  }
  return { ...(root.audit === undefined ? {} : { audit: validateAudit(root.audit) }), project: { name: name(project.name, 'project.name') }, target: { baseUrl: String(target.baseUrl), ...(headers ? { headers } : {}) }, observability: { serviceName: name(observability.serviceName, 'observability.serviceName') } };
}

/** Resolve request context only in memory; returned values must never be written to run artifacts. */
export function resolveTargetHeaders(headers: Record<string, string> | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers ?? {})) {
    const value = template.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key: string) => {
      const secret = env[key];
      if (secret === undefined || secret.length === 0) throw new CliError(`Required environment variable ${key} for request header ${name} is not set.`, `Set ${key} in the local shell environment and rerun the audit. Credential values are not stored by PerfLens.`, 2);
      return secret;
    });
    if (value.length > 8192 || /[\r\n]/.test(value)) throw new CliError(`Resolved request header ${name} is invalid.`, 'Use a single-line value no longer than 8192 characters.');
    resolved[name] = value;
  }
  return resolved;
}
export async function loadProject(file?: string, cwd = process.cwd()): Promise<{ path: string; config: ProjectConfig }> {
  let directory = resolve(cwd);
  while (true) {
    const path = file ? resolve(cwd, file) : join(directory, CONFIG_NAME);
    try {
      const raw = await readFile(path, 'utf8');
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new CliError(`Invalid JSON in ${path}.`, 'Fix the JSON syntax; comments and trailing commas are not supported.', 2); }
      return { path, config: validateConfig(value) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (file || dirname(directory) === directory) throw new CliError('PerfLens project configuration was not found.', `Run perflens init or pass --config <path> to an existing ${CONFIG_NAME}.`, 2);
      directory = dirname(directory);
    }
  }
}
/** Returns null only when no config exists; malformed configs remain fatal. */
export async function findProject(file?: string, cwd = process.cwd()): Promise<{ path: string; config: ProjectConfig } | null> {
  try { return await loadProject(file, cwd); }
  catch (error) {
    if (error instanceof CliError && error.message === 'PerfLens project configuration was not found.') return null;
    throw error;
  }
}
export async function initialize(cwd = process.cwd(), options: { baseUrl?: string; endpoint?: string | string[]; projectName?: string } = {}): Promise<{ path: string; created: boolean; projectName: string }> {
  let packageName: string | undefined;
  try { packageName = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).name; } catch { /* package.json is optional */ }
  const projectName = name(options.projectName ?? (typeof packageName === 'string' ? packageName.split('/').pop() : undefined) ?? (basename(resolve(cwd)).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 100) || 'backend'), 'project.name');
  const selected = Array.isArray(options.endpoint) ? options.endpoint : [options.endpoint ?? '/health'];
  const config: ProjectConfig = { project: { name: projectName }, target: { baseUrl: options.baseUrl ?? 'http://localhost:3000' }, observability: { serviceName: projectName }, audit: validateAudit({ endpoints: selected.map(path => ({ method: 'GET', path })) }) };
  const path = join(cwd, CONFIG_NAME);
  let created = false;
  let selectedName = projectName;
  try { await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await loadProject(path, cwd);
    selectedName = existing.config.project.name;
  }
  try {
    for (const folder of ['runs', 'results', 'logs']) await mkdir(join(cwd, '.perflens', folder), { recursive: true, mode: 0o700 });
    const gitignore = join(cwd, '.gitignore');
    const current = await readFile(gitignore, 'utf8').catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error));
    if (current === null) await writeFile(gitignore, '.perflens/\n', { flag: 'wx', mode: 0o600 });
    else if (!current.split(/\r?\n/).some(line => /^\/?\.perflens\/?$/.test(line.trim()))) await appendFile(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}.perflens/\n`);
  } catch (error) {
    throw new CliError('PerfLens config was created, but its working directories could not be prepared.', error instanceof Error ? error.message : 'Check local filesystem permissions.', 1);
  }
  return { path, created, projectName: selectedName };
}
