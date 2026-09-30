import { loadProject } from '../config/project';
import { CliError, formatError } from '../utils/errors';
import { assertLocalDocker, Infrastructure } from './infrastructure';
import { docker, Runner } from './process';
import { infrastructureRoot } from './workspace';
export interface Options { config?: string; infraDir?: string }
export async function doctor(options: Options, write: (line: string) => void = console.log, run: Runner = docker): Promise<boolean> {
  let failures = 0;
  async function check(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    try { await fn(); write(`✓ ${label}`); return true; }
    catch (error) { failures++; write(formatError(error)); return false; }
  }
  write('PerfLens Doctor');
  await check('Project configuration valid', () => loadProject(options.config));
  const installed = await check('Docker installed', () => run(['--version']));
  let compose = false, daemon = false;
  if (installed) {
    compose = await check('Docker Compose available', async () => {
      try { await run(['compose', 'version']); } catch { throw new CliError('Docker Compose is unavailable.', 'Install Docker Compose v2 (included with Docker Desktop).'); }
    });
    const local = await check('Local Docker endpoint selected', () => assertLocalDocker(run));
    if (local) daemon = await check('Docker daemon running', async () => {
      try { await run(['info', '--format', '{{.ServerVersion}}']); } catch { throw new CliError('Docker daemon is not reachable.', 'Start Docker Desktop, OrbStack, or your local Docker engine and retry.'); }
    });
  }
  let root: string | undefined;
  await check('PerfLens infrastructure files found', async () => { root = await infrastructureRoot(options.infraDir); });
  if (root && compose) {
    const infra = new Infrastructure(root, run);
    await check('Compose configuration valid', async () => {
      const config = await infra.configuration();
      if (daemon) for (const message of await infra.checkPorts(config)) write(`✓ ${message}`);
    });
    if (daemon) await check('Existing infrastructure has no readiness failures', async () => {
      const status = await infra.status();
      if (status.some(s => s.failed)) throw new CliError('Some running infrastructure services are not ready.', status.map(s => `${s.service}: ${s.state}`).join('\n') + '\nRun perflens infra up and inspect Docker logs.');
    });
  }
  write(failures ? `Not ready: ${failures} check(s) failed. Resolve the issues above and retry.` : 'Ready to run PerfLens. The target application is started separately.');
  return failures === 0;
}
