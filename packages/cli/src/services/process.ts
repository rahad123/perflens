import { spawn } from 'node:child_process';
import { CliError } from '../utils/errors';
export interface RunOptions { cwd?: string; stream?: boolean; timeout?: number }
export type Runner = (args: string[], options?: RunOptions) => Promise<string>;

// Argument arrays only: project paths and arguments never pass through a shell.
export const docker: Runner = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn('docker', args, { cwd: options.cwd, shell: false, stdio: options.stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout ?? 20000);
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timeout);
    reject(new CliError(error.code === 'ENOENT' ? 'PerfLens could not find Docker.' : 'PerfLens could not start Docker.',
      'Install Docker, ensure it is on PATH, and start its engine.\nTechnical error: ' + error.message));
  });
  child.on('close', (code, signal) => {
    clearTimeout(timeout);
    if (timedOut) reject(new CliError('Docker command timed out.', 'Check the Docker engine and container logs, then retry.'));
    else if (code !== 0) reject(new CliError(`Docker ${args[0]} failed (${signal ?? code}).`,
      // Compose config may contain credentials; never echo its rendered output.
      args.includes('config') ? 'Check .env and docker-compose.yml. Run docker compose config --quiet in the infrastructure directory for details.'
        : (stderr.trim() || 'Check Docker and the service logs, then retry.')));
    else resolve(stdout);
  });
});
