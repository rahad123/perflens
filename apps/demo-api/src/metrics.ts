import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';
import type { Request, Response, NextFunction } from 'express';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'perflens_' });
const requests = new Counter({ name: 'perflens_http_requests_total', help: 'Completed API requests', labelNames: ['method', 'route', 'status_code'], registers: [registry] });
const latency = new Histogram({ name: 'perflens_http_request_duration_seconds', help: 'API response duration', labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
export function metrics(req: Request, res: Response, next: NextFunction): void {
  if (['/metrics', '/health'].includes(req.path)) { next(); return; }
  const started = process.hrtime.bigint();
  res.once('finish', () => {
    // Route templates keep order IDs and arbitrary URLs out of metric labels.
    const labels = { method: req.method, route: req.route?.path ?? 'unmatched', status_code: String(res.statusCode) };
    requests.inc(labels);
    latency.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
  });
  next();
}
