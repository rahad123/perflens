const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { validateAudit, selectProfiles, durationMs } = require('../dist/audit/config');
const { validateConfig, resolveTargetHeaders } = require('../dist/config/project');
const { RunStore, runId, listRuns } = require('../dist/audit/storage');
const { completedEvidenceError, normalize, readSamples } = require('../dist/audit/results');
const { execute, k6Environment } = require('../dist/audit/process');
const { K6Runner } = require('../dist/audit/k6');
const { audit } = require('../dist/audit/service');
const { checkTarget, checkInstrumentation } = require('../dist/audit/preflight');
const { CliError } = require('../dist/utils/errors');
const base = { project: { name: 'test' }, target: { baseUrl: 'http://127.0.0.1:3002' }, observability: { serviceName: 'test' } };
const config = { ...base, audit: { endpoints: [{ method: 'GET', path: '/orders' }] } };
async function temp(t) { const path = await mkdtemp(join(tmpdir(), 'perflens-audit-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function summary() {
  return { state: { testRunDurationMs: 1000 }, metrics: { http_reqs: { type: 'counter', contains: 'default', values: { count: 4, rate: 4 } }, http_req_failed: { type: 'rate', contains: 'default', values: { passes: 1, fails: 3, rate: 0.25 } }, http_req_duration: { type: 'trend', contains: 'time', values: { avg: 20, med: 18, min: 10, max: 30, 'p(90)': 27, 'p(95)': 29, 'p(99)': 29.8 } } } };
}
function samples() {
  return [
    { type: 'Point', metric: 'http_reqs', data: { value: 1, tags: { status: '500', name: 'GET /orders' }, time: '2026-09-30T00:00:00Z' } },
    ...[1, 2, 3].map(i => ({ type: 'Point', metric: 'http_reqs', data: { value: 1, tags: { status: '200', name: 'GET /orders' }, time: `2026-09-30T00:00:00.00${i}Z` } })),
    ...[10, 20, 30, 40].map((value, i) => ({ type: 'Point', metric: 'http_req_duration', data: { value, tags: { name: 'GET /orders' }, time: `2026-09-30T00:00:00.00${i + 1}Z` } })),
    { type: 'Point', metric: 'perflens_request_wall_ms', data: { value: 100, time: '2026-09-30T00:00:00.200Z' } },
    { type: 'Point', metric: 'perflens_request_wall_ms', data: { value: 100, time: '2026-09-30T00:00:00.250Z' } },
    { type: 'Point', metric: 'perflens_request_wall_ms', data: { value: 50, time: '2026-09-30T00:00:00.270Z' } },
    { type: 'Point', metric: 'perflens_request_wall_ms', data: { value: 50, time: '2026-09-30T00:00:00.280Z' } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
}
function fakeDependencies(extra = {}) {
  const runner = {
    version: async () => 'k6 v2.3.0 test fixture',
    prepare: async dir => writeFile(join(dir, 'load-test.js'), '// test fixture'),
    profile: async (dir, plan) => {
      await writeFile(plan.summaryFile, JSON.stringify(summary()));
      await writeFile(join(dir, 'raw', `${plan.profile}.samples.ndjson`), samples());
      return { code: 0, signal: null, timedOut: false, cancelled: false, stdout: '' };
    },
  };
  return { runner, infrastructure: async () => ({ composeProject: 'test', readiness: [], localUrls: { tempo: 'http://127.0.0.1:3200' } }), target: async () => {}, instrumentation: async () => {}, write: () => {}, ...extra };
}
async function project(dir) { const path = join(dir, 'perflens.config.json'); await writeFile(path, JSON.stringify(config)); return path; }
async function stored(dir) { const runs = await listRuns(dir); return JSON.parse(await readFile(join(dir, '.perflens/runs', runs[0].id, 'run.json'))); }

test('audit defaults are bounded; peak and stress require explicit selection', () => {
  assert.deepEqual(selectProfiles(), ['baseline', 'normal']);
  assert.deepEqual(selectProfiles('stress, baseline'), ['baseline', 'stress']);
  const value = validateAudit(config.audit);
  assert.equal(value.profiles.normal.vus, 3); assert.equal(value.timeoutMs, 5000);
  for (const input of ['', 'baseline,baseline', 'all', 'normal,']) assert.throws(() => selectProfiles(input), CliError);
});
test('config rejects unsafe workloads, endpoints, unsupported fields, and remote targets', () => {
  for (const profile of [{ vus: 51 }, { vus: 0 }, { vus: 1.5 }, { duration: '121s' }, { duration: '1h' }, { duration: '0s' }, { paceMs: 0 }, { paceMs: 249 }, { rate: 10000 }]) {
    assert.throws(() => validateAudit({ ...config.audit, profiles: { normal: profile } }), CliError);
  }
  for (const endpoints of [[], [{ method: 'POST', path: '/orders' }], [{ method: 'GET', path: '//remote.test' }], [{ method: 'GET', path: '/orders?token=secret' }], [{ method: 'GET', path: '/../admin' }], [{ method: 'GET', path: '/x', headers: { Authorization: 'secret' } }]]) {
    assert.throws(() => validateAudit({ endpoints }), CliError);
  }
  assert.throws(() => validateConfig({ ...config, target: { baseUrl: 'https://remote.test' } }), CliError);
  assert.throws(() => validateAudit({ ...config.audit, timeoutMs: 15001 }), CliError);
  assert.equal(durationMs('120s'), 120000);
  assert.deepEqual(validateConfig(base), base, 'Phase 1 config remains valid');
});
test('request headers require env references for credentials and resolve only in memory', () => {
  const secret = 'PERFLENS_TEST_SECRET_7f93a1';
  const target = { baseUrl: 'http://127.0.0.1:3002', headers: { Authorization: 'Bearer ${PERFLENS_AUTH_TOKEN}', 'X-Api-Key': '${PERFLENS_API_KEY}', 'X-Tenant': 'tenant-a' } };
  const validated = validateConfig({ ...base, target });
  const resolved = resolveTargetHeaders(validated.target.headers, { PERFLENS_AUTH_TOKEN: secret, PERFLENS_API_KEY: secret });
  assert.equal(resolved.Authorization, `Bearer ${secret}`); assert.equal(resolved['X-Api-Key'], secret);
  assert.doesNotMatch(JSON.stringify(validated), new RegExp(secret));
  assert.throws(() => validateConfig({ ...base, target: { ...target, headers: { Authorization: 'Bearer literal-secret' } } }), /environment-variable reference/);
  assert.throws(() => resolveTargetHeaders(target.headers, {}), /PERFLENS_AUTH_TOKEN.*not set/);
});
test('run IDs and directories are exclusive; finalized stores reject overwrites and path escapes', async t => {
  assert.equal(new Set(Array.from({ length: 100 }, runId)).size, 100);
  const dir = await temp(t); const a = await RunStore.create(dir), b = await RunStore.create(dir);
  assert.notEqual(a.directory, b.directory); assert.match(a.id, /^pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}$/);
  await assert.rejects(a.write(`../${b.id}/run.json`, { status: 'failed' }), /inside its own run directory/);
  await a.finalize({ status: 'completed' }); await assert.rejects(a.write('run.json', {}), /finalized/);
  await assert.rejects(a.finalize({ status: 'failed' }), /finalized/);
  const queued = await RunStore.create(dir);
  const firstWrite = queued.write('run.json', { status: 'running' });
  const finalWrite = queued.finalize({ status: 'completed' });
  await Promise.all([firstWrite, finalWrite]);
  assert.equal(JSON.parse(await readFile(join(queued.directory, 'run.json'))).status, 'completed');
  await assert.rejects(queued.write('run.json', { status: 'failed' }), /finalized/);
  assert.equal(JSON.parse(await readFile(join(a.directory, 'run.json'))).status, 'completed');
});
test('k6 2.3 Rate.passes counts failed requests; counters, rates, duration and percentiles normalize exactly', async t => {
  const file = join(await temp(t), 'samples.ndjson'); await writeFile(file, samples());
  const evidence = await readSamples(file); assert.equal(evidence.maxObservedInFlight, 3);
  const plan = { schemaVersion: 1, runId: 'fixture', profile: 'normal', baseUrl: base.target.baseUrl, endpoints: config.audit.endpoints, workload: validateAudit(config.audit).profiles.normal, timeoutMs: 5000 };
  const result = normalize(summary(), plan, 'start', 'end', 'completed', evidence);
  assert.equal(result.metrics.requests, 4); assert.equal(result.metrics.failedRequests, 1);
  assert.equal(result.metrics.successfulRequests, 3); assert.equal(result.metrics.errorRate, 0.25);
  assert.equal(result.metrics.rps, 4); assert.equal(result.metrics.durationMs, 1000);
  assert.deepEqual(result.metrics.latencyMs, { average: 20, min: 10, p50: 18, p90: 27, p95: 29, p99: 29.8, max: 30 });
  assert.deepEqual(result.metrics.statusDistribution, { '200': 3, '500': 1 });
  assert.deepEqual(result.metrics.endpointResults[0].target, { method: 'GET', path: '/orders' });
  assert.equal(result.metrics.endpointResults[0].metrics.requests, 4);
  assert.equal(result.metrics.endpointResults[0].metrics.latencyMs.p50, 25);
  assert.equal(result.metrics.endpointResults[0].metrics.latencyMs.p95, 38.5);
  const swapped = summary(); swapped.metrics.http_req_failed.values = { passes: 3, fails: 1, rate: 0.75 };
  assert.match(completedEvidenceError(swapped, evidence), /status samples disagree/);
  assert.equal(normalize({}, plan, 'start', 'end', 'failed', null).metrics.latencyMs.p99, null);
});
test('successful default audit persists raw/normalized results and windows without overwriting earlier runs', async t => {
  const dir = await temp(t), path = await project(dir);
  const first = await audit({ config: path }, undefined, fakeDependencies());
  const before = await readFile(join(first.directory, 'run.json'), 'utf8');
  const second = await audit({ config: path, profile: 'baseline' }, undefined, fakeDependencies());
  assert.notEqual(first.run.runId, second.run.runId);
  assert.equal(await readFile(join(first.directory, 'run.json'), 'utf8'), before);
  assert.deepEqual(first.run.profiles.map(p => p.name), ['baseline', 'normal']);
  assert.equal(first.run.status, 'completed');
  assert.ok(first.run.profiles.every(p => p.startedAt <= p.endedAt));
  const metadata = JSON.parse(await readFile(join(first.directory, 'telemetry/metadata.json')));
  assert.equal(metadata.auditRunId, first.run.runId); assert.ok(metadata.auditEndedAt);
  const results = await readdir(join(first.directory, 'results')); assert.deepEqual(results.sort(), ['baseline.json', 'normal.json']);
});
test('multiple endpoint workloads require explicit approval before audit begins', async t => {
  const dir = await temp(t), path = await project(dir);
  const parsed = JSON.parse(await readFile(path)); parsed.audit.endpoints.push({ method: 'GET', path: '/products' }); await writeFile(path, JSON.stringify(parsed));
  let versionCalled = false;
  const deps = fakeDependencies(); deps.runner.version = async () => { versionCalled = true; return 'k6 v2.3.0 test'; };
  await assert.rejects(audit({ config: path }, undefined, deps), /Multiple endpoints require explicit load-test approval/);
  assert.equal(versionCalled, false);
});
test('authentication context reaches target preflight and k6 but never enters audit artifacts', async t => {
  const dir = await temp(t), path = await project(dir), secret = 'PERFLENS_TEST_SECRET_7f93a1';
  const parsed = JSON.parse(await readFile(path)); parsed.target.headers = { Authorization: 'Bearer ${PERFLENS_TEST_TOKEN}', 'X-Tenant': 'tenant-a' }; await writeFile(path, JSON.stringify(parsed));
  const previous = process.env.PERFLENS_TEST_TOKEN; process.env.PERFLENS_TEST_TOKEN = secret;
  const observed = [];
  const deps = fakeDependencies({ target: async (_config, _endpoint, _run, _signal, headers) => observed.push(headers) });
  const originalProfile = deps.runner.profile;
  deps.runner.profile = async (...args) => { observed.push(args[3]); return originalProfile(...args); };
  try {
    const result = await audit({ config: path }, undefined, deps);
    assert.deepEqual(observed[0], { Authorization: `Bearer ${secret}`, 'X-Tenant': 'tenant-a' });
    assert.deepEqual(observed[1], observed[0]);
    const files = [];
    async function walk(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = join(directory, entry.name); if (entry.isDirectory()) await walk(full); else files.push(await readFile(full, 'utf8')); } }
    await walk(result.directory);
    assert.ok(files.every(value => !value.includes(secret)), 'resolved request secret must not enter any run artifact');
    assert.ok(files.some(value => value.includes('PERFLENS_TEST_TOKEN')));
  } finally { if (previous === undefined) delete process.env.PERFLENS_TEST_TOKEN; else process.env.PERFLENS_TEST_TOKEN = previous; }
});
test('failed preflight leaves failed artifacts and never starts k6 load', async t => {
  const dir = await temp(t), path = await project(dir); let started = false;
  const deps = fakeDependencies({ infrastructure: async () => { throw new CliError('not ready', 'start infra'); } });
  deps.runner.profile = async () => { started = true; throw new Error('should not run'); };
  await assert.rejects(audit({ config: path }, undefined, deps), /Audit failed/);
  assert.equal(started, false); const run = await stored(dir);
  assert.equal(run.status, 'failed'); assert.ok(run.errors.length); assert.ok(run.endedAt);
});
test('target preflight sends correlation without redirects, rejects non-2xx, and cancels response bodies', async () => {
  const original = global.fetch;
  const valid = validateConfig({ ...config, target: { baseUrl: 'http://localhost:3002' } });
  let status = 302, cancelled = 0;
  global.fetch = async (url, options) => {
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-PerfLens-Run-Id'], 'test-run');
    assert.equal(options.headers['X-PerfLens-Profile'], 'preflight');
    assert.equal(options.headers.Authorization, 'Bearer runtime-token');
    return { status, body: { cancel: async () => cancelled++ } };
  };
  try {
    await assert.rejects(checkTarget(valid, valid.audit.endpoints[0], 'test-run', new AbortController().signal, { Authorization: 'Bearer runtime-token' }), /HTTP 302/);
    status = 200;
    await checkTarget(valid, valid.audit.endpoints[0], 'test-run', new AbortController().signal, { Authorization: 'Bearer runtime-token' });
    assert.equal(cancelled, 2);
    global.fetch = async () => { throw new Error('sensitive transport detail'); };
    await assert.rejects(checkTarget(valid, valid.audit.endpoints[0], 'test-run', new AbortController().signal), error => /Target preflight failed/.test(error.message) && !error.message.includes('sensitive'));
  } finally { global.fetch = original; }
});
test('instrumentation preflight requires the correlated Tempo server span before k6 starts', async t => {
  const dir = await temp(t), path = await project(dir); let profilesStarted = false;
  const deps = fakeDependencies({ instrumentation: async () => { throw new CliError('Target is reachable but no correlated span exists.', 'Add the bootstrap. No load was started.'); } });
  deps.runner.profile = async () => { profilesStarted = true; throw new Error('k6 must not start'); };
  await assert.rejects(audit({ config: path }, undefined, deps), /no correlated span/);
  assert.equal(profilesStarted, false);
  assert.equal((await stored(dir)).status, 'failed');
});
test('Tempo instrumentation probe is run/profile scoped and accepts a real correlated trace', async () => {
  const original = global.fetch; let query;
  global.fetch = async url => { query = new URL(url); return { ok: true, json: async () => ({ traces: [{ traceID: 'abc' }] }) }; };
  try {
    await checkInstrumentation('http://127.0.0.1:3200', 'service-a', 'run-a', new AbortController().signal, { attempts: 1, intervalMs: 0, timeoutMs: 1000 });
    assert.deepEqual(query.searchParams.getAll('tags'), ['service.name=service-a', 'perflens.audit.run_id=run-a', 'perflens.audit.profile=preflight']);
    global.fetch = async () => ({ ok: true, json: async () => ({ traces: [] }) });
    await assert.rejects(checkInstrumentation('http://127.0.0.1:3200', 'service-a', 'run-b', new AbortController().signal, { attempts: 1, intervalMs: 0, timeoutMs: 1000 }), /could not find its correlated OpenTelemetry server span/);
  } finally { global.fetch = original; }
});
test('missing correlated trace provides the selected Docker host endpoint without starting load', async () => {
  const original = global.fetch;
  global.fetch = async url => new URL(url).pathname === '/ready'
    ? { ok: true, body: null }
    : { ok: true, json: async () => ({ traces: [] }) };
  try {
    await assert.rejects(
      checkInstrumentation('http://127.0.0.1:3200', 'service-a', 'run-c', new AbortController().signal, { attempts: 1, intervalMs: 0, timeoutMs: 1000 }, 'http://host.docker.internal:4335/v1/traces'),
      error => /could not find its correlated OpenTelemetry server span/.test(error.message)
        && /127\.0\.0\.1 refers to that container/.test(error.remediation)
        && /host\.docker\.internal:4335\/v1\/traces/.test(error.remediation)
        && /No load was started/.test(error.remediation),
    );
  } finally { global.fetch = original; }
});
test('telemetry preflight distinguishes unavailable Tempo from a reachable target without traces', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('connection refused'); };
  try {
    await assert.rejects(
      checkInstrumentation('http://127.0.0.1:3200', 'service-a', 'run-d', new AbortController().signal, { attempts: 1, intervalMs: 0, timeoutMs: 1000 }),
      error => /PerfLens Tempo is unavailable/.test(error.message) && /No load was started/.test(error.remediation),
    );
  } finally { global.fetch = original; }
});
test('failed k6 preserves completed profiles and failure evidence, never completing the audit', async t => {
  const dir = await temp(t), path = await project(dir); const deps = fakeDependencies();
  const original = deps.runner.profile;
  deps.runner.profile = async (dir, plan) => ({ ...await original(dir, plan), code: plan.profile === 'normal' ? 1 : 0 });
  await assert.rejects(audit({ config: path }, undefined, deps), /Audit failed/);
  const run = await stored(dir); assert.equal(run.profiles[0].status, 'completed'); assert.equal(run.profiles[1].status, 'failed');
  const result = JSON.parse(await readFile(join(dir, '.perflens/runs', run.runId, 'results/normal.json')));
  assert.equal(result.status, 'failed'); assert.equal(result.metrics.requests, 4);
});
test('missing raw evidence is a failed execution, not a fabricated successful run', async t => {
  const dir = await temp(t), path = await project(dir); const deps = fakeDependencies();
  deps.runner.profile = async () => ({ code: 0, signal: null, timedOut: false, cancelled: false, stdout: '' });
  await assert.rejects(audit({ config: path, profile: 'baseline' }, undefined, deps), /inconsistent structured evidence/);
  assert.equal((await stored(dir)).status, 'failed');
});
test('missing summaries/samples, mismatched counts, malformed NDJSON, and zero requests fail completed profiles', async t => {
  const { unlink } = require('node:fs/promises');
  const mutations = [
    ['missing summary', async (_dir, plan) => unlink(plan.summaryFile)],
    ['missing samples', async (dir, plan) => unlink(join(dir, 'raw', `${plan.profile}.samples.ndjson`))],
    ['request-count mismatch', async (_dir, plan) => { const value = summary(); value.metrics.http_reqs.values.count = 5; await writeFile(plan.summaryFile, JSON.stringify(value)); }],
    ['malformed NDJSON', async (dir, plan) => writeFile(join(dir, 'raw', `${plan.profile}.samples.ndjson`), '{broken json\n')],
    ['zero requests', async (dir, plan) => {
      const value = summary(); value.metrics.http_reqs.values = { count: 0, rate: 0 };
      value.metrics.http_req_failed.values = { passes: 0, fails: 0, rate: 0 }; value.state.testRunDurationMs = 0;
      await writeFile(plan.summaryFile, JSON.stringify(value)); await writeFile(join(dir, 'raw', `${plan.profile}.samples.ndjson`), '');
    }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async st => {
    const dir = await temp(st), path = await project(dir), deps = fakeDependencies();
    const profile = deps.runner.profile;
    deps.runner.profile = async (runDir, plan, signal) => { const execution = await profile(runDir, plan, signal); await mutate(runDir, plan); return execution; };
    await assert.rejects(audit({ config: path, profile: 'baseline' }, undefined, deps), /inconsistent structured evidence/i);
    const run = await stored(dir); assert.equal(run.status, 'failed'); assert.equal(run.profiles[0].status, 'failed');
    const result = JSON.parse(await readFile(join(dir, '.perflens/runs', run.runId, 'results/baseline.json')));
    assert.equal(result.status, 'failed');
  });
});
test('cancellation persists cancelled status and stops further profiles', async t => {
  const dir = await temp(t), path = await project(dir), controller = new AbortController();
  const deps = fakeDependencies();
  deps.runner.profile = async () => { controller.abort(); return { code: 130, signal: 'SIGINT', timedOut: false, cancelled: true, stdout: '' }; };
  await assert.rejects(audit({ config: path }, controller.signal, deps), error => error.exitCode === 130);
  const run = await stored(dir); assert.equal(run.status, 'cancelled'); assert.equal(run.profiles[0].status, 'cancelled'); assert.equal(run.profiles[1].status, 'created');
});
test('k6 runner isolates environment, uses local-only output, and pins supported summary adapter version', async t => {
  process.env.K6_OUT = 'cloud'; process.env.HTTPS_PROXY = 'https://secret.test';
  try { assert.equal(k6Environment().K6_OUT, undefined); assert.equal(k6Environment().HTTPS_PROXY, undefined); } finally { delete process.env.K6_OUT; delete process.env.HTTPS_PROXY; }
  assert.equal(k6Environment({ PERFLENS_REQUEST_HEADER_0: 'runtime-only' }).PERFLENS_REQUEST_HEADER_0, 'runtime-only');
  assert.equal(k6Environment().PERFLENS_REQUEST_HEADER_0, undefined);
  const runner = new K6Runner(async () => ({ code: 0, stdout: 'k6 v2.4.0', signal: null, cancelled: false, timedOut: false }));
  await assert.rejects(runner.version(new AbortController().signal), /k6 2.3.x/);
  const dir = await temp(t); const store = await RunStore.create(dir); let args;
  let childOptions;
  const mock = new K6Runner(async (_, a, options) => { args = a; childOptions = options; return {}; });
  await mock.prepare(store.directory);
  const secret = 'PERFLENS_TEST_SECRET_7f93a1';
  await mock.profile(store.directory, { schemaVersion: 1, runId: store.id, profile: 'baseline', baseUrl: base.target.baseUrl, workload: validateAudit(config.audit).profiles.baseline, endpoints: config.audit.endpoints, requestHeaderEnv: [{ name: 'Authorization', envName: 'PERFLENS_REQUEST_HEADER_0' }], timeoutMs: 5000, summaryFile: join(store.directory, 'raw/baseline.summary.json') }, new AbortController().signal, { Authorization: `Bearer ${secret}` });
  assert.ok(args.includes('--no-usage-report')); assert.ok(args.includes('--include-system-env-vars=true')); assert.ok(!args.includes('cloud'));
  assert.equal(childOptions.env.PERFLENS_REQUEST_HEADER_0, `Bearer ${secret}`);
  assert.ok(args.every(argument => !argument.includes(secret)));
});
test('process execution reports missing binary and terminates on cancellation/deadline', async () => {
  await assert.rejects(execute('perflens-nonexistent-test-binary', [], { timeoutMs: 500 }), /Could not execute/);
  const control = new AbortController(); const timer = setTimeout(() => control.abort(), 150);
  const cancelled = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 5000, signal: control.signal });
  clearTimeout(timer); assert.equal(cancelled.cancelled, true); assert.notEqual(cancelled.code, 0);
  const deadline = await execute(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 });
  assert.equal(deadline.timedOut, true);
});
test('project lock prevents overlapping audit executions and is released on failure', async t => {
  const { withAuditLock } = require('../dist/audit/lock');
  const dir = await temp(t);
  await withAuditLock(dir, async () => {
    await assert.rejects(withAuditLock(dir, async () => {}), /project lock/);
  });
  await assert.rejects(withAuditLock(dir, async () => { throw new Error('fixture failure'); }), /fixture failure/);
  await withAuditLock(dir, async () => {});
});
