# Phase 1 verification

The latest results are in **CLI/toolkit evolution — 2026-09-30** below. Earlier sections are historical records; the final stack state is recorded in the latest section.

Executed on 2026-09-29 (Asia/Dhaka), using macOS/ARM64 with OrbStack. The host has Node 23.10.0 and pnpm 10.12.4; the Docker application uses Node 24. Node 24 is the documented development target.

## Results

| Check | Result |
| --- | --- |
| Dependency install and lockfile | Passed; npm network access required sandbox escalation |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed; strict TypeScript, no separate linter configured |
| `docker compose config --quiet` | Passed |
| Docker multi-stage API build | Passed, including frozen-lockfile install and production dependency deployment |
| Six-service startup | Passed; four configured healthchecks healthy, Collector and Tempo running |
| API smoke script | Passed: DB readiness, pagination, detail reads, 400/404 behavior, rejected-order non-persistence, valid order persistence, server-controlled prices, all demo endpoints, bounded metric labels |
| Database data | 2,000 customers, 500 products, 20,001 orders, 80,002 items after the smoke check created one order |
| Prometheus config | `promtool check config` passed |
| Collector config | `validate` passed, including the updated `otlp_grpc/tempo` exporter |
| Prometheus ingestion | `demo-api` target UP; request metric series queryable |
| Grafana provisioning | Datasource API confirmed Prometheus and Tempo with expected internal URLs |
| Tempo ingestion | Stored traces contain HTTP server/client and PostgreSQL spans plus service name/version/environment |
| Bottleneck trace structure | N+1 has 21 SQL query spans (plus pool spans); slow query has one SQL query span; external call has nested server → client → loopback server spans |
| k6 baseline | Passed: 150 requests, zero request failures, all 300 checks successful |

The k6 run used five VUs for 30 seconds with one-second pacing. This verifies the harness, not a throughput ceiling, latency SLO, or before/after improvement. No benchmark conclusions are drawn from the run.

## Commands executed

Version discovery used `npm view` and official release documentation. Implementation checks included:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm install --offline --frozen-lockfile
node --check apps/demo-api/test/smoke.mjs
node --check load-tests/baseline.js
cp .env.example .env
docker compose --env-file .env.example config --quiet
docker compose config --quiet
orb start
docker compose up --build -d
docker compose up -d
docker compose logs --tail=30 demo-api tempo otel-collector
BASE_URL=http://localhost:3002 pnpm test:smoke
docker compose run --rm --no-deps --entrypoint /bin/promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose run --rm --no-deps otel-collector validate --config=/etc/otelcol/config.yaml
docker compose restart otel-collector
docker compose exec -T demo-api node --input-type=module < apps/demo-api/test/telemetry.mjs
docker run --rm -i --network perflens_default -e BASE_URL=http://demo-api:3000 grafana/k6:2.3.0 run - < load-tests/baseline.js
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_items) AS items;"'
docker compose ps --all
```

## Failures encountered and resolved

- The repository was empty and had no Git metadata; `git status` could not run. Files were created in the existing workspace root.
- Sandboxed npm requests failed with DNS errors. Installation succeeded with approved network access. The stalled sandboxed installer was stopped.
- Docker was installed but the engine was stopped. Starting OrbStack required filesystem permission outside the workspace; it then started successfully.
- An initial PostgreSQL image tag was unavailable. The final verified image is `postgres:18.6`.
- The initially selected metrics package reported deprecation. It was replaced with its maintained successor, `@prometheus-io/client`.
- Host port 3000 was already occupied. Only the ignored local `.env` was changed to `API_PORT=3002`; `.env.example` retains port 3000.
- Sandboxed host HTTP smoke requests failed with `EPERM`; the same check passed with local network access approved.
- Collector logged a deprecated exporter alias. Configuration now uses `otlp_grpc/tempo`, revalidated and restarted successfully.
- pnpm reported a blocked optional `protobufjs` installation script. Build and end-to-end OTLP delivery passed without enabling it.

## Limits

Grafana was verified through its datasource API and backend data paths, not a browser UI automation test. Only local single-instance behavior and a smoke workload were tested. No failure/recovery, sustained-load, or before/after optimization study was performed. The fixture's configured delay is intentional. The application and observability data are retained in local named volumes, and the stack remains running for inspection.

Next: use Grafana Explore to review the three contrasting trace patterns and confirm the Phase 1 acceptance criteria. Do not start Phase 2 workload design as part of this implementation.

## Files created

```text
.env.example
.env                              # Ignored local settings; API_PORT=3002
.gitignore
.dockerignore
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
README.md
docker-compose.yml
apps/demo-api/package.json
apps/demo-api/tsconfig.json
apps/demo-api/Dockerfile
apps/demo-api/src/app.ts
apps/demo-api/src/entities.ts
apps/demo-api/src/instrumentation.ts
apps/demo-api/src/main.ts
apps/demo-api/src/metrics.ts
apps/demo-api/src/migration.ts
apps/demo-api/test/smoke.mjs
apps/demo-api/test/telemetry.mjs
infra/otel-collector/config.yaml
infra/tempo/tempo.yaml
infra/prometheus/prometheus.yml
infra/grafana/provisioning/datasources/datasources.yaml
load-tests/baseline.js
docs/architecture/decisions.md
docs/architecture/verification.md
```

Generated dependency directories and compiled `dist` files are ignored.

## Follow-up: unintended OTLP metrics export

The user reported a delayed `PeriodicExportingMetricReader` 404 after initial verification. The installed SDK defaults to an OTLP metric reader when `metricReaders` is omitted, while this Collector intentionally exposes only a traces pipeline. The initial checks did not catch the periodic export after its 60-second interval.

Fixed `instrumentation.ts` with explicit `metricReaders: []`; Prometheus still scrapes the independent application registry. Rebuilt/restarted the API with `docker compose up --build -d demo-api`. Build, typecheck, API smoke checks, and telemetry checks passed. Waited 65 seconds after the smoke check and inspected the recreated container's logs: no metric export errors. Prometheus target remained UP and metric series remained queryable. The repeat smoke check created order 20002.

Tempo's `starting compaction cycle` / `No more blocks to compact` messages are normal informational maintenance messages and require no change.

## Follow-up: root URL and Grafana provisioning directories

`GET /` originally returned 404 because only the specified API routes existed. Added a JSON service/endpoint index and a smoke assertion. Narrowed the Grafana bind mount to `provisioning/datasources` so the image's other provisioning directories remain available. Rebuilt/recreated the API and Grafana. Build, typecheck, Compose validation, API smoke, and telemetry checks passed. Grafana startup logs show successful provisioning and all modules healthy, with no missing-directory errors. The repeat smoke check created order 20003.

## CLI/toolkit evolution — 2026-09-30

This is the latest verification record. Earlier entries document the original demo foundation and follow-up fixes. Product positioning is now **Backend Performance Audit CLI**; the demo is a separate target.

### Implementation verified

- Added the private, executable `@perflens/cli` TypeScript/Commander package with a `perflens` binary, help/version, safe `init`, `doctor`, and `infra up/status/down`.
- Reused the original Compose file and all existing observability paths. The CLI manages only Collector, Tempo, Prometheus, and Grafana.
- Added strict minimal JSON target config and ignored `.perflens/{runs,results,logs}` convention. No audit execution, source rewriting, analysis, or reports were implemented.
- Disabled Grafana/Tempo usage reporting and Grafana automatic update/plugin/public-key downloads. Bundled Tempo and Prometheus datasource plugins remain functional.
- Updated the demo Dockerfile to build only its target package and skip workspace lifecycle hooks in container dependency installation/deployment. Demo application source, migrations, seed logic, instrumentation, and k6 workload were preserved.
- Strengthened the existing telemetry test to require recent traces and the actual 21-query N+1 trace.

### Checks and outcomes

| Check | Outcome |
| --- | --- |
| `pnpm install`, then frozen-lockfile install | Passed; root postinstall builds the CLI |
| `pnpm build` | Passed for CLI and demo API |
| `pnpm typecheck` | Passed for both packages |
| Lint | Not configured; no lint pass is claimed |
| `pnpm test` | 14 CLI tests passed |
| Real executable and package metadata | Direct binary help works; npm pack dry-run contains executable binary, compiled modules, and package metadata |
| Help/version | Passed; version 0.1.0; only implemented commands listed |
| Doctor on running stack | Passed; ports recognized as owned by matching PerfLens services |
| Doctor on stopped stack | Passed; ports 3001 and 9090 reported available |
| Doctor failure behavior | Missing Docker, daemon failure, config/Compose failures, port conflict, and unhealthy endpoint paths tested; nonzero results with remediation |
| `infra up` / `infra status` | Passed; actual readiness probes for all four services |
| Target independence | Passed: infrastructure became ready while both demo API and PostgreSQL remained stopped |
| Compose config | Passed |
| Demo multi-stage Docker build | Passed with expanded workspace and final Dockerfile |
| Existing API smoke suite | Passed after waiting for health; created order 20004 |
| PostgreSQL | 2,000 customers, 500 products, 20,004 orders, 80,008 items; DB-backed health returned 200 |
| Collector validation | Passed using installed binary |
| Prometheus validation/ingestion | promtool passed; demo target UP and application metric series queryable during target run |
| Grafana | Datasources provisioned; both `/api/datasources/uid/{uid}/health` endpoints returned HTTP 200 / OK |
| Tempo / trace pipeline | Recent traces contain HTTP server/client and PostgreSQL spans and expected resource attributes |
| N+1 | Recent trace explicitly confirmed 21 SQL query spans |
| Original k6 baseline | Passed: 150 requests, zero failures, all 300 checks successful |
| `infra down` scope | Passed: four audit services stopped, API/PostgreSQL remained healthy, all named volumes retained |
| Full cleanup after verification | Target stopped separately; infrastructure stopped again after proving independence; no volumes removed |

The k6 result validates preservation of the smoke harness. It does not establish performance capacity, an SLO, or improvement versus the earlier run. Grafana was checked through APIs; no browser UI automation is claimed.

### CLI test coverage

Tests cover executable help/version outside the checkout, rejection of unsupported/destructive infra arguments, strict/unsafe/malformed/missing config, parent lookup and explicit paths, non-overwriting init with application files preserved, doctor success/failure, missing Docker, remote Docker rejection, correct service allowlist, paths containing spaces, endpoint readiness versus container state, failed startup, unrelated port conflicts, non-destructive shutdown and shutdown failure, stopped/crashed status, both Compose JSON formats, and readable error formatting.

### Commands executed

```sh
pnpm install
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm perflens --help
pnpm perflens --version
./packages/cli/bin/perflens.cjs --help
# From packages/cli:
npm pack --dry-run --json
# From repository root:
docker compose config --quiet
pnpm perflens doctor
pnpm perflens infra up
pnpm perflens infra status
docker compose restart tempo
docker compose up --build -d demo-api
docker compose up -d --wait demo-api
docker compose exec -T demo-api node --input-type=module < apps/demo-api/test/smoke.mjs
docker compose exec -T demo-api node --input-type=module < apps/demo-api/test/telemetry.mjs
docker compose run --rm --no-deps --entrypoint /bin/promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose run --rm --no-deps otel-collector validate --config=/etc/otelcol/config.yaml
docker run --rm -i --network perflens_default -e BASE_URL=http://demo-api:3000 grafana/k6:2.3.0 run - < load-tests/baseline.js
pnpm perflens infra down
pnpm perflens infra status
docker compose ps --all
docker volume ls --filter label=com.docker.compose.project=perflens --format '{{.Name}}'
docker compose stop demo-api postgres
# Prove the CLI does not depend on the test target:
pnpm perflens doctor
pnpm perflens infra up
pnpm perflens infra status
pnpm perflens infra down
pnpm perflens infra status
docker compose ps --all
```

Additional read-only checks queried PostgreSQL row counts, API readiness after infrastructure shutdown, Grafana datasource health, Tempo readiness responses, and installed Grafana plugin/default configuration files. No publishing operation was performed; npm pack was a dry run.

### Failures and adjustments, not hidden

1. The sandbox could not access Docker's socket; doctor correctly returned nonzero. Rerunning with approved Docker access succeeded.
2. The initial live doctor detected HTTP 503 from Tempo `/ready`. A subsequent direct check returned 200; infrastructure startup/readiness and doctor then passed. This was a transient readiness failure, not bypassed by treating `running` as healthy.
3. An immediate post-rebuild smoke invocation raced API startup and received `ECONNREFUSED`. The following telemetry check lacked traffic metrics. Reran with `docker compose up -d --wait demo-api`; smoke and telemetry passed. Quick start now waits for API health.
4. The tightened telemetry test initially supplied only a search `start` time; Tempo returned HTTP 400. Added the required `end` time and reran successfully, retaining the recent-trace and N+1 assertions.
5. npm pack dry-run was initially blocked from writing its cache by the sandbox; approved access resolved it. No cache ownership or permission changes were made.
6. The first expanded-workspace image build triggered the root CLI postinstall during dependency deployment, although the CLI was not present in the demo build context. It exited successfully but showed an irrelevant no-matching-project message. The final Dockerfile explicitly skips scripts for both install and deployment and builds only the demo; the final build passed without this coupling.
7. Existing pnpm warnings about the optional blocked protobufjs build script and legacy deploy mode remain. Compilation and end-to-end telemetry succeeded; those warnings do not represent claimed test failures.

### Regressions, limitations, and final state

No functional regressions were detected in the preserved demo/observability/load-test paths after the fixes above. Infrastructure readiness is intentionally distinct from target health or ingestion. When the demo is stopped, its Prometheus scrape target is expected to be DOWN even while the infrastructure is ready.

The CLI remains private/unpublished and requires the existing checkout's assets (or `--infra-dir`). Configuration is descriptive and validated; arbitrary-project instrumentation, scrape configuration, and audit execution are not implemented. One local Compose project is supported. No automated report, findings engine, other-language adapter, production load test, or hosted product was added.

Final intended state after this verification: all six containers stopped cleanly, with the four existing named volumes retained. The target database was never reset. Restart audit services with `pnpm perflens infra up`, then start the demo separately with `docker compose up --build -d --wait demo-api`. This workspace's ignored `.env` still maps the API to port 3002; the tracked example config/default `.env.example` use 3000.

Recommended next phase: define bounded, explicitly authorized local audit runs and artifact metadata before implementing load-test orchestration. Phase 2 was not started.

### File changes for the CLI evolution

Added:

```text
packages/cli/package.json
packages/cli/tsconfig.json
packages/cli/bin/perflens.cjs
packages/cli/src/index.ts
packages/cli/src/commands/register.ts
packages/cli/src/config/project.ts
packages/cli/src/services/doctor.ts
packages/cli/src/services/infrastructure.ts
packages/cli/src/services/process.ts
packages/cli/src/services/workspace.ts
packages/cli/src/utils/errors.ts
packages/cli/test/cli.test.cjs
perflens.config.json
docs/architecture/architecture.md
docs/demo-target.md
```

Changed:

```text
README.md
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
.gitignore
.dockerignore
docker-compose.yml
apps/demo-api/Dockerfile
apps/demo-api/test/telemetry.mjs
infra/tempo/tempo.yaml
docs/architecture/decisions.md
docs/architecture/verification.md
```

Created empty ignored `.perflens/runs`, `.perflens/results`, and `.perflens/logs` directories. Existing `.env`, demo source, database schema/seed, OpenTelemetry instrumentation, Collector config, Prometheus config, datasource definitions, API smoke script, and k6 baseline script were preserved. Final `docker compose ps --all` confirmed exit code 0 for all six containers; the volume listing confirmed all four named volumes remain.
