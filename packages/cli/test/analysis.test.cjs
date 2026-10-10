const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../dist/analysis/service.js');
const { collectTempoEvidence, collectTempoEvidenceWithRetry, normalizeTempoTrace } = require('../dist/analysis/tempo.js');

const runId = 'pfl_20260930T120000000Z_12345678-1234-1234-1234-123456789abc';
function profile(name, vus) {
  return { schemaVersion: 1, runId, profile: name, status: 'completed', startedAt: '2026-09-30T12:00:00.000Z', endedAt: '2026-09-30T12:00:10.000Z', target: { endpoints: [{ method: 'GET', path: '/performance/n-plus-one' }] }, workload: { vus, durationMs: 10000 }, metrics: { requests: 40, successfulRequests: 40, failedRequests: 0, errorRate: 0, rps: 4, latencyMs: { p50: 5, p90: 10, p95: 12, p99: 15 } } };
}

test('analysis integration loads a finalized run and offline evidence, writes reusable JSON findings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-analysis-'));
  try {
    const config = { project: { name: 'fixture' }, target: { baseUrl: 'http://localhost:3002' }, observability: { serviceName: 'demo' }, audit: { endpoints: [{ method: 'GET', path: '/performance/n-plus-one' }] } };
    await fs.writeFile(path.join(root, 'perflens.config.json'), JSON.stringify(config));
    const directory = path.join(root, '.perflens', 'runs', runId);
    await fs.mkdir(path.join(directory, 'results'), { recursive: true });
    await fs.mkdir(path.join(directory, 'analysis'), { recursive: true });
    const runProfile = { name: 'normal', status: 'completed', startedAt: '2026-09-30T12:00:00.000Z', endedAt: '2026-09-30T12:00:10.000Z', result: 'results/normal.json' };
    const run = { schemaVersion: 1, runId, status: 'completed', startedAt: '2026-09-30T12:00:00.000Z', endedAt: '2026-09-30T12:00:10.000Z', target: config.target, serviceName: 'demo', profiles: [runProfile] };
    await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify(run));
    const resultProfile = profile('normal', 3);
    await fs.writeFile(path.join(directory, 'results/normal.json'), JSON.stringify(resultProfile));
    const spans = [];
    for (let i = 0; i < 5; i++) {
      const nanos = ms => String(BigInt(ms) * 1_000_000n);
      spans.push({ traceId: `trace-${i}`, spanId: `root-${i}`, parentSpanId: null, profile: 'normal', name: 'GET /performance/n-plus-one', kind: 'server', startTimeUnixNano: nanos(0), endTimeUnixNano: nanos(100), attributes: { 'perflens.audit.run_id': runId, 'perflens.audit.profile': 'normal', 'http.route': '/performance/n-plus-one' } });
      for (let q = 0; q < 8; q++) spans.push({ traceId: `trace-${i}`, spanId: `${i}-${q}`, parentSpanId: `root-${i}`, profile: 'normal', name: 'pg.query: SELECT * FROM order_items WHERE order_id = $?', kind: 'client', startTimeUnixNano: nanos(q + 1), endTimeUnixNano: nanos(q + 2), attributes: { 'db.system': 'postgresql', 'db.query.sanitized': 'select * from order_items where order_id = $?' } });
    }
    const evidence = { schemaVersion: 1, runId, target: { baseUrl: config.target.baseUrl, serviceName: 'demo', endpoints: config.audit.endpoints }, auditWindow: { startedAt: run.startedAt, endedAt: run.endedAt }, profiles: [resultProfile], traces: spans, telemetry: { source: 'fixture', collectedAt: run.endedAt, traceCount: 5, spanCount: spans.length, truncated: false }, sources: ['run.json', 'results/normal.json'] };
    await fs.writeFile(path.join(directory, 'analysis/evidence.json'), JSON.stringify(evidence));
    const output = [];
    const analysis = await analyze({ config: path.join(root, 'perflens.config.json'), offline: true }, runId, line => output.push(line));
    assert.ok(analysis.findings.some(item => item.ruleId === 'database.repeated-operation'));
    assert.ok(output.some(line => line.includes('PerfLens Analysis')));
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'analysis/analysis.json'), 'utf8'));
    const findings = JSON.parse(await fs.readFile(path.join(directory, 'analysis/findings.json'), 'utf8'));
    assert.equal(saved.runId, runId);
    assert.equal(findings.findings[0].ruleId, 'database.repeated-operation');
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'analysis/evidence.json'), 'utf8')).runId, runId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Tempo importer captures only run-matched spans and removes query values, credentials, and URL parameters', () => {
  const trace = { traceID: 'trace-safe', batches: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'demo' } }] }, scopeSpans: [{ spans: [
    { spanId: 'root', parentSpanId: '', kind: 'SPAN_KIND_SERVER', name: 'GET /orders/784?token=never', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: [{ key: 'perflens.audit.run_id', value: { stringValue: runId } }, { key: 'perflens.audit.profile', value: { stringValue: 'normal' } }, { key: 'url.path', value: { stringValue: '/orders/784' } }, { key: 'authorization', value: { stringValue: 'secret' } }] },
    { spanId: 'db', parentSpanId: 'root', kind: 'SPAN_KIND_CLIENT', name: 'pg.query:SELECT demo', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: [{ key: 'db.system.name', value: { stringValue: 'postgresql' } }, { key: 'db.query.text', value: { stringValue: "SELECT * FROM orders WHERE id = 'secret-value'" } }] },
    { spanId: 'other', kind: 'SPAN_KIND_SERVER', name: 'unrelated', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: [{ key: 'perflens.audit.run_id', value: { stringValue: 'other-run' } }] },
  ] }] }] };
  const normalized = normalizeTempoTrace(trace, 'normal', runId, 'demo', ['/orders']);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].attributes['http.route'], '/orders/:id');
  assert.equal(normalized[0].attributes.authorization, undefined);
  assert.match(normalized[1].name, /where id = \?/);
  assert.equal(normalized[1].attributes['db.system'], 'postgresql');
  assert.match(normalized[1].attributes['db.query.sanitized'], /where id = \?/);
  assert.doesNotMatch(JSON.stringify(normalized), /secret-value|authorization|never/);
});

test('Tempo importer keeps PostgreSQL error status and parent references without exception text', () => {
  const trace = { traceID: 'trace-db-error', batches: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'demo' } }] }, scopeSpans: [{ spans: [
    { spanId: 'root', kind: 'SPAN_KIND_SERVER', name: 'GET /orders', startTimeUnixNano: '1', endTimeUnixNano: '100000001', attributes: [{ key: 'perflens.audit.run_id', value: { stringValue: runId } }, { key: 'perflens.audit.profile', value: { stringValue: 'normal' } }, { key: 'http.route', value: { stringValue: '/orders' } }] },
    { spanId: 'db-error', parentSpanId: 'root', kind: 'SPAN_KIND_CLIENT', name: 'pg.query: SELECT * FROM orders WHERE id = $?', startTimeUnixNano: '2', endTimeUnixNano: '50000002', status: { code: 2, message: 'private exception and password=sentinel-value' }, attributes: [{ key: 'db.system.name', value: { stringValue: 'postgresql' } }, { key: 'db.query.text', value: { stringValue: "SELECT * FROM orders WHERE id = 'private-value'" } }] },
  ] }] }] };
  const normalized = normalizeTempoTrace(trace, 'normal', runId, 'demo', ['/orders']);
  const db = normalized.find(item => item.spanId === 'db-error');
  assert.equal(db.status, 'error');
  assert.equal(db.parentSpanId, 'root');
  assert.match(db.attributes['db.query.sanitized'], /where id = \?/);
  assert.doesNotMatch(JSON.stringify(normalized), /private exception|sentinel-value|private-value/);
});

test('Tempo normalization sanitizes PostgreSQL literal syntaxes and safely handles absent SQL attributes/status', () => {
  const sqlValues = [
    String.raw`SELECT * FROM users WHERE note = E'private\' secret-value'`,
    'SELECT * FROM users WHERE note = $body$secret-value$body$',
    'SELECT * FROM users /* outer /* nested-secret */ private-comment-tail */ WHERE id = 987654321',
    'SELECT * FROM users WHERE payload = U&\'secret-value\' AND score = 1.25e+8',
  ];
  const trace = { traceID: 'trace-sql-private', batches: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'demo' } }] }, scopeSpans: [{ spans: [
    { spanId: 'root', kind: 'SPAN_KIND_SERVER', name: 'GET /orders', startTimeUnixNano: '1', endTimeUnixNano: '100000001', attributes: [{ key: 'perflens.audit.run_id', value: { stringValue: runId } }, { key: 'perflens.audit.profile', value: { stringValue: 'normal' } }, { key: 'http.route', value: { stringValue: '/orders' } }] },
    ...sqlValues.map((sql, index) => ({ spanId: `db-${index}`, parentSpanId: 'root', kind: 'SPAN_KIND_CLIENT', name: 'pg.query', startTimeUnixNano: '2', endTimeUnixNano: '50000002', status: { code: 9, message: 'do-not-persist' }, attributes: [{ key: 'db.system.name', value: { stringValue: 'postgresql' } }, { key: 'db.operation.name', value: { stringValue: 'SELECT private-operation-secret' } }, { key: 'db.query.text', value: { stringValue: sql } }] })),
    { spanId: 'db-no-query', parentSpanId: 'root', kind: 'SPAN_KIND_CLIENT', name: 'pg.query', startTimeUnixNano: '2', endTimeUnixNano: '50000002', attributes: [{ key: 'db.system.name', value: { stringValue: 'postgresql' } }] },
  ] }] }] };
  const normalized = normalizeTempoTrace(trace, 'normal', runId, 'demo', ['/orders']);
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /secret-value|nested-secret|private-comment-tail|private-operation-secret|987654321|1\.25e\+8|do-not-persist/);
  for (const span of normalized.filter(item => item.spanId.startsWith('db-') && item.spanId !== 'db-no-query')) assert.equal(span.status, undefined, 'unknown status is omitted, not treated as OK');
  assert.equal(normalized.find(item => item.spanId === 'db-no-query').attributes['db.query.sanitized'], undefined);
  assert.doesNotMatch(normalized.find(item => item.spanId === 'db-no-query').name, /secret/i);
});

test('Tempo PostgreSQL privacy boundary drops namespaces and untrusted database metadata', () => {
  const sentinel = 'tenant-private-sentinel-9f4a';
  const trace = { traceID: 'trace-safe', batches: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'demo' } }] }, scopeSpans: [{ spans: [
    { spanId: 'root', kind: 'SPAN_KIND_SERVER', name: 'GET /orders', startTimeUnixNano: '1', endTimeUnixNano: '100000001', attributes: [{ key: 'perflens.audit.run_id', value: { stringValue: runId } }, { key: 'perflens.audit.profile', value: { stringValue: 'normal' } }, { key: 'http.route', value: { stringValue: '/orders' } }] },
    { spanId: 'safe-db', parentSpanId: 'root', kind: 'SPAN_KIND_CLIENT', name: 'pg.query', startTimeUnixNano: '2', endTimeUnixNano: '50000002', attributes: [
      { key: 'db.system.name', value: { stringValue: 'PostgreSQL' } },
      { key: 'db.namespace', value: { stringValue: sentinel } },
      { key: 'db.operation.name', value: { stringValue: sentinel } },
      { key: 'db.query.text', value: { stringValue: `SELECT * FROM orders WHERE id = 2` } },
    ] },
    { spanId: 'bad-db', parentSpanId: 'root', kind: 'SPAN_KIND_CLIENT', name: `pg.${sentinel}`, startTimeUnixNano: '2', endTimeUnixNano: '50000002', attributes: [
      { key: 'db.system.name', value: { stringValue: sentinel } },
      { key: 'db.operation.name', value: { stringValue: `SELECT ${sentinel}` } },
      { key: 'db.query.text', value: { stringValue: `SELECT * FROM orders WHERE note='${sentinel}'` } },
    ] },
    { spanId: 'unsafe-id', parentSpanId: 'root', kind: 'SPAN_KIND_CLIENT', name: `pg.query: SELECT * FROM "${sentinel} table"`, startTimeUnixNano: '2', endTimeUnixNano: '50000002', attributes: [{ key: 'db.system.name', value: { stringValue: 'postgresql' } }] },
  ] }] }] };
  const normalized = normalizeTempoTrace(trace, 'normal', runId, 'demo', ['/orders']);
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, new RegExp(sentinel));
  const safeDb = normalized.find(item => item.spanId === 'safe-db');
  assert.equal(safeDb.attributes['db.namespace'], undefined);
  assert.equal(safeDb.attributes['db.system'], 'postgresql');
  assert.equal(safeDb.attributes['db.operation.name'], undefined);
  assert.equal(safeDb.attributes['db.query.sanitized'], 'select * from orders where id = ?');
  const badDb = normalized.find(item => item.spanId === 'bad-db');
  assert.equal(badDb.attributes['db.system'], undefined);
  assert.equal(badDb.attributes['db.operation.name'], undefined);
  assert.equal(badDb.attributes['db.query.sanitized'], 'select * from orders where note = ?');
  assert.equal(badDb.name, 'database operation');
  const unsafeId = normalized.find(item => item.spanId === 'unsafe-id');
  assert.equal(unsafeId.attributes['db.query.sanitized'], undefined);
  assert.equal(unsafeId.name, 'pg.query: ');
});

test('Tempo query is bounded by service, run, profile, and audit window', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async input => {
    const url = new URL(input);
    urls.push(url);
    if (url.pathname === '/api/search') return new Response(JSON.stringify({ traces: [{ traceID: 'abc123' }] }), { status: 200 });
    return new Response(JSON.stringify({ traceID: 'abc123', batches: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'demo' } }] }, scopeSpans: [{ spans: [{ spanId: 'root', kind: 'SPAN_KIND_SERVER', name: 'GET /orders', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: [{ key: 'perflens.audit.run_id', value: { stringValue: runId } }, { key: 'perflens.audit.profile', value: { stringValue: 'normal' } }, { key: 'http.route', value: { stringValue: '/orders' } }] }] }] }] }), { status: 200 });
  };
  try {
    const result = await collectTempoEvidence('http://127.0.0.1:3200', runId, 'demo', ['/orders'], [{ profile: 'normal', startedAt: '2026-09-30T12:00:00Z', endedAt: '2026-09-30T12:00:10Z' }]);
    assert.equal(result.traceCount, 1);
    assert.equal(result.spans[0].traceId, 'abc123');
    assert.equal(result.spans[0].attributes['perflens.audit.run_id'], runId);
    assert.equal(urls.length, 2);
    assert.equal(urls[0].searchParams.get('limit'), '501');
    assert.match(urls[0].searchParams.get('q'), /service\.name = "demo"/);
    assert.match(urls[0].searchParams.get('q'), /perflens\.audit\.run_id/);
    assert.match(urls[0].searchParams.get('q'), /perflens\.audit\.profile = "normal"/);
    assert.equal(Number(urls[0].searchParams.get('end')) - Number(urls[0].searchParams.get('start')), 20);
  } finally { global.fetch = originalFetch; }
});

test('analysis waits briefly for expected run-correlated Tempo evidence before snapshotting', async () => {
  let calls = 0, waits = [];
  const result = await collectTempoEvidenceWithRetry(async () => {
    calls++;
    return calls < 3
      ? { spans: [], traceCount: 0, spanCount: 0, truncated: false }
      : { spans: [{ traceId: 'expected-run-trace' }], traceCount: 1, spanCount: 1, truncated: false };
  }, { attempts: 5, intervalMs: 400, wait: async ms => waits.push(ms) });
  assert.equal(result.traceCount, 1);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [400, 400]);
});

test('Tempo evidence retry is bounded and returns an empty snapshot only after the configured deadline', async () => {
  let calls = 0, waits = 0;
  const result = await collectTempoEvidenceWithRetry(async () => { calls++; return { spans: [], traceCount: 0, spanCount: 0, truncated: false }; }, { attempts: 3, intervalMs: 250, wait: async () => { waits++; } });
  assert.equal(result.traceCount, 0);
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test('default Tempo evidence retry is bounded to a short indexing window', async () => {
  let calls = 0, waits = 0;
  await collectTempoEvidenceWithRetry(async () => { calls++; return { spans: [], traceCount: 0, spanCount: 0, truncated: false }; }, { wait: async ms => { assert.equal(ms, 500); waits++; } });
  assert.equal(calls, 40);
  assert.equal(waits, 39);
});

test('analyze refuses missing run and rejects failed/incomplete run state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-analysis-invalid-'));
  try {
    await fs.writeFile(path.join(root, 'perflens.config.json'), JSON.stringify({ project: { name: 'fixture' }, target: { baseUrl: 'http://localhost:3000' }, observability: { serviceName: 'demo' } }));
    await assert.rejects(analyze({ config: path.join(root, 'perflens.config.json'), offline: true }, 'pfl_20260930T120000000Z_12345678-1234-1234-1234-123456789abc', () => {}), /Could not read valid JSON evidence/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
