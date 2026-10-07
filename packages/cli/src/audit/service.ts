import { withAuditLock } from './lock';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadProject, ProjectConfig, resolveTargetHeaders } from '../config/project';
import { CliError } from '../utils/errors';
import { selectProfiles, ProfileName, validateAudit, Endpoint } from './config';
import { K6Runner, Plan } from './k6';
import { checkCancelled, checkInfrastructure, checkInstrumentation, checkTarget } from './preflight';
import { completedEvidenceError, normalize, readSamples } from './results';
import { RunStatus, RunStore } from './storage';
export interface AuditOptions { config?: string; infraDir?: string; profile?: string; confirmMultipleEndpoints?: boolean; endpoints?: Endpoint[]; approveApplicationRestart?: (service: string) => Promise<boolean>; approveLoad?: () => Promise<boolean>; selectApplicationService?: (services: string[]) => Promise<string | undefined> }
interface ProfileState { name: ProfileName; status: RunStatus; startedAt: string | null; endedAt: string | null; error: string | null; result: string | null }
export interface AuditDependencies {
  runner: Pick<K6Runner, 'version' | 'prepare' | 'profile'>;
  infrastructure: typeof checkInfrastructure;
  target: typeof checkTarget;
  instrumentation: typeof checkInstrumentation;
  write: (line: string) => void;
}
const defaults: AuditDependencies = { runner: new K6Runner(), infrastructure: checkInfrastructure, target: checkTarget, instrumentation: checkInstrumentation, write: console.log };
export async function audit(options: AuditOptions, signal = new AbortController().signal, dependencies: AuditDependencies = defaults) {
  const selected = selectProfiles(options.profile);
  const loaded = await loadProject(options.config);
  const config: ProjectConfig = loaded.config;
  if (!config.audit) throw new CliError('No audit endpoints are configured.', 'Add audit.endpoints with GET paths to perflens.config.json. Existing Phase 1 configs still work for doctor/infra.', 2);
  const endpoints = options.endpoints ? validateAudit({ ...config.audit, endpoints: options.endpoints }).endpoints : config.audit.endpoints;
  if (endpoints.length > 1 && !options.confirmMultipleEndpoints) throw new CliError('Multiple endpoints require explicit load-test approval.', 'Review the selected GET endpoints and rerun interactively, or pass --yes to explicitly authorize this local endpoint set.', 2);
  resolveTargetHeaders(config.target.headers);
  return withAuditLock(dirname(loaded.path), () => executeAudit({ ...config, audit: { ...config.audit!, endpoints } }, loaded.path, selected, signal, dependencies, options.infraDir));
}
async function executeAudit(config: ProjectConfig, configPath: string, selected: ProfileName[], signal: AbortSignal, dependencies: AuditDependencies, infraDir?: string) {
  const auditConfig = config.audit!;
  const requestHeaders = resolveTargetHeaders(config.target.headers);
  const requestHeaderEnv = Object.keys(requestHeaders).map((name, index) => ({ name, envName: `PERFLENS_REQUEST_HEADER_${index}` }));
  const store = await RunStore.create(dirname(configPath));
  const profiles: ProfileState[] = selected.map(name => ({ name, status: 'created', startedAt: null, endedAt: null, error: null, result: null }));
  const run = {
    schemaVersion: 1, runId: store.id, status: 'created' as RunStatus, startedAt: new Date().toISOString(), endedAt: null as string | null,
    project: config.project, target: { baseUrl: config.target.baseUrl }, serviceName: config.observability.serviceName,
    profiles, errors: [] as string[], engine: { name: 'k6', version: null as string | null },
  };
  const metadata = {
    schemaVersion: 1, auditRunId: store.id, serviceName: config.observability.serviceName, target: { baseUrl: config.target.baseUrl },
    auditStartedAt: run.startedAt, auditEndedAt: null as string | null, profiles,
    correlation: {
      requestHeaders: ['X-PerfLens-Run-Id', 'X-PerfLens-Profile'],
      spanAttributes: ['perflens.audit.run_id', 'perflens.audit.profile'],
      traceql: `{ resource.service.name = ${JSON.stringify(config.observability.serviceName)} && span.perflens.audit.run_id = ${JSON.stringify(store.id)} }`,
      note: 'The target must capture these attributes. OpenTelemetry owns trace IDs. Preflight requests use profile=preflight. Prometheus windows are temporal; run IDs are deliberately not metric labels.',
    },
    infrastructure: null as Awaited<ReturnType<typeof checkInfrastructure>> | null,
    prometheus: { strategy: 'profile UTC time windows plus target/service identity', snapshots: null, retention: 'local stack defaults to 7 days; traces default to 24 hours' },
  };
  const save = async () => { await store.write('run.json', run); await store.write('telemetry/metadata.json', metadata); };
  await store.write('config.json', { schemaVersion: 1, ...config });
  await save();
  let currentPlan: Plan | undefined;
  try {
    run.status = 'preflight'; await save(); checkCancelled(signal);
    run.engine.version = await dependencies.runner.version(signal); checkCancelled(signal);
    metadata.infrastructure = await dependencies.infrastructure(infraDir, dirname(configPath), config.target.baseUrl); checkCancelled(signal);
    for (const endpoint of auditConfig.endpoints) {
      await dependencies.target(config, endpoint, store.id, signal, requestHeaders);
      dependencies.write(`✓ Target reachable: GET ${endpoint.path}`);
    }
    await dependencies.instrumentation(metadata.infrastructure.localUrls.tempo, config.observability.serviceName, store.id, signal, undefined, metadata.infrastructure.containerOtlpTracesEndpoint, metadata.infrastructure.otlpTracesEndpoint);
    dependencies.write('✓ Telemetry verified');
    await dependencies.runner.prepare(store.directory);
    await store.write('raw/engine.json', { schemaVersion: 1, ...run.engine, scriptSha256: createHash('sha256').update(await readFile(join(store.directory, 'load-test.js'))).digest('hex') });
    run.status = 'running'; await save();
    for (const profile of profiles) {
      checkCancelled(signal);
      profile.status = 'running'; profile.startedAt = new Date().toISOString();
      currentPlan = {
        schemaVersion: 1, runId: store.id, profile: profile.name, baseUrl: config.target.baseUrl,
        endpoints: auditConfig.endpoints, requestHeaderEnv, workload: auditConfig.profiles[profile.name], timeoutMs: auditConfig.timeoutMs,
        summaryFile: join(store.directory, 'raw', `${profile.name}.summary.json`),
      };
      await save();
      dependencies.write(`Running ${profile.name}...`);
      const execution = await dependencies.runner.profile(store.directory, currentPlan, signal, requestHeaders);
      profile.endedAt = new Date().toISOString();
      profile.status = signal.aborted || execution.cancelled ? 'cancelled' : execution.code !== 0 || execution.timedOut ? 'failed' : 'completed';
      await store.write(`raw/${profile.name}.execution.json`, { schemaVersion: 1, code: execution.code, signal: execution.signal, timedOut: execution.timedOut, cancelled: execution.cancelled });
      let summary: unknown = null, samples = null;
      try { summary = JSON.parse(await readFile(currentPlan.summaryFile, 'utf8')); } catch { /* Partial failed/cancelled runs may not produce a summary. */ }
      try { samples = await readSamples(join(store.directory, 'raw', `${profile.name}.samples.ndjson`)); } catch { /* Raw evidence remains available even if interrupted mid-line. */ }
      const result = normalize(summary, currentPlan, profile.startedAt, profile.endedAt, profile.status, samples);
      const evidenceError = completedEvidenceError(summary, samples);
      if (profile.status === 'completed' && evidenceError) {
        profile.status = 'failed'; result.status = 'failed'; profile.error = `k6 produced missing, empty, or inconsistent structured evidence. ${evidenceError}`;
      }
      profile.result = `results/${profile.name}.json`;
      await store.write(profile.result, result);
      await save();
      if (profile.status !== 'completed') throw new CliError(profile.error ?? `${profile.name} ${profile.status}${execution.timedOut ? ' (process deadline exceeded)' : ''}.`, 'Completed profile results and available raw evidence are preserved.', profile.status === 'cancelled' ? 130 : 1);
      dependencies.write(`✓ ${profile.name} complete`);
      currentPlan = undefined;
    }
    checkCancelled(signal);
    run.status = 'completed';
  } catch (error) {
    run.status = signal.aborted || (error instanceof CliError && error.exitCode === 130) ? 'cancelled' : 'failed';
    const message = error instanceof CliError ? `${error.message} ${error.remediation}` : 'Audit execution or evidence storage failed; inspect local logs and filesystem permissions.';
    run.errors.push(message);
    const active = profiles.find(p => p.status === 'running');
    if (active) {
      active.status = run.status; active.endedAt = new Date().toISOString(); active.error = message;
      if (currentPlan) {
        active.result = `results/${active.name}.json`;
        await store.write(active.result, normalize(null, currentPlan, active.startedAt!, active.endedAt, active.status, null));
      }
    }
    const failed = profiles.find(p => ['failed', 'cancelled'].includes(p.status));
    if (failed && !failed.error) failed.error = message;
    throw new CliError(`Audit ${run.status}. ${message}`, `Evidence: ${store.directory}`, run.status === 'cancelled' ? 130 : 1);
  } finally {
    run.endedAt = new Date().toISOString(); metadata.auditEndedAt = run.endedAt;
    await store.write('telemetry/metadata.json', metadata);
    await store.finalize(run);
  }
  return { directory: store.directory, run };
}
