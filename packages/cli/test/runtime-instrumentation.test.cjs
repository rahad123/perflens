const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { activateComposeInstrumentation, isSupportedNodeCommand } = require('../dist/services/runtime-instrumentation.js');

async function fixture(t, { port = 4333, targetPort = 3400, services = ['api'], active = false, nodeOptions = '', exporterEndpoint } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-runtime-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, '.perflens/infra'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.perflens/infra/.env'), `OTLP_HTTP_PORT=${port}\n`);
  await fs.writeFile(path.join(cwd, 'compose.yaml'), 'services: {}\n');
  await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { express: '^5.0.0' }, scripts: { dev: 'node dist/server.js' } }));
  const serviceConfig = name => ({
    image: 'node:22', build: { context: '.' }, working_dir: '/app', command: 'npm run dev',
    ports: [{ target: targetPort, published: '3400', host_ip: '127.0.0.1' }],
    environment: { DATABASE_URL: 'SENTINEL_CONSUMER_DATABASE_SECRET', ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) },
  });
  const config = { name: 'external-consumer', services: Object.fromEntries(services.map(name => [name, serviceConfig(name)])) };
  const calls = [];
  let containerEnv = active ? [
    `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:${port}/v1/traces`,
    'OTEL_SERVICE_NAME=fixture-api',
  ] : ['PATH=/usr/bin', ...(exporterEndpoint ? [`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${exporterEndpoint}`] : [])];
  const run = async args => {
    calls.push(args);
    if (args.includes('config')) return JSON.stringify(config);
    if (args.includes('--status')) return services.join('\n');
    if (args.includes('exec')) return '/app/node_modules/@perflens/cli/dist/preload.cjs';
    if (args.includes('-q')) return 'container-123\n';
    if (args[0] === 'inspect') return JSON.stringify(containerEnv);
    if (args.includes('up')) {
      const endpoint = args.includes('-f') ? `http://host.docker.internal:${port}/v1/traces` : '';
      containerEnv = [`NODE_OPTIONS=--require @perflens/cli/preload`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${endpoint}`, 'OTEL_SERVICE_NAME=fixture-api'];
      return '';
    }
    return '';
  };
  return { cwd, calls, run, config };
}

const args = f => ({ projectDirectory: f.cwd, baseUrl: 'http://127.0.0.1:3400', probePath: '/orders', serviceName: 'fixture-api', run: f.run, probeTarget: async () => true });

test('Docker activation uses current dynamic OTLP port and recreates only the detected service', async t => {
  const f = await fixture(t), source = await fs.readFile(path.join(f.cwd, 'compose.yaml'));
  let approvedService;
  const result = await activateComposeInstrumentation({ ...args(f), approveRestart: async service => (approvedService = service, true) });
  assert.equal(result.mode, 'docker');
  assert.equal(result.service, 'api');
  assert.equal(result.endpoint, 'http://host.docker.internal:4333/v1/traces');
  assert.equal(approvedService, 'api');
  const up = f.calls.find(call => call.includes('up'));
  assert.ok(up.includes('--no-deps'));
  assert.ok(up.includes('--force-recreate'));
  assert.equal(up.at(-1), 'api');
  assert.ok(up.includes('--project-name'));
  const override = await fs.readFile(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
  assert.match(override, /host\.docker\.internal:4333/);
  assert.match(override, /OTEL_SERVICE_NAME.*fixture-api/);
  assert.deepEqual(await fs.readFile(path.join(f.cwd, 'compose.yaml')), source);
  assert.deepEqual(await fs.readFile(path.join(f.cwd, 'package.json')), Buffer.from(JSON.stringify({ name: 'fixture', dependencies: { express: '^5.0.0' }, scripts: { dev: 'node dist/server.js' } })));
});

test('runtime detector recognizes common Node and TypeScript development launchers only', () => {
  for (const command of ['node app.js', 'node dist/server.js', 'npm run dev', 'npm start', 'tsx src/server.ts', 'ts-node src/server.ts', 'ts-node-dev --respawn --transpile-only src/bootstrap.ts', 'nodemon src/index.js']) assert.equal(isSupportedNodeCommand(command), true, command);
  for (const command of ['python app.py', 'java -jar api.jar', 'redis-server']) assert.equal(isSupportedNodeCommand(command), false, command);
});

test('dynamic OTLP port rotation replaces the old endpoint in the generated runtime override', async t => {
  const f = await fixture(t, { port: 4334, exporterEndpoint: 'http://host.docker.internal:4333/v1/traces' });
  const result = await activateComposeInstrumentation({ ...args(f), approveRestart: async () => true });
  assert.equal(result.endpoint, 'http://host.docker.internal:4334/v1/traces');
  const override = await fs.readFile(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
  assert.match(override, /host\.docker\.internal:4334/);
  assert.doesNotMatch(override, /host\.docker\.internal:4333/);
});

test('an explicit non-local exporter endpoint is rejected without being printed or persisted', async t => {
  const f = await fixture(t, { exporterEndpoint: 'https://telemetry.example.test/v1/traces?token=SENTINEL' });
  const output = [];
  await assert.rejects(activateComposeInstrumentation({ ...args(f), write: line => output.push(line), approveRestart: async () => true }), /explicit non-local OTLP traces endpoint/);
  assert.doesNotMatch(output.join('\n'), /SENTINEL|telemetry\.example/);
  await assert.rejects(fs.access(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml')));
});

test('an already instrumented consumer with current endpoint and service identity is not restarted', async t => {
  const f = await fixture(t, { active: true });
  const result = await activateComposeInstrumentation({ ...args(f), approveRestart: async () => { throw new Error('should not ask'); } });
  assert.equal(result.restarted, false);
  assert.equal(f.calls.some(call => call.includes('up')), false);
});

test('restart approval is required and unrelated Compose services are not included', async t => {
  const f = await fixture(t, { services: ['api'] });
  await assert.rejects(activateComposeInstrumentation({ ...args(f), approveRestart: async () => false }), /requires restarting api/);
  assert.equal(f.calls.some(call => call.includes('up')), false);
  const override = await fs.readFile(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
  assert.match(override, /services:\n  "api":/);
  assert.doesNotMatch(override, /redis|db|worker/);
  assert.doesNotMatch(override, /SENTINEL_CONSUMER_DATABASE_SECRET/);
});

test('multiple Node candidates require selection and never pick a service silently', async t => {
  const f = await fixture(t, { services: ['api', 'worker'] });
  await assert.rejects(activateComposeInstrumentation({ ...args(f), approveRestart: async () => true }), /More than one running Node service/);
  const result = await activateComposeInstrumentation({ ...args(f), selectService: async candidates => { assert.deepEqual(candidates, ['api', 'worker']); return 'api'; }, approveRestart: async () => true });
  assert.equal(result.service, 'api');
  const up = f.calls.filter(call => call.includes('up')).at(-1);
  assert.equal(up.at(-1), 'api');
});

test('custom runtime options are never copied into PerfLens artifacts', async t => {
  const f = await fixture(t, { nodeOptions: '--require ./private-secret-bootstrap.cjs' });
  await assert.rejects(activateComposeInstrumentation({ ...args(f), approveRestart: async () => true }), /custom NODE_OPTIONS/);
  await assert.rejects(fs.access(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml')));
});

test('host-run targets are left unchanged for existing preload or actionable preflight fallback', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.cwd, 'compose.yaml'));
  const result = await activateComposeInstrumentation({ ...args(f), approveRestart: async () => false });
  assert.equal(result.mode, 'host');
  assert.equal(f.calls.length, 0);
});
