import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Plan } from './k6';
import { durationMs } from './config';
export interface SampleEvidence {
  statusDistribution: Record<string, number>;
  endpointRequests: Record<string, number>;
  endpointStatusDistribution: Record<string, Record<string, number>>;
  endpointLatencySamples: Record<string, number[]>;
  observedRequestIntervals: number;
  maxObservedInFlight: number | null;
}
export async function readSamples(file: string): Promise<SampleEvidence> {
  const result: SampleEvidence = { statusDistribution: {}, endpointRequests: {}, endpointStatusDistribution: {}, endpointLatencySamples: {}, observedRequestIntervals: 0, maxObservedInFlight: null };
  const events: { time: number; delta: number }[] = [];
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const sample = JSON.parse(line);
      if (!sample || typeof sample.metric !== 'string' || !sample.data || typeof sample.data !== 'object') throw new Error('Invalid k6 sample record.');
      if (sample.type === 'Metric') continue;
      if (sample.type !== 'Point') throw new Error('Unknown k6 sample record type.');
      const { value, tags, time } = sample.data;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || typeof time !== 'string' || !Number.isFinite(Date.parse(time))) throw new Error('Invalid k6 sample value or timestamp.');
      if (sample.metric === 'http_reqs') {
        if (value !== 1 || typeof tags?.status !== 'string' || !/^(0|[1-9]\d{2})$/.test(tags.status) || typeof tags?.name !== 'string' || !tags.name.startsWith('GET /')) throw new Error('Invalid k6 request sample.');
        const status = tags.status;
        result.statusDistribution[status] = (result.statusDistribution[status] ?? 0) + value;
        const endpoint = tags.name;
        result.endpointRequests[endpoint] = (result.endpointRequests[endpoint] ?? 0) + value;
        result.endpointStatusDistribution[endpoint] ??= {};
        result.endpointStatusDistribution[endpoint][status] = (result.endpointStatusDistribution[endpoint][status] ?? 0) + value;
      }
      if (sample.metric === 'http_req_duration' && typeof tags?.name === 'string' && /^GET \/[a-zA-Z0-9._~/-]*$/.test(tags.name)) {
        result.endpointLatencySamples[tags.name] ??= [];
        result.endpointLatencySamples[tags.name].push(value);
      }
      if (sample.metric === 'perflens_request_wall_ms') {
        const end = Date.parse(time);
        result.observedRequestIntervals++;
        if (value > 0) events.push({ time: end - value, delta: 1 }, { time: end, delta: -1 });
      }
    }
  } finally { lines.close(); input.destroy(); }
  if (events.length) {
    events.sort((a, b) => a.time - b.time || a.delta - b.delta);
    let inFlight = 0;
    let maxInFlight = 0;
    for (const event of events) {
      inFlight += event.delta;
      maxInFlight = Math.max(maxInFlight, inFlight);
    }
    result.maxObservedInFlight = maxInFlight;
  }
  return result;
}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

// k6 2.3 handleSummary: Rate.passes counts truthy samples. For http_req_failed,
// truthy means a FAILED request; Rate.fails therefore counts successful requests.
// Validate completion separately so failed/interrupted runs can retain partial data.
export function completedEvidenceError(summary: any, samples: SampleEvidence | null): string | null {
  const metrics = summary?.metrics;
  const requests = metrics?.http_reqs?.values;
  const failures = metrics?.http_req_failed?.values;
  const latency = metrics?.http_req_duration?.values;
  const duration = summary?.state?.testRunDurationMs;
  if (metrics?.http_reqs?.type !== 'counter' || metrics?.http_req_failed?.type !== 'rate' || metrics?.http_req_duration?.type !== 'trend' || metrics.http_req_duration.contains !== 'time') return 'Missing or invalid required k6 summary metrics.';
  if (!count(requests?.count) || requests.count === 0) return 'A completed profile must contain a positive request count.';
  if (!count(failures?.passes) || !count(failures?.fails) || failures.passes + failures.fails !== requests.count) return 'Inconsistent k6 success/failure counts.';
  if (number(failures.rate) === null || failures.rate > 1 || !close(failures.rate, failures.passes / requests.count)) return 'Inconsistent k6 error rate.';
  if (number(duration) === null || duration === 0 || number(requests.rate) === null || requests.rate === 0 || !close(requests.rate, requests.count * 1000 / duration)) return 'Missing or inconsistent k6 duration/RPS.';
  const ordered = ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'].map(key => latency?.[key]);
  if (ordered.some(value => number(value) === null) || number(latency?.avg) === null || ordered.some((value, index) => index > 0 && value < ordered[index - 1]) || latency.avg < latency.min || latency.avg > latency.max) return 'Missing or invalid k6 latency statistics.';
  if (!samples || Object.values(samples.statusDistribution).reduce((a, b) => a + b, 0) !== requests.count || Object.values(samples.endpointRequests).reduce((a, b) => a + b, 0) !== requests.count || Object.values(samples.endpointLatencySamples).reduce((a, values) => a + values.length, 0) !== requests.count || samples.observedRequestIntervals !== requests.count) return 'Missing or inconsistent k6 request samples.';
  if (Object.entries(samples.endpointRequests).some(([endpoint, count]) => samples.endpointLatencySamples[endpoint]?.length !== count || Object.values(samples.endpointStatusDistribution[endpoint] ?? {}).reduce((a, b) => a + b, 0) !== count)) return 'Per-endpoint k6 request samples are incomplete.';
  const failedStatuses = Object.entries(samples.statusDistribution).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((total, [, n]) => total + n, 0);
  if (failedStatuses !== failures.passes) return 'HTTP status samples disagree with k6 failure counts.';
  return null;
}
export function normalize(summary: any, plan: Plan, startedAt: string, endedAt: string, status: string, samples: SampleEvidence | null) {
  const metrics = summary?.metrics;
  const requests = number(metrics?.http_reqs?.values?.count);
  const failed = number(metrics?.http_req_failed?.values?.passes);
  const latency = metrics?.http_req_duration?.values;
  const durationMsValue = number(summary?.state?.testRunDurationMs);
  const endpointResults = Object.keys(samples?.endpointRequests ?? {}).sort().map(key => {
    const separator = key.indexOf(' '), target = { method: key.slice(0, separator), path: key.slice(separator + 1) };
    const endpointRequests = samples!.endpointRequests[key];
    const statusDistribution = samples!.endpointStatusDistribution[key] ?? {};
    const failedRequests = Object.entries(statusDistribution).filter(([code]) => Number(code) < 200 || Number(code) >= 300).reduce((total, [, value]) => total + value, 0);
    const values = [...(samples!.endpointLatencySamples[key] ?? [])].sort((a, b) => a - b);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return { target, metrics: { requests: endpointRequests, successfulRequests: endpointRequests - failedRequests, failedRequests, errorRate: endpointRequests ? failedRequests / endpointRequests : null, rps: durationMsValue ? endpointRequests * 1000 / durationMsValue : null, latencyMs: { average, min: values[0] ?? null, p50: percentile(values, .5), p90: percentile(values, .9), p95: percentile(values, .95), p99: percentile(values, .99), max: values.at(-1) ?? null }, statusDistribution } };
  });
  return {
    schemaVersion: 1, runId: plan.runId, profile: plan.profile, status, startedAt, endedAt,
    target: { baseUrl: plan.baseUrl, endpoints: plan.endpoints },
    workload: { executor: 'constant-vus', ...plan.workload, durationMs: durationMs(plan.workload.duration), requestTimeoutMs: plan.timeoutMs, gracefulStopMs: plan.timeoutMs + plan.workload.paceMs + 1000, endpointSelection: 'round-robin across scenario iterations', approximateStartRateCeiling: plan.workload.vus * 1000 / plan.workload.paceMs },
    metrics: {
      requests, successfulRequests: requests !== null && failed !== null && failed <= requests ? requests - failed : null,
      failedRequests: failed, errorRate: number(metrics?.http_req_failed?.values?.rate),
      rps: number(metrics?.http_reqs?.values?.rate), durationMs: number(summary?.state?.testRunDurationMs),
      endpointResults,
      latencyMs: { average: number(latency?.avg), min: number(latency?.min), p50: number(latency?.med), p90: number(latency?.['p(90)']), p95: number(latency?.['p(95)']), p99: number(latency?.['p(99)']), max: number(latency?.max) },
      statusDistribution: samples?.statusDistribution ?? null,
      endpointRequests: samples?.endpointRequests ?? null,
      concurrency: samples ? { observedRequestIntervals: samples.observedRequestIntervals, maxObservedInFlight: samples.maxObservedInFlight, source: 'client wall-time intervals; millisecond precision; includes connection time' } : null,
    },
    raw: { summary: `raw/${plan.profile}.summary.json`, samples: `raw/${plan.profile}.samples.ndjson` },
    interpretation: 'Execution measurements only. Profile-level latency aggregates configured endpoints; endpoint-level latency percentiles are empirical quantiles of that endpoint’s raw k6 request duration samples. No root-cause analysis. Missing measurements are null.',
  };
}
