import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { findProject, initialize, loadProject } from '../config/project';
import { CliError } from '../utils/errors';

export interface FirstAuditSetup {
  created: boolean;
  path: string;
  projectName: string;
  framework: 'express' | 'node' | 'unknown';
}

/** Reuses the create-only init service for first audit; never edits existing config. */
export async function ensureProjectForAudit(cwd = process.cwd(), configPath?: string, ask?: (prompt: string, defaultValue?: string) => Promise<string>): Promise<FirstAuditSetup> {
  const existing = await findProject(configPath, cwd);
  if (existing) return { created: false, path: existing.path, projectName: existing.config.project.name, framework: await projectFramework(dirname(existing.path)) };
  if (configPath) throw new CliError('The requested PerfLens configuration does not exist.', `Create ${resolve(cwd, configPath)} or omit --config to initialize ${basename(resolve(cwd))}.`, 2);
  if (!ask) throw new CliError('First-time audit setup needs a local target and representative GET endpoint.', 'Run `npx perflens audit` in an interactive terminal and answer the two setup questions. No files were changed.');

  const baseUrl = (await ask('Local API base URL', 'http://localhost:3000')).trim() || 'http://localhost:3000';
  const selection = (await ask('Endpoint selection: 1 recommended safe GET routes, 2 choose multiple routes, 3 one route', '3')).trim() || '3';
  if (!['1', '2', '3'].includes(selection)) throw new CliError('Invalid endpoint selection.', 'Choose 1, 2, or 3 and rerun the audit. No configuration was written.', 2);
  const endpointPrompt = selection === '1'
    ? 'Automatic route recommendations are unavailable for this app. Enter known safe GET paths manually (comma-separated)'
    : selection === '3' ? 'GET endpoint to audit (for example /api/orders)' : 'GET endpoints to audit (comma-separated paths)';
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
