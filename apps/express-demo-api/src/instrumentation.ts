import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { startNodeInstrumentation } from '@perflens/node-instrumentation';

// This preload runs before Express and pg are imported by main.js.
export const telemetry = startNodeInstrumentation({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'perflens-express-demo-api',
  additionalInstrumentations: [new ExpressInstrumentation()],
});
