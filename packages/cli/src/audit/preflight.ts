import { CliError } from '../utils/errors';
import { assertLocalDocker, Infrastructure } from '../services/infrastructure';
import { infrastructureRoot } from '../services/workspace';
import { ProjectConfig } from '../config/project';
import { Endpoint, targetUrl } from './config';
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CliError('Audit cancelled.', 'Evidence collected so far is preserved.', 130);
}
export async function checkInfrastructure(infraDir?: string) {
  await assertLocalDocker();
  const infra = new Infrastructure(await infrastructureRoot(infraDir));
  const config = await infra.configuration();
  const states = await infra.status();
  if (!states.every(s => s.ready)) throw new CliError('Audit infrastructure is not ready.', 'Run perflens infra up; inspect perflens infra status before retrying.');
  const urls: Record<string, string | null> = {};
  for (const name of ['prometheus', 'grafana']) {
    const port = config.services[name].ports?.[0];
    urls[name] = port?.published ? `http://${port.host_ip === '::1' ? '[::1]' : '127.0.0.1'}:${port.published}` : null;
  }
  return { composeProject: config.name, readiness: states, localUrls: urls };
}
export async function checkTarget(config: ProjectConfig, endpoint: Endpoint, runId: string, signal: AbortSignal): Promise<void> {
  checkCancelled(signal);
  const url = new URL(targetUrl(config.target.baseUrl, endpoint));
  // Match k6's fixed localhost mapping; do not use proxy env or follow redirects.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(config.audit!.timeoutMs)]),
      headers: { 'X-PerfLens-Run-Id': runId, 'X-PerfLens-Profile': 'preflight' },
    });
    await response.body?.cancel();
  } catch {
    checkCancelled(signal);
    throw new CliError(`Target preflight failed for GET ${endpoint.path}.`, 'Start the target; verify its loopback URL, port, and timeout. No profile load was started.');
  }
  if (response.status < 200 || response.status >= 300) throw new CliError(`Target preflight returned HTTP ${response.status} for GET ${endpoint.path}.`, 'Preflight requires HTTP 2xx. Redirects are not followed. No profile load was started.');
}
