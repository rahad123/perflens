import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

export interface PerfLensCorrelation {
  runId?: string;
  profile?: string;
}

const runIdPattern = /^pfl_\d{8}T\d{9}Z_[0-9a-f-]{36}$/;
const profiles = new Set(['preflight', 'baseline', 'normal', 'peak', 'stress']);

/** Read only the bounded PerfLens metadata contract; other headers are never copied to spans. */
export function readPerfLensCorrelation(headers: Record<string, unknown>): PerfLensCorrelation {
  const runId = headers['x-perflens-run-id'];
  const profile = headers['x-perflens-profile'];
  if (typeof runId !== 'string' || runId.length > 64 || !runIdPattern.test(runId)) return {};
  return {
    runId,
    ...(typeof profile === 'string' && profile.length <= 16 && profiles.has(profile) ? { profile } : {}),
  };
}

export interface NodeInstrumentationOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  /** Optional exporter injection keeps the bootstrap observable in local tests. */
  traceExporter?: SpanExporter;
  /** Optional processors support in-memory verification without changing production defaults. */
  spanProcessors?: SpanProcessor[];
  /** Framework integrations are opt-in so generic Node bootstrap stays framework-neutral. */
  additionalInstrumentations?: Instrumentation[];
}

/** Start before importing the target application's HTTP framework or database client. */
export function startNodeInstrumentation(options: NodeInstrumentationOptions = {}): NodeSDK {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  const sdk = new NodeSDK({
    // Keep only the explicit service identity required for correlation; avoid machine-specific resource metadata.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'perflens-node-service',
      'service.version': options.serviceVersion ?? process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
      'deployment.environment': options.environment ?? process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    traceExporter: options.traceExporter ?? new OTLPTraceExporter(),
    // Metrics are exposed for Prometheus scrape; Collector is traces-only in Phase 1.
    metricReaders: [],
    ...(options.spanProcessors ? { spanProcessors: options.spanProcessors } : {}),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => ['/health', '/metrics'].includes(request.url ?? ''),
        requestHook: (span, request) => {
          if (!('headers' in request)) return;
          const correlation = readPerfLensCorrelation(request.headers as Record<string, unknown>);
          if (correlation.runId) span.setAttribute('perflens.audit.run_id', correlation.runId);
          if (correlation.profile) span.setAttribute('perflens.audit.profile', correlation.profile);
        },
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      ...(options.additionalInstrumentations ?? []),
    ],
  });
  sdk.start();
  return sdk;
}
