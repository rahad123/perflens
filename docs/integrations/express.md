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

The normal first-use command is `npx perflens audit`. In an interactive terminal it asks for the target base URL and whether you want to enter one known GET path or several known safe GET paths. It does not inspect an already-running Express process for its in-memory router; route discovery is unavailable, so paths are entered manually and this is stated in the prompt. It creates configuration through the same create-only service as optional `npx perflens init`. Existing configuration is validated and reused without overwriting. Non-interactive first use requires an existing `perflens.config.json`. Express is reported as detected only when listed in package dependencies. Setup creates `perflens.config.json`, appends `.perflens/` to `.gitignore` without replacing existing content, and stores runtime assets, runs and reports below `.perflens/`; it does not add dependencies or edit source files.

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

The package adapter enables generic Node HTTP and PostgreSQL instrumentation plus Express route instrumentation. For a host-run process, it reads the selected `OTLP_HTTP_PORT` from the nearest `.perflens/infra/.env` and sets `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to `http://127.0.0.1:<port>/v1/traces` before constructing the exporter. It follows a changed port on export; it does not fall back to the SDK's default port. `init`, `doctor`, `infra up`, and `audit` show both the host endpoint and a Docker-consumer endpoint built from the same authoritative port.

### Express app running in Docker

Do not use `127.0.0.1` or `localhost` as the Collector host from inside the app container. On Docker Desktop for macOS/Windows, use `host.docker.internal` and inject the current port from PerfLens's project-local infra env file when starting/recreating the consumer container. For example, add this to the existing app service (PerfLens does not edit it):

```yaml
services:
  api:
    environment:
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://host.docker.internal:${OTLP_HTTP_PORT}/v1/traces
```

Start or recreate that service with the PerfLens env file as Compose's interpolation source:

```sh
docker compose --env-file .perflens/infra/.env up -d --force-recreate api
```

Compose substitutes the current `OTLP_HTTP_PORT`; the instrumentation validates that the explicit URL uses that same selected port when the project infra file is visible in the container. If PerfLens reallocates ports after stale infra recovery, recreate the app container with the same command so it receives the new port. PerfLens never changes application Compose or source files. Confirm the printed Docker-consumer endpoint and complete the correlated telemetry preflight before allowing load. Docker Desktop normally provides `host.docker.internal`; Linux Docker Engine may require `extra_hosts: ["host.docker.internal:host-gateway"]` and reachable host networking. Because the packaged Collector binds host published ports to loopback for local-only safety, Linux bridge access to that loopback binding has not been verified and is not claimed as supported.

For a private GET route, configure request headers without committing their values:

```json
{
  "target": {
    "headers": {
      "Authorization": "Bearer ${PERFLENS_AUTH_TOKEN}",
      "X-Api-Key": "${PERFLENS_API_KEY}"
    }
  }
}
```

Export the variables in the shell that runs `npx perflens audit`. PerfLens applies resolved headers consistently to reachability preflight, correlated telemetry verification, and k6 requests. Values are not persisted in run metadata, evidence, findings, or reports. Missing variables fail before infrastructure/load. A 401/403 stops before load and explicitly says that no analysis/report was produced. Target preflight does not follow redirects.

If a correlated trace is missing although the HTTP target responds, PerfLens stops before load and names the current Docker-consumer endpoint. This check does not itself prove whether instrumentation is absent or an endpoint cannot be reached; verify bootstrap order, service identity, and container-to-host connectivity.

The `serviceName` passed to instrumentation must match `observability.serviceName` in `perflens.config.json`. PerfLens adds `X-PerfLens-Run-Id` and `X-PerfLens-Profile` to audit requests. The instrumentation maps valid values to `perflens.audit.run_id` and `perflens.audit.profile`; they are correlation metadata, never authorization. OpenTelemetry continues to create and propagate trace IDs.

## Metrics and dashboard

The packaged Prometheus configuration scrapes the configured local target at `/metrics`. The Grafana dashboard uses the verified `perflens_http_requests_total` and `perflens_http_request_duration_seconds` metric names. If your app does not expose those metrics, its scrape target may be down or those panels may have no data; tracing and k6 measurements still work. PerfLens does not install a metrics library into your app.

## Run the audit

Start your application and its database first, then run:

```sh
npx perflens audit
```

Before k6 load, audit sends a single correlated preflight request and checks Tempo for the matching service/run/profile server span. If it cannot find that trace, it stops before load and prints the supported instrumentation setup. This check is necessary because installing the CLI does not instrument an already-running process. Once verified, it starts missing local Collector/Tempo/Prometheus/Grafana services, reuses healthy infrastructure on later runs, executes the configured bounded baseline and normal profiles by default, analyzes correlated traces, and writes reports. Selecting multiple configured endpoints requires explicit approval listing the routes and profiles each run; non-interactive operation requires `--yes`. Automatic load supports GET only, excludes health/metrics paths, and dynamic paths require concrete user-supplied values. No POST/PUT/PATCH/DELETE load is performed.

Findings and reports are stored under `.perflens/runs/<run-id>/`. The HTML report is `report/report.html`; JSON and Markdown versions are beside it. To inspect the raw trace in Grafana, open Explore → Tempo and filter `perflens.audit.run_id` by the printed run ID. Prometheus is available from the URL printed by PerfLens. Advanced commands `perflens analyze <run-id>`, `perflens analyze <run-id> --offline`, `perflens report <run-id>`, and `perflens infra status|down` remain available.

For multi-endpoint runs, the report includes endpoint-scoped request counts, status/error rate, RPS, and empirical latency percentiles for each selected endpoint and profile. Phase 3 findings remain the sole source of diagnoses; the reporting layer does not merge telemetry between routes to invent findings.

## Limits and safety

Only loopback HTTP(S) audit targets are accepted. Profiles are bounded; peak and stress are not run by default. Use the tool only against systems you own or are authorized to test. PerfLens starts no target app or database, resets no data, and does not stop infrastructure on audit completion. The generated dashboard depends on the documented metrics being present. Container access to the host receiver is explicit and uses the selected local port; no port is exposed beyond the existing loopback binding. PerfLens does not mutate consumer Compose files. Only the Node instrumentation and Express integration path are documented here; other frameworks and languages are not claimed as supported.
