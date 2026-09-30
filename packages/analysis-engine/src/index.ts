export const ANALYSIS_VERSION = 1;
export const RULE_SET_VERSION = 1;

// Central rule thresholds. These are conservative defaults for local audit
// evidence, not service-level objectives or universal production limits.
export const THRESHOLDS = Object.freeze({
  minimumTraceSamples: 5,
  highConfidenceTraceSamples: 20,
  consistencyRatio: 0.7,
  highConfidenceRatio: 0.9,
  minimumLoadRequests: 20,
  p95RelativeIncrease: 0.3,
  p95AbsoluteIncreaseMs: 25,
  errorRateIncrease: 0.02,
  throughputRelativeDrop: 0.1,
  materialP95Ms: 500,
  repeatedDbOperationsPerTrace: 8,
  repeatedOperationRatio: 0.6,
  dbDominanceRatio: 0.5,
  severeDbDominanceRatio: 0.75,
  minimumDbDominanceMs: 50,
  severeDbContributionMs: 1000,
  slowDbMedianMs: 100,
  externalDominanceRatio: 0.5,
  severeExternalContributionMs: 1000,
  severeP95Ms: 2000,
  severeErrorRate: 0.1,
});

export interface ProfileResult {
  schemaVersion: number;
  runId: string;
  profile: string;
  status: string;
  startedAt: string;
  endedAt: string;
  target: { endpoints: { method: string; path: string }[] };
  workload: { vus: number; durationMs: number; [key: string]: unknown };
  metrics: {
    requests: number | null;
    successfulRequests: number | null;
    failedRequests: number | null;
    errorRate: number | null;
    rps: number | null;
    latencyMs: { p50: number | null; p90: number | null; p95: number | null; p99: number | null; [key: string]: unknown };
    [key: string]: unknown;
  };
}

export interface SanitizedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  profile: string;
  name: string;
  kind: 'server' | 'client' | 'internal' | 'producer' | 'consumer' | 'unknown';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
}

export interface AnalysisEvidence {
  schemaVersion: 1;
  runId: string;
  target: { baseUrl: string; serviceName: string; endpoints: { method: string; path: string }[] };
  auditWindow: { startedAt: string; endedAt: string };
  profiles: ProfileResult[];
  traces: SanitizedSpan[];
  telemetry: { source: string; collectedAt: string; traceCount: number; spanCount: number; truncated: boolean; unavailable?: string };
  sources: string[];
}

export type Severity = 'P0' | 'P1' | 'P2';
export type Confidence = 'high' | 'medium' | 'low';
export interface Finding {
  id: string;
  ruleId: string;
  category: 'load' | 'database' | 'dependency';
  title: string;
  summary: string;
  severity: Severity;
  confidence: Confidence;
  target: { method: string; path: string };
  profiles: string[];
  evidence: { observation: string; source: string; value?: unknown }[];
  metrics: Record<string, unknown>;
}
export interface AnalysisResult {
  schemaVersion: 1;
  analysisVersion: number;
  ruleSetVersion: number;
  runId: string;
  analyzedAt: string;
  target: AnalysisEvidence['target'];
  traceSummary: { requests: number; databaseSpans: number; externalClientSpans: number; traces: number };
  availability: { traces: boolean; note?: string };
  findings: Finding[];
  unsupported: string[];
}

export function normalizeSql(value: string): string {
  return value.toLowerCase()
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/\$\$[\s\S]*?\$\$/g, '?')
    .replace(/\$[a-zA-Z_][a-zA-Z0-9_]*\$[\s\S]*?\$[a-zA-Z_][a-zA-Z0-9_]*\$/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ').trim();
}

export function sanitizeDependency(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.split('/').map(segment =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? ':id' : segment,
    ).join('/');
    return `${url.hostname.toLowerCase()}${path}`;
  } catch { return 'external dependency'; }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function findingId(ruleId: string, target: { method: string; path: string }, profiles: string[]): string {
  return `${ruleId}:${target.method}:${target.path}:${[...profiles].sort().join(',')}`;
}
function confidence(samples: number, ratio: number): Confidence {
  if (samples >= THRESHOLDS.highConfidenceTraceSamples && ratio >= THRESHOLDS.highConfidenceRatio) return 'high';
  return 'medium';
}
function severity(impact: { p95?: number; errorRate?: number; dbRatio?: number; dbContributionMs?: number; externalRatio?: number; externalMs?: number }): Severity {
  if ((impact.errorRate ?? 0) >= THRESHOLDS.severeErrorRate || (impact.p95 ?? 0) >= THRESHOLDS.severeP95Ms || ((impact.dbRatio ?? 0) >= THRESHOLDS.severeDbDominanceRatio && (impact.dbContributionMs ?? 0) >= THRESHOLDS.severeDbContributionMs) || ((impact.externalRatio ?? 0) >= 0.8 && (impact.externalMs ?? 0) >= THRESHOLDS.severeExternalContributionMs)) return 'P0';
  if ((impact.errorRate ?? 0) >= THRESHOLDS.errorRateIncrease || (impact.p95 ?? 0) >= THRESHOLDS.materialP95Ms || (impact.dbRatio ?? 0) >= THRESHOLDS.dbDominanceRatio || (impact.externalRatio ?? 0) >= THRESHOLDS.externalDominanceRatio) return 'P1';
  return 'P2';
}

function attr(span: SanitizedSpan, key: string): string | number | boolean | undefined { return span.attributes[key]; }
function spanDuration(span: SanitizedSpan): number {
  try { return Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6; } catch { return 0; }
}
function traceMap(spans: SanitizedSpan[]) {
  const result = new Map<string, SanitizedSpan[]>();
  for (const span of spans) { const set = result.get(span.traceId) ?? []; set.push(span); result.set(span.traceId, set); }
  return result;
}
function operation(span: SanitizedSpan): string {
  const query = String(attr(span, 'db.query.sanitized') ?? '');
  const name = span.name.replace(/^pg\.query:\s*/i, '');
  if (query) return normalizeSql(query);
  // Do not equate all SELECT/UPDATE operations. Without a safe query shape,
  // repeat-query evidence is insufficient, though span counts still apply.
  return /\b(select|insert|update|delete)\b/i.test(name) ? normalizeSql(name) : '';
}
function intervalUnionWithin(spans: SanitizedSpan[], root: SanitizedSpan): number {
  try {
    const rootStart = BigInt(root.startTimeUnixNano), rootEnd = BigInt(root.endTimeUnixNano);
    const intervals = spans.map(span => {
      const start = BigInt(span.startTimeUnixNano), end = BigInt(span.endTimeUnixNano);
      return [start > rootStart ? start : rootStart, end < rootEnd ? end : rootEnd] as const;
    }).filter(([start, end]) => end > start).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    let total = 0n, start: bigint | null = null, end: bigint | null = null;
    for (const [nextStart, nextEnd] of intervals) {
      if (start === null) { start = nextStart; end = nextEnd; }
      else if (nextStart <= end!) { if (nextEnd > end!) end = nextEnd; }
      else { total += end! - start; start = nextStart; end = nextEnd; }
    }
    if (start !== null) total += end! - start;
    return Number(total) / Number(rootEnd - rootStart);
  } catch { return 0; }
}

function compareLoad(profiles: ProfileResult[], findings: Finding[]) {
  const ordered = ['baseline', 'normal', 'peak', 'stress'];
  const eligible = profiles.filter(p => p.status === 'completed').sort((a, b) => ordered.indexOf(a.profile) - ordered.indexOf(b.profile));
  for (let i = 1; i < eligible.length; i++) {
    const previous = eligible[i - 1], current = eligible[i];
    if (previous.target.endpoints.length !== 1 || current.target.endpoints.length !== 1 || previous.target.endpoints[0].path !== current.target.endpoints[0].path) continue;
    const requestsA = previous.metrics.requests, requestsB = current.metrics.requests;
    const p95A = previous.metrics.latencyMs.p95, p95B = current.metrics.latencyMs.p95;
    const p99A = previous.metrics.latencyMs.p99, p99B = current.metrics.latencyMs.p99;
    const errorA = previous.metrics.errorRate, errorB = current.metrics.errorRate;
    const rpsA = previous.metrics.rps, rpsB = current.metrics.rps;
    if (!finite(requestsA) || !finite(requestsB) || requestsA < THRESHOLDS.minimumLoadRequests || requestsB < THRESHOLDS.minimumLoadRequests ||
      !finite(previous.workload.vus) || !finite(current.workload.vus) || current.workload.vus <= previous.workload.vus || !finite(p95A) || !finite(p95B)) continue;
    const delta = p95B - p95A;
    const relative = p95A === 0 ? (p95B > 0 ? Infinity : 0) : delta / p95A;
    const latencyDegraded = delta >= THRESHOLDS.p95AbsoluteIncreaseMs && relative >= THRESHOLDS.p95RelativeIncrease;
    const errorDegraded = finite(errorA) && finite(errorB) && errorB - errorA >= THRESHOLDS.errorRateIncrease;
    const throughputDegraded = finite(rpsA) && finite(rpsB) && rpsA > 0 && rpsB <= rpsA * (1 - THRESHOLDS.throughputRelativeDrop);
    if (!latencyDegraded && !errorDegraded && !throughputDegraded) continue;
    const profilesUsed = [previous.profile, current.profile];
    const target = current.target.endpoints[0] ?? { method: 'GET', path: '/' };
    const errorsIncrease = finite(errorA) && finite(errorB) ? errorB - errorA : 0;
    const ruleId = errorDegraded ? 'load.error-degradation' : latencyDegraded ? 'load.latency-degradation' : 'load.throughput-degradation';
    findings.push({
      id: findingId(ruleId, target, profilesUsed), ruleId, category: 'load',
      title: ruleId === 'load.error-degradation' ? 'Error rate increases under load' : ruleId === 'load.throughput-degradation' ? 'Throughput decreases under higher concurrency' : 'Latency degradation under load',
      summary: latencyDegraded ? `p95 latency increased under the measured ${previous.profile} to ${current.profile} workload.` : errorDegraded ? 'The measured error rate increased as configured concurrency increased.' : 'Measured throughput decreased as configured concurrency increased; no component cause is inferred.',
      severity: severity({ p95: p95B, errorRate: errorDegraded ? errorsIncrease : 0 }), confidence: 'high', target, profiles: profilesUsed,
      evidence: [
        { observation: `Configured concurrency increased from ${previous.workload.vus} to ${current.workload.vus} VUs.`, source: `results/${previous.profile}.json, results/${current.profile}.json` },
        ...(latencyDegraded ? [{ observation: `p95 changed from ${p95A} ms to ${p95B} ms; p99 changed from ${p99A ?? 'unavailable'} ms to ${p99B ?? 'unavailable'} ms.`, source: `results/${previous.profile}.json, results/${current.profile}.json`, value: { p95BeforeMs: p95A, p95AfterMs: p95B, p99BeforeMs: p99A, p99AfterMs: p99B } }] : []),
        ...(errorDegraded ? [{ observation: `Error rate changed from ${(errorA! * 100).toFixed(2)}% to ${(errorB! * 100).toFixed(2)}%.`, source: `results/${previous.profile}.json, results/${current.profile}.json`, value: { errorRateBefore: errorA, errorRateAfter: errorB } }] : []),
        ...(throughputDegraded ? [{ observation: `Throughput changed from ${rpsA} to ${rpsB} requests/sec while configured concurrency increased.`, source: `results/${previous.profile}.json, results/${current.profile}.json`, value: { rpsBefore: rpsA, rpsAfter: rpsB } }] : []),
      ], metrics: { p95BeforeMs: p95A, p95AfterMs: p95B, p99BeforeMs: p99A, p99AfterMs: p99B, errorRateBefore: errorA, errorRateAfter: errorB, rpsBefore: rpsA, rpsAfter: rpsB, vusBefore: previous.workload.vus, vusAfter: current.workload.vus },
    });
  }
}

export function analyzeEvidence(evidence: AnalysisEvidence, analyzedAt = new Date().toISOString()): AnalysisResult {
  validateEvidence(evidence);
  const findings: Finding[] = [];
  compareLoad(evidence.profiles, findings);
  const groups = traceMap(evidence.traces);
  const traceProfiles = new Map<string, string>();
  for (const [traceId, spans] of groups) {
    const root = spans.find(span => span.kind === 'server' && attr(span, 'perflens.audit.run_id') === evidence.runId);
    if (root) traceProfiles.set(traceId, String(attr(root, 'perflens.audit.profile') ?? root.profile));
  }
  const sampledRoots = [...groups.entries()].flatMap(([traceId, spans]) => {
    const root = spans.find(span => span.kind === 'server' && attr(span, 'perflens.audit.run_id') === evidence.runId);
    return root ? [{ traceId, profile: traceProfiles.get(traceId)!, root, spans }] : [];
  });
  const db = (span: SanitizedSpan) => span.kind !== 'server' && (String(attr(span, 'db.system') ?? '').length > 0 || String(attr(span, 'db.namespace') ?? '').length > 0 || span.name.startsWith('pg.query:'));
  const clients = (span: SanitizedSpan) => span.kind === 'client' && !db(span) && (String(attr(span, 'http.request.method') ?? attr(span, 'http.method') ?? '').length > 0 || String(attr(span, 'url.sanitized') ?? '').length > 0);
  const dbCount = evidence.traces.filter(db).length;
  const clientCount = evidence.traces.filter(clients).length;

  const profileNames = [...new Set(sampledRoots.map(t => t.profile))];
  for (const profile of profileNames) {
    const profileTraces = sampledRoots.filter(t => t.profile === profile);
    const endpoints = evidence.target.endpoints.length ? evidence.target.endpoints : [{ method: 'GET', path: '/' }];
    for (const endpoint of endpoints) {
    // With one configured target, the run/profile correlation already scopes
    // the traces to that request. Route templates may differ from a literal
    // path such as /orders/123, so preserve the configured target identity.
    const traces = profileTraces.filter(t => attr(t.root, 'http.route') === endpoint.path || endpoints.length === 1);
    if (traces.length < THRESHOLDS.minimumTraceSamples) continue;
    const databasePerTrace = traces.map(t => ({ ...t, db: t.spans.filter(db) }));
    const repeated = databasePerTrace.filter(t => {
      const operations = t.db.map(span => ({ span, key: operation(span) })).filter(item => item.key);
      if (operations.length < THRESHOLDS.repeatedDbOperationsPerTrace) return false;
      const counts = new Map<string, number>();
      operations.forEach(item => counts.set(item.key, (counts.get(item.key) ?? 0) + 1));
      return [...counts.values()].some(count => count >= 5 && count / operations.length >= THRESHOLDS.repeatedOperationRatio);
    });
    const repeatedRatio = repeated.length / traces.length;
    if (repeated.length >= THRESHOLDS.minimumTraceSamples && repeatedRatio >= THRESHOLDS.consistencyRatio) {
      const queryCounts = repeated.map(t => t.db.filter(span => operation(span)).length);
      const allDbRatio = databasePerTrace.map(t => intervalUnionWithin(t.db, t.root));
      const representativeDb = median(allDbRatio);
      const target = endpoint;
      findings.push({
        id: findingId('database.repeated-operation', target, [profile]), ruleId: 'database.repeated-operation', category: 'database',
        title: 'Repeated database query pattern', summary: 'Similar PostgreSQL operations repeat within individual requests across multiple sampled traces; this is a likely N+1 query pattern, not a confirmed application root cause.',
        severity: 'P1', confidence: confidence(traces.length, repeatedRatio), target, profiles: [profile],
        evidence: [
          { observation: `${repeated.length} of ${traces.length} sampled requests had at least five equivalent operations among ${THRESHOLDS.repeatedDbOperationsPerTrace}+ query-shaped database spans.`, source: `Tempo trace snapshot (${profile})`, value: { affectedTraces: repeated.length, analyzedTraces: traces.length, ratio: repeatedRatio, minimumOperations: THRESHOLDS.repeatedDbOperationsPerTrace, sampleTraceIds: repeated.slice(0, 10).map(t => t.traceId) } },
          { observation: `Median database operations/request in affected traces: ${median(queryCounts)}.`, source: `Tempo trace snapshot (${profile})`, value: { medianOperationsPerRequest: median(queryCounts) } },
          ...(representativeDb > 0 ? [{ observation: `Database activity occupied a median ${(representativeDb * 100).toFixed(1)}% of the request execution window.`, source: `Tempo span interval union (${profile})`, value: { medianDatabaseWindowRatio: representativeDb } }] : []),
        ], metrics: { tracesAffected: repeated.length, tracesAnalyzed: traces.length, affectedRatio: repeatedRatio, medianOperationsPerRequest: median(queryCounts), medianDatabaseWindowRatio: representativeDb },
      });
    }

    const dbRatios = databasePerTrace.map(t => intervalUnionWithin(t.db, t.root));
    const dominant = databasePerTrace.filter((t, index) => dbRatios[index] >= THRESHOLDS.dbDominanceRatio && dbRatios[index] * spanDuration(t.root) >= THRESHOLDS.minimumDbDominanceMs);
    const dominanceRatio = dominant.length / traces.length;
    const repeatedId = findingId('database.repeated-operation', endpoint, [profile]);
    if (!findings.some(f => f.id === repeatedId) && dominant.length >= THRESHOLDS.minimumTraceSamples && dominanceRatio >= THRESHOLDS.consistencyRatio) {
      const ratioMedian = median(dominant.map(t => intervalUnionWithin(t.db, t.root)));
      const contributionMedianMs = median(dominant.map(t => intervalUnionWithin(t.db, t.root) * spanDuration(t.root)));
      const target = endpoint;
      findings.push({
        id: findingId('database.time-dominance', target, [profile]), ruleId: 'database.time-dominance', category: 'database', title: 'Database time dominates request execution',
        summary: 'The union of PostgreSQL span intervals occupies a substantial part of the server request window across sampled traces. Overlapping database spans are counted once.',
        severity: severity({ dbRatio: ratioMedian, dbContributionMs: contributionMedianMs }), confidence: confidence(traces.length, dominanceRatio), target, profiles: [profile],
        evidence: [
          { observation: `${dominant.length} of ${traces.length} traces had database activity occupying at least ${(THRESHOLDS.dbDominanceRatio * 100).toFixed(0)}% of the request window.`, source: `Tempo trace snapshot (${profile})`, value: { tracesAffected: dominant.length, tracesAnalyzed: traces.length, ratio: dominanceRatio, sampleTraceIds: dominant.slice(0, 10).map(t => t.traceId) } },
          { observation: `Median database interval-union contribution among affected requests: ${(ratioMedian * 100).toFixed(1)}% (${contributionMedianMs.toFixed(1)} ms).`, source: `Tempo parent/server span interval union (${profile})`, value: { medianDatabaseWindowRatio: ratioMedian, medianDatabaseContributionMs: contributionMedianMs } },
        ], metrics: { tracesAffected: dominant.length, tracesAnalyzed: traces.length, affectedRatio: dominanceRatio, medianDatabaseWindowRatio: ratioMedian, medianDatabaseContributionMs: contributionMedianMs, databaseSpanCount: databasePerTrace.reduce((sum, t) => sum + t.db.length, 0) },
      });
    }

    const byOperation = new Map<string, { spans: SanitizedSpan[]; traces: Set<string> }>();
    for (const trace of databasePerTrace) for (const span of trace.db) {
      const key = operation(span); if (!key) continue;
      const item = byOperation.get(key) ?? { spans: [], traces: new Set<string>() };
      item.spans.push(span); item.traces.add(trace.traceId); byOperation.set(key, item);
    }
    const slow = [...byOperation.entries()].map(([key, item]) => ({ key, ...item, durations: item.spans.map(spanDuration) })).filter(item =>
      item.spans.length >= 5 && item.traces.size >= THRESHOLDS.minimumTraceSamples && item.traces.size / traces.length >= THRESHOLDS.consistencyRatio && median(item.durations) >= THRESHOLDS.slowDbMedianMs,
    );
    for (const item of slow) {
      const target = endpoint;
      const durations = item.durations;
      const source = `Tempo sanitized PostgreSQL operation fingerprint (${profile})`;
      findings.push({
        id: findingId(`database.slow-operation:${item.key}`, target, [profile]), ruleId: 'database.slow-operation', category: 'database', title: 'Consistently slow database operation',
        summary: 'A sanitized, equivalent database operation was slow across multiple requests. This evidence does not establish why it is slow.',
        severity: 'P1', confidence: confidence(item.traces.size, item.traces.size / traces.length), target, profiles: [profile],
        evidence: [
          { observation: `The operation occurred ${item.spans.length} times across ${item.traces.size} sampled requests; median duration ${median(durations).toFixed(1)} ms, p95 ${percentile(durations, .95).toFixed(1)} ms.`, source, value: { operation: item.key, count: item.spans.length, traces: item.traces.size, medianMs: median(durations), p95Ms: percentile(durations, .95), sampleTraceIds: [...item.traces].sort().slice(0, 10) } },
        ], metrics: { operationFingerprint: item.key, operationCount: item.spans.length, tracesAffected: item.traces.size, medianDurationMs: median(durations), p95DurationMs: percentile(durations, .95) },
      });
    }

    const externalByHost = new Map<string, { spans: SanitizedSpan[]; traces: Set<string> }>();
    for (const trace of traces) for (const span of trace.spans.filter(clients)) {
      const dep = String(attr(span, 'url.sanitized') ?? 'external dependency');
      const item = externalByHost.get(dep) ?? { spans: [], traces: new Set<string>() };
      item.spans.push(span); item.traces.add(trace.traceId); externalByHost.set(dep, item);
    }
    for (const [dependency, item] of externalByHost) {
      if (item.spans.length < THRESHOLDS.minimumTraceSamples || item.traces.size < THRESHOLDS.minimumTraceSamples || item.traces.size / traces.length < THRESHOLDS.consistencyRatio) continue;
      const durations = item.spans.map(spanDuration);
      const contribution = traces.map(t => {
        const matching = t.spans.filter(span => clients(span) && attr(span, 'url.sanitized') === dependency);
        return intervalUnionWithin(matching, t.root);
      });
      const dominantExternal = contribution.filter(value => value >= THRESHOLDS.externalDominanceRatio);
      if (dominantExternal.length < THRESHOLDS.minimumTraceSamples || dominantExternal.length / traces.length < THRESHOLDS.consistencyRatio || median(durations) < 100) continue;
      const target = endpoint;
      const ratio = dominantExternal.length / traces.length;
      const med = median(durations);
      findings.push({
        id: findingId(`dependency.latency:${dependency}`, target, [profile]), ruleId: 'dependency.latency-dominance', category: 'dependency', title: 'External dependency contributes substantially to request latency',
        summary: 'Repeated external HTTP client spans occupy a substantial portion of the request window across sampled traces; the evidence does not establish dependency ownership or root cause.',
        severity: severity({ externalRatio: median(dominantExternal), externalMs: med }), confidence: confidence(item.traces.size, ratio), target, profiles: [profile],
        evidence: [
          { observation: `${item.spans.length} calls to ${dependency} appeared across ${item.traces.size} traces.`, source: `Tempo sanitized HTTP client spans (${profile})`, value: { dependency, calls: item.spans.length, traces: item.traces.size, sampleTraceIds: [...item.traces].sort().slice(0, 10) } },
          { observation: `Median dependency call duration ${med.toFixed(1)} ms; dependency intervals occupied a median ${(median(dominantExternal) * 100).toFixed(1)}% of affected request windows.`, source: `Tempo client/server span interval union (${profile})`, value: { medianCallMs: med, p95CallMs: percentile(durations, .95), medianRequestContribution: median(dominantExternal), affectedTraces: dominantExternal.length, analyzedTraces: traces.length } },
        ], metrics: { dependency, calls: item.spans.length, tracesAffected: item.traces.size, medianCallMs: med, p95CallMs: percentile(durations, .95), medianRequestContribution: median(dominantExternal) },
      });
    }
    }
  }

  // A dominant external-call error rate is measured independently from latency.
  const profileOrder = ['baseline', 'normal', 'peak', 'stress'];
  const completed = evidence.profiles.filter(p => p.status === 'completed').sort((a, b) => profileOrder.indexOf(a.profile) - profileOrder.indexOf(b.profile));
  for (let i = 1; i < completed.length; i++) {
    const a = completed[i - 1], b = completed[i];
    if (a.target.endpoints.length !== 1 || b.target.endpoints.length !== 1 || a.target.endpoints[0].path !== b.target.endpoints[0].path) continue;
    if (!finite(a.workload.vus) || !finite(b.workload.vus) || b.workload.vus <= a.workload.vus) continue;
    if (!finite(a.metrics.errorRate) || !finite(b.metrics.errorRate) || b.metrics.errorRate - a.metrics.errorRate < THRESHOLDS.errorRateIncrease || !finite(a.metrics.requests) || !finite(b.metrics.requests) || a.metrics.requests < THRESHOLDS.minimumLoadRequests || b.metrics.requests < THRESHOLDS.minimumLoadRequests) continue;
    if (findings.some(f => f.category === 'load' && f.profiles.includes(a.profile) && f.profiles.includes(b.profile))) continue;
    const target = b.target.endpoints[0] ?? { method: 'GET', path: '/' };
    findings.push({ id: findingId('load.error-degradation', target, [a.profile, b.profile]), ruleId: 'load.error-degradation', category: 'load', title: 'Error rate increases under load', summary: 'Measured request failures increased between completed workload profiles; root cause is not inferred.', severity: severity({ errorRate: b.metrics.errorRate }), confidence: 'high', target, profiles: [a.profile, b.profile], evidence: [{ observation: `Error rate changed from ${(a.metrics.errorRate * 100).toFixed(2)}% to ${(b.metrics.errorRate * 100).toFixed(2)}%.`, source: `results/${a.profile}.json, results/${b.profile}.json` }], metrics: { errorRateBefore: a.metrics.errorRate, errorRateAfter: b.metrics.errorRate } });
  }

  // Fold supporting database contribution into a repeated-operation finding;
  // do not emit duplicate database-time findings for the same endpoint/profile.
  const slowOperationProfiles = new Set(findings.filter(f => f.ruleId === 'database.slow-operation').map(f => `${f.target.method} ${f.target.path}:${f.profiles.join(',')}`));
  const unique = new Map<string, Finding>();
  for (const finding of findings) {
    if (finding.ruleId === 'database.time-dominance' && slowOperationProfiles.has(`${finding.target.method} ${finding.target.path}:${finding.profiles.join(',')}`)) continue;
    const discriminator = finding.ruleId === 'database.slow-operation'
      ? String(finding.metrics.operationFingerprint ?? '')
      : finding.ruleId === 'dependency.latency-dominance' ? String(finding.metrics.dependency ?? '') : '';
    const key = finding.category === 'load' ? finding.id : `${finding.ruleId}:${finding.target.method} ${finding.target.path}:${discriminator}`;
    const previous = unique.get(key);
    if (!previous) { unique.set(key, finding); continue; }
    const profiles = [...new Set([...previous.profiles, ...finding.profiles])].sort((a, b) => ['baseline', 'normal', 'peak', 'stress'].indexOf(a) - ['baseline', 'normal', 'peak', 'stress'].indexOf(b));
    const profileMetrics = {
      ...((previous.metrics.profileMetrics as Record<string, unknown> | undefined) ?? { [previous.profiles[0]]: Object.fromEntries(Object.entries(previous.metrics).filter(([name]) => name !== 'profileMetrics')) }),
      ...((finding.metrics.profileMetrics as Record<string, unknown> | undefined) ?? { [finding.profiles[0]]: Object.fromEntries(Object.entries(finding.metrics).filter(([name]) => name !== 'profileMetrics')) }),
    };
    const priority: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
    const confidenceRank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
    const strongestConfidence = confidenceRank[previous.confidence] <= confidenceRank[finding.confidence] ? previous.confidence : finding.confidence;
    const idRule = `${finding.ruleId}:${discriminator}`;
    unique.set(key, { ...previous, id: findingId(idRule, finding.target, profiles), profiles, severity: priority[previous.severity] <= priority[finding.severity] ? previous.severity : finding.severity, confidence: strongestConfidence, evidence: [...previous.evidence, ...finding.evidence], metrics: { ...previous.metrics, profileMetrics } });
  }
  const resultFindings = [...unique.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1, analysisVersion: ANALYSIS_VERSION, ruleSetVersion: RULE_SET_VERSION,
    runId: evidence.runId, analyzedAt, target: evidence.target,
    traceSummary: { requests: sampledRoots.length, databaseSpans: dbCount, externalClientSpans: clientCount, traces: groups.size },
    availability: { traces: sampledRoots.length > 0, ...(!sampledRoots.length ? { note: evidence.telemetry.unavailable ?? 'No correlated server traces were available; load-only analysis remains available.' } : {}) },
    findings: resultFindings,
    unsupported: ['CPU and memory saturation: the current Phase 2 evidence does not include reliable per-run resource metrics.', 'Prometheus rate windows: no snapshot is persisted by Phase 2, so resource and time-series rules are not evaluated.'],
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

export function validateEvidence(evidence: AnalysisEvidence): void {
  if (!evidence || evidence.schemaVersion !== 1 || !/^pfl_/.test(evidence.runId) || !Array.isArray(evidence.profiles) || !Array.isArray(evidence.traces) || !evidence.target || typeof evidence.target.baseUrl !== 'string' || typeof evidence.target.serviceName !== 'string' || !Array.isArray(evidence.target.endpoints) || !evidence.telemetry || !Array.isArray(evidence.sources) || !evidence.auditWindow) throw new Error('Unsupported or malformed analysis evidence schema (expected version 1).');
  if (!Number.isFinite(Date.parse(evidence.auditWindow.startedAt)) || !Number.isFinite(Date.parse(evidence.auditWindow.endedAt)) || Date.parse(evidence.auditWindow.endedAt) < Date.parse(evidence.auditWindow.startedAt)) throw new Error('Malformed analysis evidence audit window.');
  if (evidence.target.endpoints.some(endpoint => !endpoint || endpoint.method !== 'GET' || typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/'))) throw new Error('Malformed analysis evidence target endpoints.');
  for (const profile of evidence.profiles) {
    if (!profile || profile.schemaVersion !== 1 || profile.runId !== evidence.runId || profile.status !== 'completed' || !['baseline', 'normal', 'peak', 'stress'].includes(profile.profile) || !profile.metrics || !profile.metrics.latencyMs || !profile.workload || !Number.isFinite(profile.workload.vus) || profile.workload.vus < 1 || !Number.isFinite(profile.workload.durationMs) || profile.workload.durationMs < 1 || !Array.isArray(profile.target?.endpoints) || !Number.isFinite(Date.parse(profile.startedAt)) || !Number.isFinite(Date.parse(profile.endedAt)) || Date.parse(profile.endedAt) < Date.parse(profile.startedAt)) throw new Error(`Invalid or ineligible profile evidence: ${profile?.profile ?? 'unknown'}.`);
    for (const metric of ['requests', 'successfulRequests', 'failedRequests', 'errorRate', 'rps']) {
      const value = profile.metrics[metric];
      const mustBeInteger = ['requests', 'successfulRequests', 'failedRequests'].includes(metric);
      if (value !== null && (!finite(value) || (mustBeInteger && !Number.isSafeInteger(value)) || (metric === 'errorRate' && value > 1))) throw new Error(`Malformed ${metric} in ${profile.profile} profile evidence.`);
    }
    for (const metric of ['p50', 'p90', 'p95', 'p99']) {
      const value = profile.metrics.latencyMs[metric];
      if (!finite(value)) throw new Error(`Malformed or missing ${metric} latency in ${profile.profile} profile evidence.`);
    }
    const { requests, successfulRequests, failedRequests, errorRate, rps } = profile.metrics;
    if (!Number.isInteger(profile.workload.vus) || !finite(requests) || requests < 1 || !finite(successfulRequests) || !finite(failedRequests) || successfulRequests + failedRequests !== requests || !finite(errorRate) || !finite(rps) || rps === 0 || Math.abs(errorRate - failedRequests / requests) > 1e-6) throw new Error(`Inconsistent completed measurements in ${profile.profile} profile evidence.`);
    const latency = profile.metrics.latencyMs;
    if (!finite(latency.p50) || !finite(latency.p90) || !finite(latency.p95) || !finite(latency.p99) || latency.p50 > latency.p90 || latency.p90 > latency.p95 || latency.p95 > latency.p99) throw new Error(`Inconsistent latency percentiles in ${profile.profile} profile evidence.`);
  }
  for (const span of evidence.traces) {
    if (!span || !span.traceId || !span.spanId || !span.profile || !evidence.profiles.some(profile => profile.profile === span.profile) || !['server', 'client', 'internal', 'producer', 'consumer', 'unknown'].includes(span.kind)) throw new Error('Malformed normalized trace span evidence.');
    try { if (BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)) throw new Error(); } catch { throw new Error('Malformed normalized trace span timestamps.'); }
    if (!span.attributes || typeof span.attributes !== 'object') throw new Error('Malformed normalized trace span attributes.');
    if (span.kind === 'server' && span.attributes['perflens.audit.run_id'] !== undefined && span.attributes['perflens.audit.run_id'] !== evidence.runId) throw new Error('Trace snapshot contains server spans from another audit run.');
  }
}
