const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

test('package preload instruments Express before consumer imports and exports configured service identity', { timeout: 12000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-preload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDependencies = path.resolve(__dirname, '../../../apps/express-demo-api/node_modules');
  await fs.symlink(appDependencies, path.join(root, 'node_modules'), 'dir');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'preload-fixture', dependencies: { express: '5.2.1', pg: '8.23.0' } }));
  const script = path.join(root, 'server.cjs');
  await fs.writeFile(script, `const express = require('express'); const pg = require('pg'); const app = express(); app.get('/probe', (_req, res) => res.json({ ok: true, pg: typeof pg.Client })); const server = app.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port)); process.on('SIGTERM', () => server.close(() => process.exit(0)));`);

  let otlpPayload;
  const receiver = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { otlpPayload = Buffer.concat(chunks); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => receiver.close());
  const collectorPort = receiver.address().port;
  const preload = path.resolve(__dirname, '../dist/preload.cjs');
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--require="${preload}"`, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${collectorPort}/v1/traces`, OTEL_SERVICE_NAME: 'preload-fixture-api', OTEL_BSP_SCHEDULE_DELAY: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const deadline = Date.now() + 4000;
  while (!/PORT=\d+/.test(stdout) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const port = Number(/PORT=(\d+)/.exec(stdout)?.[1]);
  assert.ok(port, `consumer did not start: ${stderr}`);
  const response = await fetch(`http://127.0.0.1:${port}/probe`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pg: 'function' });
  const exportDeadline = Date.now() + 4000;
  while (!otlpPayload && Date.now() < exportDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(otlpPayload?.length, `preload exported no OTLP data: ${stderr}`);
  assert.ok(otlpPayload.includes(Buffer.from('preload-fixture-api')), 'OTLP resource omitted configured service.name');
  assert.ok(otlpPayload.includes(Buffer.from('/probe')), 'OTLP payload did not include the Express request span');
});

test('self-contained Docker preload instruments app-owned Express without CLI installed in app modules', { timeout: 12000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-docker-preload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDependencies = path.resolve(__dirname, '../../../apps/express-demo-api/node_modules');
  await fs.symlink(appDependencies, path.join(root, 'node_modules'), 'dir');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'image-without-perflens', dependencies: { express: '5.2.1', pg: '8.23.0' } }));
  const script = path.join(root, 'server.cjs');
  await fs.writeFile(script, `const express = require('express'); const pg = require('pg'); let cliMissing = false; try { require.resolve('@perflens/cli'); } catch (e) { cliMissing = e.code === 'MODULE_NOT_FOUND'; } const app = express(); app.get('/probe', (_req, res) => res.json({ cliMissing, pg: typeof pg.Client })); const server = app.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port)); process.on('SIGTERM', () => server.close(() => process.exit(0)));`);

  let payload;
  const receiver = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { payload = Buffer.concat(chunks); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => receiver.close());
  const endpoint = `http://127.0.0.1:${receiver.address().port}/v1/traces`;
  const preload = path.resolve(__dirname, '../dist/docker-preload.cjs');
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--require="${preload}"`, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint, OTEL_SERVICE_NAME: 'isolated-container-api', OTEL_BSP_SCHEDULE_DELAY: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const deadline = Date.now() + 4000;
  while (!/PORT=\d+/.test(stdout) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const port = Number(/PORT=(\d+)/.exec(stdout)?.[1]);
  assert.ok(port, `consumer without CLI package did not start: ${stderr}`);
  const response = await fetch(`http://127.0.0.1:${port}/probe`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cliMissing: true, pg: 'function' });
  const exportDeadline = Date.now() + 4000;
  while (!payload && Date.now() < exportDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(payload?.length, `self-contained preload exported no OTLP data: ${stderr}`);
  assert.ok(payload.includes(Buffer.from('isolated-container-api')));
  assert.ok(payload.includes(Buffer.from('/probe')));
});
