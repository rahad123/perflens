import { spawn, SpawnOptions } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { loadProject } from '../config/project';
import { CliError } from '../utils/errors';

const RUN_ID = /^pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}$/i;
type SpawnProcess = typeof spawn;

export function openerForPlatform(platform: NodeJS.Platform): { command: string; args: (file: string) => string[] } {
  if (platform === 'darwin') return { command: 'open', args: file => [file] };
  if (platform === 'win32') return { command: 'explorer.exe', args: file => [file] };
  if (platform === 'linux') return { command: 'xdg-open', args: file => [file] };
  throw new CliError(`Automatic report opening is not supported on ${platform}.`, 'Open the report file path printed below with your preferred browser.');
}

export async function openFileInBrowser(file: string, platform: NodeJS.Platform = process.platform, spawnProcess: SpawnProcess = spawn): Promise<void> {
  const opener = openerForPlatform(platform);
  await new Promise<void>((resolve, reject) => {
    let child;
    try { child = spawnProcess(opener.command, opener.args(file), { stdio: 'ignore', windowsHide: true, shell: false } as SpawnOptions); }
    catch (error) { reject(error); return; }
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${opener.command} exited with status ${String(code)}.`)));
  });
}

async function readCompletedRun(directory: string, id: string): Promise<boolean> {
  try {
    const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
    return run.schemaVersion === 1 && run.runId === id && run.status === 'completed';
  } catch { return false; }
}

async function latestGeneratedReport(projectDirectory: string): Promise<{ id: string; file: string }> {
  const runsDirectory = join(projectDirectory, '.perflens', 'runs');
  let entries;
  try { entries = await readdir(runsDirectory, { withFileTypes: true }); }
  catch { throw new CliError('No generated PerfLens report was found for this project.', 'Run `npx perflens audit` first.'); }
  for (const entry of entries.filter(item => item.isDirectory() && RUN_ID.test(item.name)).sort((a, b) => b.name.localeCompare(a.name))) {
    const directory = join(runsDirectory, entry.name), file = join(directory, 'report', 'report.html');
    if (!await readCompletedRun(directory, entry.name)) continue;
    try { await access(file); return { id: entry.name, file }; } catch { /* skip incomplete report output */ }
  }
  throw new CliError('No generated PerfLens report was found for this project.', 'Run `npx perflens audit` first.');
}

export interface OpenReportOptions { config?: string }
export async function openGeneratedReport(options: OpenReportOptions, requestedId?: string, write: (line: string) => void = console.log, openFile: (file: string) => Promise<void> = file => openFileInBrowser(file)): Promise<{ id: string; file: string; opened: boolean }> {
  const loaded = await loadProject(options.config);
  const projectDirectory = dirname(loaded.path);
  let report: { id: string; file: string };
  if (requestedId === undefined) report = await latestGeneratedReport(projectDirectory);
  else {
    if (!RUN_ID.test(requestedId)) throw new CliError('Invalid audit run ID.', 'Use the exact pfl_<UTC timestamp>_<UUID> value shown by perflens runs.');
    const directory = join(projectDirectory, '.perflens', 'runs', requestedId);
    if (!await readCompletedRun(directory, requestedId)) throw new CliError(`Completed audit run ${requestedId} was not found.`, 'Check `npx perflens runs` and select a completed run.');
    const file = join(directory, 'report', 'report.html');
    try { await access(file); } catch { throw new CliError(`No generated HTML report exists for run ${requestedId}.`, `Generate it first with npx perflens report ${requestedId}.`); }
    report = { id: requestedId, file };
  }
  const displayPath = relative(projectDirectory, report.file) || report.file;
  write(`Report: ${displayPath}`);
  try {
    await openFile(report.file);
    write('✓ Report opened in your browser.');
    return { ...report, opened: true };
  } catch {
    write('Could not open the browser automatically. Open the file above manually.');
    return { ...report, opened: false };
  }
}

/** Opens only the report belonging to a successfully completed audit result. */
export async function runAuditAndMaybeOpenReport<T extends { run: { runId: string } }>(
  runAudit: () => Promise<T>,
  open: boolean,
  options: OpenReportOptions,
  write: (line: string) => void = console.log,
  openFile?: (file: string) => Promise<void>,
): Promise<T> {
  const completed = await runAudit();
  if (open) await openGeneratedReport(options, completed.run.runId, write, openFile);
  return completed;
}
