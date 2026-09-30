import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CliError } from '../utils/errors';
export const INFRA_SERVICES = ['otel-collector', 'tempo', 'prometheus', 'grafana'] as const;
export const LABELS: Record<string, string> = { 'otel-collector': 'OTel Collector', tempo: 'Tempo', prometheus: 'Prometheus', grafana: 'Grafana' };
export async function infrastructureRoot(explicit?: string): Promise<string> {
  // The package is executable independently; infrastructure remains in the checkout.
  const root = explicit ? resolve(explicit) : resolve(__dirname, '../../../..');
  const required = ['docker-compose.yml', '.env', 'infra/otel-collector/config.yaml', 'infra/tempo/tempo.yaml', 'infra/prometheus/prometheus.yml', 'infra/grafana/provisioning/datasources/datasources.yaml'];
  for (const file of required) {
    try { await access(join(root, file)); }
    catch { throw new CliError(`Required infrastructure file is missing: ${join(root, file)}`, 'Use --infra-dir <PerfLens checkout>. In that checkout, copy .env.example to .env if needed.'); }
  }
  return root;
}
