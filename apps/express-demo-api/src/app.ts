import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';
import type { Pool } from 'pg';
import { get } from 'node:http';

export interface AppOptions {
  pool: Pick<Pool, 'query'>;
  dependencyUrl?: string;
}

export function createApp({ pool, dependencyUrl = 'http://127.0.0.1:4002/dependency' }: AppOptions): Express {
  const app = express();
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'perflens_' });
  const requests = new Counter({ name: 'perflens_http_requests_total', help: 'Completed API requests', labelNames: ['method', 'route', 'status_code'], registers: [registry] });
  const latency = new Histogram({ name: 'perflens_http_request_duration_seconds', help: 'API response duration', labelNames: ['method', 'route', 'status_code'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/metrics' || req.path === '/health') { next(); return; }
    const started = process.hrtime.bigint();
    res.once('finish', () => {
      const labels = { method: req.method, route: req.route?.path ?? 'unmatched', status_code: String(res.statusCode) };
      requests.inc(labels);
      latency.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'up' }); }
    catch { res.status(503).json({ status: 'unavailable', database: 'down' }); }
  });
  app.get('/metrics', async (_req, res) => { res.type(registry.contentType).send(await registry.metrics()); });

  // Normal reference route: one bounded read with no artificial delay or N+1 work.
  app.get('/orders', async (_req, res, next) => {
    try {
      const result = await pool.query('SELECT id, customer_id, status, created_at FROM orders ORDER BY id DESC LIMIT 20');
      res.json(result.rows);
    } catch (error) { next(error); }
  });

  app.get('/performance/n-plus-one', async (_req, res, next) => {
    try {
      // INTENTIONAL DEMO BOTTLENECK: one list query followed by 20 sequential, equivalent item queries.
      const orders = await pool.query('SELECT id, customer_id, status, created_at FROM orders ORDER BY id DESC LIMIT 20');
      const result = [];
      for (const order of orders.rows) {
        const items = await pool.query('SELECT id, order_id, product_id, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]);
        result.push({ ...order, items: items.rows });
      }
      res.json(result);
    } catch (error) { next(error); }
  });

  app.get('/performance/slow-query', async (_req, res, next) => {
    try {
      // INTENTIONAL DEMO BOTTLENECK: the cast prevents the order_id index being used in the correlated aggregate.
      const result = await pool.query(`SELECT o.id, (SELECT sum(i.quantity * i.unit_price_cents)
        FROM order_items i WHERE i.order_id::text = o.id::text) AS total_cents
        FROM orders o WHERE o.id <= 100 ORDER BY total_cents DESC`);
      res.json(result.rows);
    } catch (error) { next(error); }
  });

  app.get('/performance/external-call', async (_req, res) => {
    // INTENTIONAL DEMO BOTTLENECK: a real instrumented HTTP request to the local latency simulator.
    const request = get(dependencyUrl, (response) => {
      response.resume();
      response.on('end', () => response.statusCode === 200
        ? res.json({ dependency: 'simulated-shipping-provider', status: 'ok' })
        : res.status(503).json({ error: 'Simulated dependency failed' }));
      response.on('error', () => res.status(503).json({ error: 'Simulated dependency failed' }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Dependency timeout')));
    request.on('error', () => { if (!res.headersSent) res.status(503).json({ error: 'Simulated dependency unavailable' }); });
  });
  return app;
}
