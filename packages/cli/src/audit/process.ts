import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { CliError } from '../utils/errors';
export interface Execution {
  code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean; stdout: string;
}
export interface ProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; stdoutFile?: string; stderrFile?: string;
}
export type Execute = (executable: string, args: string[], options: ProcessOptions) => Promise<Execution>;

// Shared, shell-free audit process boundary. File descriptors avoid buffering raw logs.
export const execute: Execute = async (executable, args, options) => {
  if (options.signal?.aborted) throw new CliError('Audit cancelled.', 'No load was started.', 130);
  const out = options.stdoutFile ? await open(options.stdoutFile, 'wx', 0o600) : undefined;
  let err: Awaited<ReturnType<typeof open>> | undefined;
  try {
    err = options.stderrFile ? await open(options.stderrFile, 'wx', 0o600) : undefined;
    return await new Promise<Execution>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['ignore', out?.fd ?? 'pipe', err?.fd ?? 'pipe'] });
      let stdout = '', timedOut = false, cancelled = false;
      let force: NodeJS.Timeout | undefined;
      const stop = () => {
        if (force) return;
        child.kill('SIGINT');
        force = setTimeout(() => child.kill('SIGKILL'), 5000);
      };
      const abort = () => { cancelled = true; stop(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.stdout?.on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
      // Do not surface arbitrary child stderr/response contents in terminal exceptions.
      child.stderr?.resume();
      const cleanup = () => { clearTimeout(timer); clearTimeout(force); options.signal?.removeEventListener('abort', abort); };
      child.once('error', (error: NodeJS.ErrnoException) => {
        cleanup();
        reject(new CliError(`Could not execute ${executable}${error.code ? ` (${error.code})` : ''}.`, 'Install a supported k6 binary on PATH and retry; see the audit methodology.'));
      });
      child.once('close', (code, signal) => { cleanup(); resolve({ code, signal, stdout, timedOut, cancelled }); });
    });
  } finally { await out?.close(); await err?.close(); }
};
export function k6Environment(requestHeaders: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[key]) env[key] = process.env[key];
  // No inherited K6_*, proxy settings, telemetry exporters, or secret values.
  return { ...env, ...requestHeaders, K6_NO_USAGE_REPORT: 'true', K6_WEB_DASHBOARD: 'false' };
}
