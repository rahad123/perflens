import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner, docker } from '../services/process';

export type ProfileName = 'baseline' | 'normal' | 'peak' | 'stress';
export type ResourceState = 'available' | 'partial' | 'unavailable' | 'not-collected' | 'insufficient-evidence';
export interface ProcessSample {
  schemaVersion: 1; runId: string; profile: ProfileName; timestamp: string; monotonicNs: string;
  source: 'node-process'; processId: number; cpuUserMicros: number; cpuSystemMicros: number;
  cpuPercentOneLogicalCpu: number | null; cpuNormalization: 'one-logical-cpu';
  rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number;
}
export interface ContainerSample {
  schemaVersion: 1; runId: string; profile: ProfileName; timestamp: string; source: 'docker-container';
  container: string; dockerReportedCpuPercent: number | null; cpuNormalization: 'docker-stats-reported';
  hostLogicalCpus: number | null; cpuQuotaCores: number | null; memoryUsedBytes: number | null; memoryLimitBytes: number | null;
}
export interface ResourceEvidence {
  schemaVersion: 1; runId: string; samplingIntervalMs: number;
  collection: { process: ResourceState; container: ResourceState; processNote: string; containerNote: string };
  processSamples: ProcessSample[]; containerSamples: ContainerSample[];
}
export interface ResourceProfileSummary {
  profile: ProfileName; processSampleCount: number; processCpuAveragePercent: number | null; processCpuPeakPercent: number | null;
  rssAverageBytes: number | null; rssPeakBytes: number | null; rssGrowthBytes: number | null; heapUsedAverageBytes: number | null; heapUsedPeakBytes: number | null; heapTotalPeakBytes: number | null; externalPeakBytes: number | null;
  containerSampleCount: number; containerCpuAveragePercent: number | null; containerCpuPeakPercent: number | null;
  containerMemoryAverageBytes: number | null; containerMemoryPeakBytes: number | null; containerMemoryLimitBytes: number | null; containerMemoryPeakPercentOfLimit: number | null;
}
export interface ResourceRuntime {
  directory: string;
  container?: string;
  dockerRun?: Runner;
}

const SAMPLE_INTERVAL_MS = 1000;
const MAX_SAMPLES_PER_SOURCE = 3600;
const CONTAINER_RESOURCE_DIR = '/tmp/perflens-resource';
const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function parseDockerStatsLine(raw: string, input: { runId: string; profile: ProfileName; container: string; hostLogicalCpus: number | null; cpuQuotaCores: number | null; memoryLimitBytes?: number | null; timestamp?: string }): ContainerSample | null {
  let value: any;
  try { value = JSON.parse(raw); } catch { return null; }
  const parsePercent = (text: unknown) => typeof text === 'string' && /^\d+(?:\.\d+)?%$/.test(text.trim()) ? Number(text.trim().slice(0, -1)) : null;
  const parseBytes = (text: unknown): number | null => {
    if (typeof text !== 'string') return null;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*$/i.exec(text);
    if (!match) return null;
    const unit = match[2].toLowerCase();
    const powers: Record<string, number> = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
    return Math.round(Number(match[1]) * powers[unit]);
  };
  const memoryParts = typeof value.MemUsage === 'string' ? value.MemUsage.split('/') : [];
  return {
    schemaVersion: 1, runId: input.runId, profile: input.profile,
    timestamp: input.timestamp ?? new Date().toISOString(), source: 'docker-container', container: input.container,
    dockerReportedCpuPercent: parsePercent(value.CPUPerc), cpuNormalization: 'docker-stats-reported',
    hostLogicalCpus: input.hostLogicalCpus, cpuQuotaCores: input.cpuQuotaCores,
    memoryUsedBytes: parseBytes(memoryParts[0] ?? ''), memoryLimitBytes: input.memoryLimitBytes ?? null,
  };
}

/** Captures the host-side k6 window and retrieves process samples emitted by the managed preload. */
export class AuditResourceCollector {
  private readonly processFile: string;
  private readonly markerFile: string;
  private processSamples: ProcessSample[] = [];
  private containerSamples: ContainerSample[] = [];
  private states: ResourceEvidence['collection'] = { process: 'not-collected', container: 'not-collected', processNote: 'No process sampler was observed.', containerNote: 'No audited Docker service was selected.' };
  private interval: NodeJS.Timeout | undefined;
  private pending: Promise<void> = Promise.resolve();
  private sampleBusy = false;
  private active: { profile: ProfileName; runId: string } | undefined;
  private hasProfile = false;
  private processSetupFailed = false;
  private hostLogicalCpus: number | null = null;
  private cpuQuotaCores: number | null = null;
  private memoryLimitBytes: number | null = null;
  private containerRunner: Runner;
  constructor(private readonly projectDirectory: string, private readonly runId: string, private readonly runtime?: ResourceRuntime) {
    const directory = runtime?.directory ?? join(projectDirectory, '.perflens', 'runtime', 'resources');
    this.processFile = join(directory, `process-${runId}.ndjson`);
    this.markerFile = join(directory, 'phase.json');
    this.containerRunner = runtime?.dockerRun ?? docker;
  }
  async prepare(runDirectory: string): Promise<void> {
    try { await mkdir(join(runDirectory, 'resources'), { recursive: true, mode: 0o700 }); }
    catch {
      this.states.process = 'unavailable'; this.states.container = 'unavailable';
      this.states.processNote = 'The run resource evidence directory could not be prepared.';
      this.states.containerNote = 'The run resource evidence directory could not be prepared.';
      return;
    }
    try {
      await mkdir(join(this.projectDirectory, '.perflens', 'runtime', 'resources'), { recursive: true, mode: 0o700 });
      await writeFile(this.processFile, '', { mode: 0o600 });
      await this.writeMarker(null);
    } catch {
      this.processSetupFailed = true;
      this.states.process = 'unavailable';
      this.states.processNote = 'The project-local runtime directory is not writable; Node process samples cannot be collected.';
    }
    if (this.runtime?.container) {
      this.states.container = 'unavailable';
      try {
        const [hostCpu, hostConfigRaw] = await Promise.all([
          this.containerRunner(['info', '--format', '{{.NCPU}}'], { timeout: 10000 }),
          this.containerRunner(['inspect', '--format', '{{json .HostConfig}}', this.runtime.container], { timeout: 10000 }),
        ]);
        const hostCount = Number(hostCpu.trim());
        this.hostLogicalCpus = Number.isSafeInteger(hostCount) && hostCount > 0 ? hostCount : null;
        const config = JSON.parse(hostConfigRaw);
        const nano = numberOrNull(config?.NanoCpus);
        const quota = numberOrNull(config?.CpuQuota), period = numberOrNull(config?.CpuPeriod);
        this.cpuQuotaCores = nano ? nano / 1e9 : quota && period ? quota / period : null;
        const memoryLimit = numberOrNull(config?.Memory);
        this.memoryLimitBytes = memoryLimit && memoryLimit > 0 ? memoryLimit : null;
        const marker = join(runDirectory, 'resources', 'inactive-phase.json');
        await writeFile(marker, JSON.stringify({ schemaVersion: 1, active: false }), { mode: 0o600 });
        await this.containerRunner(['cp', marker, `${this.runtime.container}:${CONTAINER_RESOURCE_DIR}/phase.json`], { timeout: 10000 });
        this.states.container = 'partial';
        this.states.containerNote = 'Docker stats are sampled for the selected Compose application container only.';
      } catch {
        this.states.container = 'unavailable';
        this.states.containerNote = 'Docker resource statistics could not be read for the selected application container.';
      }
      this.states.process = 'unavailable';
      this.states.processNote = 'The container preload process sampler is enabled; coverage is unavailable until it writes correlated samples.';
    } else {
      this.states.process = 'not-collected';
      this.states.processNote = 'Host-run process sampling requires the supported PerfLens preload and a writable project runtime directory.';
    }
  }
  async beginProfile(profile: ProfileName): Promise<void> {
    this.hasProfile = true;
    this.active = { runId: this.runId, profile };
    await this.writeMarker(this.active);
    if (!this.runtime?.container || this.states.container === 'unavailable') return;
    await this.sampleContainer();
    this.interval = setInterval(() => { void this.sampleContainer(); }, SAMPLE_INTERVAL_MS);
    this.interval.unref();
  }
  async endProfile(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    await this.pending;
    await this.writeMarker(null);
    this.active = undefined;
  }
  async finalize(runDirectory: string): Promise<ResourceEvidence> {
    await this.endProfile();
    if (this.hasProfile) await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS + 50));
    const processInput = join(runDirectory, 'resources', 'process-samples.ndjson');
    try {
      if (this.runtime?.container) await this.containerRunner(['cp', `${this.runtime.container}:${CONTAINER_RESOURCE_DIR}/process-${this.runId}.ndjson`, processInput], { timeout: 10000 });
      else await copyFile(this.processFile, processInput);
      const raw = await readFile(processInput, 'utf8');
      this.processSamples = raw.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { const item = JSON.parse(line); return validProcessSample(item, this.runId) ? [item] : []; } catch { return []; }
      }).slice(-MAX_SAMPLES_PER_SOURCE);
      this.states.process = this.processSamples.length ? 'available' : this.processSetupFailed || this.runtime?.container ? 'unavailable' : 'not-collected';
      if (this.processSamples.length) this.states.processNote = 'Node process CPU and memory samples are correlated to the recorded profile markers.';
      if (!this.processSamples.length && this.states.process !== 'unavailable' && this.runtime?.container) this.states.processNote = 'The application container did not persist any run-correlated process samples.';
      if (!this.processSamples.length && this.states.process !== 'unavailable' && !this.runtime?.container) this.states.processNote = 'No PerfLens-preloaded host process wrote samples for this run.';
    } catch {
      this.states.process = this.processSetupFailed || this.runtime?.container ? 'unavailable' : 'not-collected';
      if (this.processSetupFailed) this.states.processNote = 'The project-local runtime directory is not writable; Node process samples cannot be collected.';
      else this.states.processNote = this.runtime?.container ? 'Process samples could not be retrieved from the selected container.' : 'No PerfLens-preloaded host process wrote samples for this run.';
    }
    if (this.containerSamples.length) this.states.containerNote = 'Docker stats were collected for the selected application container; CPU uses Docker-reported host logical CPU basis.';
    const evidence: ResourceEvidence = { schemaVersion: 1, runId: this.runId, samplingIntervalMs: SAMPLE_INTERVAL_MS, collection: this.states, processSamples: this.processSamples, containerSamples: this.containerSamples.slice(-MAX_SAMPLES_PER_SOURCE) };
    const file = join(runDirectory, 'resources', 'evidence.json');
    try { await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); }
    catch {
      this.states.process = 'unavailable'; this.states.container = 'unavailable';
      this.states.processNote = 'The run resource evidence artifact could not be persisted.';
      this.states.containerNote = 'The run resource evidence artifact could not be persisted.';
      evidence.collection = this.states;
    }
    return evidence;
  }
  private async writeMarker(active: { runId: string; profile: ProfileName } | null): Promise<void> {
    const marker = join(this.projectDirectory, '.perflens', 'runtime', 'resources', 'phase.json');
    const content = active ? { schemaVersion: 1, active: true, runId: active.runId, profile: active.profile, startedAt: new Date().toISOString() } : { schemaVersion: 1, active: false };
    try { await writeFile(this.markerFile, `${JSON.stringify(content)}\n`, { mode: active ? 0o644 : 0o600 }); }
    catch {
      this.processSetupFailed = true;
      this.states.process = 'unavailable';
      this.states.processNote = 'Could not update the project-local run/profile marker.';
    }
    if (this.runtime?.container) {
      try { await this.containerRunner(['cp', this.markerFile, `${this.runtime.container}:${CONTAINER_RESOURCE_DIR}/phase.json`], { timeout: 10000 }); }
      catch { this.states.process = 'unavailable'; this.states.processNote = 'Could not update the run/profile marker inside the selected container.'; }
    }
  }
  private async sampleContainer(): Promise<void> {
    if (!this.runtime?.container || !this.active || this.containerSamples.length >= MAX_SAMPLES_PER_SOURCE || this.sampleBusy) return;
    const sample = this.active;
    this.sampleBusy = true;
    const task = async () => {
      try {
        const raw = await this.containerRunner(['stats', '--no-stream', '--format', '{{json .}}', this.runtime!.container!], { timeout: 8000 });
        const line = raw.split(/\r?\n/).find(Boolean);
        const parsed = line && parseDockerStatsLine(line, { ...sample, container: this.runtime!.container!, hostLogicalCpus: this.hostLogicalCpus, cpuQuotaCores: this.cpuQuotaCores, memoryLimitBytes: this.memoryLimitBytes });
        if (parsed) { this.containerSamples.push(parsed); this.states.container = 'available'; }
      } catch { this.states.container = this.containerSamples.length ? 'partial' : 'unavailable'; }
    };
    this.pending = task().finally(() => { this.sampleBusy = false; });
    await this.pending;
  }
}
function validProcessSample(value: any, runId: string): value is ProcessSample {
  return value?.schemaVersion === 1 && value.runId === runId && typeof value.profile === 'string'
    && ['baseline', 'normal', 'peak', 'stress'].includes(value.profile) && typeof value.timestamp === 'string'
    && Number.isFinite(Date.parse(value.timestamp)) && Number.isInteger(value.processId)
    && Number.isFinite(value.rssBytes) && Number.isFinite(value.heapUsedBytes) && Number.isFinite(value.heapTotalBytes);
}
export function summarizeResourceProfiles(evidence: ResourceEvidence): ResourceProfileSummary[] {
  const profiles = [...new Set([...evidence.processSamples.map(sample => sample.profile), ...evidence.containerSamples.map(sample => sample.profile)])];
  const average = (values: (number | null)[]) => { const valid = values.filter((value): value is number => value !== null && Number.isFinite(value)); return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null; };
  const maximum = (values: (number | null)[]) => { const valid = values.filter((value): value is number => value !== null && Number.isFinite(value)); return valid.length ? Math.max(...valid) : null; };
  const cpuAverage = (values: (number | null)[]) => values.filter((value): value is number => value !== null && Number.isFinite(value)).length >= 2 ? average(values) : null;
  const cpuMaximum = (values: (number | null)[]) => values.filter((value): value is number => value !== null && Number.isFinite(value)).length >= 2 ? maximum(values) : null;
  return profiles.map(profile => {
    const process = evidence.processSamples.filter(sample => sample.profile === profile);
    const container = evidence.containerSamples.filter(sample => sample.profile === profile);
    const orderedProcess = [...process].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const processIds = new Set(process.map(sample => sample.processId));
    const memoryLimitRatios = container.flatMap(sample => sample.memoryUsedBytes !== null && sample.memoryLimitBytes !== null && sample.memoryLimitBytes > 0
      ? [sample.memoryUsedBytes / sample.memoryLimitBytes * 100] : []);
    const rssGrowthBytes = processIds.size === 1 && orderedProcess.length >= 2 ? orderedProcess.at(-1)!.rssBytes - orderedProcess[0].rssBytes : null;
    return {
      profile, processSampleCount: process.length,
      processCpuAveragePercent: cpuAverage(process.map(sample => sample.cpuPercentOneLogicalCpu)), processCpuPeakPercent: cpuMaximum(process.map(sample => sample.cpuPercentOneLogicalCpu)),
      rssAverageBytes: average(process.map(sample => sample.rssBytes)), rssPeakBytes: maximum(process.map(sample => sample.rssBytes)), rssGrowthBytes,
      heapUsedAverageBytes: average(process.map(sample => sample.heapUsedBytes)), heapUsedPeakBytes: maximum(process.map(sample => sample.heapUsedBytes)),
      heapTotalPeakBytes: maximum(process.map(sample => sample.heapTotalBytes)), externalPeakBytes: maximum(process.map(sample => sample.externalBytes)),
      containerSampleCount: container.length,
      containerCpuAveragePercent: cpuAverage(container.map(sample => sample.dockerReportedCpuPercent)), containerCpuPeakPercent: cpuMaximum(container.map(sample => sample.dockerReportedCpuPercent)),
      containerMemoryAverageBytes: average(container.map(sample => sample.memoryUsedBytes)), containerMemoryPeakBytes: maximum(container.map(sample => sample.memoryUsedBytes)), containerMemoryLimitBytes: maximum(container.map(sample => sample.memoryLimitBytes)),
      containerMemoryPeakPercentOfLimit: maximum(memoryLimitRatios),
    };
  });
}
