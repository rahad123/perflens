const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runCompleteAudit } = require('../dist/audit/orchestrator');

const runId = 'pfl_20261002T120000000Z_12345678-1234-1234-1234-123456789abc';
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'perflens-orchestrator-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'perflens.config.json'), JSON.stringify({
    project: { name: 'consumer' }, target: { baseUrl: 'http://localhost:3400' }, observability: { serviceName: 'consumer-api' },
    audit: { endpoints: [{ method: 'GET', path: '/health' }] },
  }));
  return cwd;
}
function mockDependencies(t, overrides = {}) {
  const events = [];
  const dir = join(t.cwd, '.perflens', 'runs', runId);
  return {
    events,
    infrastructure: () => ({
      async status() { events.push('status'); return [{ ready: true }]; },
      async up() { events.push('up'); throw new Error('must reuse healthy infrastructure'); },
    }),
    async audit() {
      events.push('audit');
      await mkdir(join(dir, 'telemetry'), { recursive: true });
      await writeFile(join(dir, 'telemetry/metadata.json'), JSON.stringify({ infrastructure: { localUrls: { grafana: 'http://127.0.0.1:3001', prometheus: 'http://127.0.0.1:9090' } } }));
      for (const [profile, requests, vus] of [['baseline', 20, 1], ['normal', 90, 3]]) {
        await mkdir(join(dir, 'results'), { recursive: true });
        await writeFile(join(dir, `results/${profile}.json`), JSON.stringify({ profile, metrics: { requests, failedRequests: 0, rps: 6, errorRate: 0, durationMs: 15000, latencyMs: { p50: 5, p95: 10, p99: 15 } } }));
      }
      return { directory: dir, run: { runId, profiles: [{ name: 'baseline', result: 'results/baseline.json' }, { name: 'normal', result: 'results/normal.json' }] } };
    },
    async analyze() { events.push('analyze'); return { availability: { traces: true }, traceSummary: { requests: 110, databaseSpans: 222, externalClientSpans: 0 }, findings: [] }; },
    async report() { events.push('report'); return { findings: [] }; },
    ...overrides,
  };
}

test('one-command audit reuses healthy infrastructure and runs measurement, analysis, then report with measured summary', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t), output = [];
  const options = { config: join(t.cwd, 'perflens.config.json') };
  const result = await runCompleteAudit(options, new AbortController().signal, line => output.push(line), deps);
  assert.deepEqual(deps.events, ['status', 'audit', 'analyze', 'report']);
  assert.equal(result.run.runId, runId);
  assert.match(output.join('\n'), /PERFORMANCE/);
  assert.match(output.join('\n'), /baseline\s+20\s+0\s+6\.00/);
  assert.match(output.join('\n'), /p50 ms.*p95 ms.*p99 ms/);
  assert.match(output.join('\n'), /No evidence-backed bottlenecks/);
  assert.match(output.join('\n'), /PostgreSQL spans: 222/);
  assert.match(output.join('\n'), /Grafana: http:\/\/127\.0\.0\.1:3001/);
  assert.match(output.join('\n'), new RegExp(runId));
});

test('a k6/audit failure is stage-labelled and never proceeds to analysis or report', async t => {
  t.cwd = await fixture(t);
  const deps = mockDependencies(t, { async audit() { deps.events.push('audit'); throw new Error('k6 exited 1'); } });
  await assert.rejects(runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, () => undefined, deps), /Audit execution or telemetry preflight failed.*k6 exited 1/);
  assert.deepEqual(deps.events, ['status', 'audit']);
});

test('missing correlated telemetry fails after preserving audit evidence and skips reporting', async t => {
  t.cwd = await fixture(t); const deps = mockDependencies(t, { async analyze() { deps.events.push('analyze'); return { availability: { traces: false }, traceSummary: { requests: 0, databaseSpans: 0, externalClientSpans: 0 }, findings: [] }; } });
  await assert.rejects(runCompleteAudit({ config: join(t.cwd, 'perflens.config.json') }, new AbortController().signal, () => undefined, deps), /Evidence analysis failed.*No correlated request traces/);
  assert.deepEqual(deps.events, ['status', 'audit', 'analyze']);
  assert.match(await readFile(join(t.cwd, '.perflens', 'runs', runId, 'telemetry/metadata.json'), 'utf8'), /grafana/);
});
