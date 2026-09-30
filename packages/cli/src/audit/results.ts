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
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const sample = JSON.parse(line);
    if (sample.type !== 'Point') continue;
    const { value, tags, time } = sample.data;
    if (sample.metric === 'http_reqs') {
      const status = tags?.status ?? 'unavailable';
      result.statusDistribution[status] = (result.statusDistribution[status] ?? 0) + value;
      const endpoint = tags?.name ?? 'unavailable';
      result.endpointRequests[endpoint] = (result.endpointRequests[endpoint] ?? 0) + value;
    }
    if (sample.metric === 'perflens_request_wall_ms' && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      const end = Date.parse(time);
      if (!Number.isFinite(end)) continue;
      result.observedRequestIntervals++;
      if (value > 0) events.push({ time: end - value, delta: 1 }, { time: end, delta: -1 });
    }
  }
  if (events.length) {
    events.sort((a, b) => a.time - b.time || a.delta - b.delta);
    let inFlight = 0, maximum = 0;
    for (const event of events) { inFlight += event.delta; maximum = Math.max(maximum, inFlight); }
    result.maxObservedInFlight = maximum;
  }
  return result;
}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
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
      requests, successfulRequests: requests !== null && failed !== null ? requests - failed : null,
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
