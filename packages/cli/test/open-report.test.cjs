const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openGeneratedReport, openFileInBrowser, openerForPlatform, runAuditAndMaybeOpenReport } = require('../dist/report/open');

const runA = 'pfl_20261007T180126602Z_20bb015a-6881-4daa-903a-73b44cb5262a';
const runB = 'pfl_20261008T120000000Z_12345678-1234-1234-1234-123456789abc';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-open-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'perflens.config.json'), JSON.stringify({ project: { name: 'fixture' }, target: { baseUrl: 'http://localhost:3000' }, observability: { serviceName: 'fixture' } }));
  return root;
}
async function addRun(root, id, { status = 'completed', report = true } = {}) {
  const directory = path.join(root, '.perflens', 'runs', id);
  await fs.mkdir(path.join(directory, 'report'), { recursive: true });
  await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify({ schemaVersion: 1, runId: id, status }));
  if (report) await fs.writeFile(path.join(directory, 'report', 'report.html'), '<!doctype html>');
  return path.join(directory, 'report', 'report.html');
}

test('report --open resolution selects the latest completed run with an HTML artifact', async t => {
  const root = await fixture(t), expected = await addRun(root, runA);
  await addRun(root, runB, { status: 'failed' });
  const paths = [], output = [];
  const opened = await openGeneratedReport({ config: path.join(root, 'perflens.config.json') }, undefined, line => output.push(line), async file => paths.push(file));
  assert.equal(opened.id, runA);
  assert.equal(paths[0], expected);
  assert.ok(output.some(line => line.includes(`.perflens/runs/${runA}/report/report.html`)));
});

test('report --open supports an explicit run ID and does not regenerate artifacts', async t => {
  const root = await fixture(t), expected = await addRun(root, runB);
  let openedFile;
  const result = await openGeneratedReport({ config: path.join(root, 'perflens.config.json') }, runB, () => {}, async file => { openedFile = file; });
  assert.equal(result.file, expected);
  assert.equal(openedFile, expected);
  assert.equal(await fs.readFile(expected, 'utf8'), '<!doctype html>');
});

test('missing and incomplete reports fail clearly', async t => {
  const root = await fixture(t);
  await assert.rejects(openGeneratedReport({ config: path.join(root, 'perflens.config.json') }, undefined, () => {}, async () => {}), /No generated PerfLens report/);
  const missing = await addRun(root, runA, { report: false });
  await assert.rejects(openGeneratedReport({ config: path.join(root, 'perflens.config.json') }, runA, () => {}, async () => {}), /No generated HTML report/);
  assert.ok(missing.endsWith('report.html'));
});

test('platform openers use safe argument vectors and support paths with spaces', async () => {
  assert.equal(openerForPlatform('darwin').command, 'open');
  assert.equal(openerForPlatform('linux').command, 'xdg-open');
  assert.equal(openerForPlatform('win32').command, 'explorer.exe');
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  await openFileInBrowser('/tmp/project with spaces/report.html', 'darwin', spawn);
  assert.equal(calls[0].command, 'open');
  assert.deepEqual(calls[0].args, ['/tmp/project with spaces/report.html']);
  assert.equal(calls[0].options.shell, false);
});

test('browser opener failure preserves report success and prints manual path', async t => {
  const root = await fixture(t), expected = await addRun(root, runA), output = [];
  const result = await openGeneratedReport({ config: path.join(root, 'perflens.config.json') }, runA, line => output.push(line), async () => { throw new Error('no browser'); });
  assert.equal(result.file, expected);
  assert.equal(result.opened, false);
  assert.ok(output.some(line => line.includes('Could not open the browser automatically')));
});

test('audit --open opens only the newly completed run and never falls back to an older report after failure', async t => {
  const root = await fixture(t), oldFile = await addRun(root, runA), newFile = await addRun(root, runB);
  const selected = [];
  const completed = await runAuditAndMaybeOpenReport(async () => ({ run: { runId: runB } }), true, { config: path.join(root, 'perflens.config.json') }, () => {}, async file => selected.push(file));
  assert.equal(completed.run.runId, runB);
  assert.deepEqual(selected, [newFile]);
  await assert.rejects(runAuditAndMaybeOpenReport(async () => { throw new Error('audit failed'); }, true, { config: path.join(root, 'perflens.config.json') }, () => {}, async file => selected.push(file)), /audit failed/);
  assert.deepEqual(selected, [newFile]);
  assert.ok(oldFile);
});
