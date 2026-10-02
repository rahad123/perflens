import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Bind the standard traces-specific OTLP setting to the port selected by the
 * consumer project's PerfLens Compose environment. This runs before exporter
 * construction so dynamic host ports never fall back to the SDK's 4318 default.
 */
export function configurePerfLensOtlpEndpoint(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  let directory = resolve(cwd), environmentFile: string | undefined;
  while (true) {
    const candidate = join(directory, '.perflens', 'infra', '.env');
    if (existsSync(candidate)) { environmentFile = candidate; break; }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!environmentFile) return null;
  const contents = readFileSync(environmentFile, 'utf8');
  const match = /^OTLP_HTTP_PORT=(\d+)$/m.exec(contents);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OTLP_HTTP_PORT in ${environmentFile}; run perflens doctor to validate local infrastructure.`);
  }
  const selected = `http://127.0.0.1:${port}/v1/traces`;
  const configured = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (configured && new URL(configured).href !== selected) {
    throw new Error(`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT does not match this PerfLens project. Use ${selected} or unset the override.`);
  }
  env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = selected;
  return selected;
}

/** Resolve the consumer's project-local port when a batch is exported. This
 * covers apps started before the first `perflens audit` creates infra config. */
export class ProjectOtlpTraceExporter implements SpanExporter {
  private delegate: SpanExporter | undefined;
  private delegateUrl: string | undefined;
  constructor(
    private readonly cwd = process.cwd(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly create: (url?: string) => SpanExporter = url => new OTLPTraceExporter(url ? { url } : undefined),
  ) {}
  export(spans: Parameters<SpanExporter['export']>[0], callback: Parameters<SpanExporter['export']>[1]): void {
    let endpoint: string | undefined;
    try { endpoint = configurePerfLensOtlpEndpoint(this.cwd, this.env) ?? this.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT; }
    catch (error) { callback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) }); return; }
    if (!this.delegate || endpoint !== this.delegateUrl) {
      const previous = this.delegate;
      this.delegate = this.create(endpoint);
      this.delegateUrl = endpoint;
      if (previous) void previous.shutdown();
    }
    this.delegate.export(spans, callback);
  }
  async forceFlush(): Promise<void> { await this.delegate?.forceFlush?.(); }
  async shutdown(): Promise<void> { await this.delegate?.shutdown(); }
}

/** Start before importing the target application's HTTP framework or database client. */
export function startNodeInstrumentation(options: NodeInstrumentationOptions = {}): NodeSDK {
  configurePerfLensOtlpEndpoint();
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  const sdk = new NodeSDK({
    // Keep only the explicit service identity required for correlation; avoid machine-specific resource metadata.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'perflens-node-service',
      'service.version': options.serviceVersion ?? process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
      'deployment.environment': options.environment ?? process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
    }),
    traceExporter: options.traceExporter ?? new ProjectOtlpTraceExporter(),
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
