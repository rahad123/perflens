import { appendFile, readFile, readdir, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ResourceProfile = 'baseline' | 'normal' | 'peak' | 'stress';
export interface ProcessResourceSample {
  schemaVersion: 1;
  runId: string;
  profile: ResourceProfile;
  timestamp: string;
  monotonicNs: string;
  source: 'node-process';
  processId: number;
  /** Identifies this process lifetime, including when a container reuses a PID after restart. */
  processInstanceId: string;
  cpuUserMicros: number | null;
  cpuSystemMicros: number | null;
  cpuPercentOneLogicalCpu: number | null;
  cpuNormalization: 'one-logical-cpu';
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

const RUN_ID = /^pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}$/;
const PROFILE = new Set<ResourceProfile>(['baseline', 'normal', 'peak', 'stress']);

/** Process CPU percentage normalized to one logical CPU, never host CPU %. */
export function processCpuPercent(userMicros: number, systemMicros: number, elapsedNanoseconds: bigint): number | null {
  if (![userMicros, systemMicros].every(value => Number.isFinite(value) && value >= 0) || elapsedNanoseconds <= 0n) return null;
  const percent = (userMicros + systemMicros) / (Number(elapsedNanoseconds) / 1000) * 100;
  return Number.isFinite(percent) ? percent : null;
}
let samplerStop: (() => void) | undefined;

/**
 * Sample only while the local CLI has placed a validated run/profile marker.
 * One hertz bounds both overhead and output size; app/request data is never read.
 * The first CPU delta after a marker transition is omitted because it can span profiles;
 * the point-in-time memory observation is still useful and remains profile-tagged.
 */
export function startProcessResourceSampler(options: { directory?: string; intervalMs?: number } = {}): () => void {
  if (samplerStop) return samplerStop;
  const directory = options.directory ?? process.env.PERFLENS_RESOURCE_DIRECTORY ?? join(process.cwd(), '.perflens', 'runtime', 'resources');
  try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { return () => {}; }
  const phasePath = join(directory, 'phase.json');
  const intervalMs = Math.max(500, Math.min(5000, options.intervalMs ?? 1000));
  let previousCpu = process.cpuUsage();
  let previousMono = process.hrtime.bigint();
  const processInstanceId = randomUUID();
  let previousPhaseKey: string | null = null;
  let sampling = false;
  let currentRunId: string | undefined;

  const tick = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const nowMono = process.hrtime.bigint();
      const cpu = process.cpuUsage(previousCpu);
      const elapsedNs = nowMono - previousMono;
      previousCpu = process.cpuUsage();
      previousMono = nowMono;
      let phase: any;
      try { phase = JSON.parse(await readFile(phasePath, 'utf8')); } catch { return; }
      if (!phase || phase.schemaVersion !== 1 || phase.active !== true || !RUN_ID.test(phase.runId)
        || !PROFILE.has(phase.profile) || typeof phase.startedAt !== 'string') { previousPhaseKey = null; return; }
      const phaseKey = `${phase.runId}:${phase.profile}`;
      if (currentRunId !== phase.runId) {
        currentRunId = phase.runId;
        for (const entry of await readdir(directory).catch(() => [])) {
          if (/^process-pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}\.ndjson$/.test(entry) && entry !== `process-${phase.runId}.ndjson`) await unlink(join(directory, entry)).catch(() => {});
        }
      }
      // The CPU delta spans the previous sample timestamp. Drop a transition sample so
      // activity from the prior profile (or inactive time) is never attributed to this one.
      const phaseChanged = previousPhaseKey !== phaseKey;
      previousPhaseKey = phaseKey;
      const memory = process.memoryUsage();
      const cpuPercentOneLogicalCpu = processCpuPercent(cpu.user, cpu.system, elapsedNs);
      const sample: ProcessResourceSample = {
        schemaVersion: 1, runId: phase.runId, profile: phase.profile,
        timestamp: new Date().toISOString(), monotonicNs: nowMono.toString(), source: 'node-process', processId: process.pid, processInstanceId,
        cpuUserMicros: phaseChanged ? null : cpu.user, cpuSystemMicros: phaseChanged ? null : cpu.system,
        cpuPercentOneLogicalCpu: !phaseChanged && Number.isFinite(cpuPercentOneLogicalCpu) ? cpuPercentOneLogicalCpu : null,
        cpuNormalization: 'one-logical-cpu', rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal, externalBytes: memory.external,
      };
      await appendFile(join(directory, `process-${phase.runId}.ndjson`), `${JSON.stringify(sample)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch { /* Runtime sampling is best-effort; the CLI records missing coverage explicitly. */ }
    finally { sampling = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  samplerStop = () => { clearInterval(timer); samplerStop = undefined; };
  return samplerStop;
}
