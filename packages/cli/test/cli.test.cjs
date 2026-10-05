const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, access } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { validateConfig, loadProject, initialize } = require('../dist/config/project');
const { Infrastructure, parseContainers, assertLocalDocker, infrastructureReady } = require('../dist/services/infrastructure');
const { INFRA_SERVICES, infrastructureProjectName, installInfrastructureAssets, infrastructureRoot, otlpTracesEndpoint } = require('../dist/services/workspace');
const { doctor } = require('../dist/services/doctor');
const { chooseAuditEndpoints, ensureProjectForAudit } = require('../dist/services/onboarding');
const { CliError, formatError } = require('../dist/utils/errors');
const { docker } = require('../dist/services/process');
const bin = resolve(__dirname, '../bin/perflens.cjs');
const version = require('../package.json').version;
const config = { project: { name: 'backend' }, target: { baseUrl: 'http://localhost:3000' }, observability: { serviceName: 'backend' } };
const portBindings = {
  'otel-collector': [{ host_ip: '127.0.0.1', published: '4317', target: 4317 }, { host_ip: '127.0.0.1', published: '4318', target: 4318 }, { host_ip: '127.0.0.1', published: '13133', target: 13133 }],
  tempo: [{ host_ip: '127.0.0.1', published: '3200', target: 3200 }],
  prometheus: [{ host_ip: '127.0.0.1', published: '9090', target: 9090 }],
  grafana: [{ host_ip: '127.0.0.1', published: '3001', target: 3000 }],
};
const compose = { name: 'perflens', services: Object.fromEntries(INFRA_SERVICES.map(service => [service, { ports: portBindings[service] }])) };
const running = INFRA_SERVICES.map(Service => ({ Service, Project: 'perflens', State: 'running', Health: 'healthy', ExitCode: 0, Publishers: portBindings[Service].map(port => ({ PublishedPort: Number(port.published), TargetPort: port.target, URL: port.host_ip, Protocol: 'tcp' })) }));
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'perflens.config.json'), JSON.stringify(config));
  for (const file of ['docker-compose.yml', '.env', 'infra/otel-collector/config.yaml', 'infra/tempo/tempo.yaml', 'infra/prometheus/prometheus.yml', 'infra/grafana/provisioning/datasources/datasources.yaml']) {
    const path = join(dir, file); await mkdir(require('node:path').dirname(path), { recursive: true }); await writeFile(path, file === '.env' ? 'OTLP_GRPC_PORT=4317\nOTLP_HTTP_PORT=4318\nOTEL_HEALTH_PORT=13133\nTEMPO_PORT=3200\nPROMETHEUS_PORT=9090\nGRAFANA_PORT=3001\n' : 'fixture');
  }
  return dir;
}
function fake(calls = [], containers = running) {
  return async (args) => {
    calls.push(args);
    if (args.includes('inspect')) return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    const projectIndex = args.indexOf('--project-name');
    const projectName = projectIndex >= 0 ? args[projectIndex + 1] : compose.name;
    if (args.includes('config')) return JSON.stringify({ ...compose, name: projectName });
    if (args.includes('ps')) return JSON.stringify(containers.map(container => container.Project === compose.name ? { ...container, Project: projectName } : container));
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
    if (question.startsWith('Endpoint selection')) return '1';
    return '/api/orders';
  });
  assert.equal(result.created, true); assert.equal(result.framework, 'express'); assert.deepEqual(prompts.map(p => p.defaultValue), ['http://localhost:3000', '1', undefined]);
  const saved = await loadProject(result.path);
  assert.equal(saved.config.target.baseUrl, 'http://localhost:4567');
  assert.deepEqual(saved.config.audit.endpoints, [{ method: 'GET', path: '/api/orders' }]);
});
test('onboarding can select several explicit safe routes and does not claim route discovery', async t => {
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
  assert.ok(questions.some(question => question.includes('comma-separated') && question.includes('does not discover routes automatically')));
});
test('single-route onboarding uses honest manual selection and excludes health endpoints', async t => {
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
test('interactive audit endpoint selection defaults to saved routes or chooses run-scoped alternatives', async () => {
  const saved = [{ method: 'GET', path: '/api/orders' }, { method: 'GET', path: '/api/products' }];
  const defaultChoice = await chooseAuditEndpoints(saved, async () => '');
  assert.deepEqual(defaultChoice, { endpoints: saved, changed: false });
  const selected = await chooseAuditEndpoints(saved, async question => question.startsWith('Current audit targets') ? '2' : '/api/industries,/api/templates');
  assert.deepEqual(selected.endpoints, [{ method: 'GET', path: '/api/industries' }, { method: 'GET', path: '/api/templates' }]);
  assert.equal(selected.changed, true);
  const one = await chooseAuditEndpoints(saved, async question => question.startsWith('Current audit targets') ? '3' : '/api/audit-logs/42');
  assert.deepEqual(one.endpoints, [{ method: 'GET', path: '/api/audit-logs/42' }]);
  assert.equal(one.changed, true);
  await assert.rejects(chooseAuditEndpoints(saved, async question => question.startsWith('Current audit targets') ? '2' : '/health'), /excluded from representative auditing/);
});
test('first audit setup refuses missing required target details without writing config', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perflens-audit-no-target-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(ensureProjectForAudit(dir, undefined, async question => question.includes('base URL') ? 'http://localhost:3000' : question.startsWith('Endpoint selection') ? '1' : ''), /requires at least one representative GET endpoint/);
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
  assert.equal(await otlpTracesEndpoint(defaultRoot, 'container'), 'http://host.docker.internal:4318/v1/traces');

  const occupied = await mkdtemp(join(tmpdir(), 'perflens-otlp-alternate-')); t.after(() => rm(occupied, { recursive: true, force: true }));
  const alternateRoot = await installInfrastructureAssets(occupied, 'http://localhost:3000', async port => port !== 4318);
  assert.match(await readFile(join(alternateRoot, '.env'), 'utf8'), /OTLP_HTTP_PORT=4319\n/);
  assert.equal(await otlpTracesEndpoint(alternateRoot), 'http://127.0.0.1:4319/v1/traces');
  assert.equal(await otlpTracesEndpoint(alternateRoot, 'container'), 'http://host.docker.internal:4319/v1/traces');

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
  const makeInfrastructure = (root, run) => new Infrastructure(root, run, undefined, async () => true);
  const output = []; const healthyRun = fake(); assert.equal(await doctor(options, line => output.push(line), healthyRun, async () => 'k6 v2.3.0', root => makeInfrastructure(root, healthyRun)), true, output.join('\n'));
  assert.match(output.join('\n'), /used by this PerfLens/);
  assert.match(output.join('\n'), /OTLP traces endpoint: http:\/\/127\.0\.0\.1:4318\/v1\/traces/);
  for (const failure of ['info', 'version', 'config']) {
    const output = []; const normal = fake();
    const run = async args => { if (args.includes(failure)) throw new Error('simulated failure'); return normal(args); };
    assert.equal(await doctor(options, line => output.push(line), run, async () => 'k6 v2.3.0', root => makeInfrastructure(root, run)), false);
    assert.match(output.join('\n'), /Not ready/); assert.doesNotMatch(output.join('\n'), /Ready to run PerfLens/);
  }
});
test('doctor reports missing or incompatible k6 without hiding the load-test prerequisite', async t => {
  const dir = await fixture(t); const options = { config: join(dir, 'perflens.config.json'), infraDir: dir };
  for (const check of [async () => { throw new CliError('PerfLens could not find k6.', 'Install k6 2.3.x.'); }, async () => 'k6 v1.2.3']) {
    const output = []; assert.equal(await doctor(options, line => output.push(line), fake(), check, root => new Infrastructure(root, fake(), undefined, async () => true)), false);
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
test('up manages only infrastructure, preserves paths with spaces, and probes actual readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'target with spaces')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'OTLP_GRPC_PORT=4317\nOTLP_HTTP_PORT=4318\nOTEL_HEALTH_PORT=13133\nTEMPO_PORT=3200\nPROMETHEUS_PORT=9090\nGRAFANA_PORT=3001\n');
  const calls = []; const infra = new Infrastructure(root, fake(calls), undefined, async () => true);
  await infra.up(0);
  const up = calls.find(args => args.includes('up'));
  assert.ok(up.includes(join(root, 'docker-compose.yml')));
  assert.deepEqual(up.slice(-4), [...INFRA_SERVICES]); assert.ok(!up.includes('demo-api'));
});
test('running containers alone do not imply readiness, and failed startup never succeeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perflens-up-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'OTLP_GRPC_PORT=4317\nOTLP_HTTP_PORT=4318\nOTEL_HEALTH_PORT=13133\nTEMPO_PORT=3200\nPROMETHEUS_PORT=9090\nGRAFANA_PORT=3001\n');
  const normal = fake();
  const infra = new Infrastructure(root, normal, undefined, async () => false);
  await assert.rejects(infra.up(0), /did not become ready/);
  const failed = new Infrastructure(root, async args => { if (args.includes('up')) throw new Error('pull failed'); return normal(args); });
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
test('infrastructure status requires this Compose project, exact port bindings, and reachable host health endpoints', async () => {
  assert.equal(infrastructureReady([]), false, 'an empty discovered service set is never ready');
  assert.equal(infrastructureReady(running.slice(0, 3).map(item => ({ service: item.Service, ready: true }))), false, 'a partial service set is never ready');
  assert.equal(infrastructureReady([...running.slice(0, 3).map(item => ({ service: item.Service, ready: true })), { service: 'tempo', ready: true }, { service: 'tempo', ready: true }]), false, 'duplicates cannot substitute for a missing expected service');
  const unrelated = running.map(container => ({ ...container, Project: 'another-perflens-project' }));
  const absent = await new Infrastructure('/tmp/test', fake([], unrelated), undefined, async () => true).status();
  assert.ok(absent.every(item => !item.ready && item.state === 'not created'));
  const stale = running.map(container => ({ ...container, Publishers: [] }));
  const staleStatus = await new Infrastructure('/tmp/test', fake([], stale), undefined, async () => true).status();
  assert.ok(staleStatus.every(item => !item.ready && /stale or missing published ports/.test(item.state)));
  const stopped = running.map(container => ({ ...container, State: 'exited', Health: 'unhealthy' }));
  const stoppedStatus = await new Infrastructure('/tmp/test', fake([], stopped), undefined, async () => true).status();
  assert.ok(stoppedStatus.every(item => !item.ready && item.state === 'exited'));
  const partial = running.filter(container => container.Service !== 'tempo');
  const partialStatus = await new Infrastructure('/tmp/test', fake([], partial), undefined, async () => true).status();
  assert.equal(partialStatus.find(item => item.service === 'tempo').state, 'not created');
  assert.equal(partialStatus.some(item => item.ready && item.service === 'tempo'), false);
  const unreachable = await new Infrastructure('/tmp/test', fake(), undefined, async () => false).status();
  assert.ok(unreachable.every(item => !item.ready && /not ready/.test(item.state)));
  const healthy = await new Infrastructure('/tmp/test', fake(), undefined, async () => true).status();
  assert.ok(healthy.every(item => item.ready));
});
test('Compose commands pin one consumer-derived identity and orphaned .env ports do not prove readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perflens-orphaned-env-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'GRAFANA_PORT=3003\nPROMETHEUS_PORT=9098\nTEMPO_PORT=3208\nOTLP_GRPC_PORT=4332\nOTLP_HTTP_PORT=4333\nOTEL_HEALTH_PORT=13140\n');
  const calls = [], stalePorts = { 'otel-collector': [4332, 4333, 13140], tempo: [3208], prometheus: [9098], grafana: [3003] };
  const previousProject = process.env.COMPOSE_PROJECT_NAME, previousOtlp = process.env.OTLP_HTTP_PORT;
  process.env.COMPOSE_PROJECT_NAME = 'older-shared-perflens-project'; process.env.OTLP_HTTP_PORT = '4318';
  t.after(() => { if (previousProject === undefined) delete process.env.COMPOSE_PROJECT_NAME; else process.env.COMPOSE_PROJECT_NAME = previousProject; if (previousOtlp === undefined) delete process.env.OTLP_HTTP_PORT; else process.env.OTLP_HTTP_PORT = previousOtlp; });
  let composeOptions;
  const run = async (args, options) => {
    calls.push(args);
    if (args.includes('--project-directory')) composeOptions = options;
    if (args.includes('config')) return JSON.stringify({ name: args[args.indexOf('--project-name') + 1], services: Object.fromEntries(INFRA_SERVICES.map(service => [service, { ports: portBindings[service].map(port => ({ ...port, published: String(stalePorts[service][portBindings[service].filter(item => item.target < port.target).length]) })) }])) });
    if (args.includes('ps')) return JSON.stringify(running.map(container => ({ ...container, Project: 'unrelated-perflens-stack', Publishers: container.Publishers.map(port => ({ ...port, PublishedPort: stalePorts[container.Service][container.Publishers.indexOf(port)] })) })));
    return '';
  };
  const infra = new Infrastructure(root, run, undefined, async () => true);
  const status = await infra.status();
  assert.equal(infrastructureReady(status), false);
  assert.equal(status.length, INFRA_SERVICES.length);
  assert.ok(status.every(service => service.state === 'not created'));
  const identity = infrastructureProjectName(root);
  assert.ok(calls.length > 0 && calls.every(args => args[args.indexOf('--project-name') + 1] === identity));
  assert.equal(composeOptions.env.OTLP_HTTP_PORT, '4333', 'the project .env overrides conflicting shell ports');
  assert.ok(composeOptions.unsetEnv.includes('OTLP_HTTP_PORT'));
});
test('a healthy stack returned under an overridden Compose project name cannot satisfy consumer readiness', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perflens-compose-identity-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'GRAFANA_PORT=3003\nPROMETHEUS_PORT=9098\nTEMPO_PORT=3208\nOTLP_GRPC_PORT=4332\nOTLP_HTTP_PORT=4333\nOTEL_HEALTH_PORT=13140\n');
  const calls = [];
  const run = async args => {
    calls.push(args);
    if (args.includes('config')) return JSON.stringify({ ...compose, name: 'older-shared-perflens-stack' });
    if (args.includes('ps')) return JSON.stringify(running.map(container => ({ ...container, Project: 'older-shared-perflens-stack' })));
    return '';
  };
  await assert.rejects(new Infrastructure(root, run, undefined, async () => true).status(), /project identity did not resolve to this consumer/);
  assert.equal(calls.some(args => args.includes('ps')), false, 'identity mismatch is rejected before service inspection');
});
test('infrastructure recovery reallocates stale occupied ports and recreates only this project stack without volumes', async t => {
  const calls = []; const root = await mkdtemp(join(tmpdir(), 'perflens-repair-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'OTLP_GRPC_PORT=4317\nOTLP_HTTP_PORT=4318\nOTEL_HEALTH_PORT=13133\nTEMPO_PORT=3200\nPROMETHEUS_PORT=9090\nGRAFANA_PORT=3001\n');
  let containers = running.map(container => ({ ...container, Publishers: [] }));
  const effectiveCompose = async () => {
    const env = await readFile(join(root, '.env'), 'utf8');
    const services = Object.fromEntries(INFRA_SERVICES.map(service => [service, { ports: portBindings[service].map(port => {
      const key = { 'otel-collector:4317': 'OTLP_GRPC_PORT', 'otel-collector:4318': 'OTLP_HTTP_PORT', 'otel-collector:13133': 'OTEL_HEALTH_PORT', 'tempo:3200': 'TEMPO_PORT', 'prometheus:9090': 'PROMETHEUS_PORT', 'grafana:3000': 'GRAFANA_PORT' }[`${service}:${port.target}`];
      return { ...port, published: new RegExp(`^${key}=(\\d+)$`, 'm').exec(env)[1] };
    }) }]));
    return { name: infrastructureProjectName(root), services };
  };
  const run = async args => {
    calls.push(args);
    const projectIndex = args.indexOf('--project-name'); const projectName = args[projectIndex + 1];
    if (args.includes('config')) return JSON.stringify(await effectiveCompose());
    if (args.includes('ps')) return JSON.stringify(containers);
    if (args.includes('up')) {
      const current = await effectiveCompose();
      containers = running.map(container => ({ ...container, Project: projectName, Publishers: current.services[container.Service].ports.map(port => ({ PublishedPort: Number(port.published), TargetPort: port.target, URL: port.host_ip, Protocol: 'tcp' })) }));
    }
    return '';
  };
  let checks = [];
  const infra = new Infrastructure(root, run, async port => { checks.push(port); return port !== 4318; }, async () => true);
  const config = await infra.up(0, true);
  assert.equal(config.name, infrastructureProjectName(root));
  assert.equal(await otlpTracesEndpoint(root), 'http://127.0.0.1:4319/v1/traces');
  assert.equal(config.services['otel-collector'].ports.find(port => port.target === 4318).published, '4319');
  const persisted = await readFile(join(root, '.env'), 'utf8');
  for (const service of INFRA_SERVICES) for (const binding of config.services[service].ports) {
    const key = { 'otel-collector:4317': 'OTLP_GRPC_PORT', 'otel-collector:4318': 'OTLP_HTTP_PORT', 'otel-collector:13133': 'OTEL_HEALTH_PORT', 'tempo:3200': 'TEMPO_PORT', 'prometheus:9090': 'PROMETHEUS_PORT', 'grafana:3000': 'GRAFANA_PORT' }[`${service}:${binding.target}`];
    assert.equal(new RegExp(`^${key}=(\\d+)$`, 'm').exec(persisted)?.[1], binding.published, `${key} must match Compose's authoritative port`);
  }
  assert.ok(checks.includes(4318));
  const up = calls.find(args => args.includes('up'));
  assert.ok(up.includes('--force-recreate'));
  assert.ok(!up.includes('-v') && !up.includes('--volumes') && !up.includes('rm'));
  assert.match(persisted, /OTLP_HTTP_PORT=4319/);
});
test('failure formatting retains remediation without stack traces', () => {
  assert.equal(formatError(new CliError('Docker unavailable.', 'Start Docker.')), '✗ Docker unavailable.\nStart Docker.');
  assert.doesNotMatch(formatError(new Error('failure')), /at .*\.js/);
});
