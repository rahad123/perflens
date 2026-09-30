import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createServer } from 'node:http';
import { AppModule } from './app';
import { seed } from './migration';
import { metrics } from './metrics';
import { telemetry } from './instrumentation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.use(metrics);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  const runner = app.get(DataSource).createQueryRunner();
  await runner.connect();
  try { await seed(runner); } finally { await runner.release(); }
  // This is a test fixture inside this process, not another deployed service.
  const dependency = createServer((req, res) => {
    if (req.url !== '/dependency') { res.writeHead(404).end(); return; }
    setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}'), 750);
  });
  await new Promise<void>((resolve, reject) => {
    dependency.once('error', reject);
    dependency.listen(4001, '127.0.0.1', resolve);
  });
  await app.listen(3000, '0.0.0.0');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await new Promise<void>((resolve) => dependency.close(() => resolve()));
    await telemetry.shutdown();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void shutdown().catch((error) => { console.error(error); process.exitCode = 1; });
  });
}
void bootstrap().catch((error) => { console.error(error); process.exit(1); });
