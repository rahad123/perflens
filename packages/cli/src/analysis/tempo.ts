import { normalizeSql, sanitizeDependency, SanitizedSpan } from '../../../analysis-engine/dist';
import { CliError } from '../utils/errors';

type Json = Record<string, any>;
const MAX_TRACES = 500;
const TRACE_FETCH_CONCURRENCY = 6;

function valueOf(attribute: Json): string | number | boolean | undefined {
  const value = attribute?.value;
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.intValue === 'string' && /^-?\d+$/.test(value.intValue)) return Number(value.intValue);
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  return undefined;
}
function attributes(raw: Json): Record<string, string | number | boolean> {
  return Object.fromEntries((raw.attributes ?? []).flatMap((item: Json) => {
    const value = valueOf(item);
    return typeof item.key === 'string' && value !== undefined ? [[item.key, value]] : [];
  }));
}
function kind(raw: Json): SanitizedSpan['kind'] {
  const value = raw.kind;
  if (value === 'SPAN_KIND_SERVER' || value === 2) return 'server';
  if (value === 'SPAN_KIND_CLIENT' || value === 3) return 'client';
  if (value === 'SPAN_KIND_INTERNAL' || value === 1) return 'internal';
  if (value === 'SPAN_KIND_PRODUCER' || value === 4) return 'producer';
  if (value === 'SPAN_KIND_CONSUMER' || value === 5) return 'consumer';
  return 'unknown';
}
function spanStatus(raw: Json): SanitizedSpan['status'] {
  const code = raw?.status?.code;
  if (code === 2 || code === '2' || code === 'STATUS_CODE_ERROR' || String(code).toUpperCase() === 'ERROR') return 'error';
  if (code === 1 || code === '1' || code === 'STATUS_CODE_OK' || String(code).toUpperCase() === 'OK') return 'ok';
  if (code === 0 || code === '0' || code === 'STATUS_CODE_UNSET' || String(code).toUpperCase() === 'UNSET') return 'unset';
  return undefined;
}
function endpointPath(path: string, allowed: string[]): string {
  if (allowed.includes(path)) return path;
  const prefix = [...allowed].sort((a, b) => b.length - a.length).find(candidate => path.startsWith(`${candidate}/`));
  if (prefix) {
    const suffix = path.slice(prefix.length).split('/').filter(Boolean).map(segment =>
      /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? ':id' : ':segment',
    ).join('/');
    return `${prefix}/${suffix}`;
  }
  return '/' + path.split('/').filter(Boolean).map(segment =>
    /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? ':id' : ':segment',
  ).join('/');
}
function safeAttributes(raw: Record<string, string | number | boolean>, endpoints: string[]): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const key of ['perflens.audit.run_id', 'perflens.audit.profile', 'db.system', 'db.namespace', 'http.request.method', 'http.method', 'http.response.status_code', 'http.status_code']) {
    if (raw[key] !== undefined) safe[key] = raw[key];
  }
  const operation = raw['db.operation.name'];
  if (typeof operation === 'string' && /^[a-z][a-z0-9_]{0,39}$/i.test(operation)) safe['db.operation.name'] = operation.toUpperCase();
  const databaseSystem = raw['db.system'] ?? raw['db.system.name'];
  if (databaseSystem !== undefined) safe['db.system'] = databaseSystem;
  const statement = raw['db.query.text'] ?? raw['db.statement'];
  if (typeof statement === 'string') safe['db.query.sanitized'] = normalizeSql(statement);
  const route = raw['http.route'];
  const urlPath = raw['url.path'];
  if (typeof route === 'string') safe['http.route'] = endpointPath(route, endpoints);
  else if (typeof urlPath === 'string') safe['http.route'] = endpointPath(urlPath, endpoints);
  const full = raw['url.full'];
  if (typeof full === 'string') safe['url.sanitized'] = sanitizeDependency(full);
  return safe;
}
export function normalizeTempoTrace(trace: Json, profile: string, runId: string, serviceName: string, endpoints: string[], sourceTraceId?: string): SanitizedSpan[] {
  const batches: Json[] = trace.batches ?? trace.resourceSpans ?? [];
  const result: SanitizedSpan[] = [];
  for (const batch of batches) {
    const resource = attributes(batch.resource ?? {});
    if (resource['service.name'] && resource['service.name'] !== serviceName) continue;
    for (const scope of batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []) {
      for (const raw of scope.spans ?? []) {
        const rawAttrs = attributes(raw);
        const spanKind = kind(raw);
        const isDatabaseSpan = typeof rawAttrs['db.system'] === 'string' || typeof rawAttrs['db.system.name'] === 'string' || typeof rawAttrs['db.namespace'] === 'string' || typeof rawAttrs['db.query.text'] === 'string' || (typeof raw.name === 'string' && /^pg\./i.test(raw.name));
        let name = typeof raw.name === 'string' ? raw.name.split('?', 1)[0] : '';
        const attrSafe = safeAttributes(rawAttrs, endpoints);
        // pg instrumentation uses the span name as its query when enhanced
        // database reporting is disabled. Persist literals-free SQL only.
        if (/^pg\.query:/i.test(name)) name = `pg.query: ${String(attrSafe['db.query.sanitized'] ?? normalizeSql(name.replace(/^pg\.query:\s*/i, '')))}`;
        if (spanKind === 'server') {
          const method = String(attrSafe['http.request.method'] ?? attrSafe['http.method'] ?? 'HTTP');
          name = `${method} ${String(attrSafe['http.route'] ?? 'server request')}`;
        } else if (spanKind === 'client' && !isDatabaseSpan) {
          name = String(attrSafe['http.request.method'] ?? attrSafe['http.method'] ?? (/^pg\.query:/i.test(name) ? name : 'HTTP client'));
        } else if (isDatabaseSpan && /^\s*(select|insert|update|delete|with)\b/i.test(name)) {
          name = normalizeSql(name);
        } else if (isDatabaseSpan && !/^pg\.[a-z_.]+$/i.test(name) && !/^pg\.query:/i.test(name)) {
          name = 'database operation';
        } else if (!isDatabaseSpan && spanKind !== 'client') {
          name = `${spanKind} span`;
        }
        if (spanKind === 'server' && rawAttrs['perflens.audit.run_id'] === runId) {
          attrSafe['perflens.audit.run_id'] = runId;
          attrSafe['perflens.audit.profile'] = String(rawAttrs['perflens.audit.profile'] ?? profile);
        } else {
          delete attrSafe['perflens.audit.run_id'];
          delete attrSafe['perflens.audit.profile'];
        }
        result.push({
          traceId: sourceTraceId ?? String(trace.traceID ?? trace.traceId ?? raw.traceId ?? ''),
          spanId: String(raw.spanId ?? ''), parentSpanId: raw.parentSpanId ? String(raw.parentSpanId) : null,
          profile: spanKind === 'server' ? String(attrSafe['perflens.audit.profile'] ?? profile) : profile,
          name, kind: spanKind, startTimeUnixNano: String(raw.startTimeUnixNano ?? ''), endTimeUnixNano: String(raw.endTimeUnixNano ?? ''),
          ...(spanStatus(raw) === undefined ? {} : { status: spanStatus(raw) }),
          attributes: attrSafe,
        });
      }
    }
  }
  const roots = result.filter(span => span.kind === 'server' && span.attributes['perflens.audit.run_id'] === runId && span.attributes['perflens.audit.profile'] === profile);
  return roots.length ? result : [];
}

async function getJson(url: URL): Promise<Json> {
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(8000) }); }
  catch { throw new CliError('Could not connect to the local Tempo query API.', 'Run perflens infra up and verify its loopback TEMPO_PORT.'); }
  if (!response.ok) throw new CliError(`Tempo query failed (HTTP ${response.status}).`, 'Check the local Tempo container logs and confirm its configured retention includes this audit.');
  try { return await response.json() as Json; }
  catch { throw new CliError('Tempo returned invalid JSON.', 'Inspect the local Tempo service and retry analysis.'); }
}

export interface TraceSnapshot { spans: SanitizedSpan[]; traceCount: number; spanCount: number; truncated: boolean }
export async function collectTempoEvidenceWithRetry(
  collect: () => Promise<TraceSnapshot>,
  options: { attempts?: number; intervalMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<TraceSnapshot> {
  // Tempo indexing can lag behind Collector acceptance under a short local
  // audit. Poll only this run/profile query for a bounded 20-second window.
  const attempts = options.attempts ?? 40, intervalMs = options.intervalMs ?? 500;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let snapshot: TraceSnapshot = { spans: [], traceCount: 0, spanCount: 0, truncated: false };
  for (let attempt = 0; attempt < attempts; attempt++) {
    snapshot = await collect();
    if (snapshot.traceCount > 0 || attempt === attempts - 1) return snapshot;
    await wait(intervalMs);
  }
  return snapshot;
}
export async function collectTempoEvidence(tempoUrl: string, runId: string, serviceName: string, endpoints: string[], profiles: { profile: string; startedAt: string; endedAt: string }[]): Promise<TraceSnapshot> {
  const base = new URL(tempoUrl);
  const spans: SanitizedSpan[] = [];
  const seenTraces = new Set<string>();
  let truncated = false;
  for (const profile of profiles) {
    const start = Date.parse(profile.startedAt), end = Date.parse(profile.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const query = `{ resource.service.name = ${JSON.stringify(serviceName)} && span.perflens.audit.run_id = ${JSON.stringify(runId)} && span.perflens.audit.profile = ${JSON.stringify(profile.profile)} }`;
    const search = new URL('/api/search', base);
    search.searchParams.set('limit', String(MAX_TRACES + 1));
    search.searchParams.set('q', query);
    search.searchParams.set('start', String(Math.max(0, Math.floor(start / 1000) - 5)));
    search.searchParams.set('end', String(Math.ceil(end / 1000) + 5));
    const found = await getJson(search);
    const matches: Json[] = Array.isArray(found.traces) ? [...found.traces].sort((a: Json, b: Json) => String(a.traceID ?? a.traceId).localeCompare(String(b.traceID ?? b.traceId))) : [];
    if (matches.length > MAX_TRACES) truncated = true;
    const traceIds = matches.slice(0, MAX_TRACES).map(item => String(item.traceID ?? item.traceId ?? '')).filter(Boolean).filter(id => !seenTraces.has(id));
    for (let offset = 0; offset < traceIds.length; offset += TRACE_FETCH_CONCURRENCY) {
      const batch = traceIds.slice(offset, offset + TRACE_FETCH_CONCURRENCY);
      const traces = await Promise.all(batch.map(async traceId => {
        seenTraces.add(traceId);
        return { traceId, trace: await getJson(new URL(`/api/traces/${encodeURIComponent(traceId)}`, base)) };
      }));
      for (const item of traces) spans.push(...normalizeTempoTrace(item.trace, profile.profile, runId, serviceName, endpoints, item.traceId));
    }
  }
  return { spans, traceCount: new Set(spans.map(span => span.traceId)).size, spanCount: spans.length, truncated };
}
