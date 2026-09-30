const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, access } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { validateConfig, loadProject, initialize } = require('../dist/config/project');
const { Infrastructure, parseContainers, assertLocalDocker } = require('../dist/services/infrastructure');
const { INFRA_SERVICES } = require('../dist/services/workspace');
const { doctor } = require('../dist/services/doctor');
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
    const path = join(dir, file); await mkdir(require('node:path').dirname(path), { recursive: true }); await writeFile(path, 'fixture');
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
  for (const name of ['init', 'doctor', 'infra']) assert.match(help.stdout, new RegExp(name));
  assert.doesNotMatch(help.stdout, /\n\s+(audit|analyze|report)\b/);
  const result = cli(['--version'], dir, { PATH: '' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), version);
});
test('unsupported infra actions, destructive flags, and excess arguments fail before running Docker', async t => {
  const dir = await fixture(t);
  for (const args of [['infra', 'destroy'], ['infra', 'down', '--volumes'], ['infra', 'up', 'demo-api'], ['audit']]) {
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
  await initialize(empty);
  for (const folder of ['runs', 'results', 'logs']) await access(join(empty, '.perflens', folder));
  assert.equal(await readFile(join(empty, 'package.json'), 'utf8'), '{"private":true}');
  const before = await readFile(join(empty, 'perflens.config.json'), 'utf8');
  await assert.rejects(initialize(empty), /already exists/);
  assert.equal(await readFile(join(empty, 'perflens.config.json'), 'utf8'), before);
});
test('doctor succeeds on its own occupied ports, fails on daemon/config/Compose errors with remediation', async t => {
  const dir = await fixture(t); const options = { config: join(dir, 'perflens.config.json'), infraDir: dir };
  const output = []; assert.equal(await doctor(options, line => output.push(line), fake()), true);
  assert.match(output.join('\n'), /used by this PerfLens/);
  for (const failure of ['info', 'version', 'config']) {
    const output = []; const normal = fake();
    const run = async args => { if (args.includes(failure)) throw new Error('simulated failure'); return normal(args); };
    assert.equal(await doctor(options, line => output.push(line), run), false);
    assert.match(output.join('\n'), /Not ready/); assert.doesNotMatch(output.join('\n'), /Ready to run PerfLens/);
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
