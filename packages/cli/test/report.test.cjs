const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { report } = require('../dist/report/service.js');

const runId = 'pfl_20260930T120000000Z_12345678-1234-1234-1234-123456789abc';
async function project({ analyzed = true, findings = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perflens-report-'));
  const dir = path.join(root, '.perflens', 'runs', runId);
  await fs.mkdir(path.join(dir, 'results'), { recursive: true });
  await fs.mkdir(path.join(dir, 'analysis'), { recursive: true });
  await fs.writeFile(path.join(root, 'perflens.config.json'), JSON.stringify({ project: { name: 'fixture' }, target: { baseUrl: 'http://localhost:3002' }, observability: { serviceName: 'demo' } }));
  const runProfile = { name: 'baseline', status: 'completed', startedAt: '2026-09-30T12:00:00Z', endedAt: '2026-09-30T12:00:10Z', result: 'results/baseline.json' };
  const run = { schemaVersion: 1, runId, status: 'completed', startedAt: runProfile.startedAt, endedAt: runProfile.endedAt, target: { baseUrl: 'http://localhost:3002' }, serviceName: 'demo', profiles: [runProfile] };
  const profile = { schemaVersion: 1, runId, profile: 'baseline', status: 'completed', target: { endpoints: [{ method: 'GET', path: '/orders' }] }, workload: { executor: 'constant-vus', vus: 1, durationMs: 10000 }, metrics: { requests: 20, successfulRequests: 20, failedRequests: 0, errorRate: 0, rps: 2, latencyMs: { p50: 5, p90: 10, p95: 12, p99: 14 } } };
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(dir, runProfile.result), JSON.stringify(profile));
  if (analyzed) {
    const analysis = { schemaVersion: 1, analysisVersion: 1, ruleSetVersion: 1, runId, analyzedAt: run.endedAt, target: { baseUrl: run.target.baseUrl, serviceName: 'demo', endpoints: profile.target.endpoints }, traceSummary: { requests: 10, databaseSpans: 20, externalClientSpans: 0, traces: 10 }, availability: { traces: true }, findings, unsupported: [] };
    await fs.writeFile(path.join(dir, 'analysis/analysis.json'), JSON.stringify(analysis));
    await fs.writeFile(path.join(dir, 'analysis/findings.json'), JSON.stringify({ schemaVersion: 1, runId, findings }));
    await fs.writeFile(path.join(dir, 'analysis/evidence.json'), JSON.stringify({ schemaVersion: 1, runId, traces: [], telemetry: { source: 'fixture' } }));
  }
  return { root, dir };
}
const sampleFinding = { id: 'db-repeat', ruleId: 'database.repeated-operation', category: 'database', title: 'Repeated database operation', summary: 'Observed repeated PostgreSQL operation.', severity: 'P2', confidence: 'high', target: { method: 'GET', path: '/orders' }, profiles: ['baseline'], evidence: [{ observation: 'Repeated query shape seen in 8/10 traces.', source: 'snapshot', value: { tracesAffected: 8 } }], metrics: { affectedRatio: 0.8 } };

test('report integration loads finalized artifacts and writes normalized JSON, Markdown and HTML', async () => {
  const { root, dir } = await project({ findings: [sampleFinding] });
  try {
    const output = [];
    const model = await report({ config: path.join(root, 'perflens.config.json') }, runId, line => output.push(line));
    assert.equal(model.perflensVersion, '0.1.0');
    assert.equal(model.findings[0].severity, 'P2');
    assert.equal(model.findings[0].confidence, 'high');
    assert.equal(model.diagnosticEvidence.schemaVersion, 1);
    assert.equal(model.diagnosticEvidence.httpStatusProfiles[0].statusState, 'not-persisted');
    for (const file of ['report.json', 'report.md', 'report.html']) await fs.access(path.join(dir, 'report', file));
    const json = JSON.parse(await fs.readFile(path.join(dir, 'report/report.json'), 'utf8'));
    const md = await fs.readFile(path.join(dir, 'report/report.md'), 'utf8');
    const html = await fs.readFile(path.join(dir, 'report/report.html'), 'utf8');
    assert.equal(json.reportVersion, 5);
    assert.equal(json.diagnosticEvidence.schemaVersion, 1);
    assert.match(html, /Diagnostic coverage/);
    assert.match(md, /Repeated database operation/);
    assert.match(html, /Repeated database operation/);
    assert.ok(output[0].includes('P2'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('latest report accepts valid zero-finding analysis and optional output format', async () => {
  const { root, dir } = await project();
  try {
    const result = await report({ config: path.join(root, 'perflens.config.json'), format: 'markdown' }, undefined, () => {});
    assert.equal(result.findings.length, 0);
    await fs.access(path.join(dir, 'report/report.json'));
    await fs.access(path.join(dir, 'report/report.md'));
    await assert.rejects(fs.access(path.join(dir, 'report/report.html')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('missing analysis, malformed artifacts, and invalid formats fail without claiming success', async () => {
  const missing = await project({ analyzed: false });
  try { await assert.rejects(report({ config: path.join(missing.root, 'perflens.config.json') }, runId, () => {}), /Run "perflens analyze .* first/); }
  finally { await fs.rm(missing.root, { recursive: true, force: true }); }
  const malformed = await project();
  try {
    await fs.writeFile(path.join(malformed.dir, 'analysis/analysis.json'), '{broken');
    await assert.rejects(report({ config: path.join(malformed.root, 'perflens.config.json') }, runId, () => {}), /Analysis is missing or invalid/);
    await assert.rejects(report({ config: path.join(malformed.root, 'perflens.config.json'), format: 'pdf' }, runId, () => {}), /Unsupported report format/);
  } finally { await fs.rm(malformed.root, { recursive: true, force: true }); }
});

test('report output write failures are explicit and never print success', async () => {
  const { root, dir } = await project();
  try {
    await fs.writeFile(path.join(dir, 'report'), 'blocking file');
    const output = [];
    await assert.rejects(report({ config: path.join(root, 'perflens.config.json') }, runId, line => output.push(line)), /Could not create report directory/);
    assert.equal(output.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
