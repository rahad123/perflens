import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { findProject, initialize, loadProject } from '../config/project';
import { Endpoint, validateSelectedEndpoints } from '../audit/config';
import { CliError } from '../utils/errors';

export interface FirstAuditSetup {
  created: boolean;
  path: string;
  projectName: string;
  framework: 'express' | 'node' | 'unknown';
}

export async function chooseAuditEndpoints(current: Endpoint[], ask: (question: string, defaultValue?: string) => Promise<string>): Promise<{ endpoints: Endpoint[]; changed: boolean }> {
  const choice = (await ask(`Current audit targets:\n${current.map(endpoint => `  GET ${endpoint.path}`).join('\n')}\nWhat would you like to audit?\n1. Use current endpoints\n2. Choose different endpoints\n3. Audit one endpoint`, '1')).trim() || '1';
  if (choice === '1') return { endpoints: current, changed: false };
  if (choice !== '2' && choice !== '3') throw new CliError('Invalid endpoint selection.', 'Choose 1, 2, or 3. No load was started.', 2);
  const entered = (await ask(choice === '3'
    ? 'Known safe GET path (PerfLens does not discover routes)'
    : 'Known safe GET paths (comma-separated; PerfLens does not discover routes)')).trim();
  const endpoints = validateSelectedEndpoints(entered.split(',').map(path => ({ method: 'GET', path: path.trim() })));
  return { endpoints, changed: endpoints.length !== current.length || endpoints.some((endpoint, index) => endpoint.path !== current[index]?.path) };
}

/** Reuses the create-only init service for first audit; never edits existing config. */
export async function ensureProjectForAudit(cwd = process.cwd(), configPath?: string, ask?: (prompt: string, defaultValue?: string) => Promise<string>): Promise<FirstAuditSetup> {
  const existing = await findProject(configPath, cwd);
  if (existing) return { created: false, path: existing.path, projectName: existing.config.project.name, framework: await projectFramework(dirname(existing.path)) };
  if (configPath) throw new CliError('The requested PerfLens configuration does not exist.', `Create ${resolve(cwd, configPath)} or omit --config to initialize ${basename(resolve(cwd))}.`, 2);
  if (!ask) throw new CliError('First-time audit setup needs a local target and representative GET endpoint.', 'Run `npx perflens audit` in an interactive terminal and answer the two setup questions. No files were changed.');

  const baseUrl = (await ask('Local API base URL', 'http://localhost:3000')).trim() || 'http://localhost:3000';
  const selection = (await ask('Endpoint selection: 1 enter one known safe GET path, 2 enter multiple known safe GET paths', '1')).trim() || '1';
  if (!['1', '2'].includes(selection)) throw new CliError('Invalid endpoint selection.', 'Choose 1 or 2 and rerun the audit. No configuration was written.', 2);
  const endpointPrompt = selection === '1'
    ? 'Known GET path to audit (for example /api/orders; PerfLens does not discover routes automatically)'
    : 'Known safe GET paths to audit (comma-separated; PerfLens does not discover routes automatically)';
  const entered = (await ask(endpointPrompt)).trim();
  const endpoints = entered.split(',').map(path => path.trim()).filter(Boolean);
  if (!endpoints.length) throw new CliError('First-time audit setup requires at least one representative GET endpoint.', 'Rerun the audit and provide application routes. Health and metrics routes are excluded from request tracing. No configuration was written.');
  if (endpoints.length > 8) throw new CliError('PerfLens supports at most 8 selected GET endpoints.', 'Choose a smaller representative endpoint set. No configuration was written.', 2);
  const excluded = endpoints.find(path => /^\/(?:health|metrics)(?:\/|$)/i.test(path));
  if (excluded) throw new CliError(`The route ${excluded} is excluded from representative auditing.`, 'Select a business GET route instead. No configuration was written.', 2);
  const result = await initialize(cwd, { baseUrl, endpoint: endpoints });
  const project = await loadProject(result.path, cwd);
  return { created: result.created, path: result.path, projectName: project.config.project.name, framework: await projectFramework(cwd) };
}

async function projectFramework(cwd: string): Promise<FirstAuditSetup['framework']> {
  try {
    const pkg = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
    if (pkg && typeof pkg === 'object' && !Array.isArray(pkg) && (pkg.dependencies?.express || pkg.devDependencies?.express)) return 'express';
    if (pkg && typeof pkg === 'object' && !Array.isArray(pkg) && pkg.name) return 'node';
  } catch { /* Package metadata is an optional hint, not a project requirement. */ }
  return 'unknown';
}
