const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { validateAudit, selectProfiles, durationMs } = require('../dist/audit/config');
const { validateConfig } = require('../dist/config/project');
const { RunStore, runId, listRuns } = require('../dist/audit/storage');
const { normalize, readSamples } = require('../dist/audit/results');
const { execute, k6Environment } = require('../dist/audit/process');
const { K6Runner } = require('../dist/audit/k6');
const { audit } = require('../dist/audit/service');
const { checkTarget } = require('../dist/audit/preflight');
const { CliError } = require('../dist/utils/errors');
const base = { project: { name: 'test' }, target: { baseUrl: 'http://127.0.0.1:3002' }, observability: { serviceName: 'test' } };
const config = { ...base, audit: { endpoints: [{ method: 'GET', path: '/orders' }] } };
async function temp(t) { const path = await mkdtemp(join(tmpdir(), 'perflens-audit-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function summary() {
  return { state: { testRunDurationMs: 1000 }, metrics: { http_reqs: { values: { count: 2, rate: 2 } }, http_req_failed: { values: { passes: 1, fails: 1, rate: 0.5 } }, http_req_duration: { values: { avg: 20, med: 20, min: 10, max: 30, 'p(90)': 28, 'p(95)': 29, 'p(99)': 29.8 } } } };
}
function samples() {
  return [
    { type: 'Point', metric: 'http_reqs', data: { value: 1, tags: { status: '200', name: 'GET /orders' }, time: '2026-09-30T00:00:00Z' } },
    { type: 'Point', metric: 'http_reqs', data: { value: 1, tags: { status: '500', name: 'GET /orders' }, time: '2026-09-30T00:00:00Z' } },
    { type: 'Point', metric: 'perflens_request_wall_ms', data: { value: 100, time: '2026-09-30T00:00:00.200Z' } },
    { type: 'Point', metric: 'perflens_request_wall_ms', data: { value: 100, time: '2026-09-30T00:00:00.250Z' } },
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
  return { runner, infrastructure: async () => ({ composeProject: 'test', readiness: [], localUrls: {} }), target: async () => {}, write: () => {}, ...extra };
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
test('run IDs and directories are exclusive; finalization prevents historical writes', async t => {
  assert.equal(new Set(Array.from({ length: 100 }, runId)).size, 100);
  const dir = await temp(t); const a = await RunStore.create(dir), b = await RunStore.create(dir);
  assert.notEqual(a.directory, b.directory); assert.match(a.id, /^pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}$/);
  await a.finalize({ status: 'completed' }); await assert.rejects(a.write('run.json', {}), /finalized/);
  assert.equal(JSON.parse(await readFile(join(a.directory, 'run.json'))).status, 'completed');
});
test('normalization uses structured k6 values, derives success, records overlap, and leaves missing values null', async t => {
  const file = join(await temp(t), 'samples.ndjson'); await writeFile(file, samples());
  const evidence = await readSamples(file); assert.equal(evidence.maxObservedInFlight, 2);
  const plan = { schemaVersion: 1, runId: 'fixture', profile: 'normal', baseUrl: base.target.baseUrl, endpoints: config.audit.endpoints, workload: validateAudit(config.audit).profiles.normal, timeoutMs: 5000 };
  const result = normalize(summary(), plan, 'start', 'end', 'completed', evidence);
  assert.equal(result.metrics.requests, 2); assert.equal(result.metrics.successfulRequests, 1);
  assert.equal(result.metrics.failedRequests, 1); assert.equal(result.metrics.errorRate, 0.5);
  assert.equal(result.metrics.latencyMs.p99, 29.8); assert.equal(result.metrics.rps, 2);
  assert.deepEqual(result.metrics.statusDistribution, { '200': 1, '500': 1 });
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
    return { status, body: { cancel: async () => cancelled++ } };
  };
  try {
    await assert.rejects(checkTarget(valid, valid.audit.endpoints[0], 'test-run', new AbortController().signal), /HTTP 302/);
    status = 200;
    await checkTarget(valid, valid.audit.endpoints[0], 'test-run', new AbortController().signal);
    assert.equal(cancelled, 2);
    global.fetch = async () => { throw new Error('sensitive transport detail'); };
    await assert.rejects(checkTarget(valid, valid.audit.endpoints[0], 'test-run', new AbortController().signal), error => /Target preflight failed/.test(error.message) && !error.message.includes('sensitive'));
  } finally { global.fetch = original; }
});
test('failed k6 preserves completed profiles and failure evidence, never completing the audit', async t => {
  const dir = await temp(t), path = await project(dir); const deps = fakeDependencies();
  const original = deps.runner.profile;
  deps.runner.profile = async (dir, plan) => ({ ...await original(dir, plan), code: plan.profile === 'normal' ? 1 : 0 });
  await assert.rejects(audit({ config: path }, undefined, deps), /Audit failed/);
  const run = await stored(dir); assert.equal(run.profiles[0].status, 'completed'); assert.equal(run.profiles[1].status, 'failed');
  const result = JSON.parse(await readFile(join(dir, '.perflens/runs', run.runId, 'results/normal.json')));
  assert.equal(result.status, 'failed'); assert.equal(result.metrics.requests, 2);
});
test('missing raw evidence is a failed execution, not a fabricated successful run', async t => {
  const dir = await temp(t), path = await project(dir); const deps = fakeDependencies();
  deps.runner.profile = async () => ({ code: 0, signal: null, timedOut: false, cancelled: false, stdout: '' });
  await assert.rejects(audit({ config: path, profile: 'baseline' }, undefined, deps), /inconsistent structured evidence/);
  assert.equal((await stored(dir)).status, 'failed');
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
  const runner = new K6Runner(async () => ({ code: 0, stdout: 'k6 v2.4.0', signal: null, cancelled: false, timedOut: false }));
  await assert.rejects(runner.version(new AbortController().signal), /k6 2.3.x/);
  const dir = await temp(t); const store = await RunStore.create(dir); let args;
  const mock = new K6Runner(async (_, a) => { args = a; return {}; });
  await mock.prepare(store.directory);
  await mock.profile(store.directory, { schemaVersion: 1, runId: store.id, profile: 'baseline', baseUrl: base.target.baseUrl, workload: validateAudit(config.audit).profiles.baseline, endpoints: config.audit.endpoints, timeoutMs: 5000, summaryFile: join(store.directory, 'raw/baseline.summary.json') }, new AbortController().signal);
  assert.ok(args.includes('--no-usage-report')); assert.ok(args.includes('--include-system-env-vars=false')); assert.ok(!args.includes('cloud'));
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
