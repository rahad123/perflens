import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://localhost:3000';
async function request(path, status = 200, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, status, `${path}: ${await response.clone().text()}`);
  return response;
}
assert.equal((await (await request('/')).json()).service, 'PerfLens Demo API');
assert.equal((await (await request('/health')).json()).database, 'up');
assert.equal((await (await request('/orders?limit=2')).json()).length, 2);
await request('/orders?limit=101', 400);
await request('/orders?limit=abc', 400);
await request('/orders/not-an-id', 400);
await request('/orders/2147483647', 404);
const original = await (await request('/orders/1')).json();
assert.equal(original.items.length, 4);
assert.ok(original.customer.email.endsWith('@example.test'));
const before = (await (await request('/orders?limit=1')).json())[0].id;
await request('/orders', 400, { customerId: 1, items: [{ productId: 2147483647, quantity: 1 }] });
assert.equal((await (await request('/orders?limit=1')).json())[0].id, before, 'failed order must not be persisted');
await request('/orders', 400, { customerId: 1, items: [{ productId: 1, quantity: 0 }] });
await request('/orders', 400, { customerId: 1, items: [{ productId: 1, quantity: 1, unitPriceCents: 1 }] });
const created = await (await request('/orders', 201, { customerId: 1, items: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }] })).json();
assert.equal(created.items.length, 2);
assert.equal(created.items[0].unitPriceCents, 513);
assert.equal((await (await request(`/orders/${created.id}`)).json()).items.length, 2);
assert.equal((await (await request('/performance/n-plus-one')).json()).length, 20);
assert.equal((await (await request('/performance/slow-query')).json()).length, 100);
assert.equal((await (await request('/performance/external-call')).json()).status, 'ok');
const metrics = await (await request('/metrics')).text();
assert.match(metrics, /perflens_http_requests_total/);
assert.match(metrics, /perflens_http_request_duration_seconds_bucket/);
assert.match(metrics, /route="\/orders\/:id"/);
assert.ok(!metrics.includes(`route="/orders/${created.id}"`), 'metrics must use route templates');
console.log('API smoke checks passed: readiness, reads, validation, atomic failure, creation, demo endpoints, bounded metric labels.');
console.log(`Created demo order ${created.id}; retained for inspection.`);
