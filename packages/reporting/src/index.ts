export type Severity = 'P0' | 'P1' | 'P2';
export interface ReportProfile {
  name: string;
  startedAt: string | null;
  endedAt: string | null;
  observedDurationMs: number | null;
  workload: { executor: string | null; vus: number | null; durationMs: number | null; configured: Record<string, unknown> };
  metrics: Record<string, unknown>;
}
export interface ReportFinding {
  id: string; ruleId: string; category: string; title: string; summary: string;
  severity: Severity; confidence: 'high' | 'medium' | 'low';
  target: { method: string; path: string }; profiles: string[];
  evidence: { observation: string; source: string; value?: unknown }[];
  metrics: Record<string, unknown>;
}
export type DiagnosticCoverageState = 'available' | 'partial' | 'no-observations' | 'not-collected' | 'not-persisted' | 'unavailable' | 'incomplete' | 'insufficient-evidence';
export interface HttpStatusEvidence {
  profile: string; target: { method: string; path: string; scope?: 'aggregate' };
  requests: number | null; successfulRequests: number | null; failedRequests: number | null; errorRate: number | null; rps: number | null;
  statusDistribution: Record<string, number> | null; statusCount: number | null; statusState: DiagnosticCoverageState; source: string;
}
export interface DiagnosticEvidence {
  schemaVersion: 1;
  httpStatusProfiles: HttpStatusEvidence[];
  coverage: { diagnostic: string; state: DiagnosticCoverageState; observations: number | null; source: string | null; note: string }[];
}
export interface ResourceSample {
  profile: string; timestamp: string; source: 'node-process' | 'docker-container';
  processId: number | null; processInstanceId: string | null;
  cpuPercent: number | null; cpuNormalization: string; hostLogicalCpus: number | null; cpuQuotaCores: number | null; rssBytes: number | null; heapUsedBytes: number | null;
  heapTotalBytes: number | null; externalBytes: number | null; memoryUsedBytes: number | null; memoryLimitBytes: number | null;
  container: string | null;
}
export interface ResourceProfileSummary {
  profile: string;
  process: { state: DiagnosticCoverageState; samples: number; processInstances: number; cpuAveragePercent: number | null; cpuPeakPercent: number | null; rssAverageBytes: number | null; rssPeakBytes: number | null; rssGrowthBytes: number | null; heapUsedAverageBytes: number | null; heapUsedPeakBytes: number | null; heapTotalAverageBytes: number | null; heapTotalPeakBytes: number | null; externalAverageBytes: number | null; externalPeakBytes: number | null };
  container: { state: DiagnosticCoverageState; samples: number; cpuAveragePercent: number | null; cpuPeakPercent: number | null; cpuNormalization: string; hostLogicalCpus: number | null; cpuQuotaCores: number | null; memoryAverageBytes: number | null; memoryPeakBytes: number | null; memoryLimitBytes: number | null; memoryPeakPercentOfLimit: number | null };
}
export interface ResourceDiagnostics {
  schemaVersion: 1; state: DiagnosticCoverageState; processState: DiagnosticCoverageState; containerState: DiagnosticCoverageState;
  samplingIntervalMs: number | null; profiles: ResourceProfileSummary[]; samples: ResourceSample[]; processNote: string; containerNote: string;
}
export interface ReportModel {
  schemaVersion: 1; perflensVersion: string; reportVersion: 4; generatedAt: string;
  run: { id: string; target: string; method: string; path: string; endpoints: { method: string; path: string }[]; startedAt: string; completedAt: string; serviceName: string; loadEngine: { name: string | null; version: string | null } };
  workload: { profiles: ReportProfile[] };
  performanceSummary: { profiles: ReportProfile[] };
  endpointEvidence: { method: string; path: string; requestTraces: number | null; databaseSpans: number | null; externalHttpSpans: number | null }[];
  findingsSummary: { total: number; bySeverity: Record<Severity, number> };
  findings: ReportFinding[];
  evidenceSummary: { requestTraces: number | null; databaseSpans: number | null; externalHttpSpans: number | null; traceAvailable: boolean; snapshotTraceCount: number | null; snapshotSpanCount: number | null; snapshotTruncated: boolean | null; profiles: string[] };
  diagnosticEvidence: DiagnosticEvidence;
  resourceDiagnostics: ResourceDiagnostics;
  limitations: string[];
}

function fail(message: string): never { throw new Error(message); }
function safeText(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '');
  return value
    .replace(/\bPERFLENS_TEST_SECRET_[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:proxy-)?authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\r\n;,]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi, 'Cookie: [REDACTED]')
    .replace(/\b((?:https?|postgres(?:ql)?|redis|rediss):\/\/)([^/\s?#@]*:[^/\s?#@]*@)/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|password|passwd|secret|token|client[_-]?secret|auth(?:orization)?)=)[^&#\s"'<>]*/gi, '$1[REDACTED]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*(['"])[^'"]*\2/gi, '$1=[REDACTED]')
    .replace(/\b(?:select|insert|update|delete)\b[\s\S]*/i, match => match.replace(/'(?:''|[^'])*'|\$[A-Za-z_0-9]*\$[\s\S]*?\$[A-Za-z_0-9]*\$/g, '?'));
}
function sanitize(value: unknown): any {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|cookie|password|secret|token|api[_-]?key|credential|request.?body/i.test(key)) continue;
      result[key] = sanitize(item);
    }
    return result;
  }
  return typeof value === 'string' ? safeText(value) : value;
}
function safeEndpointPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) fail('Analysis contains an invalid target path.');
  return value.split(/[?#]/, 1)[0].replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi, '/:id');
}
function safeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') fail('Audit run target is invalid.');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) fail('Audit run target protocol is unsupported.');
    return `${url.protocol}//${url.host}`;
  } catch { return fail('Audit run target URL is invalid.'); }
}
function finiteOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function validDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`Invalid ${label} in audit artifacts.`);
  return value;
}
function makeProfile(runProfile: any, result: any): ReportProfile {
  if (!result || result.schemaVersion !== 1 || result.status !== 'completed' || result.profile !== runProfile.name || !result.workload || !result.metrics) fail(`Profile evidence for ${String(runProfile?.name)} is missing or unsupported.`);
  const workload = result.workload;
  const metrics = sanitize(result.metrics) as Record<string, unknown>;
  const vus = finiteOrNull(workload.vus);
  const durationMs = finiteOrNull(workload.durationMs);
  const startedAt = typeof runProfile.startedAt === 'string' ? runProfile.startedAt : null;
  const endedAt = typeof runProfile.endedAt === 'string' ? runProfile.endedAt : null;
  return {
    name: safeText(runProfile.name), startedAt, endedAt,
    observedDurationMs: startedAt && endedAt && Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(endedAt)) ? Date.parse(endedAt) - Date.parse(startedAt) : null,
    workload: { executor: typeof workload.executor === 'string' ? safeText(workload.executor) : null, vus, durationMs, configured: sanitize(workload) },
    metrics,
  };
}
const statusCountMap = (value: unknown): Record<string, number> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([status, count]) => !/^(0|[1-9]\d{2})$/.test(status) || !Number.isSafeInteger(count) || (count as number) < 0)) return null;
  return Object.fromEntries(entries.sort(([a], [b]) => Number(a) - Number(b))) as Record<string, number>;
};
function statusEvidenceState(distribution: Record<string, number> | null, requests: number | null): { state: DiagnosticCoverageState; count: number | null } {
  if (!distribution) return { state: 'not-persisted', count: null };
  const count = Object.values(distribution).reduce((total, item) => total + item, 0);
  if (count === 0 && requests === 0) return { state: 'no-observations', count };
  if (count === 0 && requests === null) return { state: 'no-observations', count };
  if (count === 0 || (requests !== null && count !== requests)) return { state: 'incomplete', count };
  return { state: 'available', count };
}
function mean(values: (number | null)[]): number | null { const present = values.filter((value): value is number => value !== null && Number.isFinite(value)); return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null; }
function peak(values: (number | null)[]): number | null { const present = values.filter((value): value is number => value !== null && Number.isFinite(value)); return present.length ? Math.max(...present) : null; }
function buildResourceDiagnostics(raw: any, runId: string, profiles: ReportProfile[]): ResourceDiagnostics {
  const allowed = new Set(profiles.map(profile => profile.name));
  const artifactValid = raw?.schemaVersion === 1 && raw.runId === runId && Array.isArray(raw.processSamples) && Array.isArray(raw.containerSamples);
  const safeSamples: ResourceSample[] = [];
  if (artifactValid) {
    for (const item of raw.processSamples.slice(0, 20000)) {
      if (item?.schemaVersion !== 1 || item.runId !== runId || !allowed.has(item.profile) || typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp)) || !Number.isInteger(item.processId)) continue;
      const number = (key: string) => finiteOrNull(item[key]) !== null && item[key] >= 0 ? item[key] : null;
      const processInstanceId = typeof item.processInstanceId === 'string' && item.processInstanceId.length > 0 && item.processInstanceId.length <= 128 ? item.processInstanceId : null;
      safeSamples.push({ profile: item.profile, timestamp: item.timestamp, source: 'node-process', processId: Number.isInteger(item.processId) ? item.processId : null, processInstanceId, cpuPercent: number('cpuPercentOneLogicalCpu'), cpuNormalization: 'one-logical-CPU', hostLogicalCpus: null, cpuQuotaCores: null, rssBytes: number('rssBytes'), heapUsedBytes: number('heapUsedBytes'), heapTotalBytes: number('heapTotalBytes'), externalBytes: number('externalBytes'), memoryUsedBytes: null, memoryLimitBytes: null, container: null });
    }
    for (const item of raw.containerSamples.slice(0, 20000)) {
      if (item?.schemaVersion !== 1 || item.runId !== runId || !allowed.has(item.profile) || typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp)) || typeof item.container !== 'string') continue;
      const number = (key: string) => finiteOrNull(item[key]) !== null && item[key] >= 0 ? item[key] : null;
      safeSamples.push({ profile: item.profile, timestamp: item.timestamp, source: 'docker-container', processId: null, processInstanceId: null, cpuPercent: number('dockerReportedCpuPercent'), cpuNormalization: 'docker-stats-reported-host-logical-CPU-basis', hostLogicalCpus: number('hostLogicalCpus'), cpuQuotaCores: number('cpuQuotaCores'), rssBytes: null, heapUsedBytes: null, heapTotalBytes: null, externalBytes: null, memoryUsedBytes: number('memoryUsedBytes'), memoryLimitBytes: number('memoryLimitBytes'), container: safeText(item.container) });
    }
  }
  safeSamples.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.source.localeCompare(b.source) || a.profile.localeCompare(b.profile));
  const profilesSummary = profiles.map(profile => {
    const processRows = safeSamples.filter(sample => sample.profile === profile.name && sample.source === 'node-process');
    const containerRows = safeSamples.filter(sample => sample.profile === profile.name && sample.source === 'docker-container');
    const cpuValues = processRows.map(sample => sample.cpuPercent);
    const containerCpuValues = containerRows.map(sample => sample.cpuPercent);
    const processState: DiagnosticCoverageState = !processRows.length ? 'not-collected' : cpuValues.filter(value => value !== null).length >= 2 ? 'available' : 'insufficient-evidence';
    const containerState: DiagnosticCoverageState = !containerRows.length ? 'not-collected' : containerCpuValues.filter(value => value !== null).length >= 2 ? 'available' : 'insufficient-evidence';
    const limits = containerRows.map(sample => sample.memoryLimitBytes).filter((value): value is number => value !== null);
    const memoryLimitRatios = containerRows.flatMap(sample => sample.memoryUsedBytes !== null && sample.memoryLimitBytes !== null && sample.memoryLimitBytes > 0 ? [sample.memoryUsedBytes / sample.memoryLimitBytes * 100] : []);
    const processTimeOrdered = [...processRows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    // New evidence has a per-process-lifetime ID, protecting continuity checks from PID reuse.
    // Historical evidence falls back to PID for counting, but PID alone is not enough to
    // establish continuity because an OS/container may reuse it after a restart.
    const processInstanceKeys = new Set(processRows.map(sample => sample.processInstanceId ?? `pid:${sample.processId}`));
    const hasProcessLifetimeIds = processRows.every(sample => typeof sample.processInstanceId === 'string');
    const sameProcessGrowth = hasProcessLifetimeIds && processInstanceKeys.size === 1 && processTimeOrdered.length >= 2
      ? (processTimeOrdered.at(-1)!.rssBytes !== null && processTimeOrdered[0].rssBytes !== null ? processTimeOrdered.at(-1)!.rssBytes! - processTimeOrdered[0].rssBytes! : null) : null;
    return {
      profile: profile.name,
      process: { state: processState, samples: processRows.length, processInstances: processInstanceKeys.size, cpuAveragePercent: cpuValues.filter(value => value !== null).length >= 2 ? mean(cpuValues) : null, cpuPeakPercent: cpuValues.filter(value => value !== null).length >= 2 ? peak(cpuValues) : null, rssAverageBytes: mean(processRows.map(sample => sample.rssBytes)), rssPeakBytes: peak(processRows.map(sample => sample.rssBytes)), rssGrowthBytes: sameProcessGrowth, heapUsedAverageBytes: mean(processRows.map(sample => sample.heapUsedBytes)), heapUsedPeakBytes: peak(processRows.map(sample => sample.heapUsedBytes)), heapTotalAverageBytes: mean(processRows.map(sample => sample.heapTotalBytes)), heapTotalPeakBytes: peak(processRows.map(sample => sample.heapTotalBytes)), externalAverageBytes: mean(processRows.map(sample => sample.externalBytes)), externalPeakBytes: peak(processRows.map(sample => sample.externalBytes)) },
      container: { state: containerState, samples: containerRows.length, cpuAveragePercent: containerCpuValues.filter(value => value !== null).length >= 2 ? mean(containerCpuValues) : null, cpuPeakPercent: containerCpuValues.filter(value => value !== null).length >= 2 ? peak(containerCpuValues) : null, cpuNormalization: 'Docker reported host-logical-CPU basis; not quota-normalized', hostLogicalCpus: containerRows.map(sample => sample.hostLogicalCpus).find(value => value !== null) ?? null, cpuQuotaCores: containerRows.map(sample => sample.cpuQuotaCores).find(value => value !== null) ?? null, memoryAverageBytes: mean(containerRows.map(sample => sample.memoryUsedBytes)), memoryPeakBytes: peak(containerRows.map(sample => sample.memoryUsedBytes)), memoryLimitBytes: limits.length ? Math.min(...limits) : null, memoryPeakPercentOfLimit: peak(memoryLimitRatios) },
    } as ResourceProfileSummary;
  });
  const processState: DiagnosticCoverageState = safeSamples.some(sample => sample.source === 'node-process') ? (profilesSummary.some(item => item.process.state !== 'available') ? 'partial' : 'available') : artifactValid ? (raw.collection?.process === 'unavailable' ? 'unavailable' : 'not-collected') : 'not-collected';
  const containerState: DiagnosticCoverageState = safeSamples.some(sample => sample.source === 'docker-container') ? (profilesSummary.some(item => item.container.state !== 'available') ? 'partial' : 'available') : artifactValid ? (raw.collection?.container === 'unavailable' ? 'unavailable' : 'not-collected') : 'not-collected';
  const state = processState === 'available' && containerState === 'available' ? 'available' : processState === 'not-collected' && containerState === 'not-collected' ? 'not-collected' : 'partial';
  const resourceState = (key: 'process' | 'container', metric: 'cpu' | 'memory'): DiagnosticCoverageState => {
    const rows = safeSamples.filter(sample => sample.source === (key === 'process' ? 'node-process' : 'docker-container'));
    const values = metric === 'cpu' ? rows.filter(sample => sample.cpuPercent !== null) : rows.filter(sample => (key === 'process' ? sample.rssBytes : sample.memoryUsedBytes) !== null);
    const sourceState = key === 'process' ? processState : containerState;
    if (!rows.length) return sourceState;
    if (metric === 'cpu' && values.length < 2) return 'insufficient-evidence';
    return values.length ? 'available' : 'unavailable';
  };
  return { schemaVersion: 1, state, processState, containerState, samplingIntervalMs: artifactValid ? finiteOrNull(raw.samplingIntervalMs) : null, profiles: profilesSummary, samples: safeSamples, processNote: artifactValid ? safeText(raw.collection?.processNote ?? '') : 'Resource samples were not persisted for this historical run.', containerNote: artifactValid ? safeText(raw.collection?.containerNote ?? '') : 'Resource samples were not persisted for this historical run.' };
}
function buildDiagnosticEvidence(profiles: ReportProfile[], endpoints: { method: string; path: string }[], evidence: any, analysis: any, resources: ResourceDiagnostics): DiagnosticEvidence {
  const httpStatusProfiles: HttpStatusEvidence[] = [];
  for (const profile of profiles) {
    const metrics = profile.metrics as Record<string, any>;
    const endpointResults = Array.isArray(metrics.endpointResults) ? metrics.endpointResults : [];
    const endpointScoped = endpoints.map(target => endpointResults.find(item => item?.target?.method === target.method && typeof item?.target?.path === 'string' && safeEndpointPath(item.target.path) === target.path)).filter(Boolean);
    if (endpointScoped.length === endpoints.length && endpointScoped.length > 0) {
      for (let index = 0; index < endpoints.length; index++) {
        const result = endpointScoped[index];
        const m = result.metrics && typeof result.metrics === 'object' ? result.metrics : {};
        const requests = finiteOrNull(m.requests);
        const distribution = statusCountMap(m.statusDistribution);
        const state = statusEvidenceState(distribution, requests);
        httpStatusProfiles.push({ profile: profile.name, target: endpoints[index], requests, successfulRequests: finiteOrNull(m.successfulRequests), failedRequests: finiteOrNull(m.failedRequests), errorRate: finiteOrNull(m.errorRate), rps: finiteOrNull(m.rps), statusDistribution: distribution, statusCount: state.count, statusState: state.state, source: `results/${profile.name}.json` });
      }
    } else {
      const requests = finiteOrNull(metrics.requests);
      const distribution = statusCountMap(metrics.statusDistribution);
      const state = statusEvidenceState(distribution, requests);
      const singleTarget = endpoints.length === 1;
      const target = singleTarget ? endpoints[0] : { method: 'GET', path: 'All configured endpoints (aggregate)', scope: 'aggregate' as const };
      httpStatusProfiles.push({ profile: profile.name, target, requests, successfulRequests: finiteOrNull(metrics.successfulRequests), failedRequests: finiteOrNull(metrics.failedRequests), errorRate: finiteOrNull(metrics.errorRate), rps: finiteOrNull(metrics.rps), statusDistribution: distribution, statusCount: state.count, statusState: state.state, source: `results/${profile.name}.json` });
    }
  }
  const statusRows = httpStatusProfiles;
  const statusState: DiagnosticCoverageState = statusRows.length === 0 || statusRows.every(row => row.statusState === 'not-persisted') ? 'not-persisted'
    : statusRows.every(row => row.statusState === 'available') ? 'available'
      : statusRows.every(row => row.statusState === 'no-observations') ? 'no-observations'
        : statusRows.some(row => row.statusState === 'available' || row.statusState === 'no-observations') ? 'partial' : 'incomplete';
  const endpointMeasurementsComplete = profiles.length > 0 && profiles.every(profile => {
    const results = (profile.metrics as any).endpointResults;
    return Array.isArray(results) && endpoints.every(target => results.some((item: any) => item?.target?.method === target.method && item?.target?.path === target.path));
  });
  const traceAvailable = Boolean(analysis.availability?.traces);
  const traces = traceAvailable ? finiteOrNull(analysis.traceSummary?.requests) : null;
  const db = traceAvailable ? finiteOrNull(analysis.traceSummary?.databaseSpans) : null;
  const external = traceAvailable ? finiteOrNull(analysis.traceSummary?.externalClientSpans) : null;
  const redisSpans = traceAvailable && Array.isArray(evidence.traces) ? evidence.traces.filter((span: any) => String(span.attributes?.['db.system'] ?? '').toLowerCase() === 'redis').length : null;
  const observedState = (count: number | null): DiagnosticCoverageState => count === null ? 'unavailable' : count > 0 ? 'available' : 'no-observations';
  const coverage: DiagnosticEvidence['coverage'] = [
    { diagnostic: 'HTTP status distribution', state: statusState, observations: statusRows.some(row => row.statusCount !== null) ? statusRows.reduce((total, row) => total + (row.statusCount ?? 0), 0) : null, source: statusRows.length ? 'results/<profile>.json' : null, note: statusState === 'not-persisted' ? 'This run does not contain persisted status counts.' : statusState === 'incomplete' || statusState === 'partial' ? 'Some profile or endpoint status counts are missing or do not match request totals.' : 'Counts come from k6 HTTP response samples; status 0 represents a transport failure.' },
    { diagnostic: 'Endpoint request measurements', state: endpointMeasurementsComplete ? 'available' : profiles.length && profiles.every(profile => Array.isArray((profile.metrics as any).endpointResults)) ? 'partial' : 'not-persisted', observations: endpointMeasurementsComplete ? profiles.length * endpoints.length : null, source: 'results/<profile>.json', note: endpointMeasurementsComplete ? 'Counts, status distributions, and latency percentiles are scoped to each endpoint/profile.' : 'Some older runs contain only profile-aggregate measurements; aggregate values are not assigned to individual endpoints.' },
    { diagnostic: 'Correlated request spans', state: observedState(traces), observations: traces, source: 'analysis/evidence.json', note: traces === null ? 'Trace evidence was unavailable for analysis.' : traces > 0 ? 'Run/profile-correlated server spans were persisted.' : 'No correlated request spans were observed in the persisted snapshot.' },
    { diagnostic: 'PostgreSQL operation spans', state: observedState(db), observations: db, source: 'analysis/evidence.json', note: db === null ? 'Trace evidence was unavailable.' : db > 0 ? 'PostgreSQL spans were observed in correlated traces.' : 'No PostgreSQL spans were observed; this does not establish whether the endpoint used a database.' },
    { diagnostic: 'External HTTP spans', state: observedState(external), observations: external, source: 'analysis/evidence.json', note: external === null ? 'Trace evidence was unavailable.' : external > 0 ? 'External HTTP client spans were observed in correlated traces.' : 'No external HTTP spans were observed in the persisted snapshot.' },
    { diagnostic: 'Redis operation spans', state: redisSpans === null ? 'unavailable' : redisSpans > 0 ? 'available' : 'no-observations', observations: redisSpans, source: traceAvailable ? 'analysis/evidence.json' : null, note: redisSpans === null ? 'Trace evidence was unavailable.' : redisSpans > 0 ? 'Spans with db.system=redis were found; they are not analyzed by current Phase 3 rules.' : 'No spans declaring db.system=redis were found; PerfLens does not infer that Redis was not used.' },
    { diagnostic: 'Node process CPU', state: resourceStateFor(resources, 'node-process', 'cpu'), observations: resources.samples.filter(sample => sample.source === 'node-process' && sample.cpuPercent !== null).length || null, source: 'resources/evidence.json', note: resources.processNote || 'Process CPU is normalized to one logical CPU, not host-wide utilization.' },
    { diagnostic: 'Node process memory / heap', state: resourceStateFor(resources, 'node-process', 'memory'), observations: resources.samples.filter(sample => sample.source === 'node-process' && sample.rssBytes !== null).length || null, source: 'resources/evidence.json', note: resources.processNote || 'RSS, heap, and external memory are Node process measurements.' },
    { diagnostic: 'Docker container CPU', state: resourceStateFor(resources, 'docker-container', 'cpu'), observations: resources.samples.filter(sample => sample.source === 'docker-container' && sample.cpuPercent !== null).length || null, source: 'resources/evidence.json', note: resources.containerNote || 'Docker stats CPU is reported on its host logical CPU basis; it is not compared directly with process CPU.' },
    { diagnostic: 'Docker container memory', state: resourceStateFor(resources, 'docker-container', 'memory'), observations: resources.samples.filter(sample => sample.source === 'docker-container' && sample.memoryUsedBytes !== null).length || null, source: 'resources/evidence.json', note: resources.containerNote || 'Memory limit is shown only when Docker reports a configured limit.' },
    { diagnostic: 'Connection-pool metrics', state: 'not-collected', observations: null, source: null, note: 'Pool metrics are not part of the persisted audit evidence.' },
  ];
  return { schemaVersion: 1, httpStatusProfiles, coverage };
}
function resourceStateFor(resources: ResourceDiagnostics, source: ResourceSample['source'], metric: 'cpu' | 'memory'): DiagnosticCoverageState {
  const rows = resources.samples.filter(sample => sample.source === source);
  if (!rows.length) return source === 'node-process' ? resources.processState : resources.containerState;
  const valid = rows.filter(sample => metric === 'cpu' ? sample.cpuPercent !== null : source === 'node-process' ? sample.rssBytes !== null : sample.memoryUsedBytes !== null);
  if (metric === 'cpu' && valid.length < 2) return 'insufficient-evidence';
  return !valid.length ? 'unavailable' : metric === 'cpu' && valid.length < 2 ? 'insufficient-evidence' : 'available';
}
function validFinding(raw: any, target: { method: string; path: string }): ReportFinding {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.ruleId !== 'string' || typeof raw.category !== 'string' || typeof raw.title !== 'string' || typeof raw.summary !== 'string' || !['P0', 'P1', 'P2'].includes(raw.severity) || !['high', 'medium', 'low'].includes(raw.confidence) || !Array.isArray(raw.profiles) || !Array.isArray(raw.evidence) || !raw.metrics || typeof raw.metrics !== 'object') fail('Analysis findings artifact is malformed or unsupported.');
  const sanitized = sanitize(raw);
  const findingTarget = raw.target && typeof raw.target.method === 'string' && typeof raw.target.path === 'string'
    ? { method: safeText(raw.target.method), path: safeEndpointPath(raw.target.path) } : target;
  return {
    id: safeText(sanitized.id), ruleId: safeText(sanitized.ruleId), category: safeText(sanitized.category),
    title: safeText(sanitized.title), summary: safeText(sanitized.summary), severity: raw.severity,
    confidence: raw.confidence, target: findingTarget, profiles: raw.profiles.map(safeText).sort(),
    evidence: raw.evidence.map((item: any) => {
      if (!item || typeof item.observation !== 'string' || typeof item.source !== 'string') fail('Analysis evidence entry is malformed.');
      return { observation: safeText(item.observation), source: safeText(item.source), ...(item.value === undefined ? {} : { value: sanitize(item.value) }) };
    }), metrics: sanitize(raw.metrics),
  };
}

export function buildReportModel(input: { run: any; profiles: { runProfile: any; result: any }[]; analysis: any; findingsArtifact: any; evidence: any; resources?: any; generatedAt?: string; perflensVersion?: string }): ReportModel {
  const { run, analysis, findingsArtifact, evidence } = input;
  if (!run || run.schemaVersion !== 1 || run.status !== 'completed' || typeof run.runId !== 'string' || !Array.isArray(run.profiles)) fail('Only completed schema version 1 audit runs can be reported.');
  if (!analysis || analysis.schemaVersion !== 1 || analysis.runId !== run.runId || !Array.isArray(analysis.findings) || !analysis.traceSummary || !analysis.availability) fail('Analysis artifact is malformed or unsupported.');
  if (!findingsArtifact || findingsArtifact.schemaVersion !== 1 || findingsArtifact.runId !== run.runId || !Array.isArray(findingsArtifact.findings)) fail('Findings artifact is malformed or unsupported.');
  if (JSON.stringify(analysis.findings) !== JSON.stringify(findingsArtifact.findings)) fail('Analysis and findings artifacts disagree; refusing to generate a misleading report.');
  if (!evidence || evidence.schemaVersion !== 1 || evidence.runId !== run.runId || !Array.isArray(evidence.traces) || !evidence.telemetry) fail('Analysis evidence snapshot is malformed or unsupported.');
  const endpoints = input.profiles[0]?.result?.target?.endpoints ?? [];
  const first = endpoints[0];
  if (!first || typeof first.method !== 'string') fail('Audit run does not contain a supported endpoint target.');
  const safeEndpoints = endpoints.map((endpoint: any) => {
    if (!endpoint || typeof endpoint.method !== 'string') fail('Audit run contains an invalid endpoint target.');
    return { method: safeText(endpoint.method.toUpperCase()), path: safeEndpointPath(endpoint.path) };
  });
  const target = safeEndpoints[0];
  const endpointKey = (items: any[]) => JSON.stringify(items.map(item => `${String(item.method).toUpperCase()} ${safeEndpointPath(item.path)}`).sort());
  const expectedEndpoints = endpointKey(endpoints);
  if (input.profiles.some(item => !Array.isArray(item.result?.target?.endpoints) || endpointKey(item.result.target.endpoints) !== expectedEndpoints)) fail('Audit profile endpoint sets differ; report model does not currently support mixed targets.');
  const profiles = input.profiles.map(item => makeProfile(item.runProfile, item.result));
  const resourceDiagnostics = buildResourceDiagnostics(input.resources, run.runId, profiles);
  const endpointEvidence = safeEndpoints.map((endpoint: { method: string; path: string }) => {
    if (!analysis.availability.traces) return { ...endpoint, requestTraces: null, databaseSpans: null, externalHttpSpans: null };
    const roots = evidence.traces.filter((span: any) => span.kind === 'server'
      && span.attributes?.['perflens.audit.run_id'] === run.runId
      && span.attributes?.['http.route'] === endpoint.path);
    const traceIds = new Set(roots.map((span: any) => span.traceId));
    const scoped = evidence.traces.filter((span: any) => traceIds.has(span.traceId));
    const isDatabase = (span: any) => span.kind !== 'server'
      && (typeof span.attributes?.['db.system'] === 'string'
        || typeof span.attributes?.['db.namespace'] === 'string'
        || (typeof span.name === 'string' && span.name.startsWith('pg.query:')));
    const databaseSpans = scoped.filter(isDatabase);
    const externalHttpSpans = scoped.filter((span: any) => span.kind === 'client' && !isDatabase(span)
      && (typeof span.attributes?.['http.request.method'] === 'string'
        || typeof span.attributes?.['http.method'] === 'string'
        || typeof span.attributes?.['url.sanitized'] === 'string'));
    return { ...endpoint, requestTraces: traceIds.size, databaseSpans: databaseSpans.length, externalHttpSpans: externalHttpSpans.length };
  });
  const findings = findingsArtifact.findings.map((finding: any) => validFinding(finding, target)).sort((a: ReportFinding, b: ReportFinding) => ['P0', 'P1', 'P2'].indexOf(a.severity) - ['P0', 'P1', 'P2'].indexOf(b.severity) || a.ruleId.localeCompare(b.ruleId) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const bySeverity: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const finding of findings as ReportFinding[]) bySeverity[finding.severity]++;
  const hasResourceSamples = resourceDiagnostics.samples.length > 0;
  const limitations = [...new Set([...(Array.isArray(analysis.unsupported) ? analysis.unsupported.map(safeText).map((item: string) => hasResourceSamples && /CPU and memory saturation:/.test(item) ? 'CPU/memory measurements are available, but no Phase 3 resource pressure rules are implemented.' : item) : []), ...(analysis.availability.traces ? [] : ['Trace evidence was unavailable for this analysis.']), 'This report contains only configured audit targets and does not represent untested production traffic.'])].sort();
  return {
    schemaVersion: 1, perflensVersion: safeText(input.perflensVersion ?? 'unknown'), reportVersion: 4, generatedAt: validDate(input.generatedAt ?? new Date().toISOString(), 'report generation timestamp'),
    run: { id: run.runId, target: safeBaseUrl(run.target?.baseUrl), method: target.method, path: target.path, endpoints: safeEndpoints, startedAt: validDate(run.startedAt, 'audit start time'), completedAt: validDate(run.endedAt, 'audit completion time'), serviceName: safeText(run.serviceName ?? analysis.target?.serviceName ?? 'unknown'), loadEngine: { name: typeof run.engine?.name === 'string' ? safeText(run.engine.name) : null, version: typeof run.engine?.version === 'string' ? safeText(run.engine.version) : null } },
    workload: { profiles }, performanceSummary: { profiles }, endpointEvidence,
    findingsSummary: { total: findings.length, bySeverity }, findings,
    evidenceSummary: { requestTraces: finiteOrNull(analysis.traceSummary.requests), databaseSpans: finiteOrNull(analysis.traceSummary.databaseSpans), externalHttpSpans: finiteOrNull(analysis.traceSummary.externalClientSpans), traceAvailable: Boolean(analysis.availability.traces), snapshotTraceCount: finiteOrNull(evidence.telemetry.traceCount), snapshotSpanCount: finiteOrNull(evidence.telemetry.spanCount), snapshotTruncated: typeof evidence.telemetry.truncated === 'boolean' ? evidence.telemetry.truncated : null, profiles: profiles.map(profile => profile.name) },
    diagnosticEvidence: buildDiagnosticEvidence(profiles, safeEndpoints, evidence, analysis, resourceDiagnostics),
    resourceDiagnostics, limitations,
  };
}

const escHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escMd = (text: string) => safeText(text).replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#!|])/g, '\\$1').replace(/\r?\n/g, ' ');
const value = (data: unknown): string => data === null || data === undefined ? 'Not available' : typeof data === 'number' ? String(data) : typeof data === 'object' ? JSON.stringify(data) : String(data);
const metric = (metrics: Record<string, any>, key: string) => metrics[key] === null || metrics[key] === undefined ? 'Not available' : String(metrics[key]);
const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'Not available';
const HTTP_STATUS_TITLES: Record<string, string> = {
  '0': 'Transport error (no HTTP status)', '200': 'OK', '201': 'Created', '202': 'Accepted', '204': 'No Content',
  '301': 'Moved Permanently', '302': 'Found', '304': 'Not Modified', '400': 'Bad Request', '401': 'Unauthorized',
  '403': 'Forbidden', '404': 'Not Found', '408': 'Request Timeout', '409': 'Conflict', '422': 'Unprocessable Content',
  '429': 'Too Many Requests', '500': 'Internal Server Error', '501': 'Not Implemented', '502': 'Bad Gateway',
  '503': 'Service Unavailable', '504': 'Gateway Timeout',
};
const httpStatusText = (status: string) => status === '0' ? HTTP_STATUS_TITLES[status] : `${status} ${HTTP_STATUS_TITLES[status] ?? 'HTTP response'}`;
const coverageText = (state: DiagnosticCoverageState) => ({ available: 'Available', partial: 'Partial', 'no-observations': 'No observations', 'not-collected': 'Not collected', 'not-persisted': 'Not persisted', unavailable: 'Unavailable', incomplete: 'Incomplete', 'insufficient-evidence': 'Insufficient evidence' })[state];
const formattedNumber = (input: unknown, digits = 2): string => {
  if (typeof input === 'number') return Number.isFinite(input) ? input.toFixed(digits) : 'Not available';
  return input === null || input === undefined ? 'Not available' : value(input);
};
const formattedMetric = (metrics: Record<string, any>, key: string, digits = 2) => formattedNumber(metrics[key], digits);
const latencyMetric = (input: unknown) => `${formattedNumber(input)} ms`;
const supportingMetricRows = (metrics: Record<string, unknown>) => {
  const definitions: { before: string; after: string; label: string; format: (input: unknown) => string }[] = [
    { before: 'vusBefore', after: 'vusAfter', label: 'VUs', format: input => formattedNumber(input, 0) },
    { before: 'errorRateBefore', after: 'errorRateAfter', label: 'Error rate', format: percent },
    ...(['p50', 'p90', 'p95', 'p99', 'min', 'max'] as const).map(key => ({ before: `${key}BeforeMs`, after: `${key}AfterMs`, label: key, format: latencyMetric })),
    { before: 'rpsBefore', after: 'rpsAfter', label: 'RPS', format: input => formattedNumber(input) },
  ];
  const recognized = definitions.filter(item => Object.hasOwn(metrics, item.before) || Object.hasOwn(metrics, item.after));
  const consumed = new Set(recognized.flatMap(item => [item.before, item.after]));
  const additional = Object.fromEntries(Object.entries(metrics).filter(([key]) => !consumed.has(key)));
  return { recognized, additional };
};
const renderSupportingHtml = (metrics: Record<string, unknown>, h: (input: unknown) => string) => {
  const { recognized, additional } = supportingMetricRows(metrics);
  const table = recognized.length ? `<div class="table-wrap"><table class="supporting-measurements"><thead><tr><th>Metric</th><th>Baseline</th><th>Normal</th></tr></thead><tbody>${recognized.map(item => `<tr><th scope="row">${h(item.label)}</th><td>${h(item.format(metrics[item.before]))}</td><td>${h(item.format(metrics[item.after]))}</td></tr>`).join('')}</tbody></table></div>` : '';
  const fallback = Object.keys(additional).length ? `<details class="additional-measurements"><summary>Additional measurements</summary><pre>${h(JSON.stringify(additional, null, 2))}</pre></details>` : '';
  return table || fallback ? `${table}${fallback}` : '<p class="subtle">No supporting measurements were recorded.</p>';
};
const renderSupportingMarkdown = (metrics: Record<string, unknown>) => {
  const { recognized, additional } = supportingMetricRows(metrics);
  const table = recognized.length ? ['| Metric | Baseline | Normal |', '|---|---:|---:|', ...recognized.map(item => `| ${escMd(item.label)} | ${escMd(item.format(metrics[item.before]))} | ${escMd(item.format(metrics[item.after]))} |`)].join('\n') : '';
  const fallback = Object.keys(additional).length ? `Additional measurements: \`${escMd(JSON.stringify(additional))}\`` : '';
  return [table, fallback].filter(Boolean).join('\n\n') || 'No supporting measurements were recorded.';
};
const mebibytes = (bytes: number | null) => bytes === null ? 'Not available' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const mebibyteDelta = (bytes: number | null) => bytes === null ? 'Not available' : `${bytes >= 0 ? '+' : ''}${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const rssWindowChange = (process: ResourceProfileSummary['process']) => process.rssGrowthBytes !== null
  ? mebibyteDelta(process.rssGrowthBytes)
  : process.samples < 2 ? 'Insufficient samples' : process.processInstances > 1 ? `Unavailable (${process.processInstances} process instances)` : 'Unavailable (process continuity not established)';
function resourceSeriesChart(model: ReportModel, title: string, source: ResourceSample['source'], metrics: { label: string; get: (sample: ResourceSample) => number | null }[]): string {
  const colors = ['#316cb5', '#d66b3d', '#29836f', '#8157a7', '#ae3f63', '#547f2f', '#805c36', '#3b7482'];
  const series = model.resourceDiagnostics.profiles.flatMap((profile, profileIndex) => {
    const profileSamples = model.resourceDiagnostics.samples.filter(sample => sample.source === source && sample.profile === profile.profile);
    const groups = source === 'node-process'
      ? [...new Set(profileSamples.map(sample => sample.processInstanceId ?? `pid:${sample.processId}`))].sort()
      : [...new Set(profileSamples.map(sample => sample.container ?? 'container'))].sort();
    return metrics.flatMap((metric, metricIndex) => groups.map((group, groupIndex) => {
      const groupedSamples = profileSamples.filter(sample => source === 'node-process'
        ? (sample.processInstanceId ?? `pid:${sample.processId}`) === group
        : (sample.container ?? 'container') === group);
      const processId = groupedSamples.find(sample => sample.processId !== null)?.processId;
      const groupLabel = source === 'node-process'
        ? `process ${groupIndex + 1}${processId === undefined ? '' : ` (PID ${processId})`}`
        : group;
      return {
        label: `${profile.profile} ${metric.label} · ${groupLabel}`,
        color: colors[(profileIndex * metrics.length + metricIndex + groupIndex) % colors.length],
        points: groupedSamples.flatMap(sample => { const value = metric.get(sample); return value === null ? [] : [{ time: Date.parse(sample.timestamp), value }]; })
          .sort((a, b) => a.time - b.time),
      };
    }));
  }).filter(item => item.points.length >= 2);
  if (!series.length) return `<p class="subtle">${escHtml(title)}: not enough valid time samples to draw a chart. See the numerical profile summary and coverage below.</p>`;
  const times = series.flatMap(item => item.points.map(point => point.time));
  const values = series.flatMap(item => item.points.map(point => point.value));
  const minTime = Math.min(...times), maxTime = Math.max(...times), maxValue = Math.max(...values, 1);
  const left = 54, top = 18, width = 820, height = 190;
  const lines = series.map(item => {
    const points = item.points.map(point => `${left + (maxTime === minTime ? 0 : (point.time - minTime) / (maxTime - minTime) * width)},${top + height - point.value / maxValue * height}`).join(' ');
    return `<polyline fill="none" stroke="${item.color}" stroke-width="2.5" points="${points}"/>`;
  }).join('');
  const legend = series.map(item => `<li><span class="chart-swatch" style="background:${item.color}" aria-hidden="true"></span><span>${escHtml(item.label)}</span></li>`).join('');
  const clock = (time: number) => new Date(time).toISOString().slice(11, 19) + ' UTC';
  return `<figure class="resource-chart"><figcaption>${escHtml(title)}</figcaption><div class="svg-wrap"><svg viewBox="0 0 900 ${top + height + 34}" role="img" aria-label="${escHtml(title)} plotted against elapsed sample time"><line x1="${left}" y1="${top}" x2="${left}" y2="${top + height}" stroke="#9aa7b5"/><line x1="${left}" y1="${top + height}" x2="${left + width}" y2="${top + height}" stroke="#9aa7b5"/><text x="2" y="${top + 10}" class="axis-label">${maxValue.toFixed(1)}</text><text x="${left}" y="${top + height + 12}" class="axis-label">UTC ${clock(minTime)} – ${clock(maxTime)}</text>${lines}</svg></div><ul class="chart-legend">${legend}</ul></figure>`;
}
function allRequestsFailed(model: ReportModel): boolean {
  let requests = 0, successful = 0, failed = 0;
  for (const profile of model.performanceSummary.profiles) {
    const metrics = profile.metrics as Record<string, unknown>;
    const profileRequests = metrics.requests, profileSuccessful = metrics.successfulRequests, profileFailed = metrics.failedRequests;
    if (![profileRequests, profileSuccessful, profileFailed].every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0)) return false;
    requests += profileRequests as number;
    successful += profileSuccessful as number;
    failed += profileFailed as number;
  }
  return requests > 0 && successful === 0 && failed === requests;
}
const inconclusiveAssessment = 'Performance assessment inconclusive — all measured requests failed.';
const inconclusiveGuidance = 'No successful-response latency baseline is available. Check endpoint behavior, HTTP status, request timeouts, authentication requirements, and whether the route is a long-lived stream. Standard finite load profiles are intended for finite, safe GET endpoints.';

export function renderMarkdown(model: ReportModel): string {
  const lines = ['# PerfLens Backend Performance Audit', '', `**Run:** ${escMd(model.run.id)}  `, `**Target:** ${escMd(model.run.target)}  `, `**Endpoint:** ${escMd(model.run.method)} ${escMd(model.run.path)}  `, `**Audit period:** ${escMd(model.run.startedAt)} – ${escMd(model.run.completedAt)}  `, `**Generated:** ${escMd(model.generatedAt)} · PerfLens ${escMd(model.perflensVersion)} · Report version ${model.reportVersion}`, '', '## Executive summary', ''];
  if (allRequestsFailed(model)) {
    lines.push(`**${inconclusiveAssessment}**`, '', `Audit execution completed and the measured evidence is preserved. ${inconclusiveGuidance}`, '', model.findings.length ? `Phase 3 recorded ${model.findings.length} evidence-backed finding(s); see the detailed findings below.` : 'Failed requests alone do not establish a backend root cause.');
  } else lines.push(model.findings.length ? `${model.findings.length} evidence-backed finding${model.findings.length === 1 ? '' : 's'} were identified: ${model.findingsSummary.bySeverity.P0} P0, ${model.findingsSummary.bySeverity.P1} P1, and ${model.findingsSummary.bySeverity.P2} P2.` : 'No evidence-backed performance bottleneck met the configured detection thresholds for this audit run.');
  lines.push('', '## Test scope', '', `Target service: ${escMd(model.run.serviceName)}. Load engine: ${escMd(model.run.loadEngine.name ?? 'Not available')} ${escMd(model.run.loadEngine.version ?? '')}. Configured endpoints: ${model.run.endpoints.map(endpoint => `${escMd(endpoint.method)} ${escMd(endpoint.path)}`).join(', ')}.`, '', '## Performance summary', '', '| Profile | Configured VUs | Configured duration (ms) | Observed duration (ms) | Max observed in-flight | Requests | Successful | Failed | Error rate | RPS | min (ms) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | max (ms) |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const profile of model.performanceSummary.profiles) {
    const metrics: any = profile.metrics; const latency: any = metrics.latencyMs ?? {};
    lines.push(`| ${escMd(profile.name)} | ${value(profile.workload.vus)} | ${value(profile.workload.durationMs)} | ${value(profile.observedDurationMs)} | ${value(metrics.concurrency?.maxObservedInFlight)} | ${metric(metrics, 'requests')} | ${metric(metrics, 'successfulRequests')} | ${metric(metrics, 'failedRequests')} | ${percent(metrics.errorRate)} | ${formattedMetric(metrics, 'rps')} | ${formattedNumber(latency.min)} | ${formattedNumber(latency.p50)} | ${formattedNumber(latency.p90)} | ${formattedNumber(latency.p95)} | ${formattedNumber(latency.p99)} | ${formattedNumber(latency.max)} |`);
  }
  lines.push('', '## HTTP response status diagnostics', '', '| Profile | Endpoint | Requests | Successful | Failed | Error rate | RPS | HTTP statuses | Coverage |', '|---|---|---:|---:|---:|---:|---:|---|---|');
  for (const status of model.diagnosticEvidence.httpStatusProfiles) {
    const targetName = status.target.scope === 'aggregate' ? status.target.path : `${status.target.method} ${status.target.path}`;
    const distribution = status.statusDistribution === null ? 'Not persisted' : Object.entries(status.statusDistribution).map(([code, count]) => `${httpStatusText(code)}: ${count}`).join('; ') || 'No status observations';
    const recorded = status.statusCount === null ? '' : ` (${status.statusCount}${status.requests === null ? '' : ` of ${status.requests}`} recorded)`;
    lines.push(`| ${escMd(status.profile)} | ${escMd(targetName)} | ${value(status.requests)} | ${value(status.successfulRequests)} | ${value(status.failedRequests)} | ${percent(status.errorRate)} | ${formattedNumber(status.rps)} | ${escMd(distribution)} | ${coverageText(status.statusState)}${recorded} |`);
  }
  const has429 = model.diagnosticEvidence.httpStatusProfiles.some(item => (item.statusDistribution?.['429'] ?? 0) > 0);
  if (has429) lines.push('', 'HTTP 429 responses indicate that requests were rejected as too frequent. Possible sources include application rate limiting, an API gateway, or upstream throttling. The responsible component has not been identified.');
  lines.push('', '## CPU & memory diagnostics', '', 'Process CPU, RSS, and heap summaries are arithmetic averages and maxima of individual process samples; they are not summed service totals. Distinct process instances can be workers or restarts, and PID evidence alone does not establish their role. Process CPU is normalized to one logical CPU; Docker CPU uses the Docker-reported host logical CPU basis and is not quota-normalized.', '', '| Profile | Process sample CPU avg / peak | Process instances | RSS sample avg / per-process peak | RSS window change | Heap sample avg / peak | External memory peak | Container CPU avg / peak | Container memory avg / peak | Configured limit | Peak of limit |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const item of model.resourceDiagnostics.profiles) lines.push(`| ${escMd(item.profile)} | ${item.process.cpuAveragePercent === null ? 'Insufficient evidence' : `${formattedNumber(item.process.cpuAveragePercent)}% / ${formattedNumber(item.process.cpuPeakPercent)}%`} | ${item.process.processInstances || 'Not available'} | ${mebibytes(item.process.rssAverageBytes)} / ${mebibytes(item.process.rssPeakBytes)} | ${rssWindowChange(item.process)} | ${mebibytes(item.process.heapUsedAverageBytes)} / ${mebibytes(item.process.heapUsedPeakBytes)} | ${mebibytes(item.process.externalPeakBytes)} | ${item.container.cpuAveragePercent === null ? 'Insufficient evidence' : `${formattedNumber(item.container.cpuAveragePercent)}% / ${formattedNumber(item.container.cpuPeakPercent)}%`} (Docker stats basis; ${item.container.cpuQuotaCores === null ? 'quota unavailable' : `${formattedNumber(item.container.cpuQuotaCores)} quota cores`}) | ${mebibytes(item.container.memoryAverageBytes)} / ${mebibytes(item.container.memoryPeakBytes)} | ${mebibytes(item.container.memoryLimitBytes)} | ${percent(item.container.memoryPeakPercentOfLimit === null ? null : item.container.memoryPeakPercentOfLimit / 100)} |`);
  lines.push('', 'RSS window change is only available when samples establish one continuous process instance; it is a measured first-to-last difference, not a memory-leak diagnosis.', '', `Process resource coverage: ${coverageText(model.resourceDiagnostics.processState)}. ${escMd(model.resourceDiagnostics.processNote)}`, `Container resource coverage: ${coverageText(model.resourceDiagnostics.containerState)}. ${escMd(model.resourceDiagnostics.containerNote)}`);
  if (model.run.endpoints.length > 1) {
    lines.push('', '## Endpoint comparison', '', '| Profile | Endpoint | Requests | RPS | Error rate | p50 (ms) | p95 (ms) | p99 (ms) | Request traces | PostgreSQL spans | External HTTP spans | Findings |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const profile of model.performanceSummary.profiles) for (const endpoint of (profile.metrics as any).endpointResults ?? []) {
      const target = endpoint.target, m = endpoint.metrics ?? {}, l = m.latencyMs ?? {};
      const related = model.findings.filter(finding => finding.target.method === target.method && finding.target.path === target.path).map(finding => `${finding.severity} ${finding.title}`);
      const traceEvidence = model.endpointEvidence.find(item => item.method === target.method && item.path === target.path);
      lines.push(`| ${escMd(profile.name)} | ${escMd(target.method)} ${escMd(target.path)} | ${value(m.requests)} | ${formattedMetric(m, 'rps')} | ${percent(m.errorRate)} | ${formattedNumber(l.p50)} | ${formattedNumber(l.p95)} | ${formattedNumber(l.p99)} | ${value(traceEvidence?.requestTraces)} | ${value(traceEvidence?.databaseSpans)} | ${value(traceEvidence?.externalHttpSpans)} | ${related.length ? related.map(escMd).join('; ') : 'None'} |`);
    }
  }
  lines.push('', 'Configured workload values describe the test setup; the remaining columns describe observed results.', '', '## Findings summary', '');
  if (!model.findings.length) lines.push('No findings were recorded by Phase 3.');
  else for (const severity of ['P0', 'P1', 'P2'] as const) {
    const group = model.findings.filter(finding => finding.severity === severity); if (!group.length) continue;
    lines.push(`### ${severity}`, '');
    for (const finding of group) lines.push(`- **${escMd(finding.title)}** (${escMd(finding.category)}; ${escMd(finding.ruleId)}; confidence: ${finding.confidence.toUpperCase()}) — ${escMd(finding.summary)}`);
    lines.push('');
  }
  lines.push('## Detailed findings', '');
  if (!model.findings.length) lines.push('There are no Phase 3 findings to detail.', '');
  for (const finding of model.findings) {
    lines.push(`### ${escMd(finding.severity)} — ${escMd(finding.title)}`, '', `**Category:** ${escMd(finding.category)} · **Rule:** \`${escMd(finding.ruleId)}\` · **Confidence:** ${finding.confidence.toUpperCase()}  `, `**Target:** ${escMd(finding.target.method)} ${escMd(finding.target.path)} · **Profiles:** ${escMd(finding.profiles.join(', '))}`, '', '**What was observed**', '', escMd(finding.summary), '', '**Why the rule triggered / evidence**', '');
    for (const evidence of finding.evidence) lines.push(`- ${escMd(evidence.observation)} _(${escMd(evidence.source)})_`);
    lines.push('', '**Supporting measurements**', '', renderSupportingMarkdown(finding.metrics), '');
  }
  lines.push('## Diagnostic coverage', '', '| Diagnostic | Coverage | Observations | Source | Notes |', '|---|---|---:|---|---|');
  for (const item of model.diagnosticEvidence.coverage) lines.push(`| ${escMd(item.diagnostic)} | ${coverageText(item.state)} | ${value(item.observations)} | ${escMd(item.source ?? '—')} | ${escMd(item.note)} |`);
  lines.push('', '## Evidence coverage', '', `- Request traces analyzed: ${value(model.evidenceSummary.requestTraces)}`, `- PostgreSQL spans analyzed: ${value(model.evidenceSummary.databaseSpans)}`, `- External HTTP spans analyzed: ${value(model.evidenceSummary.externalHttpSpans)}`, `- Persisted snapshot: ${value(model.evidenceSummary.snapshotTraceCount)} traces / ${value(model.evidenceSummary.snapshotSpanCount)} spans`, `- Snapshot truncated: ${value(model.evidenceSummary.snapshotTruncated)}`, `- Trace evidence available: ${model.evidenceSummary.traceAvailable ? 'Yes' : 'No'}`, `- Profiles: ${model.evidenceSummary.profiles.map(escMd).join(', ') || 'None'}`, '', '## Limitations', '');
  for (const limitation of model.limitations) lines.push(`- ${escMd(limitation)}`);
  lines.push('', '---', '', 'Generated by PerfLens. Findings and severity are carried from the persisted Phase 3 analysis; this report does not perform additional diagnosis.', '');
  return lines.join('\n');
}

export function renderHtml(model: ReportModel): string {
  const h = (v: unknown) => escHtml(safeText(typeof v === 'string' ? v : value(v)));
  const profileRows = model.performanceSummary.profiles.map(profile => { const m: any = profile.metrics; const latency: any = m.latencyMs ?? {}; const failed = typeof m.errorRate === 'number' && m.errorRate > 0; return `<tr><th scope="row">${h(profile.name)}</th><td>${h(value(profile.workload.vus))}</td><td>${h(value(profile.workload.durationMs))}</td><td>${h(value(profile.observedDurationMs))}</td><td>${h(value(m.concurrency?.maxObservedInFlight))}</td><td>${h(metric(m, 'requests'))}</td><td>${h(metric(m, 'successfulRequests'))}</td><td>${h(metric(m, 'failedRequests'))}</td><td class="error-rate${failed ? ' nonzero' : ''}">${h(percent(m.errorRate))}</td><td>${h(formattedMetric(m, 'rps'))}</td><td>${h(formattedNumber(latency.min))}</td><td>${h(formattedNumber(latency.p50))}</td><td>${h(formattedNumber(latency.p90))}</td><td>${h(formattedNumber(latency.p95))}</td><td>${h(formattedNumber(latency.p99))}</td><td>${h(formattedNumber(latency.max))}</td></tr>`; }).join('');
  const endpointRows = model.performanceSummary.profiles.flatMap(profile => ((profile.metrics as any).endpointResults ?? []).map((endpoint: any) => {
    const m = endpoint.metrics ?? {}, latency = m.latencyMs ?? {};
    const related = model.findings.filter(finding => finding.target.method === endpoint.target.method && finding.target.path === endpoint.target.path).map(finding => `${finding.severity} ${finding.title}`).join('; ') || 'None';
    const traceEvidence = model.endpointEvidence.find(item => item.method === endpoint.target.method && item.path === endpoint.target.path);
    return `<tr><th scope="row">${h(profile.name)}</th><td class="endpoint-cell">${h(endpoint.target.method)} ${h(endpoint.target.path)}</td><td>${h(value(m.requests))}</td><td>${h(formattedMetric(m, 'rps'))}</td><td class="error-rate${typeof m.errorRate === 'number' && m.errorRate > 0 ? ' nonzero' : ''}">${h(percent(m.errorRate))}</td><td>${h(formattedNumber(latency.p50))}</td><td>${h(formattedNumber(latency.p95))}</td><td>${h(formattedNumber(latency.p99))}</td><td>${h(value(traceEvidence?.requestTraces))}</td><td>${h(value(traceEvidence?.databaseSpans))}</td><td>${h(value(traceEvidence?.externalHttpSpans))}</td><td class="finding-cell">${h(related)}</td></tr>`;
  })).join('');
  const latencyValues = model.performanceSummary.profiles.flatMap(profile => {
    const latency = (profile.metrics as any).latencyMs ?? {};
    return ['p50', 'p95', 'p99'].map(key => typeof latency[key] === 'number' && Number.isFinite(latency[key]) && latency[key] >= 0 ? latency[key] as number : null);
  });
  const latencyMax = Math.max(0, ...latencyValues.filter((item): item is number => item !== null));
  const latencyChart = latencyMax > 0 ? `<div class="latency-chart"><svg class="chart" viewBox="0 0 900 ${Math.max(130, model.performanceSummary.profiles.length * 112 + 18)}" role="img" aria-label="p50, p95, and p99 latency by load profile"><text x="0" y="18" class="axis">Latency (milliseconds)</text>${model.performanceSummary.profiles.map((profile, index) => {
    const latency = (profile.metrics as any).latencyMs ?? {};
    const y = 30 + index * 112;
    const bars = (['p50', 'p95', 'p99'] as const).map((key, barIndex) => {
      const raw = latency[key];
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return '';
      const width = Math.min(710, raw / latencyMax * 710);
      const barY = y + 24 + barIndex * 22;
      return `<text x="0" y="${barY + 13}" class="axis">${h(key)}</text><rect x="64" y="${barY}" width="${width.toFixed(2)}" height="16" rx="3" class="${key}"/><text x="${Math.min(785, 72 + width).toFixed(2)}" y="${barY + 13}" class="value">${h(latencyMetric(raw))}</text>`;
    }).join('');
    return `<g><text x="0" y="${y + 12}" class="profile-label">${h(profile.name)}</text>${bars}</g>`;
  }).join('')}</svg></div>` : '<p class="subtle">Latency chart unavailable because no profile contains measured latency percentiles.</p>';
  const nonzeroErrors = model.performanceSummary.profiles.filter(profile => typeof (profile.metrics as any).errorRate === 'number' && (profile.metrics as any).errorRate > 0);
  const errorNotice = nonzeroErrors.length ? `<aside class="error-notice" role="status"><strong>Request failures were observed.</strong> ${nonzeroErrors.map(profile => `${h(profile.name)}: ${h(percent((profile.metrics as any).errorRate))} (${h(metric(profile.metrics, 'failedRequests'))} failed of ${h(metric(profile.metrics, 'requests'))})`).join(' · ')}. This is a measured error rate, not a root-cause diagnosis.</aside>` : '';
  const databaseFindings = model.findings.filter(finding => finding.category === 'database');
  const dependencyFindings = model.findings.filter(finding => finding.category === 'dependency');
  const evidenceCards = (items: ReportFinding[]) => items.map(finding => `<article class="evidence-card"><strong>${h(finding.severity)} · ${h(finding.title)}</strong><p>${h(finding.summary)}</p><ul>${finding.evidence.slice(0, 4).map(item => `<li>${h(item.observation)}</li>`).join('')}</ul></article>`).join('');
  const findings = model.findings.length ? model.findings.map(finding => `<article class="finding ${finding.severity.toLowerCase()}"><div class="finding-head"><span class="severity">${h(finding.severity)}</span><h3>${h(finding.title)}</h3><span class="confidence">${h(finding.confidence.toUpperCase())} confidence</span></div><p class="meta">${h(finding.category)} · <code>${h(finding.ruleId)}</code> · ${h(finding.target.method)} ${h(finding.target.path)} · ${h(finding.profiles.join(', '))}</p><h4>What was observed</h4><p>${h(finding.summary)}</p><h4>Evidence</h4><ul>${finding.evidence.map(item => `<li>${h(item.observation)} <span class="source">(${h(item.source)})</span></li>`).join('')}</ul><h4>Supporting measurements</h4>${renderSupportingHtml(finding.metrics, h)}</article>`).join('') : '<p>No Phase 3 findings were recorded.</p>';
  const latencyTable = model.performanceSummary.profiles.length ? `<div class="table-wrap"><table class="latency-by-profile"><caption>Measured latency by profile (milliseconds)</caption><thead><tr><th scope="col">Profile</th><th scope="col">p50</th><th scope="col">p95</th><th scope="col">p99</th></tr></thead><tbody>${model.performanceSummary.profiles.map(profile => { const latency = (profile.metrics as any).latencyMs ?? {}; return `<tr><th scope="row">${h(profile.name)}</th>${(['p50', 'p95', 'p99'] as const).map(key => `<td>${h(typeof latency[key] === 'number' && Number.isFinite(latency[key]) ? latencyMetric(latency[key]) : 'Not available')}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>` : '<p class="subtle">No profile measurements are available.</p>';
  const httpStatusRows = model.diagnosticEvidence.httpStatusProfiles.map(item => {
    const targetName = item.target.scope === 'aggregate' ? item.target.path : `${item.target.method} ${item.target.path}`;
    const statuses = item.statusDistribution === null ? '<span>Not persisted</span>' : Object.entries(item.statusDistribution).map(([code, count]) => `<div class="status-entry"><span>${h(httpStatusText(code))}</span><strong>${h(count)}</strong></div>`).join('') || '<span>No status observations</span>';
    const recorded = item.statusCount === null ? 'Not available' : `${item.statusCount}${item.requests === null ? '' : ` of ${item.requests}`}`;
    return `<tr><th scope="row">${h(item.profile)}</th><td class="endpoint-cell">${h(targetName)}</td><td>${h(value(item.requests))}</td><td>${h(value(item.successfulRequests))}</td><td>${h(value(item.failedRequests))}</td><td class="error-rate${typeof item.errorRate === 'number' && item.errorRate > 0 ? ' nonzero' : ''}">${h(percent(item.errorRate))}</td><td>${h(formattedNumber(item.rps))}</td><td><div class="status-list">${statuses}</div></td><td>${h(coverageText(item.statusState))} (${h(recorded)} statuses)</td></tr>`;
  }).join('');
  const has429 = model.diagnosticEvidence.httpStatusProfiles.some(item => (item.statusDistribution?.['429'] ?? 0) > 0);
  const status429Note = has429 ? '<aside class="error-notice" role="note"><strong>HTTP 429 responses indicate that requests were rejected as too frequent.</strong> Possible sources include application rate limiting, an API gateway, or upstream throttling. The responsible component has not been identified.</aside>' : '';
  const diagnosticCoverageRows = model.diagnosticEvidence.coverage.map(item => `<tr><th scope="row">${h(item.diagnostic)}</th><td>${h(coverageText(item.state))}</td><td>${h(value(item.observations))}</td><td>${h(item.source ?? 'Not available')}</td><td class="coverage-note">${h(item.note)}</td></tr>`).join('');
  const resourceCpu = (summary: ResourceProfileSummary['process'] | ResourceProfileSummary['container']) => summary.cpuAveragePercent === null
    ? summary.state === 'not-collected' ? 'Not collected' : summary.state === 'unavailable' ? 'Unavailable' : 'Insufficient evidence'
    : `${formattedNumber(summary.cpuAveragePercent)}% / ${formattedNumber(summary.cpuPeakPercent)}%`;
  const resourceRows = model.resourceDiagnostics.profiles.map(item => `<tr><th scope="row">${h(item.profile)}</th><td>${h(resourceCpu(item.process))}</td><td>${h(item.process.processInstances)}</td><td>${h(item.process.samples)}</td><td>${h(mebibytes(item.process.rssAverageBytes))}</td><td>${h(mebibytes(item.process.rssPeakBytes))}</td><td>${h(rssWindowChange(item.process))}</td><td>${h(mebibytes(item.process.heapUsedAverageBytes))}</td><td>${h(mebibytes(item.process.heapUsedPeakBytes))}</td><td>${h(mebibytes(item.process.heapTotalPeakBytes))}</td><td>${h(mebibytes(item.process.externalPeakBytes))}</td><td>${h(resourceCpu(item.container))}</td><td>${h(item.container.cpuQuotaCores === null ? 'Unavailable' : `${formattedNumber(item.container.cpuQuotaCores)} cores`)}</td><td>${h(item.container.samples)}</td><td>${h(mebibytes(item.container.memoryAverageBytes))}</td><td>${h(mebibytes(item.container.memoryPeakBytes))}</td><td>${h(mebibytes(item.container.memoryLimitBytes))}</td><td>${h(percent(item.container.memoryPeakPercentOfLimit === null ? null : item.container.memoryPeakPercentOfLimit / 100))}</td></tr>`).join('');
  const processCpuChart = resourceSeriesChart(model, 'Node process CPU · one logical CPU basis (%)', 'node-process', [{ label: 'CPU', get: sample => sample.cpuPercent }]);
  const processMemoryChart = resourceSeriesChart(model, 'Node process memory (MiB)', 'node-process', [{ label: 'RSS', get: sample => sample.rssBytes === null ? null : sample.rssBytes / 1024 / 1024 }, { label: 'Heap used', get: sample => sample.heapUsedBytes === null ? null : sample.heapUsedBytes / 1024 / 1024 }]);
  const containerCpuChart = resourceSeriesChart(model, 'Docker-reported container CPU (%) · host logical CPU basis', 'docker-container', [{ label: 'CPU', get: sample => sample.cpuPercent }]);
  const containerMemoryChart = resourceSeriesChart(model, 'Docker container memory (MiB)', 'docker-container', [{ label: 'Memory used', get: sample => sample.memoryUsedBytes === null ? null : sample.memoryUsedBytes / 1024 / 1024 }]);
  const count = (severity: Severity) => model.findingsSummary.bySeverity[severity];
  const failedAssessment = allRequestsFailed(model);
  const assessmentNotice = failedAssessment ? `<aside class="assessment-warning" role="alert"><strong>${h(inconclusiveAssessment)}</strong><p>Audit execution completed and measured evidence is preserved. ${h(inconclusiveGuidance)}</p><p>Measured request counts, latency, error rates, telemetry, and any Phase 3 findings remain shown below. Failed requests alone do not establish a backend root cause.</p></aside>` : '';
  const executiveText = failedAssessment
    ? model.findings.length ? `Phase 3 recorded ${h(model.findings.length)} evidence-backed finding(s); see the detailed findings below.` : ''
    : model.findings.length ? `${h(model.findings.length)} evidence-backed finding(s) were identified.` : 'No evidence-backed performance bottleneck met the configured detection thresholds for this audit run.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PerfLens Backend Performance Audit</title><style>
 .latency-chart{display:block;width:100%;min-width:0;margin:12px 0 20px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain}.chart{display:block;width:900px;min-width:900px;max-width:none;height:auto;max-height:none}.chart .axis{font:12px system-ui;fill:var(--muted)}.chart .profile-label{font:12px system-ui;fill:var(--ink)}.chart .value{font:12px system-ui;fill:var(--ink)}.chart rect{fill:var(--blue)}.chart rect.p95{fill:#3682ad}.chart rect.p99{fill:#82b4cc}.latency-by-profile{max-width:640px;margin:10px 0}.latency-by-profile caption{text-align:left;font-weight:700;padding:8px}.supporting-measurements{max-width:640px}.supporting-measurements th,.supporting-measurements td{white-space:normal;overflow-wrap:anywhere}.http-status-table{min-width:900px}.status-list{display:grid;gap:3px;min-width:220px}.status-entry{display:flex;justify-content:space-between;gap:12px;white-space:nowrap}.coverage-note{min-width:240px;max-width:420px;white-space:normal;overflow-wrap:anywhere}.assessment-warning{margin:14px 0;padding:16px 18px;border:1px solid #d6a247;border-left:6px solid #986000;background:#fff8e9;color:#573900;overflow-wrap:anywhere}.assessment-warning p{margin:8px 0 0}.evidence-card{background:var(--wash);border-left:4px solid var(--blue);padding:12px 16px;margin:12px 0}.evidence-card p{margin:6px 0}.evidence-card li{margin:4px 0}.resource-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:18px}.resource-chart{min-width:0;margin:0;padding:14px;border:1px solid var(--line);border-radius:5px}.resource-chart figcaption{font-weight:700;margin-bottom:8px;overflow-wrap:anywhere}.resource-chart .svg-wrap{width:100%;min-width:0;overflow-x:auto;overscroll-behavior-x:contain}.resource-chart svg{display:block;width:100%;min-width:600px;height:auto;overflow:visible}.resource-chart svg text{font:11px system-ui}.resource-chart .chart-legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:6px;margin:10px 0 0;padding:0;list-style:none}.resource-chart .chart-legend li{display:flex;align-items:flex-start;gap:7px;min-width:0;overflow-wrap:anywhere}.chart-swatch{flex:0 0 12px;height:3px;margin-top:8px;border-radius:2px}.resource-numerical-table{min-width:900px}.resource-note{margin:8px 0;color:var(--muted);overflow-wrap:anywhere}
:root{color-scheme:light;--ink:#17212b;--muted:#5d6a76;--line:#d8e0e6;--paper:#fff;--wash:#f3f6f8;--blue:#175b8e;--p0:#a62b2b;--p1:#986000;--p2:#315d75}*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1100px;margin:36px auto;background:var(--paper);padding:42px 52px;box-shadow:0 8px 32px #17212b12}header{border-bottom:3px solid var(--blue);padding-bottom:22px}header .brand{font-weight:800;letter-spacing:.08em;color:var(--blue);text-transform:uppercase;font-size:13px}h1{font-size:30px;margin:8px 0}h2{font-size:21px;margin-top:34px;border-bottom:1px solid var(--line);padding-bottom:8px}h3{font-size:18px;margin:0}h4{font-size:14px;margin:16px 0 4px}.meta,.subtle,.source{color:var(--muted)}.metadata{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:22px}.metadata div{background:var(--wash);padding:12px;border-radius:5px}.metadata strong{display:block;font-size:12px;color:var(--muted);text-transform:uppercase}.counts{display:flex;gap:10px;flex-wrap:wrap}.counts span{border:1px solid var(--line);padding:7px 12px;border-radius:4px}.counts b{margin-right:5px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}thead{background:var(--wash)}.finding{border:1px solid var(--line);border-left:5px solid var(--p2);padding:20px;margin:16px 0}.finding.p0{border-left-color:var(--p0)}.finding.p1{border-left-color:var(--p1)}.finding-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.severity{font-weight:800;color:var(--p2)}.p0 .severity{color:var(--p0)}.p1 .severity{color:var(--p1)}.confidence{margin-left:auto;color:var(--muted);font-size:13px}.finding li{margin:7px 0}code{overflow-wrap:anywhere;background:var(--wash);padding:2px 4px}footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}@media(max-width:700px){main{margin:0;padding:25px 18px}h1{font-size:25px}}@media print{body{background:#fff}main{margin:0;max-width:none;box-shadow:none;padding:0}.finding{break-inside:avoid}h2{break-after:avoid}}
:root{--error:#a32121;--error-wash:#fff0ef}main{width:calc(100% - 32px);min-width:0}h1,.metadata div,.endpoint-list,.finding,.finding p,.finding li,.finding pre,.evidence-card,.evidence-card p,.evidence-card li,code,footer{overflow-wrap:anywhere;word-break:break-word}.metadata{grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}.metadata div{min-width:0}.table-wrap{max-width:100%;overscroll-behavior-x:contain}.endpoint-comparison .endpoint-cell,.endpoint-comparison .finding-cell{min-width:120px;max-width:260px;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.endpoint-comparison td.endpoint-cell{text-align:left}.error-rate.nonzero{color:var(--error);background:var(--error-wash);font-weight:800}.error-notice{margin:14px 0;padding:12px 16px;border:1px solid #e6aaa5;border-left:5px solid var(--error);background:var(--error-wash);color:#641b18;overflow-wrap:anywhere}.finding{min-width:0}.finding-head{align-items:flex-start;min-width:0}.finding-head>*{min-width:0;max-width:100%;overflow-wrap:anywhere}.finding-head h3{flex:1 1 300px}.finding pre{white-space:pre-wrap;max-width:100%;overflow-x:auto}@media(min-width:701px) and (max-width:900px){main{padding:34px 28px}}@media(max-width:700px){main{width:100%;margin:0;padding:25px 18px}.metadata{grid-template-columns:minmax(0,1fr)}.finding{padding:16px}.confidence{margin-left:0}}@media print{main{width:100%;max-width:none}}
</style></head><body><main><header><div class="brand">PerfLens</div><h1>Backend Performance Audit</h1><p class="subtle">A factual report generated from persisted audit measurements and Phase 3 findings.</p><div class="metadata"><div><strong>Run</strong>${h(model.run.id)}</div><div><strong>Target</strong>${h(model.run.target)}</div><div><strong>Endpoint</strong>${h(model.run.method)} ${h(model.run.path)}</div><div><strong>Audit period</strong>${h(model.run.startedAt)} – ${h(model.run.completedAt)}</div><div><strong>Report generated</strong>${h(model.generatedAt)}</div><div><strong>Service</strong>${h(model.run.serviceName)}</div></div></header>
<section><h2>Executive summary</h2>${assessmentNotice}${executiveText ? `<p>${executiveText}</p>` : ''}<div class="counts"><span><b class="severity">P0</b>${count('P0')}</span><span><b style="color:var(--p1)">P1</b>${count('P1')}</span><span><b style="color:var(--p2)">P2</b>${count('P2')}</span></div></section>
<section><h2>Test scope and performance overview</h2><p>Load engine: ${h(model.run.loadEngine.name ?? 'Not available')} ${h(model.run.loadEngine.version ?? '')}. Configured endpoints: <strong class="endpoint-list">${h(model.run.endpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`).join(', '))}</strong>. Configured workload values describe test setup; measurements describe observed results.</p>${errorNotice}<div class="table-wrap"><table><thead><tr><th>Profile</th><th>Configured VUs</th><th>Configured duration ms</th><th>Observed duration ms</th><th>Max in-flight</th><th>Requests</th><th>Success</th><th>Failed</th><th>Error rate</th><th>RPS</th><th>min ms</th><th>p50 ms</th><th>p90 ms</th><th>p95 ms</th><th>p99 ms</th><th>max ms</th></tr></thead><tbody>${profileRows}</tbody></table></div><h3>Latency by profile</h3>${latencyChart}${latencyTable}</section>
<section><h2>HTTP response status diagnostics</h2><p>Status counts are measured by k6 for each profile and endpoint where persisted endpoint evidence is available. A recorded status total that differs from requests is labeled incomplete.</p>${status429Note}<div class="table-wrap"><table class="http-status-table"><thead><tr><th>Profile</th><th>Endpoint</th><th>Requests</th><th>Successful</th><th>Failed</th><th>Error rate</th><th>RPS</th><th>HTTP status counts</th><th>Status coverage</th></tr></thead><tbody>${httpStatusRows}</tbody></table></div></section>
<section><h2>CPU &amp; memory diagnostics</h2><p>Samples are correlated with the audit run and profile. Process CPU is normalized to one logical CPU; it is not host-wide utilization. Process CPU/RSS/heap averages are arithmetic means of per-process sample observations; peaks are the maximum observation from one process. These values are not summed service totals. Distinct process instances may be workers or restarts; the sample evidence does not establish their role. Docker CPU is the value reported by Docker on its host logical CPU basis and is not quota-normalized. These measurements describe resource use during the audit and do not alone prove saturation or causation.</p><div class="table-wrap"><table class="resource-numerical-table"><caption>Measured resource summaries by profile</caption><thead><tr><th>Profile</th><th>Process CPU sample avg / peak</th><th>Process instances</th><th>Process samples</th><th>RSS sample avg</th><th>Per-process RSS peak</th><th>RSS window change</th><th>Heap used sample avg</th><th>Heap used peak</th><th>Heap total peak</th><th>External memory peak</th><th>Docker CPU avg / peak</th><th>CPU quota</th><th>Container samples</th><th>Container memory avg</th><th>Container memory peak</th><th>Configured memory limit</th><th>Peak of limit</th></tr></thead><tbody>${resourceRows}</tbody></table></div><div class="resource-charts">${processCpuChart}${processMemoryChart}${containerCpuChart}${containerMemoryChart}</div><p class="resource-note">Process coverage: ${h(coverageText(model.resourceDiagnostics.processState))}. ${h(model.resourceDiagnostics.processNote)}</p><p class="resource-note">Container coverage: ${h(coverageText(model.resourceDiagnostics.containerState))}. ${h(model.resourceDiagnostics.containerNote)}</p><p class="resource-note">A CPU average requires at least two valid samples per profile. Docker CPU is not quota-normalized even when a quota is known. Memory limit is only shown when Docker reports a finite configured limit. RSS window change is only available when evidence establishes one continuous process instance; it is a measured first-to-last difference, not a memory-leak diagnosis. No CPU or memory findings are added by this report.</p></section>
<section><h2>Diagnostic coverage</h2><p>Coverage describes evidence present in this run’s persisted artifacts. “No observations” does not prove that a component was unused or uninstrumented.</p><div class="table-wrap"><table><thead><tr><th>Diagnostic</th><th>Coverage</th><th>Observations</th><th>Source</th><th>Notes</th></tr></thead><tbody>${diagnosticCoverageRows}</tbody></table></div></section>
${model.run.endpoints.length > 1 ? `<section><h2>Endpoint comparison</h2><p>Endpoint latency percentiles are calculated from raw per-request k6 samples for each route. Trace counts use only persisted spans correlated to this run and matching the route template. Aggregate profile metrics above cover the full selected endpoint set.</p><div class="table-wrap"><table class="endpoint-comparison"><thead><tr><th>Profile</th><th>Endpoint</th><th>Requests</th><th>RPS</th><th>Error rate</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Request traces</th><th>PostgreSQL spans</th><th>External HTTP spans</th><th>Phase 3 finding</th></tr></thead><tbody>${endpointRows}</tbody></table></div></section>` : ''}
${databaseFindings.length ? `<section><h2>Database evidence</h2><p>PostgreSQL spans analyzed: ${h(value(model.evidenceSummary.databaseSpans))}. The following evidence is carried from Phase 3 findings.</p>${evidenceCards(databaseFindings)}</section>` : ''}${dependencyFindings.length ? `<section><h2>External dependency evidence</h2><p>External HTTP spans analyzed: ${h(value(model.evidenceSummary.externalHttpSpans))}. The following evidence is carried from Phase 3 findings.</p>${evidenceCards(dependencyFindings)}</section>` : ''}<section><h2>Detailed findings</h2>${findings}</section><section><h2>Evidence coverage</h2><ul><li>Request traces analyzed: ${h(value(model.evidenceSummary.requestTraces))}</li><li>PostgreSQL spans analyzed: ${h(value(model.evidenceSummary.databaseSpans))}</li><li>External HTTP spans analyzed: ${h(value(model.evidenceSummary.externalHttpSpans))}</li><li>Persisted snapshot: ${h(value(model.evidenceSummary.snapshotTraceCount))} traces / ${h(value(model.evidenceSummary.snapshotSpanCount))} spans</li><li>Snapshot truncated: ${h(value(model.evidenceSummary.snapshotTruncated))}</li><li>Trace evidence available: ${model.evidenceSummary.traceAvailable ? 'Yes' : 'No'}</li><li>Profiles: ${h(model.evidenceSummary.profiles.join(', ') || 'None')}</li></ul></section><section><h2>Limitations</h2><ul>${model.limitations.map(item => `<li>${h(item)}</li>`).join('')}</ul></section><footer>Generated by PerfLens ${h(model.perflensVersion)} · Report version ${model.reportVersion}. Findings, severity, and confidence are carried from the persisted Phase 3 analysis. This report does not perform additional diagnosis.</footer></main></body></html>`;
}
