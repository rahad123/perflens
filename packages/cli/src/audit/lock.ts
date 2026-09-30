import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../utils/errors';
export async function withAuditLock<T>(projectDirectory: string, work: () => Promise<T>): Promise<T> {
  const directory = join(projectDirectory, '.perflens');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'audit.lock');
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('Another audit holds this project lock.', 'Wait for it to finish. After a hard crash, verify no k6 process remains before manually removing .perflens/audit.lock.');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await work();
  } finally { await handle.close(); await unlink(file); }
}
