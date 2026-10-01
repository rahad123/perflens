import { readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { buildReportModel, renderHtml, renderMarkdown, ReportModel } from '../../../reporting/dist';
import { loadProject } from '../config/project';
import { CliError } from '../utils/errors';

const RUN_ID = /^pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}$/i;
const { version: perflensVersion } = require('../../package.json') as { version: string };
type Format = 'all' | 'markdown' | 'html';
async function readJson(file: string, label: string): Promise<any> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new CliError(`Could not read ${label}.`, error instanceof SyntaxError ? 'The artifact is malformed; preserve the run for review.' : 'Verify that the selected completed audit run contains the required artifacts.'); }
}
async function latestEligible(projectDirectory: string): Promise<string> {
  const root = join(projectDirectory, '.perflens', 'runs');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('No audit runs were found.', 'Run perflens audit and perflens analyze first.'); throw error; }
  const candidates = entries.filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).map(entry => entry.name).sort().reverse();
  for (const id of candidates) {
    try {
      const dir = join(root, id); const run = await readJson(join(dir, 'run.json'), 'audit run metadata');
      if (run.status !== 'completed') continue;
      await loadReportModel(projectDirectory, id);
      return id;
    } catch { /* Latest eligible means completed and all required analysis artifacts exist. */ }
  }
  throw new CliError('No analyzed completed audit runs were found.', 'Run perflens analyze <run-id> first.');
}
async function atomicWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new CliError(`Could not write report artifact ${file}.`, 'Check directory permissions and available disk space; existing audit evidence remains unchanged.');
  }
}
export interface ReportOptions { config?: string; format?: string }
export async function loadReportModel(projectDirectory: string, id: string, generatedAt?: string): Promise<ReportModel> {
  const directory = resolve(projectDirectory, '.perflens', 'runs', id);
  const run = await readJson(join(directory, 'run.json'), 'audit run metadata');
  if (run.schemaVersion !== 1 || run.runId !== id || run.status !== 'completed' || !Array.isArray(run.profiles)) throw new CliError(`Audit run ${id} is incomplete, malformed, or unsupported.`, 'Reports require a completed schema version 1 audit run.');
  const profiles = [];
  for (const runProfile of run.profiles) {
    if (runProfile.status !== 'completed' || typeof runProfile.result !== 'string' || runProfile.result.startsWith('/') || runProfile.result.split(/[\\/]/).includes('..')) throw new CliError(`Profile ${String(runProfile.name)} is incomplete or has an invalid result path.`, 'Reports require completed profile evidence from the selected audit run.');
    profiles.push({ runProfile, result: await readJson(join(directory, runProfile.result), `normalized ${runProfile.name} profile results`) });
  }
  let analysis: any;
  try { analysis = await readJson(join(directory, 'analysis/analysis.json'), 'Phase 3 analysis'); }
  catch (error) { if (error instanceof CliError) throw new CliError(`Analysis is missing or invalid for run ${id}. Run "perflens analyze ${id}" first.`, 'Analysis must complete successfully before a report can be generated.'); throw error; }
  let findings: any; let evidence: any;
  try {
    [findings, evidence] = await Promise.all([
      readJson(join(directory, 'analysis/findings.json'), 'Phase 3 findings'),
      readJson(join(directory, 'analysis/evidence.json'), 'Phase 3 evidence snapshot'),
    ]);
  } catch (error) {
    if (error instanceof CliError) throw new CliError(`Analysis artifacts are incomplete for run ${id}.`, `Run "perflens analyze ${id}" first.`);
    throw error;
  }
  try { return buildReportModel({ run, profiles, analysis, findingsArtifact: findings, evidence, generatedAt, perflensVersion }); }
  catch (error) { throw new CliError(`Cannot build a valid report for run ${id}.`, error instanceof Error ? error.message : 'Check the persisted run and analysis schemas.'); }
}
export async function report(options: ReportOptions, requestedId?: string, write: (line: string) => void = console.log): Promise<ReportModel> {
  const format = options.format ?? 'all';
  if (!['all', 'markdown', 'html'].includes(format)) throw new CliError(`Unsupported report format: ${format}.`, 'Choose --format all, --format markdown, or --format html.');
  const loaded = await loadProject(options.config);
  const projectDirectory = dirname(loaded.path);
  const id = requestedId ?? await latestEligible(projectDirectory);
  if (!RUN_ID.test(id)) throw new CliError('Invalid audit run ID.', 'Use the exact pfl_<UTC timestamp>_<UUID> value shown by perflens runs.');
  const model = await loadReportModel(projectDirectory, id);
  const output = join(projectDirectory, '.perflens', 'runs', id, 'report');
  try { await mkdir(output, { recursive: true, mode: 0o700 }); }
  catch { throw new CliError(`Could not create report directory ${output}.`, 'Check directory permissions and available disk space; existing audit evidence remains unchanged.'); }
  await atomicWrite(join(output, 'report.json'), `${JSON.stringify(model, null, 2)}\n`);
  if (format === 'all' || format === 'markdown') await atomicWrite(join(output, 'report.md'), renderMarkdown(model));
  if (format === 'all' || format === 'html') await atomicWrite(join(output, 'report.html'), renderHtml(model));
  write(`PerfLens Backend Performance Audit\nRun: ${id}\nFindings: ${model.findings.length} (${model.findingsSummary.bySeverity.P0} P0, ${model.findingsSummary.bySeverity.P1} P1, ${model.findingsSummary.bySeverity.P2} P2)\nReport artifacts: .perflens/runs/${id}/report/${format === 'all' ? '{report.json, report.md, report.html}' : `report.json, report.${format === 'markdown' ? 'md' : 'html'}`}`);
  return model;
}
