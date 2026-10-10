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

test('all-failed runs are explicitly inconclusive while preserving measurements and findings', () => {
  const measuredFinding = finding({ ruleId: 'database.slow-operation', title: 'Measured slow database operation', severity: 'P2' });
  const input = fixture({ findings: [measuredFinding] });
  const metrics = input.profiles[0].result.metrics;
  metrics.requests = 9; metrics.successfulRequests = 0; metrics.failedRequests = 9; metrics.errorRate = 1; metrics.rps = 0.9;
  metrics.statusDistribution = { '500': 9 };
  metrics.latencyMs = { min: 4999.1, p50: 5000, p90: 5000, p95: 5000, p99: 5000, max: 5001 };
  const model = build(input);
  const html = renderHtml(model), markdown = renderMarkdown(model);
  for (const output of [html, markdown]) {
    assert.match(output, /Performance assessment inconclusive — all measured requests failed/);
    assert.match(output, /No successful-response latency baseline is available/);
    assert.match(output, /request timeouts, authentication/);
    assert.match(output, /5000\.00/);
    assert.match(output, /100\.00%/);
    assert.match(output, /Measured slow database operation/);
    assert.doesNotMatch(output, /No evidence-backed performance bottleneck met the configured detection thresholds/);
  }
  assert.match(html, /role="alert"/);
  assert.match(html, /Failed requests alone do not establish a backend root cause/);
});

test('partial failures keep the normal assessment and measured error warning without all-failed wording', () => {
  const input = fixture();
  const html = renderHtml(build(input)), markdown = renderMarkdown(build(input));
  for (const output of [html, markdown]) {
    assert.doesNotMatch(output, /Performance assessment inconclusive — all measured requests failed/);
    assert.match(output, /Request failures were observed|1\.00%/);
    assert.match(output, /No evidence-backed performance bottleneck met the configured detection thresholds/);
  }
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

test('latency chart and accessible table occupy separate responsive flow blocks without clipping chart height', () => {
  const html = renderHtml(build(noisyTwoProfileInput().input));
  const chartStart = html.indexOf('<div class="latency-chart">');
  const chartEnd = html.indexOf('</svg></div>', chartStart);
  const tableStart = html.indexOf('<div class="table-wrap"><table class="latency-by-profile">', chartEnd);
  assert.ok(chartStart >= 0 && chartEnd > chartStart && tableStart > chartEnd);
  assert.match(html, /\.latency-chart\{display:block;width:100%;min-width:0;margin:12px 0 20px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain\}/);
  assert.match(html, /\.chart\{display:block;width:900px;min-width:900px;max-width:none;height:auto;max-height:none\}/);
  assert.match(html, /@media\(max-width:700px\)\{main\{width:100%;margin:0;padding:25px 18px\}/);
  assert.doesNotMatch(html, /profile-label"[^>]*x="830"/);
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
  const comparison = html.match(/<table class="endpoint-comparison">([\s\S]*?)<\/table>/)?.[1] ?? '';
  const rows = comparison.match(/<tr><th scope="row">[^]*?<\/tr>/g) ?? [];
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

function statusDistributionInput() {
  const targets = [{ method: 'GET', path: '/orders' }, { method: 'GET', path: '/users' }];
  const input = fixture({ findings: [finding({ id: 'kept-finding', ruleId: 'load.error-degradation', target: targets[0], severity: 'P0', confidence: 'high', evidence: [{ observation: 'Existing Phase 3 evidence stays intact.', source: 'results/baseline.json, results/normal.json' }] })] });
  const normal = input.profiles[0];
  normal.result.target.endpoints = targets;
  normal.result.metrics = {
    requests: 90, successfulRequests: 69, failedRequests: 21, errorRate: 21 / 90, rps: 6,
    latencyMs: { p50: 40, p90: 70, p95: 84, p99: 120 }, statusDistribution: { '200': 69, '429': 21 },
    endpointResults: [
      { target: targets[0], metrics: { requests: 50, successfulRequests: 29, failedRequests: 21, errorRate: 21 / 50, rps: 3.3, latencyMs: { p50: 50, p95: 100, p99: 130 }, statusDistribution: { '200': 29, '429': 21 } } },
      { target: targets[1], metrics: { requests: 40, successfulRequests: 40, failedRequests: 0, errorRate: 0, rps: 2.7, latencyMs: { p50: 20, p95: 40, p99: 60 }, statusDistribution: { '200': 40 } } },
    ],
  };
  const baselineRunProfile = { name: 'baseline', status: 'completed', startedAt: '2026-09-30T12:00:00Z', endedAt: '2026-09-30T12:00:10Z', result: 'results/baseline.json' };
  const baseline = structuredClone(normal.result);
  baseline.profile = 'baseline'; baseline.metrics.requests = 20; baseline.metrics.successfulRequests = 20; baseline.metrics.failedRequests = 0; baseline.metrics.errorRate = 0; baseline.metrics.rps = 2; baseline.metrics.statusDistribution = { '200': 20 };
  baseline.metrics.endpointResults = [
    { target: targets[0], metrics: { requests: 10, successfulRequests: 10, failedRequests: 0, errorRate: 0, rps: 1, latencyMs: { p50: 10, p95: 20, p99: 30 }, statusDistribution: { '200': 10 } } },
    { target: targets[1], metrics: { requests: 10, successfulRequests: 10, failedRequests: 0, errorRate: 0, rps: 1, latencyMs: { p50: 15, p95: 25, p99: 35 }, statusDistribution: { '200': 10 } } },
  ];
  input.run.profiles.unshift(baselineRunProfile);
  input.profiles.unshift({ runProfile: baselineRunProfile, result: baseline });
  input.run.profiles[1].name = 'normal';
  return { input, existingFinding: structuredClone(input.findingsArtifact.findings[0]) };
}

test('HTTP status diagnostics preserve per-endpoint counts for each profile and explain 429 without creating findings', () => {
  const { input, existingFinding } = statusDistributionInput();
  const model = build(input);
  assert.equal(model.reportVersion, 5);
  assert.equal(model.diagnosticEvidence.schemaVersion, 1);
  assert.equal(model.findings.length, 1);
  assert.deepEqual(model.findings[0].evidence, existingFinding.evidence);
  assert.equal(model.findings[0].severity, existingFinding.severity);
  assert.equal(model.findings[0].confidence, existingFinding.confidence);
  assert.equal(model.diagnosticEvidence.httpStatusProfiles.length, 4);
  const normalOrders = model.diagnosticEvidence.httpStatusProfiles.find(item => item.profile === 'normal' && item.target.path === '/orders');
  assert.deepEqual(normalOrders.statusDistribution, { '200': 29, '429': 21 });
  assert.equal(normalOrders.requests, 50);
  assert.equal(normalOrders.successfulRequests, 29);
  assert.equal(normalOrders.failedRequests, 21);
  assert.equal(normalOrders.statusCount, 50);
  assert.equal(normalOrders.statusState, 'available');
  assert.equal(normalOrders.source, 'results/normal.json');
  const html = renderHtml(model), markdown = renderMarkdown(model);
  for (const output of [html, markdown]) {
    assert.match(output, /HTTP response status diagnostics/);
    assert.match(output, /429 Too Many Requests/);
    assert.match(output, /requests were rejected as too frequent/);
    assert.match(output, /Possible sources include application rate limiting, an API gateway, or upstream throttling/);
    assert.match(output, /The responsible component has not been identified/);
  }
  assert.match(html, /29[\s\S]*?200 OK[\s\S]*?21[\s\S]*?429 Too Many Requests/);
  assert.match(renderHtml(model), /<h2>Diagnostic coverage<\/h2>/);
  assert.match(renderHtml(model), /Node process CPU[\s\S]*?Not collected/);
});

test('empty, unavailable, inconsistent, and legacy status distributions are distinguished without inventing zeroes', () => {
  const emptyInput = fixture();
  emptyInput.profiles[0].result.metrics.requests = 0;
  emptyInput.profiles[0].result.metrics.statusDistribution = {};
  let model = build(emptyInput);
  assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusState, 'no-observations');
  assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusCount, 0);
  assert.match(renderHtml(model), /No status observations/);

  const missingInput = fixture();
  delete missingInput.profiles[0].result.metrics.statusDistribution;
  model = build(missingInput);
  assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusState, 'not-persisted');
  assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusCount, null);
  assert.equal(model.diagnosticEvidence.coverage.find(item => item.diagnostic === 'HTTP status distribution').observations, null);
  assert.match(renderHtml(model), /Not persisted/);

  const inconsistentInput = fixture();
  inconsistentInput.profiles[0].result.metrics.statusDistribution = { '200': 198, '429': 1 };
  model = build(inconsistentInput);
  assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusState, 'incomplete');
  assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusCount, 199);
  assert.match(renderHtml(model), /Incomplete \(199 of 200 statuses\)/);

  const legacyInput = fixture();
  delete legacyInput.profiles[0].result.metrics.endpointResults;
  delete legacyInput.profiles[0].result.metrics.statusDistribution;
  model = build(legacyInput);
  assert.equal(model.performanceSummary.profiles[0].metrics.requests, 200);
  assert.equal(model.diagnosticEvidence.coverage.find(item => item.diagnostic === 'Endpoint request measurements').state, 'not-persisted');
  assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusState, 'not-persisted');
});

test('diagnostic rendering escapes endpoint text and reports evidence coverage without changing Phase 3 artifacts', () => {
  const input = fixture({ findings: [finding({ id: 'preserved', severity: 'P1', confidence: 'medium', metrics: { arbitrary: 'unchanged' } })] });
  input.profiles[0].result.target.endpoints[0].path = '/items/<img src=x onerror=alert(1)>&';
  input.profiles[0].result.metrics.statusDistribution = { '200': 198, '429': 2 };
  const before = structuredClone(input.findingsArtifact.findings);
  const model = build(input);
  const html = renderHtml(model);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&amp;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /analysis\/evidence\.json/);
  assert.deepEqual(model.findings, before);
  assert.equal(input.findingsArtifact.findings[0].metrics.arbitrary, 'unchanged');
});

test('resource diagnostics summarize run/profile-scoped process and container samples and render portable charts', () => {
  const input = fixture();
  const normalProfile = input.profiles[0];
  const baselineRunProfile = { ...normalProfile.runProfile, name: 'baseline', result: 'results/baseline.json' };
  const baselineResult = structuredClone(normalProfile.result);
  baselineResult.profile = 'baseline';
  input.profiles.unshift({ runProfile: baselineRunProfile, result: baselineResult });
  input.run.profiles.unshift(baselineRunProfile);
  const makeProcess = (profile, timestamp, cpu, rss, pid = 101) => ({ schemaVersion: 1, runId, profile, timestamp, monotonicNs: String(Date.parse(timestamp) * 1e6), source: 'node-process', processId: pid, cpuUserMicros: 1000, cpuSystemMicros: 500, cpuPercentOneLogicalCpu: cpu, cpuNormalization: 'one-logical-cpu', rssBytes: rss, heapUsedBytes: rss / 2, heapTotalBytes: rss * .75, externalBytes: 1024 });
  const makeContainer = (profile, timestamp, cpu, memory, limit = null) => ({ schemaVersion: 1, runId, profile, timestamp, source: 'docker-container', container: 'api-service', dockerReportedCpuPercent: cpu, cpuNormalization: 'docker-stats-reported', hostLogicalCpus: 8, cpuQuotaCores: 1, memoryUsedBytes: memory, memoryLimitBytes: limit });
  input.resources = {
    schemaVersion: 1, runId, samplingIntervalMs: 1000,
    collection: { process: 'available', container: 'available', processNote: 'Process <script> evidence', containerNote: 'Container evidence' },
    processSamples: [
      makeProcess('baseline', '2026-10-10T12:00:00.000Z', 10, 100 * 1024 * 1024),
      makeProcess('baseline', '2026-10-10T12:00:01.000Z', 20, 110 * 1024 * 1024),
      makeProcess('normal', '2026-10-10T12:00:02.000Z', 30, 120 * 1024 * 1024),
      makeProcess('normal', '2026-10-10T12:00:03.000Z', 40, 140 * 1024 * 1024, 202),
    ],
    containerSamples: [
      makeContainer('baseline', '2026-10-10T12:00:00.000Z', 5, 200 * 1024 * 1024, 512 * 1024 * 1024),
      makeContainer('baseline', '2026-10-10T12:00:01.000Z', 7, 220 * 1024 * 1024, 512 * 1024 * 1024),
      makeContainer('normal', '2026-10-10T12:00:02.000Z', 10, 300 * 1024 * 1024, 512 * 1024 * 1024),
      makeContainer('normal', '2026-10-10T12:00:03.000Z', 15, 400 * 1024 * 1024, 512 * 1024 * 1024),
    ],
  };
  const model = build(input), html = renderHtml(model), markdown = renderMarkdown(model);
  assert.equal(model.resourceDiagnostics.schemaVersion, 1);
  assert.equal(model.resourceDiagnostics.processState, 'available');
  assert.equal(model.resourceDiagnostics.containerState, 'available');
  const normal = model.resourceDiagnostics.profiles.find(item => item.profile === 'normal');
  assert.equal(normal.process.cpuAveragePercent, 35);
  assert.equal(normal.process.rssPeakBytes, 140 * 1024 * 1024);
  assert.equal(normal.process.processInstances, 2);
  assert.equal(normal.container.memoryPeakBytes, 400 * 1024 * 1024);
  assert.equal(normal.container.memoryAverageBytes, 350 * 1024 * 1024);
  assert.equal(normal.container.memoryLimitBytes, 512 * 1024 * 1024);
  assert.equal(normal.container.memoryPeakPercentOfLimit, 78.125);
  for (const profile of ['baseline', 'normal']) assert.match(html, new RegExp(`>${profile}<`));
  assert.match(html, /CPU &amp; memory diagnostics/);
  assert.match(html, /Node process CPU/);
  assert.match(html, /Docker container memory/);
  assert.match(html, /one logical CPU/);
  assert.match(html, /Docker CPU is the value reported by Docker on its host logical CPU basis/);
  assert.match(html, /Measured resource summaries by profile/);
  assert.match(html, /78\.13%/);
  assert.match(html, /Container memory avg/);
  assert.match(html, /External memory peak/);
  assert.match(html, /<polyline/);
  assert.match(html, /UTC 12:00:00/);
  assert.match(html, /Distinct PIDs or process-lifetime IDs are observed identities/);
  assert.match(html, /not summed service totals/);
  assert.match(html, /RSS window change is only available when evidence establishes one continuous process instance/);
  assert.match(html, /Process &lt;script&gt; evidence/);
  assert.doesNotMatch(html, /<script> evidence/);
  assert.match(markdown, /CPU & memory diagnostics/);
  assert.match(model.diagnosticEvidence.coverage.find(item => item.diagnostic === 'Node process CPU').state, /available/);
});

test('resource summaries preserve process-lifetime identity, avoid cross-process growth, and label sample aggregation', () => {
  const input = fixture();
  const profile = input.profiles[0];
  const baselineRunProfile = { ...profile.runProfile, name: 'baseline', result: 'results/baseline.json' };
  const baselineResult = structuredClone(profile.result); baselineResult.profile = 'baseline';
  input.profiles.unshift({ runProfile: baselineRunProfile, result: baselineResult });
  input.run.profiles.unshift(baselineRunProfile);
  const makeProcess = (name, pid, profileName, second, cpu, rss) => ({
    schemaVersion: 1, runId, profile: profileName, timestamp: `2026-10-10T12:00:0${second}.000Z`, monotonicNs: String(second * 1e9),
    source: 'node-process', processId: pid, processInstanceId: name, cpuUserMicros: 100, cpuSystemMicros: 100,
    cpuPercentOneLogicalCpu: cpu, cpuNormalization: 'one-logical-cpu', rssBytes: rss, heapUsedBytes: rss / 2, heapTotalBytes: rss, externalBytes: 0,
  });
  input.resources = {
    schemaVersion: 1, runId, samplingIntervalMs: 1000,
    collection: { process: 'available', container: 'not-collected', processNote: 'samples', containerNote: 'not collected' },
    processSamples: [
      makeProcess('worker-a', 1, 'baseline', 0, 10, 100), makeProcess('worker-a', 1, 'baseline', 1, 20, 150),
      makeProcess('worker-b', 2, 'baseline', 2, 20, 200), makeProcess('worker-b', 2, 'baseline', 3, 30, 250),
      makeProcess('worker-c', 3, 'baseline', 4, 30, 300), makeProcess('worker-c', 3, 'baseline', 5, 40, 350),
      // PID 1 is reused after a process restart; instance identity must keep the windows separate.
      makeProcess('restarted-pid-1', 1, 'normal', 6, 40, 400), makeProcess('restarted-pid-1', 1, 'normal', 7, 50, 600),
      makeProcess('reused-pid-1', 1, 'normal', 8, 60, 800), makeProcess('reused-pid-1', 1, 'normal', 9, 70, 1000),
      { ...makeProcess('wrong-run', 99, 'baseline', 10, 999, 999), runId: 'pfl_20261010T120000000Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      makeProcess('wrong-profile', 100, 'stress', 11, 999, 999),
    ],
    containerSamples: [],
  };
  const model = build(input), html = renderHtml(model);
  const baseline = model.resourceDiagnostics.profiles.find(item => item.profile === 'baseline');
  const normal = model.resourceDiagnostics.profiles.find(item => item.profile === 'normal');
  assert.equal(baseline.process.processInstances, 3);
  assert.equal(baseline.process.cpuAveragePercent, 25);
  assert.equal(baseline.process.cpuPeakPercent, 40);
  assert.equal(baseline.process.rssAverageBytes, 225);
  assert.equal(baseline.process.rssPeakBytes, 350);
  assert.equal(baseline.process.rssGrowthBytes, null);
  assert.equal(normal.process.processInstances, 2);
  assert.equal(normal.process.rssAverageBytes, 700);
  assert.equal(normal.process.rssPeakBytes, 1000);
  assert.equal(normal.process.rssGrowthBytes, null, 'PID reuse must not be treated as process continuity');
  assert.match(html, />3<\/td>/);
  assert.match(html, /Unavailable \(2 process identities\)/);
  assert.match(html, /not summed service totals/);
  assert.match(html, /may represent workers or restarts/);
  assert.match(html, /RSS window change is only available when evidence establishes one continuous process instance/);
  assert.match(html, /process 1 \(PID 1\)/);
  assert.match(html, /process 2 \(PID 2\)/);
  assert.match(html, /process 3 \(PID 3\)/);
  assert.equal((html.match(/<polyline /g) ?? []).length, 15, 'each of five process lifetimes has separate CPU, RSS, and heap lines');
  assert.match(html, /viewBox="0 0 900 /);
  assert.match(html, /class="chart-legend"/);
  assert.match(html, /resource-chart \.svg-wrap\{width:100%;min-width:0;overflow-x:auto/);
  assert.match(html, /chart-legend li\{display:flex;align-items:flex-start;gap:7px;min-width:0;overflow-wrap:anywhere/);
  for (const [, points] of html.matchAll(/<polyline[^>]*points="([^"]+)"/g)) {
    for (const point of points.split(' ')) {
      const [x, y] = point.split(',').map(Number);
      assert.ok(x >= 54 && x <= 874 && y >= 18 && y <= 208, `SVG point ${point} remains inside the plot area`);
    }
  }
});

test('old runs without resources remain readable and resource coverage is not represented as zero', () => {
  const model = build(fixture());
  assert.equal(model.reportVersion, 5);
  assert.equal(model.resourceDiagnostics.state, 'not-collected');
  assert.equal(model.resourceDiagnostics.processState, 'not-collected');
  assert.equal(model.resourceDiagnostics.containerState, 'not-collected');
  assert.equal(model.diagnosticEvidence.coverage.find(item => item.diagnostic === 'Node process memory / heap').observations, null);
  assert.match(renderHtml(model), /Process coverage: Not collected/);
  assert.match(renderHtml(model), /not enough valid time samples to draw a chart/);
  assert.doesNotMatch(renderHtml(model), /RSS peak[^<]*0\.0 MiB/);
});

test('one process sample reports memory observations but insufficient CPU evidence', () => {
  const input = fixture();
  input.resources = { schemaVersion: 1, runId, samplingIntervalMs: 1000, collection: { process: 'available', container: 'not-collected', processNote: 'one sample', containerNote: 'not collected' }, processSamples: [{ schemaVersion: 1, runId, profile: 'normal', timestamp: '2026-10-10T12:00:00.000Z', monotonicNs: '1', source: 'node-process', processId: 7, cpuUserMicros: 0, cpuSystemMicros: 0, cpuPercentOneLogicalCpu: null, cpuNormalization: 'one-logical-cpu', rssBytes: 80 * 1024 * 1024, heapUsedBytes: 30 * 1024 * 1024, heapTotalBytes: 60 * 1024 * 1024, externalBytes: 1 }], containerSamples: [] };
  const model = build(input);
  assert.equal(model.diagnosticEvidence.coverage.find(item => item.diagnostic === 'Node process CPU').state, 'insufficient-evidence');
  assert.equal(model.diagnosticEvidence.coverage.find(item => item.diagnostic === 'Node process memory / heap').state, 'available');
  assert.equal(model.resourceDiagnostics.profiles[0].process.rssPeakBytes, 80 * 1024 * 1024);
  assert.equal(model.resourceDiagnostics.profiles[0].process.cpuAveragePercent, null);
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
  assert.ok((markdown.match(/^\| Profile \|/gm) ?? []).length >= 3);
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

test('PostgreSQL diagnostics correlate parent chains, preserve profile and endpoint scope, summarize durations, repeats and safe errors', () => {
  const input = fixture({ findings: [
    finding({ id: 'slow-finding', ruleId: 'database.slow-operation', title: 'Consistently slow database operation' }),
    finding({ id: 'other-query-finding', ruleId: 'database.repeated-operation', title: 'Repeated database query pattern', metrics: { operationFingerprint: 'select * from unrelated_table where id = ?' } }),
  ] });
  const endpoints = [{ method: 'GET', path: '/orders' }, { method: 'GET', path: '/customers' }];
  input.profiles[0].result.target.endpoints = endpoints;
  input.profiles[0].runProfile.name = 'normal';
  input.profiles[0].result.profile = 'normal';
  input.profiles[0].result.metrics.requests = 3;
  input.profiles[0].result.metrics.successfulRequests = 3;
  input.profiles[0].result.metrics.failedRequests = 0;
  input.profiles[0].runProfile.result = 'results/normal.json';
  input.run.profiles[0] = input.profiles[0].runProfile;
  const trace = (profile, traceId, method, route, spanSpecs) => {
    const rootSpan = { traceId, spanId: `root-${traceId}`, parentSpanId: null, profile, kind: 'server', name: `${method} ${route}`, startTimeUnixNano: '0', endTimeUnixNano: '1000000000', attributes: { 'perflens.audit.run_id': runId, 'perflens.audit.profile': profile, 'http.request.method': method, 'http.route': route } };
    const children = spanSpecs.map((spec, index) => ({ traceId, spanId: `${traceId}-db-${index}`, parentSpanId: spec.parent ?? rootSpan.spanId, profile, kind: 'client', name: 'pg.query: SELECT * FROM orders WHERE id = $?', startTimeUnixNano: String(index * 1000000), endTimeUnixNano: String((index * 1000000) + (spec.durationMs * 1000000)), status: spec.status, attributes: { 'db.system': 'postgresql', ...(spec.fingerprint ? { 'db.query.sanitized': spec.fingerprint } : {}), ...(spec.operation ? { 'db.operation.name': spec.operation } : {}) } }));
    return [rootSpan, ...children];
  };
  const fingerprint = 'select * from orders where customer_id = ?';
  input.evidence.traces = [
    ...trace('normal', 'n-order-a', 'GET', '/orders', Array.from({ length: 5 }, (_, i) => ({ durationMs: 20 + i, fingerprint, status: i === 4 ? 'error' : 'ok' }))),
    ...trace('normal', 'n-order-b', 'GET', '/orders', []),
    ...trace('normal', 'n-customer', 'GET', '/customers', [{ durationMs: 9, operation: 'SELECT', status: 'unset' }]),
  ];
  input.analysis.traceSummary.databaseSpans = 7;
  input.evidence.telemetry = { source: 'Tempo', traceCount: 4, spanCount: input.evidence.traces.length, truncated: false };
  const model = build(input), html = renderHtml(model), markdown = renderMarkdown(model);
  const normalOrders = model.postgresDiagnostics.profiles.find(row => row.profile === 'normal').endpoints.find(item => item.target.path === '/orders');
  const normalCustomers = model.postgresDiagnostics.profiles.find(row => row.profile === 'normal').endpoints.find(item => item.target.path === '/customers');
  assert.equal(normalOrders.requests, 2);
  assert.equal(normalOrders.requestsWithPostgres, 1);
  assert.equal(normalOrders.operations, 5);
  assert.equal(normalOrders.averageOperationsPerRequest, 2.5);
  assert.equal(normalOrders.maxOperationsPerRequest, 5);
  assert.equal(normalOrders.summedSpanDurationMs, 110);
  assert.equal(normalOrders.operationSummaries[0].averageDurationMs, 22);
  assert.equal(normalOrders.operationSummaries[0].p95DurationMs, 24);
  assert.equal(normalOrders.repeatedPatterns[0].maxExecutionsPerTrace, 5);
  assert.equal('phase3Finding' in normalOrders.repeatedPatterns[0], false, 'descriptive fingerprint rows are never individually marked as analyzer diagnoses');
  assert.equal(normalCustomers.operations, 1);
  assert.equal(normalCustomers.operationSummaries[0].fingerprint, null);
  assert.equal(model.postgresDiagnostics.errors.length, 1);
  assert.equal(model.postgresDiagnostics.errors[0].correlation, 'parent-chain');
  assert.equal(model.findings.length, 2);
  assert.match(html, /PostgreSQL diagnostics/);
  assert.match(html, /select \* from orders where customer_id = \?/);
  assert.match(html, /EXPLAIN \(ANALYZE, BUFFERS\)/);
  assert.match(markdown, /p95 ms/);
  assert.match(markdown, /Sum of span durations \(ms; overlap possible\)/i);
  assert.match(markdown, /descriptive repetition evidence, not a confirmed N\+1 diagnosis/i);
  assert.doesNotMatch(markdown, /Phase 3 repeated-operation finding \|/);
  assert.ok(model.findings.some(item => item.ruleId === 'database.repeated-operation'));
  assert.doesNotMatch(html, /private-value/i);
  assert.equal(model.diagnosticEvidence.coverage.find(item => item.diagnostic === 'Connection-pool metrics').state, 'not-collected');
});

test('PostgreSQL fingerprint report rejects suspicious historical raw SQL and unknown status is insufficient evidence', () => {
  const legacyFinding = finding({ id: 'legacy-query-finding', metrics: { operationFingerprint: "SELECT * FROM users WHERE email = E'private\\'secret-value'" } });
  const input = fixture({ findings: [legacyFinding] });
  const base = { traceId: 'status-trace', profile: 'normal', startTimeUnixNano: '0', endTimeUnixNano: '5000000', attributes: { 'db.system': 'postgresql' } };
  const root = { ...base, spanId: 'root', parentSpanId: null, kind: 'server', name: 'GET /orders', startTimeUnixNano: '0', endTimeUnixNano: '100000000', attributes: { 'perflens.audit.run_id': runId, 'http.route': '/orders', 'http.request.method': 'GET' } };
  const leakedLegacy = { ...base, spanId: 'db-legacy', parentSpanId: 'root', kind: 'client', name: 'pg.query', status: 'unset', attributes: { ...base.attributes, 'db.operation.name': 'SELECT secret-operation-value', 'db.query.sanitized': "select * from users where email = e'private\\'secret-value'" } };
  input.evidence.traces = [root, leakedLegacy];
  input.analysis.traceSummary.requests = 1;
  input.analysis.traceSummary.databaseSpans = 1;
  const model = build(input);
  const outputs = [JSON.stringify(model), renderMarkdown(model), renderHtml(model)];
  for (const output of outputs) {
    assert.ok(!output.includes('secret-value'));
    assert.ok(!output.includes('secret-operation-value'));
  }
  assert.match(JSON.stringify(model), /SQL details redacted/);
  const operation = model.postgresDiagnostics.operations[0];
  assert.equal(operation.fingerprint, null);
  assert.equal(operation.status, 'unset');
  const errorCoverage = model.postgresDiagnostics.coverage.find(item => item.diagnostic === 'PostgreSQL error status');
  assert.equal(errorCoverage.state, 'insufficient-evidence', 'UNSET is not counted as successful operation status');

  leakedLegacy.status = undefined;
  const missingStatusModel = build(input);
  assert.equal(missingStatusModel.postgresDiagnostics.coverage.find(item => item.diagnostic === 'PostgreSQL error status').state, 'insufficient-evidence');
});

test('PostgreSQL correlation labels parent-chain, unique-root fallback, async children, and background operations distinctly', () => {
  const input = fixture({ findings: [] });
  const common = { traceId: 'single-root', profile: 'normal', startTimeUnixNano: '0', endTimeUnixNano: '10000000', attributes: { 'db.system': 'postgresql' } };
  const root = { ...common, spanId: 'root', parentSpanId: null, kind: 'server', startTimeUnixNano: '0', endTimeUnixNano: '5000000', attributes: { 'perflens.audit.run_id': runId, 'http.route': '/orders', 'http.request.method': 'GET' } };
  const middle = { ...common, spanId: 'async-work', parentSpanId: 'root', kind: 'internal', attributes: {} };
  const asyncDb = { ...common, spanId: 'async-db', parentSpanId: 'async-work', kind: 'client', name: 'pg.query', attributes: { ...common.attributes, 'db.query.sanitized': 'select * from orders where id = ?' } };
  const traceOnlyDb = { ...common, spanId: 'trace-only-db', parentSpanId: 'missing-parent', kind: 'client', name: 'pg.query', attributes: common.attributes };
  const backgroundDb = { ...common, traceId: 'background-trace', spanId: 'background-db', parentSpanId: null, kind: 'client', name: 'pg.query', attributes: common.attributes };
  input.evidence.traces = [root, middle, asyncDb, traceOnlyDb, backgroundDb];
  input.analysis.traceSummary.requests = 1;
  input.analysis.traceSummary.databaseSpans = 3;
  const operations = build(input).postgresDiagnostics.operations;
  assert.equal(operations.find(item => item.spanId === 'async-db').correlation, 'parent-chain');
  assert.equal(operations.find(item => item.spanId === 'async-db').target.path, '/orders');
  assert.equal(operations.find(item => item.spanId === 'trace-only-db').correlation, 'trace-only');
  assert.equal(operations.find(item => item.spanId === 'trace-only-db').target.path, '/orders');
  assert.equal(operations.find(item => item.spanId === 'background-db').correlation, 'unmatched');
  assert.equal(operations.find(item => item.spanId === 'background-db').target, null);
  const correlationCoverage = build(input).postgresDiagnostics.coverage.find(item => item.diagnostic === 'Endpoint-to-database correlation');
  assert.match(correlationCoverage.note, /Parent-chain: 1; trace-only unique-root fallback: 1; ambiguous multiple-root: 0; unmatched\/background: 1/);
  assert.match(renderHtml(build(input)), /trace-only/);
});

test('PostgreSQL diagnostics leave spans uncorrelated when trace has multiple request roots and mark missing status/query evidence honestly', () => {
  const input = fixture({ findings: [] });
  const span = (spanId, parentSpanId, kind, route, name, startTimeUnixNano, endTimeUnixNano, attributes = {}) => ({ traceId: 'shared-trace', spanId, parentSpanId, profile: 'normal', kind, name, startTimeUnixNano, endTimeUnixNano, attributes });
  input.evidence.traces = [
    span('root-a', null, 'server', '/orders', 'GET /orders', '0', '1000000000', { 'perflens.audit.run_id': runId, 'http.route': '/orders' }),
    span('root-b', null, 'server', '/customers', 'GET /customers', '0', '1000000000', { 'perflens.audit.run_id': runId, 'http.route': '/customers' }),
    span('db', 'missing-parent', 'client', '', 'pg.query', '0', '5000000', { 'db.system': 'postgresql' }),
  ];
  input.analysis.findings = []; input.findingsArtifact.findings = [];
  const model = build(input);
  assert.equal(model.postgresDiagnostics.operations[0].correlation, 'ambiguous');
  assert.equal(model.postgresDiagnostics.operations[0].target, null);
  assert.equal(model.postgresDiagnostics.operations[0].fingerprint, null);
  assert.equal(model.postgresDiagnostics.operations[0].status, 'unknown');
  assert.equal(model.postgresDiagnostics.coverage.find(item => item.diagnostic === 'Endpoint-to-database correlation').state, 'insufficient-evidence');
  assert.equal(model.postgresDiagnostics.coverage.find(item => item.diagnostic === 'PostgreSQL error status').state, 'insufficient-evidence');
});
