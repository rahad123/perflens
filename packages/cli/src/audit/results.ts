import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Plan } from './k6';
import { durationMs } from './config';
export interface SampleEvidence {
  statusDistribution: Record<string, number>;
  endpointRequests: Record<string, number>;
  observedRequestIntervals: number;
  maxObservedInFlight: number | null;
}
export async function readSamples(file: string): Promise<SampleEvidence> {
  const result: SampleEvidence = { statusDistribution: {}, endpointRequests: {}, observedRequestIntervals: 0, maxObservedInFlight: null };
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
    let inFlight = 0, maximum = 0;
    for (const event of events) { inFlight += event.delta; maximum = Math.max(maximum, inFlight); }
    result.maxObservedInFlight = maximum;
  }
  return result;
}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
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
  if (!samples || Object.values(samples.statusDistribution).reduce((a, b) => a + b, 0) !== requests.count || Object.values(samples.endpointRequests).reduce((a, b) => a + b, 0) !== requests.count || samples.observedRequestIntervals !== requests.count) return 'Missing or inconsistent k6 request samples.';
  const failedStatuses = Object.entries(samples.statusDistribution).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((total, [, n]) => total + n, 0);
  if (failedStatuses !== failures.passes) return 'HTTP status samples disagree with k6 failure counts.';
  return null;
}
export function normalize(summary: any, plan: Plan, startedAt: string, endedAt: string, status: string, samples: SampleEvidence | null) {
  const metrics = summary?.metrics;
  const requests = number(metrics?.http_reqs?.values?.count);
  const failed = number(metrics?.http_req_failed?.values?.passes);
  const latency = metrics?.http_req_duration?.values;
  return {
    schemaVersion: 1, runId: plan.runId, profile: plan.profile, status, startedAt, endedAt,
    target: { baseUrl: plan.baseUrl, endpoints: plan.endpoints },
    workload: { executor: 'constant-vus', ...plan.workload, durationMs: durationMs(plan.workload.duration), requestTimeoutMs: plan.timeoutMs, gracefulStopMs: plan.timeoutMs + plan.workload.paceMs + 1000, endpointSelection: 'round-robin across scenario iterations', approximateStartRateCeiling: plan.workload.vus * 1000 / plan.workload.paceMs },
    metrics: {
      requests, successfulRequests: requests !== null && failed !== null && failed <= requests ? requests - failed : null,
      failedRequests: failed, errorRate: number(metrics?.http_req_failed?.values?.rate),
      rps: number(metrics?.http_reqs?.values?.rate), durationMs: number(summary?.state?.testRunDurationMs),
      latencyMs: { average: number(latency?.avg), min: number(latency?.min), p50: number(latency?.med), p90: number(latency?.['p(90)']), p95: number(latency?.['p(95)']), p99: number(latency?.['p(99)']), max: number(latency?.max) },
      statusDistribution: samples?.statusDistribution ?? null,
      endpointRequests: samples?.endpointRequests ?? null,
      concurrency: samples ? { observedRequestIntervals: samples.observedRequestIntervals, maxObservedInFlight: samples.maxObservedInFlight, source: 'client wall-time intervals; millisecond precision; includes connection time' } : null,
    },
    raw: { summary: `raw/${plan.profile}.summary.json`, samples: `raw/${plan.profile}.samples.ndjson` },
    interpretation: 'Execution measurements only. Latency aggregates all configured endpoints. No root-cause analysis. Missing measurements are null.',
  };
}
