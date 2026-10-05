import { CliError } from '../utils/errors';
import { assertLocalDocker, Infrastructure } from '../services/infrastructure';
import { infrastructureRoot, otlpTracesEndpoint } from '../services/workspace';
import { ProjectConfig } from '../config/project';
import { Endpoint, targetUrl } from './config';
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CliError('Audit cancelled.', 'Evidence collected so far is preserved.', 130);
}
export async function checkInfrastructure(infraDir?: string, projectDirectory = process.cwd(), baseUrl?: string) {
  await assertLocalDocker();
  const infra = new Infrastructure(await infrastructureRoot(infraDir, projectDirectory, baseUrl));
  const config = await infra.configuration();
  const states = await infra.status();
  if (!states.every(s => s.ready)) throw new CliError('Audit infrastructure is not ready.', 'Run perflens infra up; inspect perflens infra status before retrying.');
  const urls: Record<string, string | null> = {};
  for (const name of ['prometheus', 'grafana', 'tempo']) {
    const port = config.services[name].ports?.[0];
    urls[name] = port?.published ? `http://${port.host_ip === '::1' ? '[::1]' : '127.0.0.1'}:${port.published}` : null;
  }
  return {
    composeProject: config.name, readiness: states, localUrls: urls,
    otlpTracesEndpoint: await otlpTracesEndpoint(infra.root),
    containerOtlpTracesEndpoint: await otlpTracesEndpoint(infra.root, 'container'),
  };
}
export async function checkTarget(config: ProjectConfig, endpoint: Endpoint, runId: string, signal: AbortSignal, requestHeaders: Record<string, string> = {}): Promise<void> {
  checkCancelled(signal);
  const url = new URL(targetUrl(config.target.baseUrl, endpoint));
  // Match k6's fixed localhost mapping; do not use proxy env or follow redirects.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(config.audit!.timeoutMs)]),
      headers: { ...requestHeaders, 'X-PerfLens-Run-Id': runId, 'X-PerfLens-Profile': 'preflight' },
    });
    await response.body?.cancel();
  } catch {
    checkCancelled(signal);
    throw new CliError(`Target preflight failed for GET ${endpoint.path}.`, 'Start the target; verify its loopback URL, port, and timeout. No profile load was started.');
  }
  if (response.status < 200 || response.status >= 300) throw new CliError(`Target preflight returned HTTP ${response.status} for GET ${endpoint.path}.`, 'Preflight requires HTTP 2xx. Redirects are not followed. No profile load was started.');
}

/** Check one lightweight correlated probe in Tempo before any k6 profile runs. */
export async function checkInstrumentation(tempoUrl: string | null, serviceName: string, runId: string, signal: AbortSignal, polling = { attempts: 36, intervalMs: 1000, timeoutMs: 5000 }, containerOtlpEndpoint?: string): Promise<void> {
  if (!tempoUrl) throw new CliError('Tempo query endpoint is unavailable.', 'Start PerfLens infrastructure and verify the local Tempo port. No load was started.');
  try {
    const ready = await fetch(new URL('/ready', tempoUrl), { signal: AbortSignal.any([signal, AbortSignal.timeout(polling.timeoutMs)]) });
    await ready.body?.cancel();
    if (!ready.ok) throw new Error(`Tempo returned HTTP ${ready.status}`);
  } catch (error) {
    checkCancelled(signal);
    throw new CliError('PerfLens Tempo is unavailable during telemetry verification.', `Check the current project's Tempo service and query port. No load was started. Technical detail: ${error instanceof Error ? error.message : String(error)}`);
  }
  const url = new URL('/api/search', tempoUrl);
  url.searchParams.set('limit', '1');
  // Use Tempo's indexed tag search for a single, narrowly correlated preflight span.
  url.searchParams.append('tags', `service.name=${serviceName}`);
  url.searchParams.append('tags', `perflens.audit.run_id=${runId}`);
  url.searchParams.append('tags', 'perflens.audit.profile=preflight');
  for (let attempt = 0; attempt < polling.attempts; attempt++) {
    checkCancelled(signal);
    try {
      const now = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(Math.max(0, now - 90)));
      url.searchParams.set('end', String(now + 5));
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(polling.timeoutMs)]) });
      if (!response.ok) throw new Error(`Tempo returned HTTP ${response.status}`);
      const result = await response.json() as { traces?: unknown[] };
      if (Array.isArray(result.traces) && result.traces.length) return;
    } catch (error) {
      checkCancelled(signal);
      if (attempt === polling.attempts - 1) throw new CliError('Could not verify target instrumentation in Tempo.', `Confirm the local Tempo endpoint is healthy and the app exports traces to the selected PerfLens OTLP endpoint. No load was started. Technical detail: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < polling.attempts - 1) await new Promise(resolve => setTimeout(resolve, polling.intervalMs));
  }
  const containerGuidance = containerOtlpEndpoint ? ` If the target runs inside Docker, 127.0.0.1 refers to that container, not the host. Set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${containerOtlpEndpoint} in the application container and recreate it using the current PerfLens OTLP_HTTP_PORT from .perflens/infra/.env. On Linux Docker Engine, map host.docker.internal to host-gateway; this host-side receiver is loopback-bound, so verify that the platform permits container access before auditing.` : '';
  throw new CliError('Target is reachable but PerfLens could not find its correlated OpenTelemetry server span.', `No load was started. Confirm the endpoint is a representative application route (health and metrics routes are excluded), and that the app initializes startExpressInstrumentation from @perflens/cli/express-instrumentation before importing Express or PostgreSQL. Restart the app, set service.name to the configured observability.serviceName, and export to the OTLP traces endpoint printed by PerfLens. Generic Node apps can preload startNodeInstrumentation from @perflens/cli/instrumentation.${containerGuidance}`);
}
