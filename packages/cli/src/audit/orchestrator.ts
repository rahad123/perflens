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
import { ResourceRuntime, summarizeResourceProfiles } from './resources';

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
function mib(value: number | null): string { return value === null ? 'unavailable' : `${(value / (1024 * 1024)).toFixed(1)} MiB`; }
function mibDelta(value: number | null): string { return value === null ? 'unavailable' : `${value >= 0 ? '+' : ''}${(value / (1024 * 1024)).toFixed(1)} MiB`; }
function memoryLimitPercent(value: number | null): string { return value === null ? 'limit utilization unavailable' : `${display(value)}% of limit`; }
function cpuDisplay(average: number | null, peak: number | null, count: number): string { return average === null || peak === null ? `insufficient samples (${count})` : `${display(average)}% / ${display(peak)}%`; }
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
  write(`PerfLens Performance Audit\nProject   ${project.config.project.name}\nTarget    ${project.config.target.baseUrl}\nEndpoints ${selectedEndpoints.length} selected GET route${selectedEndpoints.length === 1 ? '' : 's'}`);
  write('✓ Configuration valid');
  let otlpEndpoint = '';
  let resourceRuntime: ResourceRuntime | undefined;
  try {
    await dependencies.assertLocalDocker();
    let states: Awaited<ReturnType<Infrastructure['status']>>;
    try { states = await infra.status(); }
    catch { states = []; }
    if (infrastructureReady(states)) write('✓ Observability ready');
    else {
      const unavailable = states.filter(item => !item.ready).map(item => `${item.service}: ${item.state}`);
      write(`Current project infrastructure is missing, stale, or unhealthy (${unavailable.join('; ') || 'service set incomplete'}). Recovering local services...`);
      await infra.up(120000, true);
      states = await infra.status();
      if (!infrastructureReady(states)) throw new CliError('Infrastructure readiness checks did not pass.', states.map(item => `${item.service}: ${item.state}`).join('\n'));
      write('✓ Observability ready');
    }
    otlpEndpoint = await otlpTracesEndpoint(root);
  } catch (error) { throw preLoadStageError('Observability startup', error); }

  if (dependencies.activateInstrumentation) {
    try {
      const activation = await dependencies.activateInstrumentation({
        projectDirectory, baseUrl: project.config.target.baseUrl, probePath: selectedEndpoints[0]?.path, serviceName: project.config.observability.serviceName,
        approveRestart: options.approveApplicationRestart ?? (async () => false),
        selectService: options.selectApplicationService, write,
      });
      resourceRuntime = activation.resourceRuntime;
      if (activation.mode === 'docker') write(`✓ PerfLens instrumentation active${activation.service ? ` for ${activation.service}` : ''}`);
    } catch (error) { throw preLoadStageError(error instanceof ApplicationReadinessError ? 'Application readiness' : 'Instrumentation activation', error); }
  }

  if (options.approveLoad) {
    let approved = false;
    try { approved = await options.approveLoad(); }
    catch (error) { throw preLoadStageError('Audit permission', error); }
    if (!approved) throw new CliError('Audit permission was not granted.', 'No bounded load was started. Rerun interactively and approve the displayed target, endpoints, and profiles.');
  }

  let executed;
  try { executed = await dependencies.audit({ ...options, endpoints: selectedEndpoints, resourceRuntime }, signal); }
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
  const totals = profileResults.reduce((total, result) => {
    const metrics = result.metrics ?? {};
    return {
      requests: total.requests + (typeof metrics.requests === 'number' && Number.isFinite(metrics.requests) ? metrics.requests : 0),
      successful: total.successful + (typeof metrics.successfulRequests === 'number' && Number.isFinite(metrics.successfulRequests) ? metrics.successfulRequests : 0),
      failed: total.failed + (typeof metrics.failedRequests === 'number' && Number.isFinite(metrics.failedRequests) ? metrics.failedRequests : 0),
    };
  }, { requests: 0, successful: 0, failed: 0 });
  const failedAssessment = totals.requests > 0 && totals.successful === 0 && totals.failed === totals.requests;
  if (failedAssessment) {
    write('\n⚠ Performance assessment inconclusive — all measured requests failed.');
    write('  Audit execution completed. No successful-response latency baseline is available. Check endpoint behavior, HTTP status, request timeout, authentication, and whether the route is a long-lived stream. Standard profiles are intended for finite, safe GET endpoints.');
    write('  Failed requests alone do not establish a backend root cause.');
  }
  write('\nPERFORMANCE');
  for (const result of profileResults) {
    const metrics = result.metrics;
    const errorRate = typeof metrics.errorRate === 'number' ? `${display(metrics.errorRate * 100)}%` : 'unavailable';
    const errorSignal = typeof metrics.errorRate === 'number' && metrics.errorRate > 0 ? ' ⚠' : '';
    write(`  ${result.profile.padEnd(9)} ${String(metrics.requests ?? '—')} requests · ${display(metrics.rps)} RPS · p95 ${display(metrics.latencyMs.p95)} ms · errors ${errorRate}${errorSignal}`);
  }
  write('\nTELEMETRY');
  write(`  Request traces    ${analysis.traceSummary.requests}`);
  write(`  PostgreSQL spans  ${analysis.traceSummary.databaseSpans}`);
  write(`  External HTTP     ${analysis.traceSummary.externalClientSpans}`);
  write('\nRESOURCES');
  const resourceEvidence = executed.resourceEvidence;
  if (!resourceEvidence) {
    write('  Process metrics   Unavailable');
    write('  Container metrics Unavailable');
  } else {
    write(`  Process metrics   ${resourceEvidence.collection.process}`);
    write(`  Container metrics ${resourceEvidence.collection.container}`);
    write('  Node averages are means of process samples; peaks are single-process maxima, not summed service totals.');
    write('  Distinct PIDs or process-lifetime IDs are observed identities; they may represent workers or restarts, but their roles cannot be inferred from these samples.');
    for (const summary of summarizeResourceProfiles(resourceEvidence)) {
      if (summary.processSampleCount) {
        const identityLabel = summary.processInstances === 1 ? 'process identity' : 'process identities';
        const growth = summary.rssGrowthBytes !== null ? ` · RSS window change ${mibDelta(summary.rssGrowthBytes)}` : summary.processSampleCount < 2 ? '' : summary.processInstances > 1 ? ' · RSS window change unavailable (multiple process identities)' : ' · RSS window change unavailable (process continuity not established)';
        write(`  Node ${summary.profile.padEnd(8)} ${summary.processInstances} ${identityLabel} · CPU sample avg/peak ${cpuDisplay(summary.processCpuAveragePercent, summary.processCpuPeakPercent, summary.processSampleCount)} (one logical CPU) · RSS sample avg/per-process peak ${mib(summary.rssAverageBytes)} / ${mib(summary.rssPeakBytes)} · heap used peak ${mib(summary.heapUsedPeakBytes)} · external peak ${mib(summary.externalPeakBytes)}${growth}`);
      }
      if (summary.containerSampleCount) {
        const limit = summary.containerMemoryLimitBytes === null ? 'limit unavailable' : `limit ${mib(summary.containerMemoryLimitBytes)}`;
        write(`  Docker ${summary.profile.padEnd(7)} CPU avg/peak ${cpuDisplay(summary.containerCpuAveragePercent, summary.containerCpuPeakPercent, summary.containerSampleCount)} (Docker stats basis) · memory avg/peak ${mib(summary.containerMemoryAverageBytes)} / ${mib(summary.containerMemoryPeakBytes)} · ${limit} · ${memoryLimitPercent(summary.containerMemoryPeakPercentOfLimit)}`);
      }
    }
    if (resourceEvidence.collection.process !== 'available') write(`  Process note      ${resourceEvidence.collection.processNote}`);
    if (resourceEvidence.collection.container !== 'available') write(`  Container note    ${resourceEvidence.collection.containerNote}`);
  }
  write('\nFINDINGS');
  if (!analysis.findings.length) write(failedAssessment ? '  No root cause is inferred from failed requests alone.' : '  No evidence-backed bottlenecks met the configured thresholds.');
  for (const finding of analysis.findings) {
    write(`  ${finding.severity} ${finding.title} — ${finding.confidence.toUpperCase()} confidence`);
    write(`    ${finding.summary}`);
    write(`    ${finding.profiles.join(', ')} · ${finding.ruleId}`);
  }
  const grafana = (await JSON.parse(await readFile(join(executed.directory, 'telemetry/metadata.json'), 'utf8'))).infrastructure?.localUrls?.grafana;
  const prometheus = (await JSON.parse(await readFile(join(executed.directory, 'telemetry/metadata.json'), 'utf8'))).infrastructure?.localUrls?.prometheus;
  write('\n✓ Audit complete');
  write(`Run ID: ${executed.run.runId}`);
  write(`Report: .perflens/runs/${executed.run.runId}/report/report.html`);
  if (grafana) write(`Grafana: ${grafana} · filter traces by run ID ${executed.run.runId}`);
  if (prometheus) write(`Prometheus: ${prometheus}`);
  return { ...executed, analysis, report: reportModel };
}
