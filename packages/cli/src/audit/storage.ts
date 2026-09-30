import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
export type RunStatus = 'created' | 'preflight' | 'running' | 'completed' | 'failed' | 'cancelled';
export function runId(): string { return `pfl_${new Date().toISOString().replace(/[-:.]/g, '')}_${randomUUID()}`; }
export class RunStore {
  private finalized = false;
  private constructor(readonly directory: string, readonly id: string) {}
  static async create(projectDirectory: string): Promise<RunStore> {
    const parent = join(projectDirectory, '.perflens', 'runs');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const id = runId(), directory = join(parent, id);
    // Exclusive directory creation: never reuse/resume an older run.
    await mkdir(directory, { mode: 0o700 });
    for (const name of ['raw', 'results', 'telemetry', 'logs']) await mkdir(join(directory, name), { mode: 0o700 });
    return new RunStore(directory, id);
  }
  async write(file: string, value: unknown): Promise<void> {
    if (this.finalized) throw new Error('Historical run is finalized and cannot be modified.');
    const path = join(this.directory, file);
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async finalize(value: unknown): Promise<void> { await this.write('run.json', value); this.finalized = true; }
}
export async function listRuns(projectDirectory: string): Promise<{ id: string; status: string; startedAt: string }[]> {
  const parent = join(projectDirectory, '.perflens', 'runs');
  let entries;
  try { entries = await readdir(parent, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries.filter(entry => entry.isDirectory() && entry.name.startsWith('pfl_')).sort((a, b) => b.name.localeCompare(a.name))) {
    try {
      const run = JSON.parse(await readFile(join(parent, entry.name, 'run.json'), 'utf8'));
      result.push({ id: entry.name, status: String(run.status), startedAt: String(run.startedAt) });
    } catch { result.push({ id: entry.name, status: 'unreadable/incomplete', startedAt: 'unknown' }); }
  }
  return result;
}
