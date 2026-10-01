import { AuditConfig, validateAudit } from '../audit/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError } from '../utils/errors';
export const CONFIG_NAME = 'perflens.config.json';
export interface ProjectConfig {
  audit?: AuditConfig;
  project: { name: string };
  target: { baseUrl: string };
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
  const target = object(root.target, ['baseUrl'], 'target');
  const observability = object(root.observability, ['serviceName'], 'observability');
  let url: URL;
  try { url = new URL(String(target.baseUrl)); } catch { throw new CliError('Invalid target.baseUrl.', 'Provide an absolute local HTTP(S) URL.', 2); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new CliError('Unsafe target.baseUrl.', 'PerfLens permits loopback HTTP(S) URLs only, without credentials, query strings, or fragments.', 2);
  }
  return { ...(root.audit === undefined ? {} : { audit: validateAudit(root.audit) }), project: { name: name(project.name, 'project.name') }, target: { baseUrl: String(target.baseUrl) }, observability: { serviceName: name(observability.serviceName, 'observability.serviceName') } };
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
export async function initialize(cwd = process.cwd(), options: { baseUrl?: string; endpoint?: string; projectName?: string } = {}): Promise<{ path: string; created: boolean; projectName: string }> {
  let packageName: string | undefined;
  try { packageName = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).name; } catch { /* package.json is optional */ }
  const projectName = name(options.projectName ?? (typeof packageName === 'string' ? packageName.split('/').pop() : undefined) ?? (basename(resolve(cwd)).replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 100) || 'backend'), 'project.name');
  const config: ProjectConfig = { project: { name: projectName }, target: { baseUrl: options.baseUrl ?? 'http://localhost:3000' }, observability: { serviceName: projectName }, audit: validateAudit({ endpoints: [{ method: 'GET', path: options.endpoint ?? '/health' }] }) };
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
  } catch (error) {
    throw new CliError('PerfLens config was created, but its working directories could not be prepared.', error instanceof Error ? error.message : 'Check local filesystem permissions.', 1);
  }
  return { path, created, projectName: selectedName };
}
