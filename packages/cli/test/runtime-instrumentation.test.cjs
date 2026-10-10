const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { activateComposeInstrumentation, isSupportedNodeCommand, waitForApplicationReady, ApplicationReadinessError } = require('../dist/services/runtime-instrumentation.js');

async function fixture(t, { port = 4333, targetPort = 3400, services = ['api'], active = false, bundleHashOverride, nodeOptions = '', exporterEndpoint } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-runtime-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, '.perflens/infra'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.perflens/infra/.env'), `OTLP_HTTP_PORT=${port}\n`);
  await fs.writeFile(path.join(cwd, 'compose.yaml'), 'services: {}\n');
  await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { express: '^5.0.0' }, scripts: { dev: 'node dist/server.js' } }));
  await fs.writeFile(path.join(cwd, 'Dockerfile'), 'FROM node:22\nCMD ["node", "server.js"]\n');
  await fs.writeFile(path.join(cwd, 'server.js'), "require('express')().listen(3000);\n");
  const serviceConfig = name => ({
    image: 'node:22', build: { context: '.' }, working_dir: '/app', command: 'npm run dev',
    ports: [{ target: targetPort, published: '3400', host_ip: '127.0.0.1' }],
    environment: { DATABASE_URL: 'SENTINEL_CONSUMER_DATABASE_SECRET', ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}) },
  });
  const config = { name: 'external-consumer', services: Object.fromEntries(services.map(name => [name, serviceConfig(name)])) };
  const calls = [];
  const packagedBundle = await fs.readFile(require.resolve('@perflens/cli/docker-preload'));
  const bundleHash = createHash('sha256').update(packagedBundle).digest('hex');
  let containerEnv = active ? [
    `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:${port}/v1/traces`,
    'OTEL_SERVICE_NAME=fixture-api',
    'NODE_OPTIONS=--require /opt/perflens/runtime/perflens-preload.cjs',
    'PERFLENS_RESOURCE_DIRECTORY=/tmp/perflens-resource',
    `PERFLENS_RUNTIME_BUNDLE_SHA256=${bundleHashOverride ?? bundleHash}`,
  ] : ['PATH=/usr/bin', ...(exporterEndpoint ? [`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${exporterEndpoint}`] : [])];
  const run = async args => {
    calls.push(args);
    if (args.includes('config')) return JSON.stringify(config);
    if (args.includes('--status')) return services.join('\n');
    if (args.includes('-q')) return 'container-123\n';
    if (args[0] === 'inspect') return JSON.stringify(containerEnv);
    if (args.includes('up')) {
      const endpoint = args.includes('-f') ? `http://host.docker.internal:${port}/v1/traces` : '';
      const overrideText = await fs.readFile(path.join(cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
      const injectedNodeOptions = /NODE_OPTIONS: "([^"]*)"/.exec(overrideText)?.[1];
      const injectedHash = /PERFLENS_RUNTIME_BUNDLE_SHA256: "([^"]+)"/.exec(overrideText)?.[1];
      containerEnv = [`NODE_OPTIONS=${injectedNodeOptions}`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${endpoint}`, 'OTEL_SERVICE_NAME=fixture-api', 'PERFLENS_RESOURCE_DIRECTORY=/tmp/perflens-resource', `PERFLENS_RUNTIME_BUNDLE_SHA256=${injectedHash}`];
      return '';
    }
    return '';
  };
  return { cwd, calls, run, config };
}

const args = f => ({ projectDirectory: f.cwd, baseUrl: 'http://127.0.0.1:3400', probePath: '/orders', serviceName: 'fixture-api', run: f.run, probeTarget: async () => true });

test('Docker activation uses current dynamic OTLP port and recreates only the detected service', async t => {
  const f = await fixture(t), source = await fs.readFile(path.join(f.cwd, 'compose.yaml'));
  const unchangedFiles = await Promise.all(['package.json', 'Dockerfile', 'server.js'].map(file => fs.readFile(path.join(f.cwd, file))));
  let approvedService;
  const output = [];
  const result = await activateComposeInstrumentation({ ...args(f), write: line => output.push(line), approveRestart: async service => (approvedService = service, true) });
  assert.equal(result.mode, 'docker');
  assert.equal(result.service, 'api');
  assert.equal(result.endpoint, 'http://host.docker.internal:4333/v1/traces');
  assert.equal(approvedService, 'api');
  const up = f.calls.find(call => call.includes('up'));
  assert.ok(up.includes('--no-deps'));
  assert.ok(up.includes('--force-recreate'));
  assert.equal(up.at(-1), 'api');
  assert.ok(up.includes('--project-name'));
  assert.match(output.join('\n'), /✓ Node\/Express service detected: api/);
  assert.doesNotMatch(output.join('\n'), /host\.docker\.internal|OTEL_EXPORTER_OTLP_TRACES_ENDPOINT|set OTEL_/);
  assert.equal(f.calls.some(call => call.includes('exec')), false, 'activation must not require the CLI package inside the image');
  const override = await fs.readFile(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
  assert.match(override, /host\.docker\.internal:4333/);
  assert.match(override, /OTEL_SERVICE_NAME.*fixture-api/);
  assert.match(override, /target: \/opt\/perflens\/runtime\/perflens-preload\.cjs/);
  assert.match(override, /read_only: true/);
  assert.match(override, /source: .*perflens-docker-preload\.cjs/);
  assert.match(override, /NODE_OPTIONS.*--require \/opt\/perflens\/runtime\/perflens-preload\.cjs/);
  assert.ok((await fs.stat(path.join(f.cwd, '.perflens/runtime/perflens-docker-preload.cjs'))).size > 100_000, 'runtime bundle should include OpenTelemetry dependencies and not depend on CLI installation in the image');
  assert.deepEqual(await fs.readFile(path.join(f.cwd, 'compose.yaml')), source);
  for (const [index, file] of ['package.json', 'Dockerfile', 'server.js'].entries()) assert.deepEqual(await fs.readFile(path.join(f.cwd, file)), unchangedFiles[index]);
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

test('an otherwise active app with a stale bundle marker is recreated using the current CLI bundle', async t => {
  const f = await fixture(t, { active: true, bundleHashOverride: 'stale-bundle-hash' });
  const result = await activateComposeInstrumentation({ ...args(f), approveRestart: async () => true });
  assert.equal(result.restarted, true);
  assert.ok(f.calls.some(call => call.includes('up') && call.at(-1) === 'api'));
});

test('restart approval is required and unrelated Compose services are not included', async t => {
  const f = await fixture(t, { services: ['api'] });
  await assert.rejects(activateComposeInstrumentation({ ...args(f), approveRestart: async () => false }), /requires restarting api/);
  assert.equal(f.calls.some(call => call.includes('up')), false);
  const override = await fs.readFile(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
  assert.match(override, /services:\n  "api":/);
  assert.doesNotMatch(override, /\n  "(?:redis|db|worker)":/);
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

test('existing NODE_OPTIONS are preserved while one temporary preload is added', async t => {
  const f = await fixture(t, { nodeOptions: '--max-old-space-size=2048 --enable-source-maps --require ./bootstrap.cjs' });
  await activateComposeInstrumentation({ ...args(f), approveRestart: async () => true });
  const override = await fs.readFile(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
  assert.match(override, /--max-old-space-size=2048/);
  assert.match(override, /--enable-source-maps/);
  assert.match(override, /--require \.\/bootstrap\.cjs/);
  assert.equal((override.match(/perflens-preload\.cjs/g) ?? []).length, 2); // environment + mount target
});

test('existing package preload is replaced and repeated activation does not duplicate the mounted preload', async t => {
  const f = await fixture(t, { nodeOptions: '--require @perflens/cli/preload --trace-warnings' });
  await activateComposeInstrumentation({ ...args(f), approveRestart: async () => true });
  const override = await fs.readFile(path.join(f.cwd, '.perflens/runtime/instrumentation.compose.yaml'), 'utf8');
  assert.doesNotMatch(override, /@perflens\/cli\/preload/);
  assert.match(override, /--trace-warnings/);
  assert.equal((override.match(/--require \/opt\/perflens\/runtime\/perflens-preload\.cjs/g) ?? []).length, 1);
  const result = await activateComposeInstrumentation({ ...args(f), approveRestart: async () => { throw new Error('current preload should be reused'); } });
  assert.equal(result.restarted, false);
});

test('runtime artifact is refreshed from the currently installed CLI bundle', async t => {
  const f = await fixture(t);
  const asset = path.join(f.cwd, '.perflens/runtime/perflens-docker-preload.cjs');
  await fs.mkdir(path.dirname(asset), { recursive: true });
  await fs.writeFile(asset, 'stale bundle');
  await activateComposeInstrumentation({ ...args(f), approveRestart: async () => true });
  assert.ok((await fs.stat(asset)).size > 100_000);
});

test('temporary runtime bundle is self-contained from OpenTelemetry packages and consumer image CLI installation', async () => {
  const bundle = await fs.readFile(path.resolve(__dirname, '../dist/docker-preload.cjs'), 'utf8');
  assert.doesNotMatch(bundle, /require\(["']@opentelemetry\//, 'OpenTelemetry runtime dependencies must be bundled');
  assert.doesNotMatch(bundle, /require\(["']@perflens\/cli/);
  assert.doesNotMatch(bundle, /require\(["']supports-color["']\)/, 'optional debug color dependency must not remain as a container runtime dependency');
  assert.match(bundle, /createRequire/);
  assert.match(bundle, /consumerRequire\.resolve\("express"\)/);
});

test('host-run targets are left unchanged for existing preload or actionable preflight fallback', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.cwd, 'compose.yaml'));
  const result = await activateComposeInstrumentation({ ...args(f), approveRestart: async () => false });
  assert.equal(result.mode, 'host');
  assert.equal(f.calls.length, 0);
});

test('application readiness accepts an immediate HTTP response without an arbitrary delay', async () => {
  let probes = 0, waits = 0;
  await waitForApplicationReady({ target: 'http://127.0.0.1:3400/orders', serviceName: 'api', probe: async url => { probes++; assert.equal(url, 'http://127.0.0.1:3400/orders'); return true; }, isServiceRunning: async () => true, wait: async () => { waits++; } });
  assert.equal(probes, 1);
  assert.equal(waits, 0);
});

test('application readiness keeps polling through transient connection failures and stops on first success', async () => {
  let clock = 0, probes = 0, waits = 0;
  await waitForApplicationReady({ target: 'http://127.0.0.1:3400/orders', serviceName: 'api', probe: async () => ++probes >= 4, isServiceRunning: async () => true, timeoutMs: 10000, intervalMs: 500, now: () => clock, wait: async ms => { waits++; clock += ms; } });
  assert.equal(probes, 4);
  assert.equal(waits, 3);
  assert.equal(clock, 1500);
});

test('slow application startup can become reachable within the bounded readiness timeout', async () => {
  let clock = 0, probes = 0;
  await waitForApplicationReady({ target: 'http://127.0.0.1:3400/orders', serviceName: 'api', probe: async () => { probes++; return clock >= 8000; }, isServiceRunning: async () => true, timeoutMs: 60000, intervalMs: 750, now: () => clock, wait: async ms => { clock += ms; } });
  assert.equal(clock, 8250);
  assert.ok(probes > 5);
});

test('application readiness timeout is bounded and performs no extra post-deadline probe', async () => {
  let clock = 0, probes = 0;
  await assert.rejects(waitForApplicationReady({ target: 'http://127.0.0.1:3400/orders', serviceName: 'api', probe: async () => { probes++; return false; }, isServiceRunning: async () => true, timeoutMs: 2000, intervalMs: 500, now: () => clock, wait: async ms => { clock += ms; } }), error => error instanceof ApplicationReadinessError && /did not become reachable within 2 seconds/.test(error.message) && /No load was started/.test(error.remediation));
  assert.equal(clock, 2000);
  assert.equal(probes, 4);
});

test('selected container exit fails readiness immediately instead of waiting for timeout', async () => {
  let clock = 0, probes = 0, checks = 0;
  await assert.rejects(waitForApplicationReady({ target: 'http://127.0.0.1:3400/orders', serviceName: 'api', probe: async () => { probes++; return false; }, isServiceRunning: async () => ++checks < 3, timeoutMs: 60000, intervalMs: 500, now: () => clock, wait: async ms => { clock += ms; } }), error => error instanceof ApplicationReadinessError && /service api exited/.test(error.message));
  assert.equal(probes, 2);
  assert.equal(clock, 1000);
});

test('Docker activation probes the configured endpoint after recreating only the selected service', async t => {
  const f = await fixture(t), events = [];
  const originalProbe = async url => { events.push(`probe:${url}`); return events.filter(event => event.startsWith('probe:')).length >= 3; };
  const result = await activateComposeInstrumentation({ ...args(f), probeTarget: originalProbe, isServiceRunning: async service => (events.push(`running:${service}`), true), wait: async () => { events.push('wait'); }, approveRestart: async () => true, write: line => events.push(line) });
  assert.equal(result.restarted, true);
  assert.ok(events.indexOf('Waiting for application readiness...') < events.indexOf('✓ Application ready'));
  assert.ok(events.indexOf('✓ Application ready') > events.indexOf('wait'));
  assert.equal(events.filter(event => event === 'probe:http://127.0.0.1:3400/orders').length, 3);
  const up = f.calls.find(call => call.includes('up'));
  assert.equal(up.at(-1), 'api');
  assert.ok(up.includes('--no-deps'));
});
