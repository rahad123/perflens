import assert from 'node:assert/strict';
const read = async (url) => { const r = await fetch(url); assert.ok(r.ok, `${url}: ${r.status}${r.ok ? '' : ' ' + await r.text()}`); return r.json(); };
const sources = await read('http://grafana:3000/api/datasources');
assert.equal(sources.find(s => s.uid === 'tempo')?.url, 'http://tempo:3200');
assert.equal(sources.find(s => s.uid === 'prometheus')?.url, 'http://prometheus:9090');
const targets = await read('http://prometheus:9090/api/v1/targets');
assert.equal(targets.data.activeTargets.find(t => t.labels.job === 'demo-api')?.health, 'up');
const metric = await read('http://prometheus:9090/api/v1/query?query=perflens_http_requests_total');
assert.ok(metric.data.result.length > 0, 'application metrics must be ingested');
const search = await read('http://tempo:3200/api/search?limit=100&q=' + encodeURIComponent('{ resource.service.name = "perflens-demo-api" && span.url.path =~ "/performance/.*" }') + '&start=' + (Math.floor(Date.now() / 1000) - 300) + '&end=' + Math.floor(Date.now() / 1000));
assert.ok(search.traces?.length > 0, 'Tempo must contain traces');
let postgres = false, client = false, server = false, nPlusOne = false;
for (const trace of search.traces) {
  const data = await read(`http://tempo:3200/api/traces/${trace.traceID}`);
  const batches = data.batches ?? data.resourceSpans ?? [];
  const spans = batches.flatMap(b => (b.scopeSpans ?? []).flatMap(s => s.spans));
  if (spans.some(s => s.attributes?.some(a => a.key === 'url.path' && a.value.stringValue === '/performance/n-plus-one'))) {
    nPlusOne = true;
    assert.equal(spans.filter(s => s.name.startsWith('pg.query:')).length, 21, 'N+1 trace must have one list query plus 20 item queries');
  }
  for (const batch of batches) {
    const resource = Object.fromEntries((batch.resource?.attributes ?? []).map(a=>[a.key,a.value.stringValue]));
    assert.equal(resource['service.name'], 'perflens-demo-api');
    assert.equal(resource['service.version'], '0.1.0');
    assert.equal(resource['deployment.environment'], 'local');
    for (const scope of batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []) {
      for (const span of scope.spans) {
        const attrs = Object.fromEntries((span.attributes ?? []).map(a=>[a.key,a.value.stringValue]));
        const db = attrs['db.system.name'] ?? attrs['db.system'];
        if (db === 'postgresql') postgres = true;
        if (scope.scope?.name === '@opentelemetry/instrumentation-http') {
          if (span.kind === 2 || span.kind === 'SPAN_KIND_SERVER') server = true;
          if (span.kind === 3 || span.kind === 'SPAN_KIND_CLIENT') client = true;
        }
      }
    }
  }
}
assert.ok(nPlusOne, 'A recent N+1 trace must be present');
assert.ok(postgres, 'PostgreSQL spans must be stored in Tempo');
assert.ok(client, 'HTTP client spans must be stored in Tempo');
assert.ok(server, 'HTTP server spans must be stored in Tempo');
console.log(JSON.stringify({ grafanaDatasources: sources.map(s=>s.name), prometheusTarget: 'up', metricSeries: metric.data.result.length, tracesFound: search.traces.length, postgres, client, server, nPlusOne }));
