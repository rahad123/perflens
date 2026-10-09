const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runCompleteAudit } = require('../dist/audit/orchestrator');
const { otlpTracesEndpoint } = require('../dist/services/workspace');
const { ApplicationReadinessError } = require('../dist/services/runtime-instrumentation');
const infraServices = ['otel-collector', 'tempo', 'prometheus', 'grafana'];

const runId = 'pfl_20261002T120000000Z_12345678-1234-1234-1234-123456789abc';
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'perflens-orchestrator-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'perflens.config.json'), JSON.stringify({
    project: { name: 'consumer' }, target: { baseUrl: 'http://localhost:3400' }, observability: { serviceName: 'consumer-api' },
    audit: { endpoints: [{ method: 'GET', path: '/orders' }] },
  }));
  return cwd;
}
function mockDependencies(t, overrides = {}) {
  const events = [];
  const dir = join(t.cwd, '.perflens', 'runs', runId);
  const infraRoot = join(t.cwd, '.perflens', 'infra');
  const setup = (async () => {
    await mkdir(infraRoot, { recursive: true });
    await writeFile(join(infraRoot, '.env'), 'OTLP_HTTP_PORT=4319\n');
  })();
  return {
    events,
    ready: setup,
    async infrastructureRoot() { await setup; return infraRoot; },
    async assertLocalDocker() {},
    infrastructure: () => ({
      async status() { events.push('status'); return infraServices.map(service => ({ service, ready: true })); },
      async up() { events.push('up'); throw new Error('must reuse healthy infrastructure'); },
    }),
    async audit(options) {
      events.push('audit');
      events.push(`endpoints:${options.endpoints.map(endpoint => endpoint.path).join(',')}`);
      await mkdir(join(dir, 'telemetry'), { recursive: true });
      await writeFile(join(dir, 'telemetry/metadata.json'), JSON.stringify({ infrastructure: { localUrls: { grafana: 'http://127.0.0.1:3001', prometheus: 'http://127.0.0.1:9090' } } }));
      for (const [profile, requests, vus] of [['baseline', 20, 1], ['normal', 90, 3]]) {
        await mkdir(join(dir, 'results'), { recursive: true });
        await writeFile(join(dir, `results/${profile}.json`), JSON.stringify({ profile, metrics: { requests, failedRequests: 0, rps: 6, errorRate: 0, durationMs: 15000, latencyMs: { p50: 5, p95: 10, p99: 15 } } }));
      }
      return { directory: dir, run: { runId, profiles: [{ name: 'baseline', result: 'results/baseline.json' }, { name: 'normal', result: 'results/normal.json' }] } };
    },
    async analyze() { events.push('analyze'); return { availability: { traces: true }, traceSummary: { requests: 110, databaseSpans: 222, externalClientSpans: 0 }, findings: [] }; },
    async report() { events.push('report'); return { findings: [] }; },
    ...overrides,
  };
}

test('one-command audit reuses healthy infrastructure and runs measurement, analysis, then report with measured summary', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t), output = [];
  const options = { config: join(t.cwd, 'perflens.config.json') };
  const result = await runCompleteAudit(options, new AbortController().signal, line => output.push(line), deps);
  assert.deepEqual(deps.events, ['status', 'audit', 'endpoints:/orders', 'analyze', 'report']);
  assert.equal(result.run.runId, runId);
  assert.match(output.join('\n'), /PERFORMANCE/);
  assert.match(output.join('\n'), /baseline\s+20 requests · 6\.00 RPS · p95 10\.00 ms · errors 0\.00%/);
  assert.match(output.join('\n'), /No evidence-backed bottlenecks/);
  assert.match(output.join('\n'), /PostgreSQL spans\s+222/);
  assert.match(output.join('\n'), /✓ Observability ready/);
  assert.doesNotMatch(output.join('\n'), /OTLP traces endpoint|host\.docker\.internal|set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
  assert.match(output.join('\n'), /Grafana: http:\/\/127\.0\.0\.1:3001/);
  assert.match(output.join('\n'), new RegExp(runId));
});

test('all-failed completed profiles are labeled inconclusive without inventing a root cause', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t);
  const originalAudit = deps.audit.bind(deps);
  deps.audit = async options => {
    const executed = await originalAudit(options);
    for (const profile of ['baseline', 'normal']) {
      const file = join(executed.directory, `results/${profile}.json`);
      const result = JSON.parse(await readFile(file, 'utf8'));
      result.metrics.successfulRequests = 0;
      result.metrics.failedRequests = result.metrics.requests;
      result.metrics.errorRate = 1;
      result.metrics.latencyMs.p95 = 5000;
      await writeFile(file, JSON.stringify(result));
    }
    return executed;
  };
  const output = [];
  await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, line => output.push(line), deps);
  const text = output.join('\n');
  assert.match(text, /Performance assessment inconclusive — all measured requests failed/);
  assert.match(text, /No successful-response latency baseline is available/);
  assert.match(text, /baseline\s+20 requests/);
  assert.match(text, /p95 5000\.00 ms · errors 100\.00%/);
  assert.match(text, /No root cause is inferred from failed requests alone/);
  assert.doesNotMatch(text, /No evidence-backed bottlenecks met the configured thresholds/);
  assert.match(text, /✓ Audit complete/);
});

test('partial failed requests remain a measured error rate rather than an all-failed assessment', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t);
  const originalAudit = deps.audit.bind(deps);
  deps.audit = async options => {
    const executed = await originalAudit(options);
    const file = join(executed.directory, 'results/normal.json');
    const result = JSON.parse(await readFile(file, 'utf8'));
    result.metrics.successfulRequests = 60;
    result.metrics.failedRequests = 30;
    result.metrics.errorRate = 1 / 3;
    await writeFile(file, JSON.stringify(result));
    return executed;
  };
  const output = [];
  await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, line => output.push(line), deps);
  const text = output.join('\n');
  assert.doesNotMatch(text, /Performance assessment inconclusive — all measured requests failed/);
  assert.match(text, /errors 33\.33%/);
  assert.match(text, /No evidence-backed bottlenecks met the configured thresholds/);
});

test('a k6/audit failure is stage-labelled and never proceeds to analysis or report', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t, { async audit() { deps.events.push('audit'); throw new Error('k6 exited 1 after HTTP 500 responses'); } });
  await assert.rejects(runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, () => undefined, deps), error => /Load execution failed.*k6 exited 1 after HTTP 500/.test(error.message) && /Load test: failed or incomplete/.test(error.message) && !/Load test: not started/.test(error.message) && /Analysis: not run/.test(error.message) && /Report: not generated/.test(error.message));
  assert.deepEqual(deps.events, ['status', 'audit']);
});
test('HTTP 401 preflight explicitly reports that load, analysis, and report did not run', async t => {
  t.cwd = await fixture(t); const deps = mockDependencies(t, { async audit() { deps.events.push('audit'); throw new Error('Target preflight returned HTTP 401 for GET /api/private'); } });
  let failure;
  try { await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, () => undefined, deps); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.match(failure.message, /Audit stopped before load testing/);
  assert.match(failure.message, /Load test: not started/);
  assert.match(failure.message, /Analysis: not run/);
  assert.match(failure.message, /Report: not generated/);
  assert.match(failure.remediation, /target\.headers.*environment-variable references/);
  assert.deepEqual(deps.events, ['status', 'audit']);
});

test('missing correlated telemetry fails after preserving audit evidence and skips reporting', async t => {
  t.cwd = await fixture(t); const deps = mockDependencies(t, { async analyze() { deps.events.push('analyze'); return { availability: { traces: false }, traceSummary: { requests: 0, databaseSpans: 0, externalClientSpans: 0 }, findings: [] }; } });
  const output = [];
  let failure;
  try { await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, line => output.push(line), deps); }
  catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /Evidence analysis failed.*No correlated request traces/);
  assert.match(failure.message, /Load test: completed \(evidence preserved\)/);
  assert.match(failure.message, /Report: not generated/);
  assert.deepEqual(deps.events, ['status', 'audit', 'endpoints:/orders', 'analyze']);
  assert.match(await readFile(join(t.cwd, '.perflens', 'runs', runId, 'telemetry/metadata.json'), 'utf8'), /grafana/);
  const endpoint = await otlpTracesEndpoint(join(t.cwd, '.perflens', 'infra'));
  assert.ok(failure.remediation.includes(endpoint));
  assert.doesNotMatch(output.join('\n'), /OTLP traces endpoint/);
  assert.ok(failure.remediation.includes(endpoint));
});

test('stale partial current-project infrastructure is repaired before audit without claiming reuse', async t => {
  t.cwd = await fixture(t);
  let statusCount = 0;
  const deps = mockDependencies(t, {
    infrastructure: () => ({
      async status() { deps.events.push(`status-${++statusCount}`); return statusCount === 1 ? [{ service: 'otel-collector', ready: true }, { service: 'tempo', ready: false }, { service: 'prometheus', ready: true }, { service: 'grafana', ready: true }] : infraServices.map(service => ({ service, ready: true })); },
      async up(timeout, forceRecreate) { deps.events.push(`recover:${timeout}:${forceRecreate}`); },
    }),
  });
  await deps.ready;
  const output = [];
  await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, line => output.push(line), deps);
  assert.deepEqual(deps.events.slice(0, 4), ['status-1', 'recover:120000:true', 'status-2', 'audit']);
  assert.match(output.join('\n'), /Current project infrastructure is missing, stale, or unhealthy/);
  assert.doesNotMatch(output.join('\n'), /Observability infrastructure already ready/);
});

test('orphaned persisted ports with no current-project containers trigger recovery despite unrelated healthy stacks', async t => {
  t.cwd = await fixture(t);
  let statusCalls = 0;
  const deps = mockDependencies(t, {
    infrastructure: () => ({
      async status() {
        statusCalls++;
        deps.events.push(`status-${statusCalls}`);
        return statusCalls === 1
          ? infraServices.map(service => ({ service, state: 'not created', ready: false, failed: false }))
          : infraServices.map(service => ({ service, state: 'ready', ready: true, failed: false }));
      },
      async up(timeout, forceRecreate) { deps.events.push(`recover:${timeout}:${forceRecreate}`); },
    }),
  });
  await deps.ready;
  await writeFile(join(t.cwd, '.perflens', 'infra', '.env'), 'GRAFANA_PORT=3003\nPROMETHEUS_PORT=9098\nTEMPO_PORT=3208\nOTLP_GRPC_PORT=4332\nOTLP_HTTP_PORT=4333\nOTEL_HEALTH_PORT=13140\n');
  const output = [];
  await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, line => output.push(line), deps);
  assert.deepEqual(deps.events.slice(0, 4), ['status-1', 'recover:120000:true', 'status-2', 'audit']);
  assert.match(output.join('\n'), /not created/);
  assert.doesNotMatch(output.join('\n'), /Observability infrastructure already ready/);
});

test('run-scoped endpoint override reaches audit without changing saved project configuration', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t), endpoints = [{ method: 'GET', path: '/api/industries' }, { method: 'GET', path: '/api/templates' }];
  await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json'), endpoints, confirmMultipleEndpoints: true }, new AbortController().signal, () => undefined, deps);
  assert.ok(deps.events.includes('endpoints:/api/industries,/api/templates'));
  const saved = JSON.parse(await readFile(join(t.cwd, 'perflens.config.json'), 'utf8'));
  assert.deepEqual(saved.audit.endpoints, [{ method: 'GET', path: '/orders' }]);
});

test('a changed single endpoint cannot reach load without explicit approval', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t);
  await assert.rejects(runCompleteAudit({ config: join(t.cwd, 'perflens.config.json'), endpoints: [{ method: 'GET', path: '/private' }] }, new AbortController().signal, () => undefined, deps), /Selected endpoints require explicit load-test approval/);
  assert.deepEqual(deps.events, []);
});

test('bounded load is never started when explicit load approval is denied', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t);
  await assert.rejects(runCompleteAudit({ config: join(t.cwd, 'perflens.config.json'), approveLoad: async () => false }, new AbortController().signal, () => undefined, deps), /Audit permission was not granted/);
  assert.ok(!deps.events.includes('audit'));
  assert.ok(!deps.events.includes('analyze'));
  assert.ok(!deps.events.includes('report'));
});

test('application readiness completes before telemetry preflight/load orchestration begins', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t, { async activateInstrumentation() { deps.events.push('application-ready'); return { mode: 'docker', service: 'api', restarted: true, endpoint: 'http://host.docker.internal:4319/v1/traces' }; } });
  await runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, () => undefined, deps);
  assert.ok(deps.events.indexOf('application-ready') < deps.events.indexOf('audit'));
  assert.ok(deps.events.indexOf('audit') < deps.events.indexOf('analyze'));
});

test('readiness failure is accurately staged and prevents load, analysis, and report', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t, { async activateInstrumentation() { deps.events.push('readiness-failed'); throw new ApplicationReadinessError('Application service api is running, but the audit target did not become reachable within 60 seconds: http://localhost:3400/orders', 'No load was started.'); } });
  await assert.rejects(runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, () => undefined, deps), error => /Application readiness failed/.test(error.message) && /Load test: not started/.test(error.message) && /Analysis: not run/.test(error.message) && /Report: not generated/.test(error.message));
  assert.deepEqual(deps.events, ['status', 'readiness-failed']);
});
