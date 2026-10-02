import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Trend } from 'k6/metrics';

const plan = JSON.parse(open(__ENV.PERFLENS_PLAN));
const wall = new Trend('perflens_request_wall_ms');
const requestHeaders = Object.fromEntries((plan.requestHeaderEnv || []).map(item => [item.name, __ENV[item.envName]]));
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }));
export const options = {
  scenarios: { audit: { executor: 'constant-vus', vus: plan.workload.vus, duration: plan.workload.duration, gracefulStop: `${plan.timeoutMs + plan.workload.paceMs + 1000}ms` } },
  hosts: { localhost: '127.0.0.1' },
  maxRedirects: 0,
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  tags: { audit_run_id: plan.runId, audit_profile: plan.profile },
};
export default function () {
  const endpoint = plan.endpoints[exec.scenario.iterationInTest % plan.endpoints.length];
  const start = Date.now();
  http.get(plan.baseUrl.replace(/\/$/, '') + endpoint.path, {
    redirects: 0,
    timeout: `${plan.timeoutMs}ms`,
    headers: { ...requestHeaders, 'X-PerfLens-Run-Id': plan.runId, 'X-PerfLens-Profile': plan.profile },
    tags: { name: `GET ${endpoint.path}` },
  });
  // Raw sample timestamp minus value approximates the client in-flight interval.
  // This is measurement evidence, not a trace ID or a root-cause inference.
  wall.add(Date.now() - start, { name: `GET ${endpoint.path}`, vu: String(exec.vu.idInTest) });
  // At least paceMs between request starts per VU; slow requests naturally reduce RPS.
  sleep(Math.max(0, plan.workload.paceMs - (Date.now() - start)) / 1000);
}
export function handleSummary(data) {
  return { [plan.summaryFile]: JSON.stringify(data, null, 2) };
}
