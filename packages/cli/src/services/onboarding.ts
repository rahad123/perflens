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
  const endpoint = (await ask('Representative GET endpoint (for example /api/orders)')).trim();
  if (!endpoint) throw new CliError('First-time audit setup requires a representative GET endpoint.', 'Rerun the audit and provide an application route. Health and metrics routes are excluded from request tracing. No configuration was written.');
  const result = await initialize(cwd, { baseUrl, endpoint });
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
