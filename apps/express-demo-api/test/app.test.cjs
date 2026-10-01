const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createApp } = require('../dist/app.js');
const { execFileSync } = require('node:child_process');

async function withApp(pool, action, dependencyUrl) {
  const app = createApp({ pool, dependencyUrl });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await action(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('health and normal orders endpoint use bounded clean database reads', async () => {
  const statements = [];
  const pool = { query: async sql => { statements.push(sql); return { rows: sql === 'SELECT 1' ? [{ '?column?': 1 }] : [{ id: 1 }] }; } };
  await withApp(pool, async base => {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', database: 'up' });
    assert.deepEqual(await (await fetch(`${base}/orders`)).json(), [{ id: 1 }]);
    assert.match(statements[1], /ORDER BY id DESC LIMIT 20/);
    assert.equal(statements.length, 2);
    const metrics = await (await fetch(`${base}/metrics`)).text();
    assert.match(metrics, /perflens_http_requests_total/);
  });
});

test('N+1 fixture performs one list plus 20 equivalent sequential database operations', async () => {
  const statements = [];
  const pool = { query: async sql => {
    statements.push(sql);
    if (sql.includes('FROM orders')) return { rows: Array.from({ length: 20 }, (_, id) => ({ id: id + 1 })) };
    return { rows: [] };
  } };
  await withApp(pool, async base => {
    assert.equal((await (await fetch(`${base}/performance/n-plus-one`)).json()).length, 20);
    assert.equal(statements.length, 21);
    assert.equal(new Set(statements.slice(1)).size, 1);
    assert.match(statements[1], /FROM order_items WHERE order_id = \$1/);
  });
});

test('slow query fixture runs one database operation and external fixture makes a real HTTP request', async () => {
  const statements = [];
  const pool = { query: async sql => { statements.push(sql); return { rows: Array.from({ length: 100 }, (_, id) => ({ id })) }; } };
  const dependency = createServer((_req, res) => res.end('{"status":"ok"}'));
  dependency.listen(0, '127.0.0.1');
  await new Promise(resolve => dependency.once('listening', resolve));
  const dependencyUrl = `http://127.0.0.1:${dependency.address().port}/dependency`;
  try {
    await withApp(pool, async base => {
      assert.equal((await (await fetch(`${base}/performance/slow-query`)).json()).length, 100);
      assert.equal(statements.length, 1);
      assert.match(statements[0], /order_id::text = o\.id::text/);
    assert.deepEqual(await (await fetch(`${base}/performance/external-call`)).json(), { dependency: 'simulated-shipping-provider', status: 'ok' });
    }, dependencyUrl);
  } finally { await new Promise(resolve => dependency.close(resolve)); }
});

test('preload-time Express instrumentation emits correlated route and child HTTP client spans', () => {
  const output = execFileSync(process.execPath, ['test/telemetry-child.cjs'], { encoding: 'utf8' });
  const spans = JSON.parse(output.trim().split('\n').at(-1));
  const server = spans.find(span => span.kind === 1 && span.attributes['http.route'] === '/performance/external-call');
  assert.ok(server, 'expected server span with stable Express route template');
  assert.equal(server.attributes['http.request.method'] ?? server.attributes['http.method'], 'GET');
  assert.equal(server.attributes['perflens.audit.run_id'], 'pfl_20260930T120000000Z_123e4567-e89b-12d3-a456-426614174000');
  assert.equal(server.attributes['perflens.audit.profile'], 'normal');
  assert.equal(server.resource['service.name'], 'perflens-test-express');
  assert.equal(server.resource['service.version'], '9.8.7');
  assert.equal(server.resource['deployment.environment'], 'test');
  const routeHandler = spans.find(span => span.kind === 0 && span.parentSpanId === server.spanId && span.attributes['http.route'] === '/performance/external-call');
  assert.ok(routeHandler, 'expected a framework-neutral route-handler child span');
  const client = spans.find(span => span.kind === 2 && span.parentSpanId === routeHandler.spanId);
  assert.ok(client, 'expected an HTTP client child span for the local dependency call');
  assert.equal(client.traceId, server.traceId);
});
