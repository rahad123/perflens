const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReportModel, renderHtml, renderMarkdown } = require('../dist');

const runId = 'pfl_20260930T120000000Z_12345678-1234-1234-1234-123456789abc';
function fixture({ findings = [], traces = 0 } = {}) {
  const target = { method: 'GET', path: '/orders' };
  const findingSet = findings;
  const profile = { schemaVersion: 1, runId, profile: 'normal', status: 'completed', target: { baseUrl: 'http://localhost:3002', endpoints: [target] }, workload: { executor: 'constant-vus', vus: 5, duration: '10s', durationMs: 10000 }, metrics: { requests: 200, successfulRequests: 198, failedRequests: 2, errorRate: 0.01, rps: 20, latencyMs: { p50: 12, p90: 30, p95: 45, p99: 90 } } };
  const runProfile = { name: 'normal', status: 'completed', startedAt: '2026-09-30T12:00:00Z', endedAt: '2026-09-30T12:00:10Z', result: 'results/normal.json' };
  return { run: { schemaVersion: 1, runId, status: 'completed', startedAt: '2026-09-30T12:00:00Z', endedAt: '2026-09-30T12:00:10Z', target: { baseUrl: 'http://user:password@localhost:3002/path?token=do-not-leak' }, serviceName: 'demo', profiles: [runProfile] }, profiles: [{ runProfile, result: profile }], analysis: { schemaVersion: 1, runId, findings: findingSet, traceSummary: { requests: traces, databaseSpans: 4, externalClientSpans: 1 }, availability: { traces: true }, unsupported: ['CPU resource metrics are unavailable.'] }, findingsArtifact: { schemaVersion: 1, runId, findings: findingSet }, evidence: { schemaVersion: 1, runId, traces: [], telemetry: { source: 'test' } } };
}
function finding(overrides = {}) { return { id: 'finding-1', ruleId: 'database.repeated-operation', category: 'database', title: 'Repeated <query> pattern', summary: 'Observed & measured.', severity: 'P2', confidence: 'high', target: { method: 'GET', path: '/orders' }, profiles: ['normal'], evidence: [{ observation: 'Repeated operation affected 8 requests.', source: 'Tempo snapshot', value: { ratio: 0.8 } }], metrics: { queriesPerRequest: 21 }, ...overrides }; }
function build(input = fixture(), generatedAt = '2026-09-30T12:01:00.000Z') { return buildReportModel({ ...input, generatedAt }); }

test('builds workload, observed metrics, evidence and real analysis limitations into a report model', () => {
  const model = build(fixture({ traces: 12 }));
  assert.equal(model.run.target, 'http://localhost:3002');
  assert.equal(model.perflensVersion, 'unknown');
  assert.equal(model.workload.profiles[0].workload.vus, 5);
  assert.equal(model.performanceSummary.profiles[0].metrics.requests, 200);
  assert.equal(model.performanceSummary.profiles[0].metrics.latencyMs.p95, 45);
  assert.equal(model.evidenceSummary.requestTraces, 12);
  assert.ok(model.limitations.some(item => item.includes('CPU')));
});

test('preserves Phase 3 severity and confidence exactly while ordering by severity then stable key', () => {
  const p2 = finding({ id: 'z', ruleId: 'z.rule', severity: 'P2', confidence: 'high' });
  const p1 = finding({ id: 'a', ruleId: 'a.rule', severity: 'P1', confidence: 'low' });
  const model = build(fixture({ findings: [p2, p1] }));
  assert.deepEqual(model.findings.map(item => [item.severity, item.confidence]), [['P1', 'low'], ['P2', 'high']]);
});

test('zero-finding runs remain valid and produce conservative report language', () => {
  const model = build();
  assert.equal(model.findingsSummary.total, 0);
  assert.match(renderMarkdown(model), /No evidence-backed performance bottleneck met the configured detection thresholds/);
  assert.match(renderHtml(model), /No evidence-backed performance bottleneck met the configured detection thresholds/);
});

test('Markdown and HTML escape untrusted finding text and sanitize secret values and URL queries', () => {
  const secretFinding = finding({ title: '<img src=x onerror=alert(1)>', summary: 'Bearer abc.def and https://example.test/pay?token=private', evidence: [{ observation: 'password=topsecret; Authorization: Bearer abc.def', source: 'SQL SELECT * FROM x WHERE name=\'secret-sql\'' }] });
  const model = build(fixture({ findings: [secretFinding] }));
  const md = renderMarkdown(model); const html = renderHtml(model); const serialized = JSON.stringify(model);
  for (const text of ['topsecret', 'abc.def', 'private', 'secret-sql', 'user:password']) {
    assert.ok(!md.includes(text), `markdown leaked ${text}`);
    assert.ok(!html.includes(text), `html leaked ${text}`);
    assert.ok(!serialized.includes(text), `model leaked ${text}`);
  }
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'));
});

test('missing optional metrics render as unavailable without fabricated values', () => {
  const input = fixture(); input.profiles[0].result.metrics.rps = null; input.profiles[0].result.metrics.latencyMs.p99 = null;
  const md = renderMarkdown(build(input));
  assert.match(md, /Not available/);
  assert.doesNotMatch(md, /p99 \(ms\).*90/);
});

test('rejects incomplete runs, unsupported artifacts, mismatched findings, and unsupported report inputs', () => {
  const invalid = fixture(); invalid.run.status = 'failed';
  assert.throws(() => build(invalid), /completed schema version 1/);
  const mismatch = fixture(); mismatch.findingsArtifact.findings = [finding()];
  assert.throws(() => build(mismatch), /disagree/);
  const unsupported = fixture(); unsupported.analysis.schemaVersion = 2;
  assert.throws(() => build(unsupported), /malformed or unsupported/);
});

test('identical artifacts produce deterministically ordered semantic content', () => {
  const input = fixture({ findings: [finding({ id: 'two', ruleId: 'z.rule' }), finding({ id: 'one', ruleId: 'a.rule', severity: 'P1' })] });
  const first = build(input, '2026-09-30T12:00:00Z'); const second = build(input, '2026-09-30T12:30:00Z');
  first.generatedAt = second.generatedAt;
  assert.deepEqual(first, second);
  assert.equal(renderMarkdown(first), renderMarkdown(second));
});
