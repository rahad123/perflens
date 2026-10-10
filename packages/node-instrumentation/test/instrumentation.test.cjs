const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { readPerfLensCorrelation, configurePerfLensOtlpEndpoint, ProjectOtlpTraceExporter } = require('../dist/index.js');
const { processCpuPercent, startProcessResourceSampler } = require('../dist/resources.js');

const runId = 'pfl_20260930T120000000Z_123e4567-e89b-12d3-a456-426614174000';

test('process CPU delta is normalized to one logical CPU and rejects invalid elapsed time', () => {
  assert.equal(processCpuPercent(50_000, 0, 100_000_000n), 50);
  assert.equal(processCpuPercent(25_000, 25_000, 100_000_000n), 50);
  assert.equal(processCpuPercent(100, 0, 0n), null);
  assert.equal(processCpuPercent(-1, 0, 10n), null);
});

test('resource sampler persists timestamped process CPU and memory samples only for active run/profile markers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'perflens-process-resource-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'phase.json');
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, active: true, runId, profile: 'baseline', startedAt: new Date().toISOString() }));
  const stop = startProcessResourceSampler({ directory, intervalMs: 500 });
  t.after(stop);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, active: true, runId, profile: 'normal', startedAt: new Date().toISOString() }));
  await new Promise(resolve => setTimeout(resolve, 1100));
  stop();
  const rows = (await readFile(join(directory, `process-${runId}.ndjson`), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.profile === 'baseline'));
  assert.ok(rows.some(row => row.profile === 'normal'));
  for (const profile of ['baseline', 'normal']) {
    const profileRows = rows.filter(row => row.profile === profile);
    assert.ok(profileRows.some(row => row.cpuPercentOneLogicalCpu === null), `${profile} boundary delta is unavailable`);
    assert.ok(profileRows.some(row => row.cpuPercentOneLogicalCpu !== null), `${profile} has an uncontaminated CPU delta`);
  }
  for (const row of rows) {
    assert.equal(row.runId, runId);
    assert.equal(row.source, 'node-process');
    assert.ok(Number.isFinite(Date.parse(row.timestamp)));
    assert.equal(row.cpuNormalization, 'one-logical-cpu');
    assert.ok(Number.isInteger(row.processId));
    assert.equal(row.processId, process.pid, 'sample records the actual emitting Node process PID');
    assert.match(row.processInstanceId, /^[0-9a-f-]{36}$/i);
    assert.ok(row.rssBytes > 0 && row.heapUsedBytes >= 0 && row.heapTotalBytes >= row.heapUsedBytes && row.externalBytes >= 0);
  }
  assert.equal(new Set(rows.map(row => row.processInstanceId)).size, 1, 'one live Node process keeps one identity across profile markers');
});

test('maps valid PerfLens audit correlation headers without copying unrelated headers', () => {
  assert.deepEqual(readPerfLensCorrelation({
    'x-perflens-run-id': runId, 'x-perflens-profile': 'normal', authorization: 'Bearer secret', cookie: 'secret=1',
  }), { runId, profile: 'normal' });
});

test('allows absent and malformed correlation without creating metadata', () => {
  assert.deepEqual(readPerfLensCorrelation({}), {});
  assert.deepEqual(readPerfLensCorrelation({ 'x-perflens-run-id': 'not-a-run', 'x-perflens-profile': 'stress' }), {});
  assert.deepEqual(readPerfLensCorrelation({ 'x-perflens-run-id': runId, 'x-perflens-profile': 'unknown' }), { runId });
  assert.deepEqual(readPerfLensCorrelation({ 'x-perflens-run-id': 'x'.repeat(100000), 'x-perflens-profile': 'normal' }), {});
});

test('configures the OpenTelemetry traces exporter from the consumer selected Collector port', async t => {
  for (const port of [4318, 4319]) {
    const project = await mkdtemp(join(tmpdir(), 'perflens-otel-env-'));
    t.after(() => rm(project, { recursive: true, force: true }));
    await mkdir(join(project, '.perflens', 'infra'), { recursive: true });
    await writeFile(join(project, '.perflens', 'infra', '.env'), `OTLP_HTTP_PORT=${port}\n`);
    const env = {};
    assert.equal(configurePerfLensOtlpEndpoint(project, env), `http://127.0.0.1:${port}/v1/traces`);
    assert.equal(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, `http://127.0.0.1:${port}/v1/traces`);
  }
});

test('host consumers retain loopback while Docker consumers may use the same authoritative port through host.docker.internal', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-otel-container-host-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const infra = join(project, '.perflens', 'infra'); await mkdir(infra, { recursive: true });
  await writeFile(join(infra, '.env'), 'OTLP_HTTP_PORT=4335\n');
  assert.equal(configurePerfLensOtlpEndpoint(project, {}), 'http://127.0.0.1:4335/v1/traces');
  const containerEnv = { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://host.docker.internal:4335/v1/traces' };
  assert.equal(configurePerfLensOtlpEndpoint(project, containerEnv), 'http://host.docker.internal:4335/v1/traces');
});

test('Docker consumer endpoint cannot select a different port or an arbitrary remote host', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-otel-container-conflict-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, '.perflens', 'infra'), { recursive: true });
  await writeFile(join(project, '.perflens', 'infra', '.env'), 'OTLP_HTTP_PORT=4335\n');
  assert.throws(() => configurePerfLensOtlpEndpoint(project, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://host.docker.internal:4333/v1/traces' }), /does not match this PerfLens project.*4335/);
  assert.throws(() => configurePerfLensOtlpEndpoint(project, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example:4335/v1/traces' }), /supported local host/);
});

test('a previously PerfLens-managed OTLP endpoint follows recovered infrastructure ports and preserves its consumer host', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-otel-recovered-port-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const infra = join(project, '.perflens', 'infra'); await mkdir(infra, { recursive: true });
  const env = {};
  await writeFile(join(infra, '.env'), 'OTLP_HTTP_PORT=4333\n');
  assert.equal(configurePerfLensOtlpEndpoint(project, env), 'http://127.0.0.1:4333/v1/traces');
  await writeFile(join(infra, '.env'), 'OTLP_HTTP_PORT=4335\n');
  assert.equal(configurePerfLensOtlpEndpoint(project, env), 'http://127.0.0.1:4335/v1/traces');
  assert.equal(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, 'http://127.0.0.1:4335/v1/traces');
  env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://host.docker.internal:4335/v1/traces';
  assert.equal(configurePerfLensOtlpEndpoint(project, env), 'http://host.docker.internal:4335/v1/traces');
  await writeFile(join(infra, '.env'), 'OTLP_HTTP_PORT=4336\n');
  assert.equal(configurePerfLensOtlpEndpoint(project, env), 'http://host.docker.internal:4336/v1/traces');
});

test('rejects a conflicting explicit traces endpoint instead of silently exporting to another port', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-otel-conflict-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, '.perflens', 'infra'), { recursive: true });
  await writeFile(join(project, '.perflens', 'infra', '.env'), 'OTLP_HTTP_PORT=4319\n');
  assert.throws(() => configurePerfLensOtlpEndpoint(project, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' }), /does not match this PerfLens project.*4319/);
});

test('exporter started before first audit switches to the selected project endpoint on export', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-otel-late-infra-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const endpoints = [], callbacks = [];
  const exporter = new ProjectOtlpTraceExporter(project, {}, url => {
    endpoints.push(url);
    return { export(_spans, callback) { callbacks.push(callback); callback({ code: 0 }); }, shutdown: async () => {} };
  });
  exporter.export([], () => {});
  assert.equal(endpoints[0], undefined);
  await mkdir(join(project, '.perflens', 'infra'), { recursive: true });
  await writeFile(join(project, '.perflens', 'infra', '.env'), 'OTLP_HTTP_PORT=4319\n');
  exporter.export([], () => {});
  assert.equal(endpoints[1], 'http://127.0.0.1:4319/v1/traces');
  assert.equal(callbacks.length, 2);
  await exporter.shutdown();
});
