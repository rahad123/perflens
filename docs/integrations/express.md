# Use PerfLens with an existing Express project

PerfLens installs into the backend project you want to audit. The demo APIs and monorepo are not runtime requirements.

## Requirements

- Node.js 22.12 or newer
- Docker with a local daemon and Docker Compose
- k6 2.3.x on `PATH`
- An Express app that you can start on a loopback address
- An application-owned database if the app needs one

Install from the consumer project directory:

```sh
npm install -D @perflens/cli
```

The normal first-use command is `npx perflens audit`. In an interactive terminal it asks for the target base URL and representative GET endpoint, then creates configuration through the same create-only service as optional `npx perflens init`. Existing configuration is validated and reused without prompts or overwriting. Non-interactive first use requires an existing `perflens.config.json`; PerfLens will not guess a target route. Express is reported as detected only when listed in package dependencies. Setup writes configuration and `.perflens/{runs,results,logs}` only; it does not add dependencies or edit source files.

## Start instrumentation before Express and database imports

Create a small preload module such as `src/perflens-instrumentation.ts`:

```ts
import { startExpressInstrumentation } from '@perflens/cli/express-instrumentation';

startExpressInstrumentation({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'my-api',
  serviceVersion: '1.0.0',
  environment: 'local',
});
```

Compile that file with the application and preload it before the server entrypoint imports Express, `pg`, TypeORM, or other instrumented modules:

```sh
OTEL_SERVICE_NAME=my-api node --require ./dist/perflens-instrumentation.js ./dist/server.js
```

The package adapter enables the generic Node HTTP and PostgreSQL instrumentation plus Express route instrumentation. At startup it reads the selected `OTLP_HTTP_PORT` from the nearest `.perflens/infra/.env` and sets the standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` variable before constructing the exporter. It does not fall back to the SDK's default port when project infrastructure selected another port. If an existing `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` conflicts with the selected local endpoint, bootstrap fails with both the mismatch and the expected URL. `perflens init`, `doctor`, `infra up`, and `audit` print this same endpoint. Apps using their own OpenTelemetry SDK can set the printed URL directly in `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. PerfLens does not capture arbitrary headers or request bodies.

The `serviceName` passed to instrumentation must match `observability.serviceName` in `perflens.config.json`. PerfLens adds `X-PerfLens-Run-Id` and `X-PerfLens-Profile` to audit requests. The instrumentation maps valid values to `perflens.audit.run_id` and `perflens.audit.profile`; they are correlation metadata, never authorization. OpenTelemetry continues to create and propagate trace IDs.

## Metrics and dashboard

The packaged Prometheus configuration scrapes the configured local target at `/metrics`. The Grafana dashboard uses the verified `perflens_http_requests_total` and `perflens_http_request_duration_seconds` metric names. If your app does not expose those metrics, its scrape target may be down or those panels may have no data; tracing and k6 measurements still work. PerfLens does not install a metrics library into your app.

## Run the audit

Start your application and its database first, then run:

```sh
npx perflens audit
```

Before k6 load, audit sends a single correlated preflight request and checks Tempo for the matching service/run/profile server span. If it cannot find that trace, it stops before load and prints the supported instrumentation setup. Once verified, it starts missing local Collector/Tempo/Prometheus/Grafana services, reuses healthy infrastructure on later runs, executes the configured bounded baseline and normal profiles by default, analyzes correlated traces, and writes a report. It prints profile measurements, Phase 3 findings, telemetry coverage, the Grafana URL, and the HTML report path.

Findings and reports are stored under `.perflens/runs/<run-id>/`. The HTML report is `report/report.html`; JSON and Markdown versions are beside it. To inspect the raw trace in Grafana, open Explore → Tempo and filter `perflens.audit.run_id` by the printed run ID. Prometheus is available from the URL printed by PerfLens. Advanced commands `perflens analyze <run-id>`, `perflens analyze <run-id> --offline`, `perflens report <run-id>`, and `perflens infra status|down` remain available.

## Limits and safety

Only loopback HTTP(S) targets are accepted. Profiles are bounded; peak and stress are not run by default. Use the tool only against systems you own or are authorized to test. PerfLens starts no target app or database, resets no data, and does not stop infrastructure on audit completion. The generated dashboard depends on the documented metrics being present. Only the Node instrumentation and Express integration path are documented here; other frameworks and languages are not claimed as supported.
