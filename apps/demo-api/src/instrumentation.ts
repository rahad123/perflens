import { startNodeInstrumentation } from '@perflens/node-instrumentation';

// This file is preloaded before NestJS and TypeORM in the container start command.
export const telemetry = startNodeInstrumentation({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'perflens-demo-api' });
