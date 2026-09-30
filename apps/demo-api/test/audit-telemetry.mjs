// Acceptance check for the known demo fixtures; not a PerfLens diagnosis engine.
import assert from 'node:assert/strict';
const runId = process.env.AUDIT_RUN_ID;
assert.match(runId ?? '', /^pfl_[0-9TZa-f_-]+$/i);
async function read(url) { const response = await fetch(url); assert.ok(response.ok, `${url}: ${response.status}`); return response.json(); }
const query = `{ resource.service.name = "perflens-demo-api" && span.perflens.audit.run_id = "${runId}" }`;
const found = await read(`http://tempo:3200/api/search?limit=1000&q=${encodeURIComponent(query)}`);
assert.ok(found.traces?.length, 'Audit-correlated traces must exist');
const counts = { server: 0, postgres: 0, externalClient: 0, nPlusOne: 0 };
const profiles = new Set();
const intervals = new Map();
for (const item of found.traces) {
  const trace = await read(`http://tempo:3200/api/traces/${item.traceID}`);
  const spans = (trace.batches ?? trace.resourceSpans ?? []).flatMap(batch => (batch.scopeSpans ?? []).flatMap(scope => scope.spans));
  const attributes = span => Object.fromEntries((span.attributes ?? []).map(a => [a.key, a.value.stringValue]));
  const root = spans.find(span => attributes(span)['perflens.audit.run_id'] === runId);
  assert.ok(root, 'Every matched trace must carry the requested run ID');
  const attrs = attributes(root), profile = attrs['perflens.audit.profile'];
  if (profile === 'preflight') continue;
  profiles.add(profile); counts.server++;
  assert.ok(root.kind === 'SPAN_KIND_SERVER' || root.kind === 2);
  const events = intervals.get(profile) ?? [];
  events.push({ t: BigInt(root.startTimeUnixNano), delta: 1 }, { t: BigInt(root.endTimeUnixNano), delta: -1 });
  intervals.set(profile, events);
  const queries = spans.filter(span => span.name.startsWith('pg.query:'));
  counts.postgres += queries.length;
  if (attrs['url.path'] === '/performance/n-plus-one') {
    assert.equal(queries.length, 21, 'Known N+1 fixture must preserve 21 queries'); counts.nPlusOne++;
  }
  if (attrs['url.path'] === '/performance/external-call') {
    const clients = spans.filter(span => (span.kind === 'SPAN_KIND_CLIENT' || span.kind === 3) && attributes(span)['url.full'] === 'http://127.0.0.1:4001/dependency');
    assert.ok(clients.length, 'Known external fixture must retain its HTTP client span');
    assert.ok(clients.some(span => span.parentSpanId === root.spanId), 'HTTP client must remain a child of the server span');
    counts.externalClient += clients.length;
  }
}
const maxServerOverlap = {};
for (const [profile, events] of intervals) {
  events.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : a.delta - b.delta);
  let active = 0, max = 0;
  for (const event of events) { active += event.delta; max = Math.max(max, active); }
  maxServerOverlap[profile] = max;
}
assert.ok(counts.server && counts.postgres, 'HTTP server and PostgreSQL spans must remain present');
if (process.env.EXPECT_DEMOS === 'true') {
  assert.ok(counts.nPlusOne && counts.externalClient, 'Both demo trace patterns must be present');
  assert.ok(Object.values(maxServerOverlap).some(value => value >= 2), 'Trace time intervals must prove concurrent requests');
}
const targets = await read('http://prometheus:9090/api/v1/targets');
assert.equal(targets.data.activeTargets.find(t => t.labels.job === 'demo-api')?.health, 'up');
const metrics = await read('http://prometheus:9090/api/v1/query?query=perflens_http_requests_total');
assert.ok(metrics.data.result.length);
console.log(JSON.stringify({ runId, matchedTraces: found.traces.length, profiles: [...profiles], counts, maxServerOverlap, prometheus: 'up' }));
