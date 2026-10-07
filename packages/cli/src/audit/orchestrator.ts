import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { analyze } from '../analysis/service';
import { loadProject, resolveTargetHeaders } from '../config/project';
import { report } from '../report/service';
import { Endpoint, selectProfiles, validateSelectedEndpoints } from './config';
import { assertLocalDocker, Infrastructure, infrastructureReady } from '../services/infrastructure';
import { infrastructureRoot, otlpTracesEndpoint } from '../services/workspace';
import { CliError } from '../utils/errors';
import { audit, AuditOptions } from './service';
import { activateComposeInstrumentation, ApplicationReadinessError, RuntimeActivationResult } from '../services/runtime-instrumentation';

function stageError(stage: string, error: unknown): CliError {
  const detail = error instanceof Error ? error.message : String(error);
  const remediation = error instanceof CliError ? error.remediation : 'Inspect the preserved run artifacts and local service logs before retrying.';
  return new CliError(`${stage} failed. ${detail}`, remediation, error instanceof CliError ? error.exitCode : 1);
}
function preLoadStageError(stage: string, error: unknown): CliError {
  const detail = error instanceof Error ? error.message : String(error);
  const remediation = error instanceof CliError ? error.remediation : 'Inspect local service state and retry.';
  const authHint = /HTTP 401|HTTP 403/.test(detail) ? '\nIf this endpoint is private, configure target.headers with environment-variable references; PerfLens does not store credential values.' : '';
  return new CliError(`${stage} failed. ${detail}\n\nAudit stopped before load testing.\nLoad test: not started\nAnalysis: not run\nReport: not generated.`, `${remediation}${authHint}`, error instanceof CliError ? error.exitCode : 1);
}
function auditStageError(error: unknown): CliError {
  const detail = error instanceof Error ? error.message : String(error);
  const preflight = /Target preflight|correlated OpenTelemetry|instrumentation in Tempo|target preflight/i.test(detail);
  if (preflight) return preLoadStageError('Target or telemetry preflight', error);
  const remediation = error instanceof CliError ? error.remediation : 'Inspect preserved run artifacts and local service logs before retrying.';
  return new CliError(`Load execution failed. ${detail}\n\nLoad test: failed or incomplete\nAnalysis: not run\nReport: not generated.`, remediation, error instanceof CliError ? error.exitCode : 1);
}
function completedLoadStageError(stage: string, error: unknown, next: 'analysis' | 'report'): CliError {
  const detail = error instanceof Error ? error.message : String(error);
  const remediation = error instanceof CliError ? error.remediation : 'Inspect the preserved run artifacts before retrying.';
  const state = next === 'analysis' ? 'Analysis: failed\nReport: not generated.' : 'Analysis: completed\nReport: failed.';
  return new CliError(`${stage} failed. ${detail}\n\nLoad test: completed (evidence preserved)\n${state}`, remediation, error instanceof CliError ? error.exitCode : 1);
}
function display(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'unavailable';
}
export interface CompleteAuditDependencies {
  infrastructureRoot(projectDirectory: string, baseUrl: string): Promise<string>;
  assertLocalDocker(): Promise<void>;
  infrastructure(root: string): Pick<Infrastructure, 'status' | 'up'>;
  activateInstrumentation?: (input: { projectDirectory: string; baseUrl: string; probePath?: string; serviceName: string; approveRestart: (service: string) => Promise<boolean>; selectService?: (services: string[]) => Promise<string | undefined>; write: (line: string) => void }) => Promise<RuntimeActivationResult>;
  audit: typeof audit;
  analyze: typeof analyze;
  report: typeof report;
}
const defaults: CompleteAuditDependencies = {
  infrastructureRoot: (projectDirectory, baseUrl) => infrastructureRoot(undefined, projectDirectory, baseUrl),
  assertLocalDocker: () => assertLocalDocker(),
  infrastructure: root => new Infrastructure(root),
  activateInstrumentation: activateComposeInstrumentation,
  audit, analyze, report,
};
/** Coordinates existing Phase 2, 3, and 4 services; it contains no audit or diagnosis rules. */
export async function runCompleteAudit(options: AuditOptions, signal: AbortSignal, write: (line: string) => void = console.log, dependencies: CompleteAuditDependencies = defaults) {
  selectProfiles(options.profile);
  let project;
  try { project = await loadProject(options.config); }
  catch (error) { throw stageError('Configuration validation', error); }
  const projectDirectory = dirname(project.path);
  const selectedEndpoints: Endpoint[] = project.config.audit ? options.endpoints ? validateSelectedEndpoints(options.endpoints) : validateSelectedEndpoints(project.config.audit.endpoints) : [];
  const savedEndpoints = project.config.audit?.endpoints ?? [];
  const endpointSelectionChanged = Boolean(options.endpoints) && (selectedEndpoints.length !== savedEndpoints.length || selectedEndpoints.some((endpoint, index) => endpoint.path !== savedEndpoints[index]?.path));
  if ((selectedEndpoints.length > 1 || endpointSelectionChanged) && !options.confirmMultipleEndpoints) throw new CliError('Selected endpoints require explicit load-test approval.', 'Review the selected GET endpoint list and rerun interactively, or pass --yes to explicitly authorize these local targets. No load was started.', 2);
  try { resolveTargetHeaders(project.config.target.headers); }
  catch (error) { throw preLoadStageError('Request context validation', error); }
  let root: string;
  try { root = options.infraDir ? await infrastructureRoot(options.infraDir, projectDirectory, project.config.target.baseUrl) : await dependencies.infrastructureRoot(projectDirectory, project.config.target.baseUrl); }
  catch (error) { throw stageError('Infrastructure asset setup', error); }
  const infra = dependencies.infrastructure(root);
  write(`PerfLens Performance Audit\nProject  ${project.config.project.name}\nTarget   ${project.config.target.baseUrl}\nEndpoints ${selectedEndpoints.map(e => `GET ${e.path}`).join(', ') || 'not configured'}`);
  write('✓ Configuration valid');
  let otlpEndpoint = '';
  try {
    await dependencies.assertLocalDocker();
    let states: Awaited<ReturnType<Infrastructure['status']>>;
    try { states = await infra.status(); }
    catch { states = []; }
    if (infrastructureReady(states)) write('✓ Observability infrastructure already ready');
    else {
      const unavailable = states.filter(item => !item.ready).map(item => `${item.service}: ${item.state}`);
      write(`Current project infrastructure is missing, stale, or unhealthy (${unavailable.join('; ') || 'service set incomplete'}). Recovering local services...`);
      await infra.up(120000, true);
      states = await infra.status();
      if (!infrastructureReady(states)) throw new CliError('Infrastructure readiness checks did not pass.', states.map(item => `${item.service}: ${item.state}`).join('\n'));
      write('✓ Observability infrastructure ready');
    }
    otlpEndpoint = await otlpTracesEndpoint(root);
    write(`OTLP traces endpoint ${otlpEndpoint}`);
    write(`Docker container traces endpoint ${await otlpTracesEndpoint(root, 'container')} (set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT in the consumer container)`);
  } catch (error) { throw preLoadStageError('Observability startup', error); }

  if (dependencies.activateInstrumentation) {
    try {
      const activation = await dependencies.activateInstrumentation({
        projectDirectory, baseUrl: project.config.target.baseUrl, probePath: selectedEndpoints[0]?.path, serviceName: project.config.observability.serviceName,
        approveRestart: options.approveApplicationRestart ?? (async () => false),
        selectService: options.selectApplicationService, write,
      });
      if (activation.mode === 'docker') write(activation.restarted ? `✓ PerfLens instrumentation activated for ${activation.service}` : `✓ PerfLens instrumentation already active for ${activation.service}`);
    } catch (error) { throw preLoadStageError(error instanceof ApplicationReadinessError ? 'Application readiness' : 'Instrumentation activation', error); }
  }

  let executed;
  try { executed = await dependencies.audit({ ...options, endpoints: selectedEndpoints }, signal); }
  catch (error) { throw auditStageError(error); }

  let analysis;
  try {
    analysis = await dependencies.analyze(options, executed.run.runId, () => undefined);
    if (!analysis.availability.traces || analysis.traceSummary.requests === 0) {
      throw new CliError('No correlated request traces were collected for this audit.', `The completed load evidence remains under .perflens/runs. Check the selected application's startup logs and Collector delivery, then retry analysis for this run. PerfLens did not generate a report from missing telemetry (current Collector endpoint: ${otlpEndpoint}).`);
    }
  }
  catch (error) { throw completedLoadStageError('Evidence analysis', error, 'analysis'); }
  let reportModel;
  try { reportModel = await dependencies.report(options, executed.run.runId, () => undefined); }
  catch (error) { throw completedLoadStageError('Report generation', error, 'report'); }

  const profileResults = [];
  for (const profile of executed.run.profiles) {
    if (!profile.result) continue;
    try { profileResults.push(JSON.parse(await readFile(join(executed.directory, profile.result), 'utf8'))); }
    catch (error) { throw stageError(`Reading ${profile.name} measurements`, error); }
  }
  write('\nPERFORMANCE');
  write('Profile     Requests   Failed   RPS     Error   p50 ms   p95 ms   p99 ms');
  for (const result of profileResults) {
    const metrics = result.metrics, latency = metrics.latencyMs;
    write(`${result.profile.padEnd(11)} ${String(metrics.requests ?? '—').padStart(8)} ${String(metrics.failedRequests ?? '—').padStart(8)} ${display(metrics.rps).padStart(7)} ${display(typeof metrics.errorRate === 'number' ? metrics.errorRate * 100 : null).padStart(7)}% ${display(latency.p50).padStart(8)} ${display(latency.p95).padStart(8)} ${display(latency.p99).padStart(8)}`);
  }
  write(`Duration: ${profileResults.map(result => `${result.profile} ${display(result.metrics.durationMs, 0)} ms`).join(' · ')}`);

  write('\nBOTTLENECK FINDINGS');
  if (!analysis.findings.length) write('✓ No evidence-backed bottlenecks met Phase 3 thresholds for this run.');
  for (const finding of analysis.findings) {
    write(`${finding.severity}  ${finding.title} — ${finding.confidence.toUpperCase()} confidence`);
    write(`    ${finding.summary}`);
    write(`    Rule: ${finding.ruleId} · Profiles: ${finding.profiles.join(', ')}`);
    for (const evidence of finding.evidence.slice(0, 2)) write(`    • ${evidence.observation}`);
  }
  write(`\nTELEMETRY\nRequest traces: ${analysis.traceSummary.requests} · PostgreSQL spans: ${analysis.traceSummary.databaseSpans} · External HTTP spans: ${analysis.traceSummary.externalClientSpans}`);
  const grafana = (await JSON.parse(await readFile(join(executed.directory, 'telemetry/metadata.json'), 'utf8'))).infrastructure?.localUrls?.grafana;
  const prometheus = (await JSON.parse(await readFile(join(executed.directory, 'telemetry/metadata.json'), 'utf8'))).infrastructure?.localUrls?.prometheus;
  if (grafana) write(`Grafana: ${grafana}`);
  if (prometheus) write(`Prometheus: ${prometheus}`);
  if (grafana) write(`Trace navigation: Grafana → Explore → Tempo → filter perflens.audit.run_id = ${executed.run.runId}`);
  write(`Run ID: ${executed.run.runId}`);
  write(`\n✓ Audit complete\nReport: .perflens/runs/${executed.run.runId}/report/report.html`);
  return { ...executed, analysis, report: reportModel };
}
