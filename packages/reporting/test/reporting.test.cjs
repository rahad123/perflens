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

test('long run IDs and endpoint URLs remain intact with wrapping layout at desktop and mobile widths', () => {
  const longId = 'pfl_20261007T180126602Z_20bb015a-6881-4daa-903a-73b44cb5262a';
  const paths = [
    '/api/dpps/ZTU3OWMxMzMxNWVkNDE4MWJlNjA4YmIxODRjZmVkNzc/public-view',
    '/api/organizations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/private-view',
  ];
  const input = fixture();
  input.run.runId = longId;
  input.analysis.runId = longId;
  input.findingsArtifact.runId = longId;
  input.evidence.runId = longId;
  input.profiles[0].result.runId = longId;
  input.profiles[0].result.target.endpoints = paths.map(path => ({ method: 'GET', path }));
  input.profiles[0].result.metrics.endpointResults = paths.map((path, index) => ({ target: { method: 'GET', path }, metrics: { requests: 40, rps: 4, errorRate: index ? 0.1333 : 0, failedRequests: index ? 6 : 0, latencyMs: { p50: 20, p95: 84, p99: 120 } } }));
  const html = renderHtml(build(input));
  assert.ok(html.includes(longId));
  for (const path of paths) assert.ok(html.includes(path));
  assert.match(html, /h1,\.metadata div,\.endpoint-list[^}]*overflow-wrap:anywhere/);
  assert.match(html, /\.metadata div\{min-width:0\}/);
  assert.match(html, /\.evidence-card p,\.evidence-card li,code,footer\{overflow-wrap:anywhere/);
  assert.match(html, /\.endpoint-comparison \.endpoint-cell[^}]*white-space:normal;overflow-wrap:anywhere/);
  assert.match(html, /@media\(max-width:700px\)\{main\{width:100%;margin:0;padding:25px 18px\}/);
  assert.match(html, /minmax\(min\(100%,220px\),1fr\)/);
});

test('non-zero error rates are highlighted as measured failures without creating a diagnosis', () => {
  const html = renderHtml(build(fixture()));
  assert.match(html, /Request failures were observed\./);
  assert.match(html, /normal: 1\.00% \(2 failed of 200\)/);
  assert.match(html, /class="error-rate nonzero"/);
  assert.match(html, /This is a measured error rate, not a root-cause diagnosis\./);
  assert.match(renderMarkdown(build(fixture())), /\| 1\.00% \|/);
});

function noisyTwoProfileInput() {
  const input = fixture({ findings: [finding({
    ruleId: 'load.error-degradation', category: 'load', title: 'Error rate increases under higher configured concurrency',
    summary: 'Error rate increased from 0.00% to 62.22% as configured concurrency increased from 1 to 3 VUs. p95 latency also increased.',
    metrics: {
      p95BeforeMs: 42.00189999999998, p95AfterMs: 80.33554999999997,
      p99BeforeMs: 66.56357999999999, p99AfterMs: 132.43526,
      errorRateBefore: 0, errorRateAfter: 0.6222222222222222,
      rpsBefore: 1.9951987537190505, rpsAfter: 5.993789235594078,
      vusBefore: 1, vusAfter: 3,
    },
  })] });
  const normal = input.profiles[0];
  normal.result.metrics = {
    requests: 90, successfulRequests: 34, failedRequests: 56, errorRate: 0.6222222222222222, rps: 5.993789235594078,
    latencyMs: { min: 4.0019, p50: 42.00189999999998, p90: 66.56357999999999, p95: 80.33554999999997, p99: 132.43526, max: 210.3456 },
  };
  normal.result.workload.vus = 3;
  const baselineResult = structuredClone(normal.result);
  baselineResult.profile = 'baseline'; baselineResult.workload.vus = 1;
  baselineResult.metrics = {
    requests: 20, successfulRequests: 20, failedRequests: 0, errorRate: 0, rps: 1.9951987537190505,
    latencyMs: { min: 2.12345, p50: 21.23456, p90: 35.67891, p95: 42.00189999999998, p99: 66.56357999999999, max: 89.87654 },
  };
  const baselineRunProfile = { name: 'baseline', status: 'completed', startedAt: '2026-09-30T12:00:00Z', endedAt: '2026-09-30T12:00:10Z', result: 'results/baseline.json' };
  input.profiles.unshift({ runProfile: baselineRunProfile, result: baselineResult });
  input.run.profiles.unshift(baselineRunProfile);
  return { input, sourceBaseline: baselineResult.metrics.latencyMs.p95, sourceNormalRps: normal.result.metrics.rps };
}

test('presentation formats noisy floats without changing raw persisted measurements', () => {
  const { input, sourceBaseline, sourceNormalRps } = noisyTwoProfileInput();
  const model = build(input);
  assert.equal(model.performanceSummary.profiles[0].metrics.latencyMs.p95, sourceBaseline);
  assert.equal(model.performanceSummary.profiles[1].metrics.rps, sourceNormalRps);
  const html = renderHtml(model);
  const markdown = renderMarkdown(model);
  for (const output of [html, markdown]) {
    assert.match(output, /42\.00/);
    assert.match(output, /80\.34/);
    assert.match(output, /66\.56/);
    assert.match(output, /132\.44/);
    assert.match(output, /2\.00/);
    assert.match(output, /5\.99/);
    assert.match(output, /62\.22%/);
    assert.doesNotMatch(output, /42\.00189999999998|80\.33554999999997|66\.56357999999999|132\.43526|1\.9951987537190505|5\.993789235594078|0\.6222222222222222/);
  }
});

test('latency-by-profile has accessible measured values for both profiles and tolerates missing measurements', () => {
  const input = noisyTwoProfileInput().input;
  const html = renderHtml(build(input));
  const table = html.match(/<table class="latency-by-profile">([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table);
  assert.match(table, /baseline[\s\S]*21\.23 ms[\s\S]*42\.00 ms[\s\S]*66\.56 ms/);
  assert.match(table, /normal[\s\S]*42\.00 ms[\s\S]*80\.34 ms[\s\S]*132\.44 ms/);

  for (const profile of input.profiles) profile.result.metrics.latencyMs = {};
  const withoutLatency = renderHtml(build(input));
  assert.match(withoutLatency, /Latency chart unavailable/);
  assert.match(withoutLatency, /Not available/);
});

test('known supporting measurements render as an escaped readable table and unknown structures use safe JSON fallback', () => {
  const input = noisyTwoProfileInput().input;
  const html = renderHtml(build(input));
  const section = html.match(/<h4>Supporting measurements<\/h4>([\s\S]*?)<\/article>/)?.[1];
  assert.ok(section);
  assert.match(section, /<table class="supporting-measurements">/);
  assert.match(section, /<th scope="row">VUs<\/th><td>1<\/td><td>3<\/td>/);
  assert.match(section, /Error rate<\/th><td>0\.00%<\/td><td>62\.22%/);
  assert.match(section, /p95<\/th><td>42\.00 ms<\/td><td>80\.34 ms/);
  assert.match(section, /RPS<\/th><td>2\.00<\/td><td>5\.99/);
  assert.doesNotMatch(section, /42\.00189999999998|\[object Object\]/);

  const unknown = renderHtml(build(fixture({ findings: [finding({ metrics: { custom: { label: '<script>alert(1)</script>' } } })] })));
  assert.match(unknown, /<details class="additional-measurements">/);
  assert.match(unknown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(unknown, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(unknown, /\[object Object\]/);
});
test('multi-endpoint report comparison uses endpoint-scoped k6 samples and existing Phase 3 findings only', () => {
  const input = fixture({ findings: [finding({ target: { method: 'GET', path: '/products' }, severity: 'P1', confidence: 'medium' })] });
  const profile = input.profiles[0].result;
  const products = { method: 'GET', path: '/products' };
  profile.target.endpoints.push(products);
  input.run.profiles[0].result = profile;
  profile.metrics.endpointResults = [
    { target: { method: 'GET', path: '/orders' }, metrics: { requests: 12, rps: 1.2, errorRate: 0, latencyMs: { p50: 10, p95: 25, p99: 30 } } },
    { target: products, metrics: { requests: 9, rps: 0.9, errorRate: 0.1, latencyMs: { p50: 50, p95: 150, p99: 200 } } },
  ];
  const model = build(input);
  const html = renderHtml(model), markdown = renderMarkdown(model);
  assert.match(html, /Endpoint comparison/);
  assert.match(html, /GET \/products/);
  assert.match(html, /150/);
  assert.match(html, /P1 Repeated &lt;query&gt; pattern/);
  assert.match(markdown, /GET \/products/);
  assert.ok(markdown.includes('P1 Repeated \\<query\\> pattern'));
  assert.equal(model.findings[0].severity, 'P1');
  assert.equal(model.findings[0].confidence, 'medium');
});

test('multi-endpoint report renders each endpoint metrics and findings independently', () => {
  const endpoints = [
    { method: 'GET', path: '/orders' },
    { method: 'GET', path: '/performance/n-plus-one' },
    { method: 'GET', path: '/performance/slow-query' },
    { method: 'GET', path: '/performance/external-call' },
  ];
  const repeated = finding({ id: 'n-plus-one', target: endpoints[1], ruleId: 'database.repeated-operation', title: 'Repeated DB evidence', evidence: [{ observation: 'NPLUS_ONLY_EVIDENCE', source: 'trace snapshot' }] });
  const slow = finding({ id: 'slow-query', target: endpoints[2], ruleId: 'database.slow-operation', title: 'Slow DB evidence', evidence: [{ observation: 'SLOW_ONLY_EVIDENCE', source: 'trace snapshot' }] });
  const dependency = finding({ id: 'external-call', target: endpoints[3], ruleId: 'dependency.latency-dominance', category: 'dependency', title: 'Dependency evidence', evidence: [{ observation: 'DEPENDENCY_ONLY_EVIDENCE', source: 'trace snapshot' }] });
  const input = fixture({ findings: [repeated, slow, dependency] });
  const profile = input.profiles[0].result;
  profile.target.endpoints = endpoints;
  profile.metrics.endpointResults = endpoints.map((target, index) => ({
    target,
    metrics: { requests: 10 + index, rps: 1 + index, errorRate: 0, latencyMs: { p50: 10 + index, p95: 20 + index, p99: 30 + index } },
  }));
  input.evidence.traces = endpoints.flatMap((target, index) => {
    const traceId = `trace-${index}`;
    const root = { traceId, spanId: `root-${index}`, parentSpanId: null, kind: 'server', name: `GET ${target.path}`, attributes: { 'perflens.audit.run_id': runId, 'http.route': target.path } };
    if (index === 3) return [root, { traceId, spanId: 'external-span', parentSpanId: root.spanId, kind: 'client', name: 'GET', attributes: { 'http.request.method': 'GET', 'url.sanitized': 'dependency.test/api' } }];
    const count = index === 1 ? 21 : 1;
    return [root, ...Array.from({ length: count }, (_, query) => ({ traceId, spanId: `db-${index}-${query}`, parentSpanId: root.spanId, kind: 'client', name: 'pg.query: SELECT', attributes: { 'db.system': 'postgresql' } }))];
  });
  const model = build(input);
  assert.deepEqual(model.endpointEvidence.map(item => [item.path, item.requestTraces, item.databaseSpans, item.externalHttpSpans]), [
    ['/orders', 1, 1, 0],
    ['/performance/n-plus-one', 1, 21, 0],
    ['/performance/slow-query', 1, 1, 0],
    ['/performance/external-call', 1, 0, 1],
  ]);
  const html = renderHtml(model);
  const rows = html.match(/<tr><th scope="row">[^]*?<\/tr>/g) ?? [];
  const endpointRows = Object.fromEntries(endpoints.map(endpoint => [endpoint.path, rows.find(row => row.includes(endpoint.path))]));
  assert.ok(endpointRows['/orders'].includes('10</td>') && endpointRows['/orders'].includes('None'));
  assert.ok(endpointRows['/performance/n-plus-one'].includes('11</td>') && endpointRows['/performance/n-plus-one'].includes('P2 Repeated DB evidence'));
  assert.ok(endpointRows['/performance/slow-query'].includes('12</td>') && endpointRows['/performance/slow-query'].includes('P2 Slow DB evidence'));
  assert.ok(endpointRows['/performance/external-call'].includes('13</td>') && endpointRows['/performance/external-call'].includes('P2 Dependency evidence'));
  assert.ok(endpointRows['/orders'].includes('>1</td><td>1</td><td>0</td>'));
  assert.ok(endpointRows['/performance/n-plus-one'].includes('>1</td><td>21</td><td>0</td>'));
  assert.ok(endpointRows['/performance/slow-query'].includes('>1</td><td>1</td><td>0</td>'));
  assert.ok(endpointRows['/performance/external-call'].includes('>1</td><td>0</td><td>1</td>'));
  for (const [path, text] of [['/performance/n-plus-one', 'NPLUS_ONLY_EVIDENCE'], ['/performance/slow-query', 'SLOW_ONLY_EVIDENCE'], ['/performance/external-call', 'DEPENDENCY_ONLY_EVIDENCE']]) {
    const section = (html.match(/<article class="finding[^]*?<\/article>/g) ?? []).find(article => article.includes(path));
    assert.ok(section, `${path} has a detailed finding section`);
    assert.ok(section.includes(text), `${path} includes its own evidence`);
    for (const other of ['NPLUS_ONLY_EVIDENCE', 'SLOW_ONLY_EVIDENCE', 'DEPENDENCY_ONLY_EVIDENCE'].filter(item => item !== text)) assert.ok(!section.includes(other), `${path} excludes ${other}`);
  }
  assert.ok(!endpointRows['/orders'].includes('Repeated DB evidence'));
  assert.ok(!endpointRows['/orders'].includes('Slow DB evidence'));
  assert.ok(!endpointRows['/orders'].includes('Dependency evidence'));
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
