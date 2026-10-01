import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createApp } from './app';
import { ensureDevelopmentData } from './seed';
import { telemetry } from './instrumentation';

async function bootstrap(): Promise<void> {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost', port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB,
    max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000,
  });
  await ensureDevelopmentData(pool);
  const dependency = createServer((req, res) => {
    if (req.url !== '/dependency') { res.writeHead(404).end(); return; }
    setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}'), 750);
  });
  await new Promise<void>((resolve, reject) => { dependency.once('error', reject); dependency.listen(4002, '127.0.0.1', resolve); });
  const app = createApp({ pool });
  const server = app.listen(3000, '0.0.0.0');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise<void>(resolve => dependency.close(() => resolve()));
    await pool.end();
    await telemetry.shutdown();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void shutdown().catch(error => { console.error(error); process.exitCode = 1; });
  });
}
void bootstrap().catch(error => { console.error(error); process.exit(1); });
