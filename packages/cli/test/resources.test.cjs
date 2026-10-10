const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { AuditResourceCollector, parseDockerStatsLine, summarizeResourceProfiles } = require('../dist/audit/resources.js');

const runId = 'pfl_20261010T120000000Z_123e4567-e89b-12d3-a456-426614174000';

test('Docker stats parsing records Docker CPU basis, memory bytes, and only a known configured limit', () => {
  const unbounded = parseDockerStatsLine(JSON.stringify({ CPUPerc: '12.50%', MemUsage: '32.0MiB / 7.7GiB' }), {
    runId, profile: 'baseline', container: 'selected-api', hostLogicalCpus: 8, cpuQuotaCores: null,
  });
  assert.equal(unbounded.dockerReportedCpuPercent, 12.5);
  assert.equal(unbounded.cpuNormalization, 'docker-stats-reported');
  assert.equal(unbounded.memoryUsedBytes, 32 * 1024 * 1024);
  assert.equal(unbounded.memoryLimitBytes, null);
  const bounded = parseDockerStatsLine(JSON.stringify({ CPUPerc: '50%', MemUsage: '1.5MiB / 512MiB' }), {
    runId, profile: 'normal', container: 'selected-api', hostLogicalCpus: 8, cpuQuotaCores: 1, memoryLimitBytes: 512 * 1024 * 1024,
  });
  assert.equal(bounded.memoryLimitBytes, 512 * 1024 * 1024);
  assert.equal(bounded.cpuQuotaCores, 1);
  assert.equal(parseDockerStatsLine('not json', { runId, profile: 'baseline', container: 'api', hostLogicalCpus: null, cpuQuotaCores: null }), null);
});

test('resource profile summaries use persisted samples and keep absent values unavailable', () => {
  const evidence = {
    schemaVersion: 1, runId, samplingIntervalMs: 1000, collection: {},
    processSamples: [
      { profile: 'baseline', timestamp: '2026-10-10T12:00:00.000Z', cpuPercentOneLogicalCpu: 20, rssBytes: 1000, heapUsedBytes: 500, heapTotalBytes: 800, externalBytes: 100 },
      { profile: 'baseline', timestamp: '2026-10-10T12:00:01.000Z', cpuPercentOneLogicalCpu: 40, rssBytes: 1200, heapUsedBytes: 600, heapTotalBytes: 900, externalBytes: 120 },
    ],
    containerSamples: [
      { profile: 'baseline', timestamp: '2026-10-10T12:00:00.000Z', dockerReportedCpuPercent: 25, memoryUsedBytes: 2000, memoryLimitBytes: 4000 },
      { profile: 'baseline', timestamp: '2026-10-10T12:00:01.000Z', dockerReportedCpuPercent: 45, memoryUsedBytes: 2400, memoryLimitBytes: 4000 },
    ],
  };
  const [summary] = summarizeResourceProfiles(evidence);
  assert.equal(summary.processCpuAveragePercent, 30);
  assert.equal(summary.processCpuPeakPercent, 40);
  assert.equal(summary.rssPeakBytes, 1200);
  assert.equal(summary.heapUsedPeakBytes, 600);
  assert.equal(summary.containerCpuAveragePercent, 35);
  assert.equal(summary.containerMemoryAverageBytes, 2200);
  assert.equal(summary.containerMemoryPeakBytes, 2400);
  assert.equal(summary.containerMemoryLimitBytes, 4000);
  assert.equal(summary.containerMemoryPeakPercentOfLimit, 60);
});

test('resource profile aggregation is sample-weighted and RSS continuity requires one process instance', () => {
  const evidence = {
    schemaVersion: 1, runId, samplingIntervalMs: 1000, collection: {},
    processSamples: [
      { profile: 'baseline', timestamp: '2026-10-10T12:00:00.000Z', processId: 11, processInstanceId: 'worker-a', cpuPercentOneLogicalCpu: 20, rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 80, externalBytes: 5 },
      { profile: 'baseline', timestamp: '2026-10-10T12:00:01.000Z', processId: 12, processInstanceId: 'worker-b', cpuPercentOneLogicalCpu: 40, rssBytes: 300, heapUsedBytes: 150, heapTotalBytes: 180, externalBytes: 15 },
    ], containerSamples: [],
  };
  const [summary] = summarizeResourceProfiles(evidence);
  assert.equal(summary.processInstances, 2);
  assert.equal(summary.processCpuAveragePercent, 30, 'CPU average is a mean of per-process samples, not a sum');
  assert.equal(summary.processCpuPeakPercent, 40, 'peak is one observed process sample');
  assert.equal(summary.rssAverageBytes, 200, 'RSS average is a mean of samples, not service memory total');
  assert.equal(summary.rssPeakBytes, 300, 'RSS peak is one process sample');
  assert.equal(summary.rssGrowthBytes, null, 'multiple process lifetimes are not joined into one growth window');
});

test('profile marker and raw resource evidence are persisted with run/profile attribution', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-resource-project-'));
  const runDirectory = join(project, '.perflens', 'runs', runId);
  const resourceDirectory = join(project, '.perflens', 'runtime', 'resources');
  await mkdir(runDirectory, { recursive: true });
  t.after(() => rm(project, { recursive: true, force: true }));
  const collector = new AuditResourceCollector(project, runId, { directory: resourceDirectory });
  await collector.prepare(runDirectory);
  await collector.beginProfile('baseline');
  const marker = JSON.parse(await readFile(join(resourceDirectory, 'phase.json'), 'utf8'));
  assert.deepEqual([marker.runId, marker.profile, marker.active], [runId, 'baseline', true]);
  const sample = { schemaVersion: 1, runId, profile: 'baseline', timestamp: new Date().toISOString(), monotonicNs: '10', source: 'node-process', processId: 42, processInstanceId: 'process-lifetime-42', cpuUserMicros: 500, cpuSystemMicros: 100, cpuPercentOneLogicalCpu: 12, cpuNormalization: 'one-logical-cpu', rssBytes: 1000, heapUsedBytes: 500, heapTotalBytes: 800, externalBytes: 100 };
  await writeFile(join(resourceDirectory, `process-${runId}.ndjson`), `${JSON.stringify(sample)}\n`);
  await collector.endProfile();
  const evidence = await collector.finalize(runDirectory);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.runId, runId);
  assert.equal(evidence.collection.process, 'available');
  assert.deepEqual(evidence.processSamples.map(row => [row.runId, row.profile, row.processId]), [[runId, 'baseline', 42]]);
  assert.equal(evidence.processSamples[0].processInstanceId, 'process-lifetime-42');
  assert.ok(JSON.parse(await readFile(join(runDirectory, 'resources', 'evidence.json'), 'utf8')));
});

test('unavailable Docker statistics are represented as unavailable rather than zero', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-resource-docker-'));
  const runDirectory = join(project, '.perflens', 'runs', runId);
  await mkdir(runDirectory, { recursive: true });
  t.after(() => rm(project, { recursive: true, force: true }));
  const collector = new AuditResourceCollector(project, runId, { directory: join(project, '.perflens', 'runtime', 'resources'), container: 'selected-api', dockerRun: async () => { throw new Error('unavailable'); } });
  await collector.prepare(runDirectory);
  const evidence = await collector.finalize(runDirectory);
  assert.equal(evidence.collection.container, 'unavailable');
  assert.equal(evidence.containerSamples.length, 0);
  assert.match(evidence.collection.containerNote, /Docker resource statistics could not be read/);
});

test('runtime sampling setup failures are recorded without aborting the audit', async t => {
  const project = await mkdtemp(join(tmpdir(), 'perflens-resource-runtime-failure-'));
  const runDirectory = join(project, '.perflens', 'runs', runId);
  await mkdir(runDirectory, { recursive: true });
  await mkdir(join(project, '.perflens'), { recursive: true });
  await writeFile(join(project, '.perflens', 'runtime'), 'blocks runtime directory');
  t.after(() => rm(project, { recursive: true, force: true }));
  const collector = new AuditResourceCollector(project, runId);
  await assert.doesNotReject(async () => {
    await collector.prepare(runDirectory);
    await collector.beginProfile('baseline');
    await collector.endProfile();
  });
  const evidence = await collector.finalize(runDirectory);
  assert.equal(evidence.collection.process, 'unavailable');
  assert.match(evidence.collection.processNote, /not writable/);
});
