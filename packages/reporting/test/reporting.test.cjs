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
  const carried = model.findings.find(item => item.id === 'z');
  assert.equal(carried.ruleId, p2.ruleId);
  assert.deepEqual(carried.evidence, p2.evidence);
  assert.deepEqual(carried.metrics, p2.metrics);
});

test('zero-finding runs remain valid and produce conservative report language', () => {
  const model = build();
  assert.equal(model.findingsSummary.total, 0);
  assert.match(renderMarkdown(model), /No evidence-backed performance bottleneck met the configured detection thresholds/);
  const html = renderHtml(model);
  assert.match(html, /No evidence-backed performance bottleneck met the configured detection thresholds/);
  assert.match(html, /<svg[^>]+aria-label="p50, p95, and p99 latency by load profile"/);
  assert.match(html, /Latency by profile/);
  assert.match(html, /p99/);
});

test('HTML comparison visualizations use only measured percentiles and conditionally show component evidence', () => {
  const model = build(fixture({ findings: [finding({ category: 'dependency', title: 'External dependency latency', evidence: [{ observation: '75% contribution in 12 traces', source: 'Tempo' }] })] }));
  const html = renderHtml(model);
  assert.match(html, /75% contribution in 12 traces/);
  assert.match(html, /External dependency evidence/);
  assert.doesNotMatch(html, /Database evidence/);
  assert.match(html, /width="710\.00"/);
  const escaped = renderHtml(build(fixture({ findings: [finding({ title: '<svg onload=alert(1)>', summary: '<script>owned</script>' })] })));
  assert.match(escaped, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(escaped, /&lt;script&gt;owned&lt;\/script&gt;/);
  assert.doesNotMatch(escaped, /<script>owned<\/script>/);
});

test('redacts adversarial credentials, cookie values, database/dependency URLs, query secrets, and SQL literals at model construction', () => {
  const cases = [
    ['Bearer authorization', 'Authorization: Bearer bearerSentinel'],
    ['Basic authorization', 'Authorization: Basic basicSentinel=='],
    ['Cookie', 'Cookie: session=cookieSentinel; theme=dark'],
    ['Set-Cookie', 'Set-Cookie: session=setCookieSentinel; HttpOnly; Secure'],
    ['PostgreSQL URL', 'postgres://user:pgSentinel@db.internal:5432/app'],
    ['PostgreSQL long URL', 'postgresql://user:pgLongSentinel@db.internal/app'],
    ['Redis URL', 'redis://user:redisSentinel@cache.internal:6379/0'],
    ['Redis password-only URL', 'redis://:redisPasswordOnlySentinel@cache.internal:6379/0'],
    ['Redis TLS URL', 'rediss://user:redisTlsSentinel@cache.internal:6380/0'],
    ['HTTP credentials', 'http://alice:httpSentinel@example.test/path'],
    ['HTTPS credentials', 'https://alice:httpsSentinel@example.test/path'],
    ['api_key query', 'https://api.test/path?api_key=apiKeySentinel&keep=yes'],
    ['access_token query', 'https://api.test/path?access_token=accessTokenSentinel'],
    ['password query', 'https://api.test/path?password=passwordSentinel'],
    ['secret query', 'https://api.test/path?secret=secretSentinel'],
    ['token query', 'https://api.test/path?token=tokenSentinel'],
    ['SQL email literal', "SELECT * FROM customers WHERE email = 'customer@example.com'"],
    ['SQL token literal', "SELECT * FROM events WHERE token = 'sqlTokenSentinel'"],
  ];
  for (const [label, input] of cases) {
    const model = build(fixture({ findings: [finding({ summary: input })] }));
    const outputs = [JSON.stringify(model, null, 2), renderMarkdown(model), renderHtml(model)].join('\n');
    assert.doesNotMatch(outputs, /bearerSentinel|basicSentinel|cookieSentinel|setCookieSentinel|pgSentinel|pgLongSentinel|redisSentinel|redisPasswordOnlySentinel|redisTlsSentinel|httpSentinel|httpsSentinel|apiKeySentinel|accessTokenSentinel|passwordSentinel|secretSentinel|tokenSentinel|customer@example\.com|sqlTokenSentinel/, label);
  }
});

test('HTML injection fixtures are rendered only as escaped text', () => {
  const inputText = `<script>alert(1)</script> <img src=x onerror=alert(1)> "double" 'single' <angle> & ampersand`;
  const model = build(fixture({ findings: [finding({ title: inputText, summary: inputText, evidence: [{ observation: inputText, source: inputText }] })] }));
  const html = renderHtml(model);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&quot;double&quot;'));
  assert.ok(html.includes('&#39;single&#39;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
});

test('Markdown evidence cannot inject table rows, headings, raw HTML, or links', () => {
  const injection = 'cell | injected\n| fake | row\n# heading <script>alert(1)</script> [click](javascript:alert(1)) & "quote"';
  const model = build(fixture({ findings: [finding({ title: injection, summary: injection, evidence: [{ observation: injection, source: injection }] })] }));
  const markdown = renderMarkdown(model);
  assert.ok(markdown.includes('cell \\| injected \\| fake \\| row \\# heading \\<script\\>alert(1)\\</script\\> \\[click\\](javascript:alert(1))'));
  assert.equal((markdown.match(/^\| fake \| row$/gm) ?? []).length, 0);
  assert.equal((markdown.match(/^\| Profile \|/gm) ?? []).length, 1);
  assert.ok(!markdown.includes('<script>alert(1)</script>'));
});

test('unique sentinel secrets are removed from the model and every renderer across artifact fields', () => {
  const sentinel = 'PERFLENS_TEST_SECRET_7f93a1';
  const input = fixture({ findings: [finding({
    summary: `finding summary ${sentinel}`,
    evidence: [{ observation: `evidence ${sentinel}`, source: `dependency ${sentinel}`, value: { databaseOperation: `SELECT * FROM t WHERE token='${sentinel}'`, externalDependency: `redis://user:${sentinel}@cache/0`, note: sentinel } }],
    metrics: { dependency: `https://user:${sentinel}@service.test/path?access_token=${sentinel}`, databaseFingerprint: `SELECT * FROM t WHERE email='${sentinel}@example.test'`, nested: { detail: sentinel } },
  })] });
  input.run.serviceName = `service-${sentinel}`;
  input.run.engine = { name: `k6-${sentinel}`, version: sentinel };
  input.run.target.baseUrl = `http://user:${sentinel}@localhost:3002/?api_key=${sentinel}`;
  input.profiles[0].result.workload.label = sentinel;
  input.profiles[0].result.metrics.extra = { dependency: sentinel, database: sentinel };
  input.analysis.unsupported.push(sentinel);
  input.evidence.telemetry.source = sentinel;
  input.evidence.telemetry.details = { token: sentinel, note: sentinel };
  input.evidence.traces.push({ name: sentinel, attributes: { 'db.query.text': `SELECT '${sentinel}'` } });

  const model = build(input);
  const outputs = [JSON.stringify(model, null, 2), renderMarkdown(model), renderHtml(model)];
  for (const output of outputs) assert.ok(!output.includes(sentinel), 'sentinel must be absent before and after rendering');
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
