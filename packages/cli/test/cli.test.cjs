const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, access } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { validateConfig, loadProject, initialize } = require('../dist/config/project');
const { Infrastructure, parseContainers, assertLocalDocker } = require('../dist/services/infrastructure');
const { INFRA_SERVICES, installInfrastructureAssets, infrastructureRoot, otlpTracesEndpoint } = require('../dist/services/workspace');
const { doctor } = require('../dist/services/doctor');
const { ensureProjectForAudit } = require('../dist/services/onboarding');
const { CliError, formatError } = require('../dist/utils/errors');
const { docker } = require('../dist/services/process');
const bin = resolve(__dirname, '../bin/perflens.cjs');
const version = require('../package.json').version;
const config = { project: { name: 'backend' }, target: { baseUrl: 'http://localhost:3000' }, observability: { serviceName: 'backend' } };
const compose = { name: 'perflens', services: Object.fromEntries(INFRA_SERVICES.map(s => [s, s === 'grafana' ? { ports: [{ host_ip: '127.0.0.1', published: '3001', target: 3000 }] } : {}])) };
const running = INFRA_SERVICES.map(Service => ({ Service, State: 'running', Health: '', ExitCode: 0, Publishers: Service === 'grafana' ? [{ PublishedPort: 3001, URL: '127.0.0.1' }] : [] }));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'perflens.config.json'), JSON.stringify(config));
  for (const file of ['docker-compose.yml', '.env', 'infra/otel-collector/config.yaml', 'infra/tempo/tempo.yaml', 'infra/prometheus/prometheus.yml', 'infra/grafana/provisioning/datasources/datasources.yaml']) {
    const path = join(dir, file); await mkdir(require('node:path').dirname(path), { recursive: true }); await writeFile(path, file === '.env' ? 'OTLP_HTTP_PORT=4318\n' : 'fixture');
  }
  return dir;
}
function fake(calls = [], containers = running) {
  return async (args) => {
    calls.push(args);
    if (args.includes('inspect')) return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    if (args.includes('config')) return JSON.stringify(compose);
    if (args.includes('ps')) return JSON.stringify(containers);
    return '';
  };
}
function cli(args, cwd, extraEnv = {}) { return spawnSync(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf8' }); }

test('executable help/version work outside checkout and advertise only implemented commands', async t => {
  const dir = await fixture(t);
  const help = cli(['--help'], dir, { PATH: '' });
  assert.equal(help.status, 0); assert.match(help.stdout, /Backend Performance Audit CLI/);
  for (const name of ['init', 'doctor', 'infra', 'audit', 'runs', 'analyze', 'report']) assert.match(help.stdout, new RegExp(name));
  const result = cli(['--version'], dir, { PATH: '' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), version);
});
test('unsupported infra actions, destructive flags, and excess arguments fail before running Docker', async t => {
  const dir = await fixture(t);
  for (const args of [['infra', 'destroy'], ['infra', 'down', '--volumes'], ['infra', 'up', 'demo-api'], ['audit', '--profile', 'unbounded']]) {
    const result = cli(args, dir, { PATH: '' });
    assert.equal(result.status, 2, result.stderr); assert.doesNotMatch(result.stderr, /spawn docker/);
  }
});
test('config rejects unsafe URLs, secrets, typos, and invalid names', () => {
  assert.deepEqual(validateConfig(config), config);
  for (const url of ['https://production.example.com', 'file:///tmp/file', 'http://user:password@localhost', 'http://localhost?secret=x', 'http://localhost/#token', 'http://localhost.evil.test']) {
    assert.throws(() => validateConfig({ ...config, target: { baseUrl: url } }), CliError);
  }
  assert.throws(() => validateConfig({ ...config, credentials: {} }), CliError);
  assert.throws(() => validateConfig({ ...config, project: { name: '' } }), CliError);
  assert.throws(() => validateConfig({ ...config, observability: { serviceName: 'a', typo: 1 } }), CliError);
});
test('config discovery searches parents, explicit paths work, malformed/missing config fails', async t => {
  const dir = await fixture(t); await mkdir(join(dir, 'nested'));
  assert.equal((await loadProject(undefined, join(dir, 'nested'))).config.project.name, 'backend');
  assert.equal((await loadProject('../perflens.config.json', join(dir, 'nested'))).config.project.name, 'backend');
  await writeFile(join(dir, 'bad.json'), '{');
  await assert.rejects(loadProject('bad.json', dir), /Invalid JSON/);
  await assert.rejects(loadProject('missing.json', dir), /not found/);
});
test('init is create-only and never changes application files', async t => {
  const dir = await fixture(t); const empty = join(dir, 'new-target'); await mkdir(empty);
  await writeFile(join(empty, 'package.json'), '{"private":true}');
  await writeFile(join(empty, '.gitignore'), 'node_modules/\n# existing project ignores\n');
  const first = await initialize(empty);
  assert.equal(first.created, true);
  for (const folder of ['runs', 'results', 'logs']) await access(join(empty, '.perflens', folder));
  const expectedGitignore = 'node_modules/\n# existing project ignores\n.perflens/\n';
  assert.equal(await readFile(join(empty, '.gitignore'), 'utf8'), expectedGitignore);
  assert.equal(await readFile(join(empty, 'package.json'), 'utf8'), '{"private":true}');
  const custom = JSON.parse(await readFile(join(empty, 'perflens.config.json'), 'utf8'));
  custom.target.baseUrl = 'http://localhost:4310'; custom.audit.endpoints[0].path = '/api/orders';
  await writeFile(join(empty, 'perflens.config.json'), JSON.stringify(custom, null, 2));
  const before = await readFile(join(empty, 'perflens.config.json'), 'utf8');
  const repeated = await initialize(empty, { baseUrl: 'http://localhost:9999', endpoint: '/replace-me' });
  assert.equal(repeated.created, false); assert.equal(repeated.projectName, 'new-target');
  assert.equal(await readFile(join(empty, 'perflens.config.json'), 'utf8'), before);
  assert.equal(await readFile(join(empty, '.gitignore'), 'utf8'), expectedGitignore, 'existing ignore content is preserved and the rule is not duplicated');
});
test('first audit setup asks only for target details, creates config through init service, and recognizes Express', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-audit-onboarding-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@example/api', dependencies: { express: '^5.0.0' } }));
  const prompts = [];
  const result = await ensureProjectForAudit(dir, undefined, async (question, defaultValue) => {
    prompts.push({ question, defaultValue });
    if (question.includes('base URL')) return 'http://localhost:4567';
    if (question.startsWith('Endpoint selection')) return '3';
    return '/api/orders';
  });
  assert.equal(result.created, true); assert.equal(result.framework, 'express'); assert.deepEqual(prompts.map(p => p.defaultValue), ['http://localhost:3000', '3', undefined]);
  const saved = await loadProject(result.path);
  assert.equal(saved.config.target.baseUrl, 'http://localhost:4567');
  assert.deepEqual(saved.config.audit.endpoints, [{ method: 'GET', path: '/api/orders' }]);
});
test('onboarding can select several explicit safe routes and falls back honestly when route discovery is unavailable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-audit-multi-onboarding-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const questions = [];
  const result = await ensureProjectForAudit(dir, undefined, async (question, fallback) => {
    questions.push(question);
    if (question.includes('base URL')) return 'http://localhost:4567';
    if (question.startsWith('Endpoint selection')) return '2';
    return '/api/orders,/api/products';
  });
  assert.equal(result.created, true);
  assert.deepEqual((await loadProject(result.path)).config.audit.endpoints, [{ method: 'GET', path: '/api/orders' }, { method: 'GET', path: '/api/products' }]);
  assert.ok(questions.some(question => question.includes('comma-separated')));
});
test('automatic route recommendation selection falls back to manual path entry and excludes health endpoints', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-audit-route-fallback-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(ensureProjectForAudit(dir, undefined, async question => question.includes('base URL') ? 'http://localhost:3000' : question.startsWith('Endpoint selection') ? '1' : '/health'), /excluded from representative auditing/);
  await assert.rejects(readFile(join(dir, 'perflens.config.json'), 'utf8'), { code: 'ENOENT' });
});
test('existing audit project is reused without prompts or config changes; repeat setup remains idempotent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-audit-existing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), '{"name":"existing","devDependencies":{"express":"5"}}');
  const created = await initialize(dir, { baseUrl: 'http://localhost:4567', endpoint: '/orders' });
  const before = await readFile(created.path, 'utf8');
  const existing = await ensureProjectForAudit(dir, undefined, async () => { throw new Error('must not prompt'); });
  const repeated = await ensureProjectForAudit(dir, undefined);
  assert.equal(existing.created, false); assert.equal(existing.framework, 'express');
  assert.equal(repeated.created, false); assert.equal(await readFile(created.path, 'utf8'), before);
});
test('first audit setup refuses missing required target details without writing config', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-audit-no-target-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(ensureProjectForAudit(dir, undefined, async question => question.includes('base URL') ? 'http://localhost:3000' : question.startsWith('Endpoint selection') ? '3' : ''), /requires at least one representative GET endpoint/);
  await assert.rejects(readFile(join(dir, 'perflens.config.json'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(ensureProjectForAudit(dir, undefined), /needs a local target and representative GET endpoint/);
});
test('malformed existing config is fatal and never replaced during first audit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-audit-malformed-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'perflens.config.json'); await writeFile(path, '{broken');
  await assert.rejects(ensureProjectForAudit(dir), /Invalid JSON/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});
test('init surfaces the selected project OTLP traces endpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-init-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), '{"name":"init-target"}');
  const result = cli(['init'], dir, { PATH: '' });
  assert.equal(result.status, 0, result.stderr);
  const endpoint = await otlpTracesEndpoint(join(dir, '.perflens', 'infra'));
  assert.ok(result.stdout.includes(endpoint));
  assert.match(result.stdout, /bootstrap configures this automatically/);
});
test('installed infrastructure assets are package-relative, project-local, secret-free, and target the configured local metrics port', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-assets-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await installInfrastructureAssets(dir, 'http://localhost:4567');
  assert.equal(root, join(dir, '.perflens', 'infra'));
  const composeText = await readFile(join(root, 'docker-compose.yml'), 'utf8');
  assert.match(composeText, /name: perflens-[a-f0-9]{10}/);
  assert.doesNotMatch(composeText, /__PERFLENS_COMPOSE_NAME__/);
  const prometheus = await readFile(join(root, 'prometheus.yml'), 'utf8');
  assert.match(prometheus, /host\.docker\.internal:4567/);
  assert.ok(!prometheus.includes('__PERFLENS_'));
  assert.match(await readFile(join(root, 'grafana/dashboards/perflens-performance.json'), 'utf8'), /histogram_quantile/);
  assert.doesNotMatch(await readFile(join(root, '.env'), 'utf8'), /PASSWORD|TOKEN|SECRET/i);
  await installInfrastructureAssets(dir, 'http://localhost:4568');
  assert.match(await readFile(join(root, 'prometheus.yml'), 'utf8'), /host\.docker\.internal:4568/);
  assert.equal(await infrastructureRoot(root), root);
});
test('installed OTLP endpoint follows selected ports with default and occupied 4318', async t => {
  const available = await mkdtemp(join(tmpdir(), 'perflens-otlp-default-')); t.after(() => rm(available, { recursive: true, force: true }));
  const defaultRoot = await installInfrastructureAssets(available, 'http://localhost:3000', async () => true);
  assert.match(await readFile(join(defaultRoot, '.env'), 'utf8'), /OTLP_HTTP_PORT=4318\n/);
  assert.equal(await otlpTracesEndpoint(defaultRoot), 'http://127.0.0.1:4318/v1/traces');

  const occupied = await mkdtemp(join(tmpdir(), 'perflens-otlp-alternate-')); t.after(() => rm(occupied, { recursive: true, force: true }));
  const alternateRoot = await installInfrastructureAssets(occupied, 'http://localhost:3000', async port => port !== 4318);
  assert.match(await readFile(join(alternateRoot, '.env'), 'utf8'), /OTLP_HTTP_PORT=4319\n/);
  assert.equal(await otlpTracesEndpoint(alternateRoot), 'http://127.0.0.1:4319/v1/traces');

  const probeFailure = await mkdtemp(join(tmpdir(), 'perflens-otlp-probe-failure-')); t.after(() => rm(probeFailure, { recursive: true, force: true }));
  await assert.rejects(installInfrastructureAssets(probeFailure, 'http://localhost:3000', async () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); }), /Cannot check local port 3001/);
});
test('partial infrastructure setup restores missing files and port settings without replacing customized assets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-infra-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await installInfrastructureAssets(dir, 'http://localhost:3000', async () => true);
  const composePath = join(root, 'docker-compose.yml'); const compose = await readFile(composePath, 'utf8');
  const { unlink } = require('node:fs/promises');
  await unlink(join(root, 'tempo.yaml')); await unlink(join(root, '.env'));
  await installInfrastructureAssets(dir, 'http://localhost:3000', async () => true);
  assert.equal(await readFile(composePath, 'utf8'), compose);
  assert.match(await readFile(join(root, 'tempo.yaml'), 'utf8'), /server:/);
  assert.equal(await otlpTracesEndpoint(root), 'http://127.0.0.1:4318/v1/traces');
});
test('doctor succeeds on its own occupied ports, fails on daemon/config/Compose errors with remediation', async t => {
  const dir = await fixture(t); const options = { config: join(dir, 'perflens.config.json'), infraDir: dir };
  const output = []; assert.equal(await doctor(options, line => output.push(line), fake(), async () => 'k6 v2.3.0'), true);
  assert.match(output.join('\n'), /used by this PerfLens/);
  assert.match(output.join('\n'), /OTLP traces endpoint: http:\/\/127\.0\.0\.1:4318\/v1\/traces/);
  for (const failure of ['info', 'version', 'config']) {
    const output = []; const normal = fake();
    const run = async args => { if (args.includes(failure)) throw new Error('simulated failure'); return normal(args); };
    assert.equal(await doctor(options, line => output.push(line), run, async () => 'k6 v2.3.0'), false);
    assert.match(output.join('\n'), /Not ready/); assert.doesNotMatch(output.join('\n'), /Ready to run PerfLens/);
  }
});
test('doctor reports missing or incompatible k6 without hiding the load-test prerequisite', async t => {
  const dir = await fixture(t); const options = { config: join(dir, 'perflens.config.json'), infraDir: dir };
  for (const check of [async () => { throw new CliError('PerfLens could not find k6.', 'Install k6 2.3.x.'); }, async () => 'k6 v1.2.3']) {
    const output = []; assert.equal(await doctor(options, line => output.push(line), fake(), check), false);
    assert.match(output.join('\n'), /k6/); assert.match(output.join('\n'), /Not ready/);
  }
});
test('missing Docker produces a useful CLI failure, not an unhandled stack', async t => {
  const dir = await fixture(t); const result = cli(['--infra-dir', dir, 'doctor'], dir, { PATH: '' });
  assert.equal(result.status, 1); assert.match(result.stdout, /could not find Docker/); assert.match(result.stdout, /Install Docker/);
  assert.doesNotMatch(result.stderr, /at .*\.js:/);
});
test('remote Docker contexts are rejected before infrastructure mutation', async () => {
  await assert.rejects(assertLocalDocker(async () => JSON.stringify([{ Endpoints: { docker: { Host: 'ssh://production' } } }])), /local Docker/);
});
test('up manages only infrastructure, preserves paths with spaces, and probes actual readiness', async () => {
  const calls = []; const infra = new Infrastructure('/tmp/target with spaces', fake(calls));
  await infra.up(0);
  const up = calls.find(args => args.includes('up'));
  assert.ok(up.includes('/tmp/target with spaces/docker-compose.yml'));
  assert.deepEqual(up.slice(-4), [...INFRA_SERVICES]); assert.ok(!up.includes('demo-api'));
  assert.equal(calls.filter(args => args.includes('wget')).length, 4);
});
test('running containers alone do not imply readiness, and failed startup never succeeds', async () => {
  const normal = fake();
  const infra = new Infrastructure('/tmp/test', async args => { if (args.includes('wget')) throw new Error('endpoint unavailable'); return normal(args); });
  await assert.rejects(infra.up(0), /did not become ready/);
  const failed = new Infrastructure('/tmp/test', async args => { if (args.includes('up')) throw new Error('pull failed'); return normal(args); });
  await assert.rejects(failed.up(0), /pull failed/);
});
test('doctor/up port check distinguishes unrelated conflicts from owned ports', async () => {
  const infra = new Infrastructure('/tmp/test', fake([], []), async () => false);
  await assert.rejects(infra.checkPorts(compose), /occupied by another process/);
  const ready = new Infrastructure('/tmp/test', fake([], []), async () => true);
  assert.match((await ready.checkPorts(compose))[0], /available/);
});
test('down stops only allowed services, never deletes volumes, and verifies shutdown', async () => {
  const calls = []; const stopped = running.map(c => ({ ...c, State: 'exited' }));
  await new Infrastructure('/tmp/test', fake(calls, stopped)).down();
  const stop = calls.find(args => args.includes('stop'));
  assert.deepEqual(stop.slice(-4), [...INFRA_SERVICES]);
  assert.ok(calls.every(args => !args.includes('down') && !args.includes('-v') && !args.includes('rm')));
  await assert.rejects(new Infrastructure('/tmp/test', fake()).down(), /did not stop/);
});
test('status understands stopped/crashed services and both Compose JSON representations', async () => {
  assert.equal(parseContainers(running.map(c => JSON.stringify(c)).join('\n')).length, 4);
  assert.equal(parseContainers(JSON.stringify(running)).length, 4); assert.deepEqual(parseContainers(''), []);
  const crashed = running.map(c => ({ ...c, State: 'exited', ExitCode: 1 }));
  assert.ok((await new Infrastructure('/tmp/test', fake([], crashed)).status()).every(s => s.failed));
});
test('failure formatting retains remediation without stack traces', () => {
  assert.equal(formatError(new CliError('Docker unavailable.', 'Start Docker.')), '✗ Docker unavailable.\nStart Docker.');
  assert.doesNotMatch(formatError(new Error('failure')), /at .*\.js/);
});
