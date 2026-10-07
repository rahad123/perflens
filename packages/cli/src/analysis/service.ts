import { AnalysisEvidence, AnalysisResult, analyzeEvidence, validateEvidence } from '../../../analysis-engine/dist';
import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadProject } from '../config/project';
import { infrastructureRoot } from '../services/workspace';
import { Infrastructure } from '../services/infrastructure';
import { CliError } from '../utils/errors';
import { collectTempoEvidence, collectTempoEvidenceWithRetry } from './tempo';

export interface AnalyzeOptions { config?: string; infraDir?: string; offline?: boolean }
interface RunRecord { schemaVersion: number; runId: string; status: string; startedAt: string; endedAt: string; target: { baseUrl: string }; serviceName: string; profiles: { name: string; status: string; startedAt: string | null; endedAt: string | null; result: string | null }[] }
const RUN_ID = /^pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}$/i;

async function json(file: string, missingIsOptional = false): Promise<any> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (missingIsOptional && (error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw new CliError(`Could not read valid JSON evidence: ${file}.`, error instanceof SyntaxError ? 'The artifact is malformed; preserve it for review and rerun a new audit.' : 'Verify the selected audit run contains this artifact.');
  }
}
async function latestRun(projectDirectory: string): Promise<string> {
  const parent = join(projectDirectory, '.perflens', 'runs');
  let entries;
  try { entries = await readdir(parent, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('No audit runs were found.', 'Run perflens audit first.'); throw error; }
  const ids = entries.filter(item => item.isDirectory() && RUN_ID.test(item.name)).map(item => item.name).sort().reverse();
  for (const id of ids) {
    try { if ((await json(join(parent, id, 'run.json'))).status === 'completed') return id; } catch { /* Ignore incomplete/unreadable entries when choosing latest eligible. */ }
  }
  throw new CliError('No completed audit runs were found.', 'Run perflens audit successfully before analysis.');
}
function endpointSet(profiles: any[]): { method: string; path: string }[] {
  const map = new Map<string, { method: string; path: string }>();
  for (const profile of profiles) for (const endpoint of profile.target?.endpoints ?? []) {
    if (typeof endpoint.method === 'string' && typeof endpoint.path === 'string') map.set(`${endpoint.method} ${endpoint.path}`, endpoint);
  }
  return [...map.values()];
}
function validateRun(run: any, requestedId: string): asserts run is RunRecord {
  if (!run || run.schemaVersion !== 1 || run.runId !== requestedId || run.status !== 'completed' || !Array.isArray(run.profiles) || !run.target || typeof run.target.baseUrl !== 'string' || typeof run.serviceName !== 'string' || !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.endedAt))) {
    throw new CliError(`Audit run ${requestedId} is incomplete, malformed, or unsupported.`, 'Only completed schema version 1 PerfLens runs can be analyzed.');
  }
}
async function loadCompletedProfiles(directory: string, run: RunRecord) {
  const results = [];
  for (const profile of run.profiles) {
    if (profile.status !== 'completed') throw new CliError(`Profile ${profile.name} is not completed.`, 'Analysis requires every selected profile in the audit run to be complete.');
    if (!profile.result || profile.result.startsWith('/') || profile.result.split(/[\\/]/).includes('..')) throw new CliError(`Invalid result path in profile ${profile.name}.`, 'Do not edit run metadata; use a valid completed audit run.');
    const result = await json(join(directory, profile.result));
    if (result.schemaVersion !== 1 || result.runId !== run.runId || result.profile !== profile.name || result.status !== 'completed' || !Array.isArray(result.target?.endpoints) || !result.metrics || !result.workload) {
      throw new CliError(`Normalized evidence for ${profile.name} is invalid or unsupported.`, 'Analysis requires completed schema version 1 profile results.');
    }
    results.push(result);
  }
  if (!results.length) throw new CliError('The completed audit run has no profile results.', 'Run perflens audit and preserve its result artifacts.');
  return results;
}
async function tempoUrl(options: AnalyzeOptions): Promise<string> {
  const project = await loadProject(options.config);
  const root = await infrastructureRoot(options.infraDir, dirname(project.path), project.config.target.baseUrl);
  const config = await new Infrastructure(root).configuration();
  const binding = config.services.tempo?.ports?.find(port => port.published);
  if (!binding || !['127.0.0.1', '::1'].includes(binding.host_ip ?? '')) throw new CliError('Tempo query API is not exposed on loopback.', 'Configure TEMPO_PORT in .env and run perflens infra up.');
  return `http://${binding.host_ip === '::1' ? '[::1]' : '127.0.0.1'}:${binding.published}`;
}
async function persist(directory: string, file: string, value: unknown): Promise<void> {
  const path = join(directory, file);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
function targetPath(run: RunRecord, profiles: any[]): string {
  const first = profiles[0]?.target?.endpoints?.[0];
  if (!first) return run.target.baseUrl;
  try { return new URL(first.path, run.target.baseUrl).pathname; } catch { return first.path; }
}
function render(result: AnalysisResult, requestedPath: string, write: (line: string) => void): void {
  write(`PerfLens Analysis\nRun: ${result.runId}\nTarget: ${result.target.endpoints[0]?.method ?? 'GET'} ${requestedPath}\nAnalyzed: ${result.traceSummary.requests} request traces, ${result.traceSummary.databaseSpans} PostgreSQL spans, ${result.traceSummary.externalClientSpans} external HTTP spans`);
  if (!result.availability.traces) write(`Trace analysis: insufficient evidence (${result.availability.note})`);
  if (!result.findings.length) write('No findings met the evidence and sample-size thresholds.');
  for (const finding of result.findings) {
    write(`\n${finding.severity}  ${finding.title}\n    ${finding.summary}`);
    write(`    Affected profiles: ${finding.profiles.join(', ')}`);
    for (const evidence of finding.evidence) write(`    • ${evidence.observation} (${evidence.source})`);
    write(`    Confidence: ${finding.confidence.toUpperCase()} · Rule: ${finding.ruleId}`);
  }
  write(`\nAnalysis complete.\nFindings: ${result.findings.length}\nResults: .perflens/runs/${result.runId}/analysis/`);
}

export async function analyze(options: AnalyzeOptions, requestedId?: string, write: (line: string) => void = console.log): Promise<AnalysisResult> {
  const loaded = await loadProject(options.config);
  const projectDirectory = dirname(loaded.path);
  const id = requestedId ?? await latestRun(projectDirectory);
  if (!RUN_ID.test(id)) throw new CliError('Invalid audit run ID.', 'Use the exact pfl_<UTC timestamp>_<UUID> value shown by perflens runs.');
  const directory = resolve(projectDirectory, '.perflens', 'runs', id);
  const run = await json(join(directory, 'run.json'));
  validateRun(run, id);
  const profiles = await loadCompletedProfiles(directory, run);
  const analysisDirectory = join(directory, 'analysis');
  await mkdir(analysisDirectory, { recursive: true, mode: 0o700 });
  const evidencePath = join(analysisDirectory, 'evidence.json');
  let evidence: AnalysisEvidence;
  try {
    evidence = await json(evidencePath, true) as AnalysisEvidence;
    validateEvidence(evidence);
    if (evidence.runId !== id) throw new CliError('Stored analysis evidence belongs to a different audit run.', 'Preserve the existing run and investigate the mismatched artifact.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !options.offline) throw error;
    if (options.offline) throw new CliError('No valid evidence snapshot is available for offline analysis.', 'Run perflens analyze once while local PerfLens infrastructure and Tempo retention are available.');
    const profileWindows = run.profiles.flatMap(profile => profile.status === 'completed' && profile.startedAt && profile.endedAt ? [{ profile: profile.name, startedAt: profile.startedAt, endedAt: profile.endedAt }] : []);
    let snapshot: Awaited<ReturnType<typeof collectTempoEvidence>>;
    try {
      const endpoint = await tempoUrl(options);
      snapshot = await collectTempoEvidenceWithRetry(() => collectTempoEvidence(endpoint, id, run.serviceName, endpointSet(profiles).map(item => item.path), profileWindows));
    }
    catch (cause) {
      if (cause instanceof CliError) throw cause;
      throw new CliError('Could not collect correlated Tempo evidence.', 'Start local PerfLens infrastructure and confirm the audit traces are retained.');
    }
    if (snapshot.traceCount === 0) {
      throw new CliError('No correlated request traces became available in Tempo.', 'The load results are preserved. Check the selected service logs and Collector delivery, then retry `perflens analyze <run-id>`; PerfLens did not save an empty telemetry snapshot.');
    }
    evidence = {
      schemaVersion: 1, runId: id,
      target: { baseUrl: run.target.baseUrl, serviceName: run.serviceName, endpoints: endpointSet(profiles) },
      auditWindow: { startedAt: run.startedAt, endedAt: run.endedAt }, profiles,
      traces: snapshot.spans,
      telemetry: { source: 'Tempo TraceQL query scoped to service.name, perflens.audit.run_id, perflens.audit.profile and each profile UTC window', collectedAt: new Date().toISOString(), traceCount: snapshot.traceCount, spanCount: snapshot.spanCount, truncated: snapshot.truncated, ...(snapshot.traceCount === 0 ? { unavailable: 'Tempo was reachable, but no spans carried the expected run/profile correlation attributes.' } : {}) },
      sources: ['run.json', ...run.profiles.map(profile => profile.result).filter((path): path is string => Boolean(path)), 'Tempo correlated trace snapshot'],
    };
    validateEvidence(evidence);
    await persist(directory, 'analysis/evidence.json', evidence);
  }
  // Use current normalized profile files with the snapshotted spans. This lets
  // analysis be reproducible without contacting Tempo after the first run.
  evidence.profiles = profiles;
  validateEvidence(evidence);
  const result = analyzeEvidence(evidence);
  await persist(directory, 'analysis/findings.json', { schemaVersion: 1, runId: id, findings: result.findings });
  await persist(directory, 'analysis/analysis.json', result);
  render(result, targetPath(run, profiles), write);
  return result;
}
