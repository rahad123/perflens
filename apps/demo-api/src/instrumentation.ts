import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

// Preloaded with --require before NestJS, HTTP, or pg can be imported.
export const telemetry = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME ?? 'perflens-demo-api',
    'service.version': '0.1.0',
    'deployment.environment': process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
  }),
  traceExporter: new OTLPTraceExporter(),
  // Metrics are scraped from /metrics. An omitted option enables OTLP metrics
  // by default, but the Collector intentionally has only a traces pipeline.
  metricReaders: [],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => ['/health', '/metrics'].includes(req.url ?? ''),
    }),
    new PgInstrumentation({ enhancedDatabaseReporting: false }),
  ],
});
telemetry.start();
