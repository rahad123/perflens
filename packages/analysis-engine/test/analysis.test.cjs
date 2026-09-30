const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeEvidence, compareWorkloadIntensity, normalizeSql, sanitizeDependency, validateEvidence } = require('../dist/index.js');

const RUN = 'pfl_20260930T120000000Z_12345678-1234-1234-1234-123456789abc';
function profile(name, vus, p95, p99 = p95 * 1.2, errorRate = 0, requests = 100) {
  return {
    schemaVersion: 1, runId: RUN, profile: name, status: 'completed', startedAt: '2026-09-30T12:00:00.000Z', endedAt: '2026-09-30T12:00:10.000Z',
    target: { endpoints: [{ method: 'GET', path: '/orders' }] }, workload: { executor: 'constant-vus', vus, durationMs: 10000, paceMs: 500, requestTimeoutMs: 5000 },
    metrics: { requests, successfulRequests: Math.round(requests * (1 - errorRate)), failedRequests: Math.round(requests * errorRate), errorRate, rps: requests / 10, latencyMs: { p50: p95 / 2, p90: p95 * .8, p95, p99 } },
  };
}
function span(traceId, id, parent, kind, startMs, endMs, name, attributes = {}) {
  const nanos = value => String(BigInt(value) * 1_000_000n);
  return { traceId, spanId: String(id), parentSpanId: parent === null ? null : String(parent), profile: 'normal', kind, startTimeUnixNano: nanos(startMs), endTimeUnixNano: nanos(endMs), name, attributes };
}
function root(traceId, index, duration = 100, profileName = 'normal') {
  return span(traceId, `root${index}`, null, 'server', 0, duration, 'GET /orders', { 'perflens.audit.run_id': RUN, 'perflens.audit.profile': profileName, 'http.route': '/orders' });
}
function evidence({ profiles = [profile('baseline', 1, 50), profile('normal', 3, 55)], traces = [] } = {}) {
  return { schemaVersion: 1, runId: RUN, target: { baseUrl: 'http://localhost:3002', serviceName: 'demo', endpoints: [{ method: 'GET', path: '/orders' }] }, auditWindow: { startedAt: '2026-09-30T12:00:00.000Z', endedAt: '2026-09-30T12:01:00.000Z' }, profiles, traces, telemetry: { source: 'fixture', collectedAt: '2026-09-30T12:02:00.000Z', traceCount: new Set(traces.map(x => x.traceId)).size, spanCount: traces.length, truncated: false }, sources: ['run.json', 'results/baseline.json', 'results/normal.json'] };
}
function nplusTraces(count = 20) {
  const spans = [];
  for (let i = 0; i < count; i++) {
    const id = `t${i}`;
    spans.push(root(id, i));
    spans.push(span(id, `list${i}`, `root${i}`, 'client', 1, 2, 'pg.query: SELECT * FROM orders LIMIT 20', { 'db.system': 'postgresql', 'db.query.sanitized': 'SELECT * FROM orders LIMIT ?' }));
    for (let q = 0; q < 20; q++) spans.push(span(id, `q${i}-${q}`, `root${i}`, 'client', 3 + q * 2, 4 + q * 2, 'pg.query: SELECT * FROM order_items WHERE order_id = $1', { 'db.system': 'postgresql', 'db.query.sanitized': 'SELECT * FROM order_items WHERE order_id = $?' }));
  }
  return spans;
}

test('normalizes SQL literals and numeric parameters without retaining secrets', () => {
  assert.equal(normalizeSql("SELECT * FROM orders WHERE email = 'private@example.test' AND id = 782 -- token=secret"), 'select * from orders where email = ? and id = ?');
  assert.equal(sanitizeDependency('https://user:pass@payments.example/api/123?token=secret#x'), 'payments.example/api/:id');
  assert.equal(sanitizeDependency('not a URL'), 'external dependency');
});

test('positive repeated database operation rule requires repeated equivalent SQL across many requests', () => {
  const result = analyzeEvidence(evidence({ traces: nplusTraces() }));
  const finding = result.findings.find(item => item.ruleId === 'database.repeated-operation');
  assert.ok(finding);
  assert.equal(finding.confidence, 'high');
  assert.equal(finding.metrics.tracesAffected, 20);
  assert.equal(finding.metrics.medianOperationsPerRequest, 21);
  assert.match(finding.summary, /likely N\+1/);
  assert.equal(result.traceSummary.databaseSpans, 420);
});

test('same target/rule across profiles is one finding with complete per-profile evidence', () => {
  const baselineSpans = nplusTraces(10).map(item => ({
    ...item, traceId: `baseline-${item.traceId}`, profile: 'baseline',
    attributes: { ...item.attributes, ...(item.kind === 'server' ? { 'perflens.audit.profile': 'baseline' } : {}) },
  }));
  const normalSpans = nplusTraces(10).map(item => ({ ...item, traceId: `normal-${item.traceId}` }));
  const result = analyzeEvidence(evidence({ profiles: [profile('baseline', 1, 50), profile('normal', 3, 50)], traces: [...baselineSpans, ...normalSpans] }));
  const findings = result.findings.filter(item => item.ruleId === 'database.repeated-operation');
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].profiles, ['baseline', 'normal']);
  assert.deepEqual(Object.keys(findings[0].metrics.profileMetrics), ['baseline', 'normal']);
  assert.equal(findings[0].evidence.length, 6);
});

test('one configured dynamic target can match a sanitized route template', () => {
  const traces = nplusTraces(10).map(item => item.kind === 'server' ? { ...item, name: 'GET /orders/:segment', attributes: { ...item.attributes, 'http.route': '/orders/:segment' } } : item);
  const input = evidence({ traces });
  input.target.endpoints = [{ method: 'GET', path: '/orders/123' }];
  input.profiles.forEach(item => { item.target.endpoints = [{ method: 'GET', path: '/orders/123' }]; });
  const finding = analyzeEvidence(input).findings.find(item => item.ruleId === 'database.repeated-operation');
  assert.equal(finding.target.path, '/orders/123');
});

test('many fast different queries do not trigger N+1 or database dominance', () => {
  const traces = [];
  for (let i = 0; i < 20; i++) {
    traces.push(root(`d${i}`, i));
    for (let q = 0; q < 10; q++) traces.push(span(`d${i}`, `q${i}-${q}`, `root${i}`, 'client', q + 1, q + 2, `pg.query: SELECT * FROM table_${q} WHERE id = ${q}`, { 'db.system': 'postgresql' }));
  }
  const result = analyzeEvidence(evidence({ traces }));
  assert.equal(result.findings.some(item => item.ruleId.startsWith('database.')), false);
});

test('generic SELECT span names without a relation-bearing query shape are not grouped as repeated queries', () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    traces.push(root(`generic${i}`, i));
    for (let q = 0; q < 12; q++) traces.push(span(`generic${i}`, `g${i}-${q}`, `root${i}`, 'client', 2 + q, 3 + q, 'SELECT', { 'db.system': 'postgresql' }));
  }
  assert.equal(analyzeEvidence(evidence({ traces })).findings.some(item => item.ruleId === 'database.repeated-operation'), false);
});

test('repeated SQL in one request with remaining requests clean is below consistency guard', () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    traces.push(root(`sparse-repeat${i}`, i));
    if (i === 0) for (let q = 0; q < 12; q++) traces.push(span(`sparse-repeat${i}`, `sr${q}`, `root${i}`, 'client', 2 + q, 3 + q, 'pg.query: SELECT * FROM items WHERE id = 7', { 'db.system': 'postgresql', 'db.query.sanitized': 'SELECT * FROM items WHERE id = ?' }));
  }
  assert.equal(analyzeEvidence(evidence({ traces })).findings.some(item => item.ruleId === 'database.repeated-operation'), false);
});

test('repeated fast query shape stays a low-severity candidate when request impact is small', () => {
  const traces = nplusTraces(10);
  const finding = analyzeEvidence(evidence({ traces })).findings.find(item => item.ruleId === 'database.repeated-operation');
  assert.ok(finding);
  assert.equal(finding.severity, 'P2');
  assert.match(finding.summary, /candidate/);
});

test('slow repeated DB query is measured without misclassifying one query per request as N+1', () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    traces.push(root(`slow${i}`, i, 300));
    traces.push(span(`slow${i}`, `db${i}`, `root${i}`, 'client', 20, 220, 'pg.query: SELECT * FROM orders WHERE id::text = o.id::text', { 'db.system': 'postgresql', 'db.query.sanitized': 'SELECT * FROM orders WHERE id::text = o.id::text' }));
  }
  const result = analyzeEvidence(evidence({ traces }));
  assert.ok(result.findings.some(item => item.ruleId === 'database.slow-operation'));
  assert.equal(result.findings.some(item => item.ruleId === 'database.repeated-operation'), false);
});

test('a slow operation seen in only a few requests is below the consistency guard', () => {
  const traces = [];
  for (let i = 0; i < 20; i++) {
    traces.push(root(`sparse${i}`, i, 1000));
    if (i < 3) for (let q = 0; q < 5; q++) traces.push(span(`sparse${i}`, `db${i}-${q}`, `root${i}`, 'client', 10, 210, 'pg.query: SELECT * FROM orders WHERE id = 7', { 'db.system': 'postgresql', 'db.query.sanitized': 'select * from orders where id = ?' }));
  }
  const result = analyzeEvidence(evidence({ traces }));
  assert.equal(result.findings.some(item => item.ruleId === 'database.slow-operation'), false);
});

test('overlapping database intervals are unioned and never exceed the request window', () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    traces.push(root(`overlap${i}`, i, 100));
    for (let q = 0; q < 6; q++) traces.push(span(`overlap${i}`, `db${i}-${q}`, `root${i}`, 'client', 10, 80, `pg.query: SELECT * FROM t WHERE id = ${q}`, { 'db.system': 'postgresql' }));
  }
  const result = analyzeEvidence(evidence({ traces }));
  const finding = result.findings.find(item => item.ruleId === 'database.time-dominance');
  assert.ok(finding);
  assert.equal(finding.metrics.medianDatabaseWindowRatio, 0.7);
  assert.ok(finding.metrics.medianDatabaseWindowRatio <= 1);
});

test('single trace and sparse database samples are below trace-rule sample guards', () => {
  const result = analyzeEvidence(evidence({ traces: nplusTraces(1) }));
  assert.equal(result.findings.some(item => item.category === 'database'), false);
  assert.equal(result.availability.traces, true);
});

test('a consistently slow external dependency is identified without a DB claim', () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    traces.push(root(`ext${i}`, i, 1000));
    traces.push(span(`ext${i}`, `http${i}`, `root${i}`, 'client', 50, 800, 'GET', { 'url.sanitized': '127.0.0.1/dependency', 'http.request.method': 'GET' }));
  }
  const result = analyzeEvidence(evidence({ traces }));
  assert.ok(result.findings.some(item => item.ruleId === 'dependency.latency-dominance'));
  assert.equal(result.findings.some(item => item.category === 'database'), false);
  assert.ok(result.findings[0].severity);
});

test('one request with many slow dependency calls cannot dominate request-level aggregation', () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    traces.push(root(`one-heavy${i}`, i, 1000));
    if (i === 0) for (let call = 0; call < 20; call++) traces.push(span(`one-heavy${i}`, `many${call}`, `root${i}`, 'client', 50 + call, 800 + call, 'GET', { 'url.sanitized': '127.0.0.1/dependency', 'http.request.method': 'GET' }));
  }
  assert.equal(analyzeEvidence(evidence({ traces })).findings.some(item => item.ruleId === 'dependency.latency-dominance'), false);
});

test('one slow external call is insufficient evidence for a persistent dependency finding', () => {
  const traces = [root('one', 1, 1000), span('one', 'http', 'root1', 'client', 50, 900, 'GET', { 'url.sanitized': 'payments.example/api/payment', 'http.request.method': 'GET' })];
  const result = analyzeEvidence(evidence({ traces }));
  assert.equal(result.findings.some(item => item.category === 'dependency'), false);
});

test('PostgreSQL connection spans with a peer address are not external HTTP evidence', () => {
  const traces = [];
  for (let i = 0; i < 10; i++) {
    traces.push(root(`pg${i}`, i, 1000));
    traces.push(span(`pg${i}`, `connect${i}`, `root${i}`, 'client', 10, 900, 'HTTP client', { 'db.namespace': 'perflens', 'url.sanitized': 'postgres' }));
  }
  const result = analyzeEvidence(evidence({ traces }));
  assert.equal(result.findings.some(item => item.category === 'dependency'), false);
});

test('load degradation requires an actual higher-concurrency comparison and a meaningful delta', () => {
  const worsened = analyzeEvidence(evidence({ profiles: [profile('baseline', 1, 100, 140), profile('normal', 3, 150, 230)] }));
  assert.ok(worsened.findings.some(item => item.ruleId === 'load.latency-degradation'));
  const stable = analyzeEvidence(evidence({ profiles: [profile('baseline', 1, 100), profile('normal', 3, 110)] }));
  assert.equal(stable.findings.some(item => item.ruleId.startsWith('load.')), false);
  const noComparison = analyzeEvidence(evidence({ profiles: [profile('baseline', 1, 100)] }));
  assert.equal(noComparison.findings.some(item => item.ruleId.startsWith('load.')), false);
  const material = analyzeEvidence(evidence({ profiles: [profile('baseline', 1, 300, 400), profile('normal', 3, 600, 800)] }));
  assert.equal(material.findings.find(item => item.ruleId === 'load.latency-degradation').severity, 'P1');
  const severe = analyzeEvidence(evidence({ profiles: [profile('baseline', 1, 300, 400), profile('normal', 3, 2400, 2800)] }));
  assert.equal(severe.findings.find(item => item.ruleId === 'load.latency-degradation').severity, 'P0');
  const throughputDrop = [profile('baseline', 1, 100), profile('normal', 3, 105)];
  throughputDrop[0].metrics.rps = 10; throughputDrop[1].metrics.rps = 8;
  const observed = analyzeEvidence(evidence({ profiles: throughputDrop }));
  const throughput = observed.findings.find(item => item.ruleId === 'load.throughput-degradation');
  assert.ok(throughput);
  assert.match(throughput.title, /Observed throughput decrease/);
  assert.match(throughput.summary, /does not establish saturation/);
  assert.match(throughput.evidence[1].observation, /Observed throughput changed/);
});

test('workload comparison is explicit, deterministic, and requires comparable constant-VU profiles', () => {
  const before = profile('baseline', 1, 100);
  const after = profile('normal', 3, 100);
  assert.deepEqual(compareWorkloadIntensity(before, after), { comparable: true, reason: 'same constant-VU model and configuration with higher VUs', beforeLoad: 1, afterLoad: 3 });
  const variants = [
    pair => { pair[1].workload.executor = 'constant-arrival-rate'; },
    pair => { pair[1].workload.vus = 1; },
    pair => { pair[0].workload.vus = 3; pair[1].workload.vus = 2; },
    pair => { pair[1].workload.paceMs = 250; },
    pair => { pair[1].workload.requestTimeoutMs = 3000; },
    pair => { pair[1].target.endpoints = [{ method: 'GET', path: '/performance/slow-query' }]; },
    pair => { pair[0].target.endpoints.push({ method: 'GET', path: '/health' }); pair[1].target.endpoints.push({ method: 'GET', path: '/health' }); },
  ];
  for (const change of variants) {
    const pair = [structuredClone(before), structuredClone(after)]; change(pair);
    assert.equal(compareWorkloadIntensity(...pair).comparable, false);
    pair[0].metrics.rps = 10; pair[1].metrics.rps = 5;
    const result = analyzeEvidence(evidence({ profiles: pair }));
    assert.equal(result.findings.some(item => item.category === 'load'), false);
  }
  const tooFew = [profile('baseline', 1, 100, 120, 0, 19), profile('normal', 3, 200, 240, 0, 19)];
  assert.equal(analyzeEvidence(evidence({ profiles: tooFew })).findings.some(item => item.category === 'load'), false);
});

test('error degradation is distinct from inferred component root cause', () => {
  const result = analyzeEvidence(evidence({ profiles: [profile('baseline', 1, 100, 120, 0), profile('normal', 3, 105, 125, .05)] }));
  const finding = result.findings.find(item => item.ruleId === 'load.error-degradation');
  assert.ok(finding);
  assert.equal(finding.category, 'load');
  assert.equal(finding.severity, 'P1');
  assert.equal(result.findings.some(item => item.category === 'database'), false);
});

test('low trace sample cannot produce high-confidence output and unsupported resources are explicit', () => {
  const spans = nplusTraces(5);
  const result = analyzeEvidence(evidence({ traces: spans }));
  const finding = result.findings.find(item => item.ruleId === 'database.repeated-operation');
  assert.equal(finding.confidence, 'medium');
  assert.match(result.unsupported[0], /CPU and memory/);
});

test('malformed or unsupported evidence is rejected instead of receiving an empty successful analysis', () => {
  assert.throws(() => validateEvidence({ ...evidence(), schemaVersion: 2 }), /Unsupported or malformed/);
  assert.throws(() => analyzeEvidence(evidence({ profiles: [{ ...profile('baseline', 1, 5), status: 'failed' }] })), /ineligible profile/);
  const malformed = evidence({ traces: [{ ...root('x', 1), startTimeUnixNano: 'not-nanos' }] });
  assert.throws(() => analyzeEvidence(malformed), /timestamps/);
  const inconsistent = profile('normal', 3, 100); inconsistent.metrics.successfulRequests--;
  assert.throws(() => analyzeEvidence(evidence({ profiles: [inconsistent] })), /Inconsistent completed measurements/);
  const missingPercentile = profile('normal', 3, 100); missingPercentile.metrics.latencyMs.p95 = null;
  assert.throws(() => analyzeEvidence(evidence({ profiles: [missingPercentile] })), /missing p95 latency/);
});

test('analysis output is deterministic apart from analyzedAt metadata', () => {
  const input = evidence({ traces: nplusTraces(10) });
  const first = analyzeEvidence(input, '2026-09-30T12:03:00.000Z');
  const second = analyzeEvidence(input, '2026-09-30T12:04:00.000Z');
  assert.deepEqual({ ...first, analyzedAt: null }, { ...second, analyzedAt: null });
});
