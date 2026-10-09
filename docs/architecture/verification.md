# PerfLens verification

The latest results are in **Phase 2 hardening and re-verification — 2026-09-30** below. All preceding sections are historical records; their implementation boundaries and stack states describe those earlier checks.

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

## Phase 2 initial implementation verification — 2026-09-30

Implemented incrementally in the working repository. No infrastructure definitions, demo endpoints, database schema/seed, independent Prometheus registry, or original k6 smoke script were replaced. No Phase 3 analysis, findings, reports, or source-code modification was added.

### Environment and implementation

macOS ARM64/OrbStack; host Node 23.10.0 and pnpm 10.12.4, Docker API Node 24.21.0, host k6 2.3.0. Node 24 remains the recommended host version. The existing ignored `.env` uses API host port 3002. The tracked `.env.example` and project config now match 3002; the Docker-internal API remains 3000. No secret was changed or committed.

- Added `audit [--profile baseline,normal,peak,stress]` and optional `runs` to the existing Commander CLI. Default selection is baseline + normal only.
- Added strict GET workload validation, supported-k6 preflight, existing infrastructure readiness checks, timed target checks, bounded concurrent profiles, explicit cancellation/deadlines, and per-project locking.
- Added UUID run storage, resolved config/script identity, raw k6 summaries/samples, normalized metrics, lifecycle/error records, logs, and telemetry windows/correlation metadata.
- Added an allowlisted incoming HTTP span hook for run/profile metadata. The existing OpenTelemetry SDK preload, metric-reader setting, pg instrumentation, and trace propagation remain intact.
- Added automated behavior tests and a demo acceptance script that verifies known trace fixtures and actual server-span overlap. This script is not a product bottleneck detector.

### Checks and outcomes

| Check | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; no dependency or lockfile changes required; existing optional protobufjs script warning remains |
| `pnpm build` | CLI and demo passed |
| `pnpm typecheck` | Both packages passed |
| Lint | No linter configured; no lint pass claimed |
| `pnpm test` | All 27 tests passed: 14 preserved Phase 1 tests plus 13 audit tests |
| CLI help/version | Passed; audit/runs listed, version 0.1.0 |
| Doctor / Compose configuration | Passed on ready stack; failures were not ignored |
| `infra up` / `infra status` | All four existing audit services ready through actual endpoint checks |
| Demo Docker rebuild/start | Passed with `--wait`; target and database started separately |
| API and PostgreSQL | DB-backed health returned `{"status":"ok","database":"up"}`; original smoke suite passed, latest created order 20006 retained |
| Baseline-only audit | Completed, 20 requests, 0 failures; artifacts inspected |
| Default audit | Completed baseline + normal only; no peak/stress plan or result created |
| Concurrent demo matrix | Normal/peak/stress completed against all four configured demo endpoints; results below |
| Independent concurrency evidence | Tempo server span intervals overlapped by 3 / 6 / 10 requests, matching selected VUs |
| Run correlation | Exact run-ID TraceQL matched 175 traces: 171 measured requests + four preflight requests |
| Preserved trace structure | 970 PostgreSQL query spans across measured matrix traces; 42 N+1 traces each had exactly 21 SQL queries; 41 external HTTP client spans retained their server parents |
| Prometheus | Demo target UP, request series queryable; original telemetry check reported 11 series |
| Grafana | Both provisioned datasource health APIs returned HTTP 200 / status OK |
| Failure artifacts | Unreachable loopback target returned exit 1 with failed run/end timestamp; raw/results directories remained empty because no load started |
| Cancellation | Real SIGINT returned 130, cancelled run/profile stored with nine completed requests, project lock removed |
| Historical integrity | SHA-256 hashes of every file in the first completed baseline were unchanged across the cancellation test |
| HTTP error normalization | Temporary local fixture returned two 200s and two 500s under real k6; normalized 4 requests, 2 successes, 2 failures, errorRate 0.5; execution correctly completed |
| Original manual k6 baseline | Passed unchanged: 150 requests, zero failures, all 300 checks passed |
| Artifact consistency | All stored run IDs, schema versions, statuses, UTC start/end windows, profile/result windows, and telemetry metadata matched |
| No residual load | Approved host process check found no remaining k6 processes after completion/cancellation |

Grafana was verified through APIs and the trace/metric data paths, not browser UI automation. The status fixture was temporary, uninstrumented, and local; its results validate error normalization, not demo performance.

### Real measured output and workload details

The baseline-only run was `pfl_20260930T081552001Z_ccf063c3-f3fe-48b8-aa4a-d238d2812e64`, stored in the root `.perflens/runs/`. Its UTC window was `08:15:52.001Z`–`08:16:02.482Z` on 2026-09-30. Exact console summary:

```text
✓ baseline complete — Requests: 20; RPS: 2.00; p50/p95/p99: 3.56/8.96/9.88 ms; Errors: 0.00%
Audit complete (measurements only).
```

The default run was `pfl_20260930T082509817Z_f0c1a664-9ed0-475c-91b9-ea328ae936f7`, also in root `.perflens/runs/`, with window `08:25:09.817Z`–`08:25:35.607Z`. These values are real local observations, rounded for this table:

| GET /orders profile | VUs / configured duration | Requests | RPS | p50 ms | p95 ms | p99 ms | Error rate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline-only run | 1 / 10s | 20 | 2.00 | 3.56 | 8.96 | 9.88 | 0% |
| Default run: baseline | 1 / 10s | 20 | 1.98 | 3.94 | 9.63 | 27.04 | 0% |
| Default run: normal | 3 / 15s | 90 | 5.99 | 3.86 | 10.00 | 11.45 | 0% |

The demo matrix run was `pfl_20260930T082419064Z_ed21e494-090b-47c4-9a2c-7f695ed49aed`, using ignored `.perflens/verification/demo-profiles.json`. Since artifacts are config-relative, its directory is `.perflens/verification/.perflens/runs/<run-id>/`. UTC window: `08:24:19.065Z`–`08:24:39.089Z`.

Configured endpoints were GET `/orders`, `/performance/slow-query`, `/performance/n-plus-one`, `/performance/external-call`. Normal/peak/stress durations were explicitly reduced to **5s each** for this controlled acceptance run. VUs retained defaults 3/6/10; pacing was 500 ms per VU and request timeout 5000 ms. Profiles were sequential; endpoint selection was round-robin. The table aggregates all four endpoints and is not a comparison with the orders-only run.

| Matrix profile | Requests | RPS | p50 ms | p95 ms | p99 ms | Error rate | Maximum concurrent server spans |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| normal | 27 | 4.99 | 58.45 | 754.11 | 754.23 | 0% | 3 |
| peak | 54 | 9.71 | 298.70 | 756.31 | 758.68 | 0% | 6 |
| stress | 90 | 15.98 | 327.08 | 755.01 | 767.87 | 0% | 10 |

The normalized artifacts also contain average/p90/min/max, exact test durations (including graceful completion), success/failure counts, status distributions, endpoint request counts, and approximate client overlap. All matrix statuses were 200. Client overlap independently matched 3/6/10. The stronger concurrency assertion used start/end nanoseconds from actual Tempo server spans, not just the declared VU count.

No capacity, SLO, improvement, or root-cause conclusion is inferred from these short local runs. Environment state, sampling, intentional fixtures, and limited request counts affect observations.

### Failure and interruption evidence

- Initial implementation error: `pfl_20260930T081334592Z_98d934a5-a995-4aca-8d84-2bec6fbc9444` failed before load. During a lock refactor, an extracted function still referenced `options.infraDir` outside its scope. The concurrent compiler invocation reported the error, but TypeScript had emitted JavaScript. Fixed the explicit parameter handoff, enabled CLI `noEmitOnError`, waited for successful build/typecheck, and reran successfully. The original failed run remains stored.
- Controlled unreachable target: `pfl_20260930T083353468Z_f2074175-1245-4b33-99ef-2f7c61de1fcd`, under the verification config directory, failed with exit 1 against `http://127.0.0.1:1`. Its run/metadata windows and error are stored; no profile started.
- Controlled SIGINT: `pfl_20260930T083915798Z_95605f07-070e-45a1-8d95-36fe9f685cd8`, under root runs, was interrupted after about 1.5 seconds of normal load. Status `cancelled`, exit 130, nine requests preserved, lock removed, previous run hashes unchanged.
- HTTP-status fixture: `pfl_20260930T084040678Z_4dff58b0-75e6-4875-8ac1-3052b9b12505`, under verification runs, completed a 1-VU/1s/250ms profile with two failed requests out of four. This is explicitly fixture evidence for result parsing and completion semantics, not a performance benchmark.
- A live doctor initially detected transient Tempo `/ready` HTTP 503; startup/readiness retry succeeded and final doctor passed. Running was never treated as sufficient readiness.
- The original telemetry check initially ran after its five-minute fresh-trace window elapsed and found no matching recent performance traces. Refreshed traffic using the unchanged API smoke script; the same telemetry check then passed all server/client/PostgreSQL/N+1 assertions.
- The sandbox blocked host process-list access (`sysmond service not found`); an approved read-only rerun succeeded with no k6 matches. Docker/network checks likewise used required approved access.
- The existing optional protobufjs installation-script warning remained; builds and actual OTLP/metrics paths passed. No warning was disguised as a test pass.

### Commands executed

Core checks and live workflow:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm perflens --help
pnpm perflens --version
pnpm perflens doctor
docker compose config --quiet
pnpm perflens infra up
pnpm perflens infra status
docker compose up --build -d --wait demo-api
docker compose exec -T demo-api node --input-type=module < apps/demo-api/test/smoke.mjs
pnpm perflens audit --profile baseline
pnpm perflens --config .perflens/verification/demo-profiles.json audit --profile normal,peak,stress
pnpm perflens audit
pnpm perflens --config .perflens/verification/unreachable.json audit --profile baseline
pnpm perflens runs
docker compose exec -T -e AUDIT_RUN_ID=pfl_20260930T082419064Z_ed21e494-090b-47c4-9a2c-7f695ed49aed -e EXPECT_DEMOS=true demo-api node --input-type=module < apps/demo-api/test/audit-telemetry.mjs
docker compose exec -T demo-api node --input-type=module < apps/demo-api/test/telemetry.mjs
k6 run -e BASE_URL=http://localhost:3002 load-tests/baseline.js
node .perflens/verification/check-cancellation.cjs
node .perflens/verification/check-http-errors.cjs
git diff --check
pgrep -fl '(^|/)k6( |$)'
pnpm perflens infra down
pnpm perflens infra status
docker compose ps --all
```

The ignored verification configs/harnesses and local run data remain available in this workspace. They are not required for a fresh clone. The demo matrix can be reproduced by setting the four endpoints and 5s profile durations described above; the unreachable config differs only in its local target URL. The cancellation harness spawns the real CLI, sends SIGINT after the normal profile starts, asserts exit 130 and cancellation artifacts, and hashes the earlier completed run before/after. The status harness binds a temporary loopback HTTP server, returns 2xx for preflight, alternates 500/200 during load, and closes it afterwards. Reusable equivalent failure/cancellation branches are covered by tracked automated tests.

Additional read-only checks validated every stored artifact's status/windows/schema, queried datasource health and DB-backed API health, and inspected shutdown state/volumes. The full original API smoke test was rerun twice during Phase 2, creating orders 20005 and 20006; the database was not reset.

### Added files

```text
packages/cli/assets/audit.js
packages/cli/src/audit/config.ts
packages/cli/src/audit/k6.ts
packages/cli/src/audit/lock.ts
packages/cli/src/audit/preflight.ts
packages/cli/src/audit/process.ts
packages/cli/src/audit/results.ts
packages/cli/src/audit/service.ts
packages/cli/src/audit/storage.ts
packages/cli/test/audit.test.cjs
apps/demo-api/test/audit-telemetry.mjs
docs/audit-methodology.md
```

### Changed files

```text
.env.example
README.md
perflens.config.json
packages/cli/package.json
packages/cli/tsconfig.json
packages/cli/src/commands/register.ts
packages/cli/src/config/project.ts
packages/cli/test/cli.test.cjs
apps/demo-api/src/instrumentation.ts
docs/architecture/architecture.md
docs/architecture/decisions.md
docs/architecture/verification.md
docs/demo-target.md
```

The Compose file, infrastructure configs, demo controllers/entities/migrations/metrics, original smoke/telemetry tests, and original k6 baseline are unchanged in this phase. Existing `.gitignore` already covers `.perflens`, so no additional ignore rule was needed. The lockfile has no changes because no new dependencies were introduced.

### Relevant repository tree

```text
perflens/
├── packages/cli/
│   ├── bin/perflens.cjs
│   ├── assets/audit.js
│   ├── src/
│   │   ├── index.ts
│   │   ├── commands/register.ts
│   │   ├── config/project.ts
│   │   ├── audit/{config,k6,lock,preflight,process,results,service,storage}.ts
│   │   ├── services/{doctor,infrastructure,process,workspace}.ts
│   │   └── utils/errors.ts
│   └── test/{cli,audit}.test.cjs
├── apps/demo-api/
│   ├── src/instrumentation.ts
│   └── test/{smoke,telemetry,audit-telemetry}.mjs
├── infra/{otel-collector,tempo,prometheus,grafana}/
├── load-tests/baseline.js
├── docs/
│   ├── audit-methodology.md
│   ├── demo-target.md
│   └── architecture/{architecture,decisions,verification}.md
├── .perflens/runs/<run-id>/      # ignored raw/results/telemetry/logs and run state
├── perflens.config.json
├── docker-compose.yml
└── README.md
```

### Limits and next phase

No functional regressions were detected after the fixes. Audits require host k6 2.3.x and the existing local checkout infrastructure. Targets remain loopback GET only, with no auth/body/query support or remote authorization override. Latencies aggregate configured endpoints. Historical run protection is application-level; disk failures and hard kills can prevent finalization. Raw sample volume and retained runs consume local disk; no automatic deletion occurs. Project locking does not stop unrelated traffic.

Correlation does not export trace data or take metric snapshots. Tempo/Prometheus retention still applies, and metric windows may include other traffic. Arbitrary targets need explicit instrumentation/header capture and scrape setup. No browser UI automation, remote/load-distributed test, sustained-capacity experiment, or production test was performed.

Recommended Phase 3, not started: define how to consume versioned run evidence and correlated telemetry, with explicit missing/expired-data handling and evidence-backed analysis. No diagnosis heuristics, P0/P1/P2 findings, report formats, comparison engine, or integrations were added here.

### Confirmed final shutdown state

`perflens infra down` stopped Collector, Tempo, Prometheus, and Grafana with exit code 0. `infra status` reported all four exited. `docker compose ps --all` confirmed the independently managed demo API and PostgreSQL remained healthy at that point. Stopped those separately with `docker compose stop demo-api postgres`; the final `ps --all` showed **all six containers exited with code 0**.

`docker volume ls --filter label=com.docker.compose.project=perflens` confirmed all four named volumes remain: `perflens_grafana-data`, `perflens_postgres-data`, `perflens_prometheus-data`, and `perflens_tempo-data`. No volume/database reset or history deletion occurred. Local audit artifacts remain in their config-relative `.perflens/runs` directories. Final `git diff --check` passed.

Restart with `pnpm perflens infra up`, then `docker compose up --build -d --wait demo-api`, then `pnpm perflens audit`. This verification is complete; Phase 3 was not started.

## Phase 2 hardening and re-verification — 2026-09-30

This pass reviewed the local `feat/phase-2` branch for merge readiness. The public PR page lists the PR as open, from `feat/phase-2` into `main`, with no reviews; its listed head (`9e1cf02`) matches this workspace's HEAD. This hardening diff is currently local and uncommitted, so it is not yet in the remote PR. The GitHub CLI is not authenticated; hosted check status could not be verified. CI is added locally but has not run on GitHub. No remote PR write or merge was attempted.

### Changes in this pass

- Added `.github/workflows/ci.yml` for pull requests and pushes to `main`. It uses Node 24, the repository's pinned pnpm version, frozen lockfile installation, build, typecheck, optional root/workspace lint, and the Docker-independent `pnpm test` suite. Permissions are read-only, PR checkout credentials are not persisted, and the job has a ten-minute limit. It does not provision Docker or k6.
- Checked normalized results against actual k6 2.3.0 `handleSummary` output. `http_reqs.values.count/rate` are request count/RPS. For the k6 Rate metric `http_req_failed`, `values.passes` counts failing requests (the metric's truthy samples), `fails` counts successful requests, and `rate` is the failure fraction. Successful request count is therefore requests minus `passes`.
- Completed-run validation now requires the supported counter/rate/trend types and units; positive, consistent request count and duration; RPS consistent with count/duration; a bounded error rate consistent with failure counts; all configured percentile values in monotonic order; and raw request/status/endpoint/client-interval samples consistent with the summary. Observed HTTP statuses must agree with k6's failure count. Missing/invalid data never turns an exited-zero process into a completed profile.
- NDJSON parsing rejects malformed records, request points, sample values, and timestamps. Failed/cancelled runs still keep raw files and preserve whatever structured metrics can be read.
- `RunStore` now rejects paths escaping its run directory, serializes writes, stops accepting writes when finalization starts, drains earlier queued writes before final state, and refuses repeat finalization.
- Added asymmetric fixtures (three successes, one failure) so swapping the k6 Rate pass/fail interpretation cannot pass unnoticed. Added missing-summary, missing-samples, mismatched-count, malformed-NDJSON, and zero-request completed-run tests. Added queue finalization and artifact path escape tests.

No Phase 3 behavior was introduced.

### Final checks run

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm --if-present run lint
pnpm -r --if-present run lint
pnpm test
docker compose config --quiet
ruby -e 'require "yaml"; YAML.parse_file(".github/workflows/ci.yml"); puts "CI YAML parse passed"'
git diff --check
```

Results: frozen install passed with no lockfile change; build and typecheck passed for both workspaces; optional lint commands passed and found no lint script configured; **33 tests passed** (including five invalid-evidence subtests); Compose and CI YAML parsed; whitespace check passed. The existing pnpm warning that the optional `protobufjs` build script is ignored remains. No unit/integration test requires Docker or k6.

Additional checks after hardening:

- `pnpm perflens --help`, `--version`, `doctor`, and `infra status` passed.
- Baseline audit `pfl_20260930T094546475Z_616bb573-9b0d-4469-bf5a-0088f42e06ac` completed with 20 requests, 0 failures, 2.00 RPS, and p50/p95/p99 **3.52 / 7.06 / 7.16 ms**.
- Normal audit `pfl_20260930T094633744Z_f2f5ad76-810f-4a78-8f75-fdc667c63c3c` completed with 90 requests, 0 failures, 5.99 RPS, and p50/p95/p99 **4.41 / 9.50 / 45.07 ms**. These are local observations, not thresholds or capacity claims.
- Its run-ID trace check found 90 measured root server spans and 90 PostgreSQL spans, with maximum simultaneous server-span overlap **3**. Prometheus target was UP and request metrics were queryable.
- Original API smoke suite passed and created order 20007. After its new traces were allowed to flush through Tempo batching, the unchanged telemetry regression script passed: Grafana datasources, Prometheus target/11 metric series, and recent HTTP server/client/PostgreSQL/N+1 traces. N+1 remained 21 queries.
- After restarting the stack for the final Phase 1 load-script regression, the unchanged `k6 run -e BASE_URL=http://localhost:3002 load-tests/baseline.js` passed again: **150 requests, zero failures, 300/300 checks**, five VUs for 30 seconds. This is the original smoke test, distinct from CLI audit artifacts. The final API smoke rerun created order 20008; the original telemetry test passed after waiting for Tempo's batch flush.
- An unreachable target returned exit 1 and stored failed preflight without load: `pfl_20260930T094804004Z_c9da57e3-6b6b-475b-a513-687f8740bbf1`.
- Real SIGINT returned exit 130 and stored cancellation evidence: `pfl_20260930T094819133Z_a1c2b196-6399-4f9b-9e60-015469565c65`. The lock was removed and prior baseline run hashes stayed unchanged.
- Real k6 against a temporary loopback server returned both 200 and 500. The run completed and measured the failures: `pfl_20260930T094856457Z_eef445ed-31c1-4be0-bfcf-3753e355cfdc`, **5 requests, 2 successful, 3 failed, 60% error rate**. This temporary fixture is not a demo benchmark; actual request count and response ordering are stored in its artifact.

The first stricter test run failed because its fake summary omitted k6 metric type/unit metadata. I updated the fixtures to match actual k6 2.3 output. A concurrency fixture assertion was also corrected to match its measured timestamp overlap. The final run passed.

No linter or `actionlint` is installed; CI syntax was checked with Ruby's YAML parser. GitHub Actions itself was not run locally. The public PR page confirms it remains open with no reviews; GitHub's checks tab could not be fetched and the CLI has no credentials, so hosted check/required-check status remains unverified.

After verification, all six Compose containers were stopped with exit code 0. The four named volumes remain; no database reset was performed. Generated `.perflens` run evidence and smoke-created orders remain local.

## Phase 3 — evidence-based analysis verification — 2026-09-30

Phase 3 analysis was added without changing the Phase 2 audit/k6/run-storage contract or the existing demo endpoints. `@perflens/analysis-engine` is framework- and CLI-independent. `perflens analyze [run-id]` selects the newest completed run by default, reads normalized profile results, and collects Tempo traces by service name, exact audit run ID, profile, and that profile's UTC window. The first analysis stores sanitized trace evidence; subsequent analysis, including `--offline`, replays that snapshot. Tempo's query API is exposed only at the loopback `TEMPO_PORT` (default `3200`) so the CLI can fetch traces without depending on the demo container.

### Checks

The following completed successfully after the final source changes:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm perflens --help
pnpm perflens --version
pnpm perflens doctor
pnpm perflens infra up
pnpm perflens infra status
docker compose config --quiet
```

The frozen install postinstall built all three workspaces. Build/typecheck passed for the demo API, analysis engine, and CLI. **53 tests passed:** 16 analysis-engine tests and 37 CLI tests, including offline run-artifact integration, TraceQL scoping, Tempo span normalization, privacy sanitization, sample guards, false-positive cases, and all existing Phase 1/2 CLI and audit tests. No lint script is configured in these workspaces. No Docker dependency was added to the automated test suite.

The full existing local stack started ready. The API `/health` returned `{"status":"ok","database":"up"}`. Grafana health returned HTTP 200 and listed provisioned `Prometheus` and `Tempo` datasources. Prometheus readiness returned HTTP 200 and `perflens_http_requests_total` returned four series. Tempo `/ready` returned HTTP 200. The demo target, PostgreSQL spans, collector, and run-correlated trace search were all exercised by the analyses below.

### Actual local audits and findings

All runs used the existing k6 2.3.0 adapter and the conservative configured `baseline` (1 VU, 10 seconds) and `normal` (3 VUs, 15 seconds) profiles against the local demo only. RPS and latency are observations from this workstation and are not benchmark claims.

| Target | Run | Baseline requests / RPS / p50 / p95 / p99 | Normal requests / RPS / p50 / p95 / p99 | Observed analysis |
| --- | --- | --- | --- | --- |
| `GET /orders` | `pfl_20260930T103520872Z_e90e1db0-ccf6-44a5-aab1-aed55131dcab` | 20 / 2.00 / 3.35 / 5.27 / 7.02 ms | 90 / 5.99 / 5.82 / 14.52 / 20.60 ms | No finding; 110 correlated request traces, 222 PostgreSQL spans, no external HTTP spans. The measured p95 increase was below the configured absolute threshold. |
| `GET /performance/n-plus-one` | `pfl_20260930T104003569Z_96168e94-4ce1-4678-af14-a86e2cb9547a` | 20 / 2.00 / 6.84 / 16.69 / 19.45 ms | 90 / 5.99 / 15.73 / 33.08 / 41.61 ms | One repeated-operation finding across baseline and normal, HIGH confidence. Tempo snapshot: 110 request traces and 4,622 PostgreSQL-related spans. 20/20 baseline and 90/90 normal traces had a median 21 query-shaped operations/request. |
| `GET /performance/slow-query` | `pfl_20260930T104056317Z_eddf8d0a-cb5e-4677-8491-fea78c4f1386` | 19 / 1.83 / 526.51 / 616.17 / 645.61 ms | 87 / 5.64 / 528.46 / 553.43 / 579.32 ms | One recurring slow database-operation finding across baseline and normal, HIGH overall confidence (19 baseline traces provide MEDIUM support; 87 normal traces HIGH). PostgreSQL span median duration was 525.6 ms / 527.6 ms respectively; no repeated-query/N+1 finding. |
| `GET /performance/external-call` | `pfl_20260930T104151112Z_66f1ccb2-8e6f-4d1e-a976-79a04217f2e0` | 14 / 1.32 / 754.44 / 756.24 / 756.32 ms | 60 / 3.96 / 755.94 / 763.42 / 763.92 ms | One external-dependency finding across baseline and normal, HIGH overall confidence. `127.0.0.1/dependency` median span duration 752.5 ms / 753.7 ms, occupying 99.9% of the request window. Baseline support is MEDIUM, normal support HIGH; zero PostgreSQL spans and no database finding. |

Every audit reported zero request errors. The load rule did not report degradation for these runs: `/orders` p95 increased by 9.25 ms, and other p95 changes did not cross the material threshold. The N+1 result is described as a candidate, not a certain root cause. The slow-query endpoint was not classified as repeated-query behavior. External calls were not mislabeled as database activity. PostgreSQL pool/connection spans are excluded from the repeated-query denominator and external HTTP rule.

All four saved snapshots were then re-analyzed offline with `--offline`; each produced the same finding content without a live Tempo request. Trace findings for the same target/rule/pattern are consolidated across profiles, retaining per-profile evidence and metrics rather than duplicating the finding. A no-ID `perflens analyze --offline` selected the newest completed run (`/performance/external-call`). Analysis artifacts are at each run's `analysis/evidence.json`, `analysis/findings.json`, and `analysis/analysis.json`. The evidence snapshot stores only normalized profile results and allowlisted sanitized span attributes; observed SQL shapes were derived from `db.query.text`, with literals and numeric values removed before persistence.

### Phase 1 regression and shutdown

The original `load-tests/baseline.js` ran unchanged with 5 VUs for 30 seconds against local `/orders`: **150 requests, 4.93 RPS, p50 6.14 ms, p95 59.96 ms, zero failed requests, and 300/300 checks passed**. The API health response confirmed PostgreSQL connectivity. Grafana datasources, Prometheus metric ingestion, Tempo readiness, HTTP root spans, and PostgreSQL child spans remained available during audit analysis.

The four infrastructure services were stopped with `pnpm perflens infra down`, followed by `docker compose stop --timeout 30 demo-api postgres`. All six containers exited cleanly (exit code 0). The `postgres-data`, `tempo-data`, `prometheus-data`, and `grafana-data` volumes remain; no database reset or volume deletion occurred. Audit run artifacts remain local under ignored `.perflens/`. `perflens.phase3.local.json` was only an ignored acceptance config and is removed after verification.

The analysis deliberately does not infer CPU, memory, connection-pool saturation, or missing indexes: Phase 2 does not persist reliable per-run resource snapshots. Trace collection is capped at 500 traces per profile and marks truncation. Phase 4 reports, recommendations, comparisons, and automatic changes remain unimplemented.

## Phase 3 merge-readiness hardening — 2026-09-30

The analysis comparison and trace aggregation rules were hardened without changing the evidence/run schema or CLI workflow:

- Load comparisons now require both profiles to use the recorded `constant-vus` executor, identical endpoint sets, identical request pacing and request timeout, and a strictly larger VU count in the later profile. At least 20 requests per profile remain required. Workload model/config mismatches, non-increasing VUs, multi-endpoint aggregates, and different endpoints are skipped. The VU comparison is explicitly valid only for this supported constant-VU model.
- Throughput findings now say only that throughput decreased between comparable workloads. The title and summary explicitly avoid saturation or root-cause claims.
- External dependency contribution and its severity/confidence are based on the per-request union of dependency span intervals, then aggregated over affected request traces. Call count and call latency remain supporting measurements; one request with many calls cannot outweigh requests without the dependency.
- Repeated SQL detection requires a relation-bearing normalized query shape. Bare `SELECT` span names are not treated as equivalent query evidence. A repeated-query candidate with little measured request-time contribution is P2 and its wording distinguishes repetition from latency impact.

### Checks run

```sh
pnpm build
pnpm typecheck
pnpm --if-present run lint
pnpm -r --if-present run lint
pnpm test
docker compose config --quiet
git diff --check
pnpm perflens doctor
pnpm perflens infra status
BASE_URL=http://localhost:3002 pnpm test:smoke
k6 run --no-usage-report --env BASE_URL=http://localhost:3002 load-tests/baseline.js
```

Build and typecheck passed across all three workspaces. No lint script is configured, so both optional lint invocations completed without running a linter. All **59 tests passed** (22 analysis-engine and 37 CLI tests), including explicit workload-comparability negatives, request-level dependency weighting, generic `SELECT` rejection, sparse repeated-query traces, low-impact repeated-query severity, and deterministic-output assertions. The full suite also reran the Phase 1/2 CLI, audit, cancellation, evidence validation, run-storage, and offline-analysis tests. Compose validation and `git diff --check` passed.

Doctor reported the local configuration and Docker ready; Collector, Tempo, Prometheus, and Grafana subsequently reported ready. Tempo was stopped temporarily: `curl http://localhost:3200/ready` failed to connect, while all four persisted real acceptance snapshots were analyzed with `perflens analyze <run-id> --offline` successfully. Each snapshot was analyzed twice directly from the exact same `analysis/evidence.json`; after excluding `analyzedAt`, complete analysis JSON was identical. A plain container start briefly left Tempo at HTTP 503 while its ingester was warming; `pnpm perflens infra up` restored all four services to ready, and Tempo `/ready`, Prometheus `/-/ready`, and Grafana `/api/health` then passed. No telemetry snapshot, run artifact, or volume was removed.

The existing demo smoke test's default URL (`localhost:3000`) does not match this workspace's `.env` mapping (`API_PORT=3002`); the default invocation failed with a closed connection. Rerunning with `BASE_URL=http://localhost:3002` passed all API, PostgreSQL, demo-endpoint, and bounded-metric-label assertions and created order 20009. This pass used the configured target address rather than changing the test or port configuration.

The unchanged k6 baseline script completed locally with five VUs for 30 seconds: **150 requests, 0 failed, 4.96728 requests/sec, p50 4.57 ms, p90 12.3 ms, p95 14.46 ms, and 300/300 checks passed**. These are local observations, not performance guarantees.

### Current analysis of persisted local acceptance evidence

The four real endpoint runs above were replayed with the hardened engine after Tempo had been stopped. They were originally generated against the local demo API with baseline and normal profiles; this hardening pass did not issue replacement audit traffic. All request/trace counts and findings below come from those persisted run artifacts:

| Target | Run | Persisted evidence and current findings |
| --- | --- | --- |
| `GET /orders` | `pfl_20260930T103520872Z_e90e1db0-ccf6-44a5-aab1-aed55131dcab` | 110 correlated requests, 222 PostgreSQL spans, 0 external spans; **no findings**. |
| `GET /performance/n-plus-one` | `pfl_20260930T104003569Z_96168e94-4ce1-4678-af14-a86e2cb9547a` | 110 correlated requests, 4,622 PostgreSQL spans; **P2 repeated database query pattern, HIGH confidence**. All 20 baseline and 90 normal request traces showed a median 21 query-shaped operations/request. Median DB interval contribution was 27.6% baseline and 57.0% normal. The engine calls this a likely N+1 *candidate*; severity remains P2 because this persisted evidence does not meet the absolute request-time impact guard across profiles. |
| `GET /performance/slow-query` | `pfl_20260930T104056317Z_eddf8d0a-cb5e-4677-8491-fea78c4f1386` | 106 correlated requests, 213 PostgreSQL spans; **P1 consistently slow database operation, HIGH overall confidence**. Equivalent operation median duration was 525.6 ms across 19 baseline requests and 527.6 ms across 87 normal requests. **No repeated-query finding.** |
| `GET /performance/external-call` | `pfl_20260930T104151112Z_66f1ccb2-8e6f-4d1e-a976-79a04217f2e0` | 74 correlated requests, 0 PostgreSQL spans, 74 external HTTP spans; **P1 external dependency latency, HIGH overall confidence**. Per-request median dependency interval contribution was 752.3 ms (99.9%) baseline and 753.7 ms (99.9%) normal. **No database finding.** |

The added negative fixtures confirm that different fast database queries, generic `SELECT` names without query shape, one request with repeated queries while peers remain clean, and fewer than the minimum trace sample count do not produce an N+1 finding. A repeated fast-query candidate can still be emitted, but with P2 severity and impact-qualified wording. One trace containing 20 slow dependency calls among 10 otherwise sampled requests does not produce dependency dominance. These findings are deterministic from the saved evidence; all are Phase 3 observations, not Phase 4 recommendations.

## PR #2 Phase 3 merge-readiness acceptance — 2026-09-30

This pass added tests distinguishing repeated-query patterns from measured impact, including 21 fast equivalent operations (P2 candidate) and 21 equivalent operations consuming over half of each request window (P1). It also tests HTTP method mismatch, high latency without DB/dependency evidence, and a positive external-dependency pattern with request-level metrics. Workload comparisons are explicitly limited to matching `constant-vus` profiles with the same one-endpoint target, pacing, and timeout; VUs are interpreted as higher configured concurrency only under those fixed semantics. External dependency medians/percentiles and severity are calculated from per-request interval unions, not individual client-call durations.

### Build, tests, and regressions

The following commands completed successfully:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm --if-present run lint
pnpm -r --if-present run lint
pnpm test
docker compose config --quiet
git diff --check
pnpm perflens doctor
pnpm perflens infra status
BASE_URL=http://localhost:3002 pnpm test:smoke
k6 run --no-usage-report --env BASE_URL=http://localhost:3002 load-tests/baseline.js
```

The frozen install completed and all workspaces built. Typecheck passed. No lint script is configured. **61 tests passed** (24 analysis-engine and 37 CLI tests); all Phase 1/2 CLI, audit, k6 evidence, cancellation, storage, and Phase 3 analysis integration tests are included in `pnpm test`. The API smoke and original k6 baseline passed against the configured local API port. The k6 smoke completed **150 requests, 0 failures, 4.962452 RPS, p50 5.24 ms, p95 14.37 ms, and 300/300 checks**. Doctor and all four infrastructure readiness checks passed. The Compose stack remained on the local Docker context; no volumes were deleted.

### Fresh local acceptance runs

Each row below is a new bounded `baseline,normal` CLI audit against the local demo API on 2026-09-30, followed by a live Tempo-correlated analysis. Percentiles and rates are observed workstation measurements, not benchmark guarantees.

| Endpoint and run ID | k6 measurements: baseline; normal | Correlated traces and component spans | Findings and non-findings |
| --- | --- | --- | --- |
| `GET /orders` — `pfl_20260930T125939295Z_edb52fb1-0161-44cd-9172-0d6a443a8727` | 20 requests, 1.99 RPS, p50/p95/p99 **4.60/14.55/108.61 ms**; 90 requests, 5.99 RPS, **8.53/18.23/20.78 ms**. Both 0 errors. | 110 request traces; 222 PostgreSQL spans; 0 external HTTP spans. | **No findings.** No DB/dependency diagnosis and no severe finding. A high baseline p99 alone did not trigger a component claim. |
| `GET /performance/n-plus-one` — `pfl_20260930T130708133Z_14da067c-55b3-4e1f-af9c-3abe09f10c1f` | 20 requests, 2.00 RPS, p50/p95/p99 **6.70/15.88/21.90 ms**; 90 requests, 5.99 RPS, **13.64/28.11/34.60 ms**. Both 0 errors. | 110 request traces; 4,622 PostgreSQL spans. Every sampled request had a median **21 query-shaped DB operations**; DB interval contribution median was 32.0%/1.8 ms baseline and 53.4%/6.0 ms normal. **0/20 and 0/90** requests respectively met both material-impact thresholds (at least 50% and 50 ms). | **P2 `database.repeated-operation`, HIGH confidence**, described as a likely N+1 pattern candidate. The repeated pattern is real, while request-level absolute DB contribution is low. No slow-operation or load-degradation finding. |
| `GET /performance/slow-query` — `pfl_20260930T130808618Z_a3dbfdaf-35eb-4cca-941e-a74f9dc33ca5` | 20 requests, 1.94 RPS, p50/p95/p99 **505.23/538.23/557.93 ms**; 87 requests, 5.61 RPS, **529.20/548.73/596.49 ms**. Both 0 errors. | 107 request traces; 215 PostgreSQL spans; 0 external HTTP spans. Equivalent DB operation median duration **504.0 ms across 20 baseline requests** and **528.3 ms across 87 normal requests**. | **P1 `database.slow-operation`, HIGH confidence.** No repeated-operation/N+1 finding; the traces show one slow equivalent operation per request, not a repeated pattern within requests. No external dependency finding. |
| `GET /performance/external-call` — `pfl_20260930T130916690Z_e8396595-f274-4e92-800c-d5b9c4d5346f` | 14 requests, 1.32 RPS, p50/p95/p99 **756.98/761.77/766.12 ms**; 60 requests, 3.96 RPS, **758.08/761.64/763.07 ms**. Both 0 errors. | 74 request traces; 0 PostgreSQL spans; 74 external HTTP spans. Per-request dependency contribution median **753.5 ms (99.8%) baseline** and **754.7 ms (99.9%) normal**; request-level p95 contribution **761.1/756.5 ms**. | **P1 `dependency.latency-dominance`, HIGH confidence.** No database finding. No load-degradation finding because p95 remained stable across profiles. |

The n-plus-one, slow-query, and external-call rule IDs listed above triggered; the absent component/load rules are intentionally absent because their own evidence conditions were not met. Run-specific request counts and span counts come from the saved `results/*.json` and `analysis/evidence.json` artifacts under each listed ID.

### Determinism and offline replay

After the fresh runs had `analysis/evidence.json`, Tempo was stopped and its loopback readiness endpoint refused connections. `perflens analyze <run-id> --offline` succeeded for all four IDs above. Each exact saved snapshot was also analyzed twice directly; full result JSON was equal after removing only `analyzedAt`, including finding order, rule IDs, severity, confidence, evidence, and metrics. Tempo was restarted afterward. Analysis did not need Tempo retention after the snapshot was present.

No Phase 4 features were added. Resource saturation remains unsupported because Phase 2 does not persist reliable per-run CPU, memory, event-loop, or pool metrics.

## Phase 4 report acceptance — 2026-09-30

The Phase 4 reporting command was exercised against the four persisted analyzed runs from the preceding local acceptance pass. It reused each run's Phase 2 profile results, `analysis/evidence.json`, `analysis/findings.json`, and `analysis/analysis.json`; report generation made no live Tempo query and did not rerun analysis. All default-format commands wrote `report.json`, `report.md`, and `report.html` below each run's `report/` directory.

| Target / run | Actual Phase 2 measurements | Persisted Phase 3 findings carried into report |
| --- | --- | --- |
| `GET /orders` — `pfl_20260930T125939295Z_edb52fb1-0161-44cd-9172-0d6a443a8727` | baseline 20 requests, 1.99 RPS, p50/p95/p99 4.60/14.55/108.61 ms; normal 90 requests, 5.99 RPS, 8.53/18.23/20.78 ms; 0 errors; 110 traces, 222 PostgreSQL spans, 0 external spans | Zero findings. A useful report was generated; no bottleneck was fabricated. |
| `GET /performance/n-plus-one` — `pfl_20260930T130708133Z_14da067c-55b3-4e1f-af9c-3abe09f10c1f` | baseline 20 requests, 2.00 RPS, p50/p95/p99 6.70/15.88/21.90 ms; normal 90 requests, 5.99 RPS, 13.64/28.11/34.60 ms; 0 errors; 110 traces, 4,622 PostgreSQL spans | P2 `database.repeated-operation`, HIGH confidence, likely N+1 pattern candidate. Severity and confidence were carried unchanged. |
| `GET /performance/slow-query` — `pfl_20260930T130808618Z_a3dbfdaf-35eb-4cca-941e-a74f9dc33ca5` | baseline 20 requests, p50/p95/p99 505.23/538.23/557.93 ms; normal 87 requests, 529.20/548.73/596.49 ms; 0 errors; 107 traces, 215 PostgreSQL spans | P1 `database.slow-operation`, HIGH confidence. No N+1 finding and no index recommendation. |
| `GET /performance/external-call` — `pfl_20260930T130916690Z_e8396595-f274-4e92-800c-d5b9c4d5346f` | baseline 14 requests, p50/p95/p99 756.98/761.77/766.12 ms; normal 60 requests, 758.08/761.64/763.07 ms; 0 errors; 74 traces, 0 PostgreSQL spans, 74 external HTTP spans | P1 `dependency.latency-dominance`, HIGH confidence. No database finding. |

The measured numbers above are read from the persisted run/profile artifacts and refer to the previous Phase 2/3 local acceptance runs. This reporting acceptance verified faithful presentation of those real values and findings; it did not generate new load. The path for every generated report set is `.perflens/runs/<run-id>/report/{report.json,report.md,report.html}`. Reporting fixtures also verified malformed/missing analysis rejection, format errors, a valid no-findings report, severity/confidence preservation, renderer escaping, common secret redaction, and deterministic semantic output.

Phase 4 checks: `pnpm install --frozen-lockfile` completed and its workspace postinstall build passed; `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm perflens --help`, `pnpm perflens --version`, `pnpm perflens report`, `docker compose config --quiet`, and `git diff --check` passed. No lint script is configured. The report command with no ID selected the latest eligible analyzed run and produced all three formats.

The current machine could not run `pnpm perflens doctor` or `pnpm perflens infra status`: Docker is installed, but its local daemon socket (`~/.orbstack/run/docker.sock`) was unreachable. `docker compose config --quiet` still validated successfully. The report acceptance therefore consumed the actual already-persisted local acceptance runs above; it did not start new containers or claim a fresh API/telemetry round trip during this pass. The stored evidence confirms the measurements and findings listed above, and report generation itself uses only those artifacts.

## Phase 5 — Express and generic Node integration

### Automated checks

`CI=1 pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `git diff --check`, and `docker compose --env-file .env.example config --quiet` passed. The complete workspace suite reported **81 tests passed**: 24 analysis-engine, 2 shared Node instrumentation, 41 CLI, 10 reporting, and 4 Express target/instrumentation tests. No lint script is configured. `pnpm perflens --help` and `pnpm perflens --version` passed and continued to list the same framework-neutral commands.

The Express tests exercise health, the clean bounded `/orders` query, the deterministic slow-query shape, the real HTTP dependency call, and a 21-call N+1 sequence (one order-list operation plus 20 identical item operations). A separate child Node process starts the SDK and `ExpressInstrumentation` before requiring Express, then exports spans through an in-memory processor. It observed a server span named `GET /performance/external-call` with `http.route=/performance/external-call`, `http.request.method=GET`, the supplied `perflens.audit.run_id` and `.profile=normal`, and resource attributes `service.name=perflens-test-express`, `service.version=9.8.7`, `deployment.environment=test`. The observed hierarchy was server span → Express request-handler span → HTTP client span; the HTTP client and server spans shared the same trace ID. This verifies route and correlation semantics against the installed instrumentation version without contacting a collector.

### Docker and live-stack limitation

Compose syntax validation passed, but live acceptance could not run. `pnpm perflens doctor` reported Docker installed, Compose available, local endpoint selected, and Compose configuration valid, then failed because the Docker daemon was unreachable. `pnpm perflens infra status` failed with permission denied on `unix:///Users/admin/.orbstack/run/docker.sock`. No fresh Compose build, PostgreSQL-backed Express run, Collector/Tempo export, k6 audit, Phase 3 analysis, Phase 4 report, or NestJS runtime regression is claimed in this verification. PostgreSQL span generation for `pg` and the real four-endpoint audit/report workflow still require rerun after the local daemon is available.

No remote target support or other framework/language integration was added. The only live local trace evidence in this pass is the in-memory HTTP/Express test above; it did not exercise PostgreSQL or Tempo.

### Phase 4 report security hardening — 2026-09-30

The normalized report model now redacts secret-bearing values while projecting artifacts into the safe model, before Markdown or HTML rendering. Regression coverage includes Bearer and Basic authorization headers, Cookie and Set-Cookie values, PostgreSQL/Postgres/Redis/Rediss URLs with credentials, HTTP/HTTPS username-password URLs, `api_key`, `access_token`, `password`, `secret`, and `token` query parameters, and SQL string literals containing email/token values. A `PERFLENS_TEST_SECRET_7f93a1` sentinel placed across run metadata, profile workload/metrics, finding evidence/metrics, and database/dependency values is asserted absent from the serialized model (the `report.json` content), Markdown, and HTML.

HTML injection fixtures cover script/img tags, event handlers, quotes, angle brackets, and ampersands; tests assert they render as escaped text. Markdown fixtures cover table delimiters, newlines, headings, raw HTML, and link-like input; tests assert they cannot inject a row or heading or become a link. Finding preservation tests compare `ruleId`, severity, confidence, evidence, and metrics with Phase 3 inputs to ensure reporting does not reinterpret them.

Final hardening commands: `CI=1 pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm -r --if-present run lint`, `pnpm test`, and `git diff --check` all passed. **75 tests passed**: 24 analysis-engine, 41 CLI, and 10 reporting. The repository has no lint script, so lint was not added or run. Docker remained unavailable as noted above; no fresh Docker acceptance is claimed by this hardening pass.

## Phase 5 live acceptance — 2026-10-01

Docker/Compose was available for this pass. The existing observability stack was started with `pnpm perflens infra up`; the Express reference target was built and started with its PostgreSQL dependency, and `/health` returned `{"status":"ok","database":"up"}`. Four fresh Express audits used only `http://localhost:3003`, with baseline (1 configured VU, 10 seconds, 500 ms pacing) and normal (3 configured VUs, 15 seconds, 500 ms pacing). Each completed profile had zero failed requests. These are observations from the persisted run artifacts, not benchmark guarantees.

| Express endpoint / run ID | Baseline: requests; RPS; p50/p95/p99 ms | Normal: requests; RPS; p50/p95/p99 ms | Errors; correlated traces; PostgreSQL / external HTTP spans | Phase 3 findings |
| --- | --- | --- | --- | --- |
| `GET /orders` — `pfl_20261001T055203528Z_c3d352e0-c1bf-471b-b325-63c027f9d84a` | 20; 1.9951; 3.698 / 8.64485 / 10.66417 | 90; 5.9969; 4.8865 / 9.47135 / 13.11891 | 0/20 and 0/90 failed (0%); 110 traces; 222 / 0 spans | None; no severe finding was fabricated. |
| `GET /performance/n-plus-one` — `pfl_20261001T055323526Z_4e575518-5057-4753-a6ed-1482ae95b4bc` | 20; 1.9964; 7.644 / 10.71805 / 11.95001 | 90; 5.9957; 11.1625 / 19.52015 / 20.34632 | 0/20 and 0/90 failed (0%); 110 traces; 4,622 / 0 spans | P2 / HIGH, `database.repeated-operation`; median 21 DB operations/request, repeated pattern in 20/20 baseline and 90/90 normal traces. Median DB interval contribution 37.2% (2.3 ms) baseline and 51.9% (5.0 ms) normal. Material-impact guard met in 0/20 and 0/90; no severe impact claim. |
| `GET /performance/slow-query` — `pfl_20261001T055415962Z_579a9fd5-16c9-4080-b58e-15dcd73f8b4d` | 19; 1.8291; 522.72 / 653.0981 / 657.85802 | 81; 5.3793; 539.788 / 641.447 / 655.6386 | 0/19 and 0/81 failed (0%); 97 traces; 195 / 0 spans | P1 / HIGH, `database.slow-operation`; equivalent operation observed 19 baseline times (median 521.2 ms, p95 657.8 ms) and 78 normal times (median 542.4 ms, p95 642.3 ms). No N+1 or external finding. |
| `GET /performance/external-call` — `pfl_20261001T055511247Z_96bab56b-30f2-4625-bc78-222a4e1b2d05` | 14; 1.3241; 754.2035 / 757.3697 / 758.72274 | 60; 3.9618; 756.3255 / 761.4301 / 762.18887 | 0/14 and 0/60 failed (0%); 74 traces; 0 / 74 spans | P1 / HIGH, `dependency.latency-dominance`; request-level dependency median contribution 751.8 ms / 99.9% baseline and 753.7 ms / 99.9% normal. No DB finding. |

Tempo traces for these exact run IDs showed `service.name=perflens-express-demo-api`, `service.version=0.1.0`, `deployment.environment=local`, stable `http.route` matching the endpoint, and `perflens.audit.run_id` / `perflens.audit.profile`. Sampled `/orders` and slow-query traces had PostgreSQL descendants; N+1 traces had repeated PostgreSQL spans under the Express handler; external-call traces had an HTTP client span under the handler and its simulator server span in the same trace. The spans and parent/child relationships were checked in returned Tempo trace data. Prometheus returned `up{job="express-demo-api"}=1` and `sum(perflens_http_requests_total{job="express-demo-api"})=398`. Tempo `/ready` and Grafana `/api/health` returned ready/healthy.

All four Express report sets exist at `/tmp/perflens-express-acceptance/.perflens/runs/<run-id>/report/{report.json,report.md,report.html}` for the run IDs above. Report JSON retained Phase 3 rule ID, severity, and confidence. `/orders` produced a valid zero-finding report.

### Fresh NestJS regression

After Express verification, the NestJS target was rebuilt and force-recreated from the current repository. Its health check reported the database up. A new baseline/normal audit targeted `GET /orders` at `http://localhost:3002`:

| Run ID | Baseline: requests; RPS; p50/p95/p99 ms | Normal: requests; RPS; p50/p95/p99 ms | Failures and telemetry |
| --- | --- | --- | --- |
| `pfl_20261001T060415440Z_f59a02d9-4d6e-409e-bdcd-539e7d995d3e` | 20; 2.00; 3.45 / 5.96 / 6.39 | 90; 5.99; 5.83 / 27.21 / 40.13 | 0 errors in both profiles; 110 correlated traces, 222 PostgreSQL spans, 0 external HTTP spans. No findings met evidence/sample-size thresholds. |

The run was analyzed and reported after the live Tempo query. Its report has zero findings and all three files at `/tmp/perflens-nest-acceptance/.perflens/runs/pfl_20261001T060415440Z_f59a02d9-4d6e-409e-bdcd-539e7d995d3e/report/{report.json,report.md,report.html}`. The analysis confirms trace correlation and PostgreSQL evidence. No further NestJS span-attribute claim is made here.

### Commands and outcomes

`CI=1 pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `docker compose --env-file .env.example config --quiet`, and `git diff --check` passed. The suite reported **81 passing tests**: 24 analysis-engine, 2 shared Node instrumentation, 41 CLI, 10 reporting, and 4 Express target/instrumentation. No lint script is configured. Express Compose build/start, health, Tempo trace retrieval, Prometheus scrape/query, Grafana health, audits, analysis, reports, and the fresh NestJS audit/analysis/report were executed. No remote, staging, or production target was used; no rules or thresholds were changed.

## Phase 6 — packed consumer audit acceptance — 2026-10-02

The CLI was packed from `packages/cli` as `perflens-cli-0.1.0.tgz` (70.9 kB, 35 files) and installed with npm in `/tmp/perflens-phase6-live-consumer`, outside this repository. The tarball contained the executable, bundled CLI, generic Node and Express instrumentation entrypoints, type declarations, k6 script, and package-owned Compose/Collector/Tempo/Prometheus/Grafana assets. It did not require workspace links and contained no `.env`, run evidence, test output, or source tree. The install command was `npm install /tmp/perflens-phase6-pack-final/perflens-cli-0.1.0.tgz express@5.2.1 pg@8.23.0 @prometheus-io/client@0.16.1`. The install reported zero vulnerabilities. `npx perflens --help`, `--version` (`0.1.0`), `init`, repeated `init`, and `doctor` were exercised in the external project. Init detected Express and preserved the existing config on the second invocation.

The consumer used package-provided infrastructure and project-specific ports: Grafana `http://127.0.0.1:3004`, Prometheus `http://127.0.0.1:9091`, Tempo query API `http://127.0.0.1:3201`, and OTLP HTTP `http://127.0.0.1:4318/v1/traces`. Its Express target ran at `http://localhost:3100` with a separate temporary PostgreSQL container on loopback port 55432. The audit configuration used constant-VU profiles: baseline 1 VU for 10 seconds, normal 3 VUs for 15 seconds, 500 ms pacing per VU, and a 5-second request timeout. All four traced route audits completed with zero failed HTTP requests. Values below are read from persisted profile JSON and are workstation observations, not guarantees.

| Consumer endpoint / run ID | Baseline: requests, RPS, p50/p95/p99 ms | Normal: requests, RPS, p50/p95/p99 ms | Correlated request traces; PostgreSQL / external HTTP spans | Actual findings |
| --- | --- | --- | --- | --- |
| `GET /orders` — `pfl_20261001T193545321Z_5074d02e-cb3f-4e7d-86b3-4616b75c33b2` | 20; 1.9974; 2.841 / 6.0303 / 6.2325 | 90; 5.9965; 3.864 / 10.0415 / 13.7331 | 20 request traces; 40 / 0 spans | No findings. No severe bottleneck was fabricated. |
| `GET /performance/n-plus-one` — `pfl_20261001T193738030Z_400c4369-d1f3-43a7-b69d-34c068a5b0b0` | 20; 1.9965; 15.634 / 29.2468 / 43.8510 | 90; 5.9974; 18.5445 / 25.8771 / 31.4927 | 65 request traces; 2,732 / 0 spans | P2 / HIGH, `database.repeated-operation`; median 21 DB operations/request and repeated-operation pattern in 20/20 sampled baseline traces. |
| `GET /performance/slow-query` — `pfl_20261001T193857465Z_687201ed-7523-4ea5-9cf7-d4608087aa96` | 19; 1.8510; 535.071 / 579.5801 / 589.2648 | 87; 5.6105; 526.332 / 595.9752 / 648.2659 | 43 request traces; 88 / 0 spans | P1 / HIGH, `database.slow-operation`; equivalent operation median duration 534.5 ms baseline and 517.2 ms normal. No N+1 finding. |
| `GET /performance/external-call` — `pfl_20261001T193958620Z_49a03f48-63eb-4204-b8fe-e4b7fa218d4d` | 14; 1.3252; 753.486 / 757.3967 / 758.6753 | 60; 3.9763; 754.382 / 755.7735 / 757.4358 | 29 request traces; 0 / 29 spans | P1 / MEDIUM, `dependency.latency-dominance`; dependency intervals contributed median 752.0 ms (99.9% of request windows) across 14/14 sampled baseline requests. No DB finding. |

For each successful run the CLI generated `report/report.json`, `report/report.md`, and `report/report.html` in that run directory. For example, the N+1 HTML report is `/tmp/perflens-phase6-live-consumer/.perflens/runs/pfl_20261001T193738030Z_400c4369-d1f3-43a7-b69d-34c068a5b0b0/report/report.html`. Reports carried Phase 3 findings unchanged. The earlier `/health` attempt (`pfl_20261001T193438484Z_9c67d352-3abf-4014-9e4f-1c59df0380cf`) measured 20 baseline and 90 normal requests but correctly failed analysis: `/health` is intentionally excluded from server request spans. It did not claim a full successful audit or produce a report. Init now warns that `/health` and `/metrics` are excluded so users select a representative application endpoint.

### Live telemetry and dashboard checks

Tempo returned real Express traces with `service.name=phase6-consumer-express`, `service.version=0.1.0`, and `deployment.environment=local`. A trace from the external-call run was named `GET /performance/external-call`; its root HTTP server span contained `http.route=/performance/external-call`, method `GET`, and the exact audit run ID/profile attributes. The HTTP client span was a child of the Express handler, and the local simulated dependency server span was beneath the client span in the same trace. A real N+1 trace carried its run/profile attributes and stable route, with repeated PostgreSQL query spans descended from the Express route. Slow-query traces had PostgreSQL spans and no external client spans.

The provisioned dashboard loaded from Grafana `/api/dashboards/uid/perflens-performance` with three panels: request rate, 4xx/5xx request rate, and histogram p50/p95/p99. Prometheus returned `up{job="perflens-target"}=1`; `/api/targets` showed an empty scrape error. The scraped `perflens_http_requests_total` samples included 111 `/orders`, 111 N+1, 107 slow-query, and 75 external-call requests at query time. The dashboard p95 query returned 0.9594 seconds over its broad five-minute histogram window at query time; this is a live aggregate, not a per-run result. Grafana provisioning and Prometheus query data were verified through their APIs; browser rendering was not automated.

`perflens audit` reused healthy package-owned infrastructure. The first sandboxed Docker invocation was denied access to the local Docker socket; rerunning with authorized local Docker access succeeded. No volumes or unrelated containers were removed. This Phase 6 pass did not run a fresh NestJS runtime regression; the previous Phase 5 NestJS live acceptance above remains the latest NestJS evidence. No remote target was used.

### Phase 6 repository quality results

`CI=1 pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `docker compose --env-file .env.example config --quiet`, and `git diff --check` passed. The full `pnpm test` suite passed with **87 tests**: 24 analysis-engine, 2 Node instrumentation, 46 CLI, 11 reporting, and 4 Express app/instrumentation tests. The CI run for commit `8b348f9` failed in the CLI orchestration tests because `installInfrastructureAssets` created `.perflens/infra` before calling `fs.cp` with `errorOnExist: true`; Node 24 correctly raised `EEXIST` for that destination. Setup now creates only the parent directory before copying and restores restrictive directory permissions afterward. The exact Node 24.21.0 full suite now passes. The initial sandboxed test attempt separately failed because Express integration tests bind loopback (`listen EPERM`); the authorized local run passed all 87 tests. No lint script is configured. `pnpm perflens --help`, `pnpm perflens --version`, and from the packed external install `npx perflens doctor` plus `npx perflens infra status` passed. Doctor confirmed k6 2.3.x, Docker/Compose, packaged assets, Compose config, and all six assigned ports; all four infrastructure services reported ready.

### Phase 6 OTLP endpoint hand-off hardening — 2026-10-02

The project-local `.perflens/infra/.env` `OTLP_HTTP_PORT` is now authoritative. `perflens init`, `doctor`, `infra up`, `infra status`, and audit output use the same derived traces URL. PerfLens's Node bootstrap reads that selected port before constructing the OTLP exporter and sets the standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`; a conflicting explicit traces endpoint fails with the correct remediation URL. Port-probe failures other than `EADDRINUSE` now fail closed rather than being mistaken for available ports.

Unit coverage verifies default port 4318, occupied 4318 selecting 4319, selected endpoint output and instrumentation config, conflicting endpoint rejection, and audit remediation using the selected endpoint. The orchestration tests inject a project infrastructure resolver so they do not rely on unprivileged sandbox socket binding. `pnpm test` passed **91 tests**: 24 analysis-engine, 4 Node instrumentation, 48 CLI, 11 reporting, and 4 Express app/instrumentation tests. `CI=1 pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `docker compose --env-file .env.example config --quiet`, and `git diff --check` passed. The test suite required loopback access because the sandbox returns `EPERM` for bind probes; the authorized test run passed. No lint script is configured.

Packed consumer acceptance used `/tmp/perflens-phase6-live-consumer` and a packed `@perflens/cli` tarball. A local listener intentionally occupied 4318. `npx perflens init` selected 4319 and printed `http://127.0.0.1:4319/v1/traces`; `doctor` and `infra up` printed the same URL, and Compose mapped host 4319 to Collector 4318. The consumer Express process had no traces-specific override and was deliberately given the generic `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`; the PerfLens bootstrap selected the traces-specific 4319 endpoint, and the audit completed with correlated Tempo traces. This confirms the exported traces reached the selected Collector rather than relying on the occupied default port.

Actual audit: run `pfl_20261001T204812519Z_1d06fc32-092b-42b9-82bc-7527260f1f15`, target `GET /performance/external-call`. Baseline recorded 14 requests, 0 failed, 1.33 RPS, p50/p95/p99 752.91/753.70/754.11 ms. Normal recorded 60 requests, 0 failed, 3.98 RPS, p50/p95/p99 753.15/754.91/757.88 ms. The CLI/analyzer collected 29 correlated request traces, 0 PostgreSQL spans, and 29 external HTTP spans. Phase 3 emitted P1 / MEDIUM `dependency.latency-dominance`; measured dependency contribution was a 751.9 ms median (99.9%) across 14/14 sampled baseline requests. `analyze` and `report` both succeeded; report artifacts were written under `/tmp/perflens-phase6-live-consumer/.perflens/runs/pfl_20261001T204812519Z_1d06fc32-092b-42b9-82bc-7527260f1f15/report/`.

Tempo's search API returned traces for that exact run ID with root service `phase6-consumer-express` and root span `GET /performance/external-call`. The receiving Collector was the Compose service published at host port 4319. No fresh NestJS acceptance was part of this endpoint-specific hardening pass. The local alternate-port stack remains available for inspection; no remote target was used.

## Phase 6.1 — first-audit onboarding verification — 2026-10-02

The packed CLI was installed in `/tmp/perflens-phase61-packed-d`, an external Express consumer outside the PerfLens repository. Port 4318 was occupied by a local Python listener (`127.0.0.1:4318`). No manual `perflens init` was run in this consumer: the first command was `npx perflens audit`. It asked for the target URL and representative endpoint, detected Express from `package.json`, created `perflens.config.json` and `.perflens/`, and made no application-source or dependency changes. It selected `OTLP_HTTP_PORT=4329` and surfaced `http://127.0.0.1:4329/v1/traces`; the app's package-provided Node instrumentation resolved that project-local endpoint. A correlated-trace preflight succeeded before k6 began.

The consumer API was `http://localhost:3406`, backed by the temporary local PostgreSQL instance on port 55433. The target was `GET /performance/n-plus-one`. The existing bounded constant-VU profiles ran unchanged: baseline 1 VU for 10 seconds with 500 ms pacing, then normal 3 VUs for 15 seconds with 500 ms pacing. The persisted normal result recorded a maximum of 3 simultaneous in-flight requests, confirming actual concurrency.

| First automatic audit | Requests / failures | RPS | p50 / p95 / p99 (ms) | Duration |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 20 / 0 | 1.9964 | 8.9935 / 43.9249 / 48.6354 | 10,018 ms |
| Normal | 90 / 0 | 5.9963 | 9.858 / 19.2753 / 27.833 | 15,009 ms |

Run `pfl_20261002T080311754Z_6cd192b5-7e3a-418e-bbd6-f62fca31d08f` completed. PerfLens correlated 44 request traces (20 baseline, 24 sampled normal), with 1,851 PostgreSQL spans and 0 external HTTP spans. Phase 3 produced one P2 / HIGH `database.repeated-operation` finding for `GET /performance/n-plus-one`: 21 median database operations per sampled request and a repeated pattern in 20/20 baseline traces and 24/24 sampled normal traces. The analysis recorded median DB interval contributions of 3.286 ms baseline and 4.696 ms normal; no material-impact threshold was met. No severe latency-impact claim was made. The report files exist at `/tmp/perflens-phase61-packed-d/.perflens/runs/pfl_20261002T080311754Z_6cd192b5-7e3a-418e-bbd6-f62fca31d08f/report/report.{json,md,html}`.

An immediate second `npx perflens audit` did not repeat onboarding, preserved the configuration, reused the healthy infrastructure and endpoint `http://127.0.0.1:4329/v1/traces`, and created a new immutable run `pfl_20261002T080402469Z_9bf12c91-0d96-4f4d-be61-5451fc5b6d11`. Baseline recorded 20 requests, 0 failures, 1.9941 RPS, and p50/p95/p99 of 7.964 / 12.3797 / 13.5303 ms. Normal recorded 90 requests, 0 failures, 5.9962 RPS, and p50/p95/p99 of 9.108 / 29.3255 / 32.2102 ms; `maxObservedInFlight` was 3. It produced the same P2 / HIGH `database.repeated-operation` finding, with 21 median DB operations/request. Its report files exist at `/tmp/perflens-phase61-packed-d/.perflens/runs/pfl_20261002T080402469Z_9bf12c91-0d96-4f4d-be61-5451fc5b6d11/report/report.{json,md,html}`. All first-run profile evidence and report files remained present after the second audit.

The existing explicit `perflens init` path was also exercised twice in `/tmp/perflens-phase61-explicit-init`: the first call created configuration and working directories without changing application files; the second preserved the existing config and reported the selected project OTLP endpoint. Its first sandboxed repeat attempt could not bind a loopback port (`EPERM`); rerunning with local socket permission completed successfully.

### Phase 6.1 quality results

`CI=1 pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `docker compose --env-file .env.example config --quiet`, and `git diff --check` completed successfully. The test suite reported **99 passing tests**: 24 analysis-engine, 5 Node instrumentation, 55 CLI, 11 reporting, and 4 Express app/instrumentation tests. The first sandboxed test attempt failed two CLI cases because local port probes were denied with `listen EPERM`; the authorized rerun passed all 99. No lint script is configured. The external first-audit and repeat-audit runs used the packed CLI tarball and required no workspace links. No Phase 7 functionality was added.

## Phase 6.2 — Consumer UX and multi-endpoint hardening — 2026-10-02

### External packed consumer run

The current CLI package tarball was installed with npm in `/tmp/perflens-phase62-consumer`, outside the PerfLens monorepo. The Express consumer and PostgreSQL target were independent of workspace packages; application instrumentation was loaded before the Express app. Port 4318 was intentionally occupied by a Python listener on `127.0.0.1:4318` (PID 79544), and PerfLens selected `http://127.0.0.1:4331/v1/traces`. Infrastructure was started automatically, then reused on later audits. The consumer configuration referenced `${PERFLENS_TEST_TOKEN}`; the value `PERFLENS_TEST_SECRET_7f93a1` was provided only in the process environment.

The first command was `npx --no-install perflens audit`; `init`, `doctor`, and `infra up` were not invoked manually. The user selected two GET routes and approved them. The unauthenticated `GET /api/audit-logs` returned HTTP 401. Audit stopped before load, reported load not started, analysis not run, and report not generated; that failed run contains configuration, run state, and telemetry metadata only, with no profile results or report. This is the expected safe behavior for missing auth.

With `PERFLENS_TEST_TOKEN` set to the sentinel and `target.headers.Authorization` configured as `Bearer ${PERFLENS_TEST_TOKEN}`, a second audit completed for `/api/orders` and `/api/audit-logs`:

| Profile | Requests | Failed | RPS | Error rate | p50 / p95 / p99 (ms) | Duration | Observed in-flight |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| baseline | 20 | 0 | 1.9964 | 0% | 3.29 / 9.74 / 11.72 | 10,018 ms | 1 |
| normal | 90 | 0 | 5.9939 | 0% | 3.04 / 12.74 / 27.68 | 15,009 ms | 3 |

That run correlated 23 request traces and 48 PostgreSQL spans, had no external client spans because no external-call route was selected, and produced no Phase 3 findings for these routes. The three report formats were generated. Configuration retained the env reference, not the secret.

A further audit selected `/api/orders`, `/api/audit-logs`, and `/api/dependency`; PerfLens showed all three GET endpoints plus baseline/normal profiles and waited for explicit approval before running k6. It reused infrastructure and the selected OTLP port. Run ID: `pfl_20261002T174405892Z_8e641def-142f-473e-97c6-044e22729e65`.

| Profile | Requests | Failed | RPS | Error rate | p50 / p95 / p99 (ms) | Duration | Observed in-flight |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| baseline | 20 | 0 | 1.9964 | 0% | 3.8365 / 42.9608 / 43.4746 | 10,018 ms | 1 |
| normal | 90 | 0 | 5.9977 | 0% | 3.4395 / 43.7354 / 45.3084 | 15,006 ms | 3 |

Per-endpoint normal-profile results were measured from the raw k6 sample stream:

| Endpoint | Requests | RPS | Error rate | p50 / p95 / p99 (ms) | Status |
| --- | ---: | ---: | ---: | --- | --- |
| `GET /api/orders` | 30 | 1.9992 | 0% | 2.855 / 6.715 / 8.0032 | 30 × 200 |
| `GET /api/audit-logs` | 30 | 1.9992 | 0% | 2.787 / 7.4303 / 8.5216 | 30 × 200 |
| `GET /api/dependency` | 30 | 1.9992 | 0% | 43.3185 / 44.528 / 48.9762 | 30 × 200 |

Telemetry analysis for that run found 23 correlated request traces, 34 PostgreSQL spans, and 7 external HTTP client spans. Phase 3 emitted no findings; no DB or dependency diagnosis was invented. The report's endpoint comparison lists each route/profile independently, and the profile evidence records a maximum of 3 simultaneous in-flight requests. Output files are `/tmp/perflens-phase62-consumer/.perflens/runs/pfl_20261002T174405892Z_8e641def-142f-473e-97c6-044e22729e65/report/report.json`, `report.md`, and `report.html`.

The successful report includes endpoint-scoped measured samples, status counts, request count, RPS, error rate, and latency percentiles. Its top-level report target metadata uses the first configured endpoint; the endpoint-comparison section contains all selected endpoints. The three-endpoint run did not include the intentional N+1 or slow-query routes, so their findings were not tested in this consumer run. The dependency route did produce seven correlated client spans, but Phase 3 thresholds were not met and no dependency finding was emitted.

Secret scan: recursive `rg` over the consumer `.perflens/` tree and config found no `PERFLENS_TEST_SECRET_7f93a1` occurrences. The stored config contains the env placeholder only. The failed 401 run has no report; the successful report run has all three expected report files. Grafana and Prometheus URLs printed from this run were `http://127.0.0.1:3010` and `http://127.0.0.1:9097`; Tempo navigation used the verified run ID filter in Grafana Explore. Port 4318 remained occupied during these runs.

The Express process ran on the host and used a Docker PostgreSQL container. This verification did not claim that an app running inside Docker can reach the loopback-bound OTLP receiver; the integration guide now explains the container/host networking distinction and that PerfLens does not rewrite consumer Compose files.

The persisted correlated Tempo snapshot contains 94 spans across 23 traces. In an observed baseline `/api/dependency` trace, the root server span was `GET /api/dependency` with route `/api/dependency`, `profile=baseline`, and the exact run ID. Its `GET` HTTP client span had the root's internal handler span as parent; the simulated dependency server span `GET /:segment` was a child of that client span in the same trace. The request trace also contained PostgreSQL client spans on DB-backed endpoints. Trace attributes were sanitized before persistence, and the sentinel secret was absent. Grafana `/api/health` returned database `ok` (Grafana 13.2.2); Tempo `/ready` returned `ready`. A Prometheus query for `up` returned `up{job="prometheus"}=1`; its consumer target `up{job="perflens-target",instance="host.docker.internal:3412"}=0` because this external demo app did not expose the documented `/metrics` scrape endpoint. Therefore this acceptance verified Grafana/Tempo availability and trace evidence, but did not claim populated consumer metrics panels.

The package's final packed artifact was recreated at `/tmp/perflens-phase62-pack-final/perflens-cli-0.1.0.tgz`: 84,623 bytes and 36 tar entries, including compiled CLI code, package metadata, generic Node/Express instrumentation, the k6 script, and packaged infrastructure templates. It contains no consumer run data or `.env` secrets. The external project was refreshed from a project-local tarball path with `npm install --offline --cache /tmp/perflens-phase62-npm-cache -D ./vendor/perflens-cli-0.1.0.tgz`; its package manifest and lockfile refer to `file:vendor/perflens-cli-0.1.0.tgz`, not a host `/tmp` path. `npx --no-install perflens --help` and `--version` worked there (`0.1.0`). The dogfood-only `vendor/` tarball is not part of the published install workflow.

### Phase 6.2 quality results

`CI=1 pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm typecheck` passed. The full test suite passed **106 tests**: 24 analysis-engine, 5 Node instrumentation, 61 CLI, 12 reporting, and 4 Express integration tests. One initial new report assertion expected the wrong fixture title; the report correctly carried the fixture's existing repeated-query finding, the assertion was corrected to verify that title, and all 12 reporting tests then passed. A failure-path regression also verifies that an HTTP 500 mentioned in a failed k6 execution is reported as load failure, not incorrectly labeled a preflight failure. `docker compose --env-file .env.example config --quiet` and `git diff --check` passed. No root lint script is configured. The first registry install attempt in the sandbox failed DNS resolution; the frozen-lockfile install was rerun with approved registry access and passed. The sandboxed test rerun denied local port probes (`listen EPERM`); the complete suite passed on the authorized loopback-enabled rerun.

The 4318-occupied acceptance used a listener observed on `127.0.0.1:4318`; the project's `.perflens/infra/.env` selected OTLP HTTP 4331 and the audit/metadata/instrumentation agreed on `http://127.0.0.1:4331/v1/traces`. The separate default-port unit case remains covered by the CLI suite. An explicit authenticated target preflight and k6 run succeeded, while the unauthenticated 401 path failed before load and left no report. No remote target was used.

## Phase 6.2 route and multi-endpoint isolation verification — 2026-10-03

Express route discovery remains an honest manual fallback. The CLI prompt no longer describes manual path entry as “recommended” discovery: it asks for one known GET path or multiple known safe GET paths and explicitly says PerfLens does not inspect the already-running Express router. Health and metrics routes remain excluded. The integration guide and README describe this limitation.

For live isolation verification, the repository Express reference app and its real PostgreSQL schema/data were used with an isolated local database and a local delayed HTTP dependency. One multi-endpoint audit selected `GET /orders`, `GET /performance/n-plus-one`, `GET /performance/slow-query`, and `GET /performance/external-call`; no separate endpoint audits or changes to analysis thresholds were used. The run was `pfl_20261002T184919953Z_4024eb49-ce39-44a2-8add-76a0ac9e4627`. Baseline used 1 VU for 20 seconds; normal used 3 VUs for 30 seconds. Normal recorded a maximum of 3 in-flight requests. Baseline recorded 35 requests at 1.71 RPS, p50/p95/p99 27.92/752.77/753.23 ms; normal recorded 157 requests at 5.15 RPS, p50/p95/p99 39.16/752.35/767.80 ms. Both profiles had 0 failures and 0% error rate.

The endpoint-specific k6 samples were:

| Endpoint | Profile | Requests | RPS | Errors | p50 / p95 / p99 (ms) |
| --- | --- | ---: | ---: | ---: | --- |
| `GET /orders` | baseline | 9 | 0.4408 | 0 (0%) | 2.152 / 11.6946 / 11.79572 |
| `GET /orders` | normal | 40 | 1.3123 | 0 (0%) | 1.4585 / 2.5584 / 4.96243 |
| `GET /performance/n-plus-one` | baseline | 9 | 0.4408 | 0 (0%) | 18.14 / 25.7514 / 27.48708 |
| `GET /performance/n-plus-one` | normal | 39 | 1.2795 | 0 (0%) | 6.04 / 12.5922 / 30.8999 |
| `GET /performance/slow-query` | baseline | 9 | 0.4408 | 0 (0%) | 597.271 / 676.1422 / 702.34604 |
| `GET /performance/slow-query` | normal | 39 | 1.2795 | 0 (0%) | 552.915 / 616.9942 / 953.55828 |
| `GET /performance/external-call` | baseline | 8 | 0.3918 | 0 (0%) | 752.324 / 753.2262 / 753.30684 |
| `GET /performance/external-call` | normal | 39 | 1.2795 | 0 (0%) | 751.785 / 753.4776 / 764.59004 |

The persisted Tempo snapshot had 144 correlated request traces, 1,703 PostgreSQL spans, and 34 external HTTP client spans. Grouping root server spans by `http.route` and their trace IDs showed: `/orders` 37 traces / 37 query spans / 0 external spans; `/performance/n-plus-one` 37 / 777 / 0; `/performance/slow-query` 36 / 36 / 0; `/performance/external-call` 34 / 0 / 34. The same run ID and baseline/normal profile attributes were present on the corresponding root spans. Each finding’s sampled trace IDs mapped only to root spans with that finding’s target route.

Phase 3 emitted exactly three findings: P2 / HIGH `database.repeated-operation` targeted `/performance/n-plus-one` (21 median DB operations/request; repeated pattern in 9/9 baseline and 28/28 normal samples; median interval-union DB contribution 11.88 ms baseline and 1.68 ms normal, so the finding describes a pattern, not a major impact); P1 / HIGH `database.slow-operation` targeted `/performance/slow-query` (9 baseline and 27 normal slow-operation spans, median 596.27 ms and 548.63 ms respectively); and P1 / HIGH `dependency.latency-dominance` targeted `/performance/external-call` (request-level median contribution 751.62 ms / 99.9% baseline and 751.02 ms / 99.9% normal). No finding targeted `/orders`. The slow-query route produced one query operation/request and no repeated-operation finding. The external-call route produced no PostgreSQL spans and no DB finding. Findings and evidence did not leak to the other routes.

The generated report exists at `.perflens/runs/pfl_20261002T184919953Z_4024eb49-ce39-44a2-8add-76a0ac9e4627/report/report.json`, `report.md`, and `report.html` (report model version 2). The report endpoint comparison rendered independent baseline and normal rows for all four routes with each route's own request count, RPS, error rate, p50/p95/p99, run-correlated request trace count, PostgreSQL span count, external HTTP span count, and associated finding (or `None` for `/orders`). The persisted endpoint evidence counts were `/orders`: 37 traces / 75 PostgreSQL spans / 0 HTTP client spans; N+1: 37 / 1,555 / 0; slow-query: 36 / 73 / 0; external-call: 34 / 0 / 34. Detailed finding cards included only the evidence and target path belonging to that finding. A reporting regression test now asserts this separation across all four endpoint rows and three endpoint-specific findings; an analysis regression test also asserts DB rule targets and evidence trace IDs remain route-scoped.

`pnpm --filter @perflens/reporting test` passed 13 tests and `pnpm --filter @perflens/analysis-engine test` passed 25 tests after these changes. Full workspace quality checks are recorded below after completion. This live acceptance used the existing local infrastructure with OTLP endpoint `http://127.0.0.1:4333/v1/traces`; it did not use a remote target or modify rule thresholds.

### Phase 6.2.1 quality results

`pnpm build` and `pnpm typecheck` passed. `pnpm test` passed **108 tests** across the workspace: 25 analysis-engine, 5 Node instrumentation, 61 CLI, 13 reporting, and 4 Express tests. The initial sandboxed `pnpm test` attempt failed only the two CLI loopback port-probe tests with `listen EPERM`; the full rerun with local socket access passed. `git diff --check` passed. No lint script is configured.

## Phase 6.2 stale-infrastructure recovery and endpoint reselection — 2026-10-04

The rebuilt `@perflens/cli@0.1.0` tarball (`/private/tmp/perflens-6-2-pack/perflens-cli-0.1.0.tgz`; 88.3 kB packed, 350.6 kB unpacked, 36 files) was installed into `/private/tmp/perflens-62-consumer`, outside the repository and without workspace links. Its temporary Express target ran on the host at `http://localhost:38471`; it was not Dockerized. No `perflens init`, `doctor`, or `infra up` command was used for the audit workflow.

The initialized consumer had project-scoped ports `3003, 9098, 3208, 4332, 4333, 13140`. Its four containers were stopped, and a separate healthy Compose project was started on those same ports. On the next `npx --no-install perflens audit`, PerfLens did not print “already ready”; it detected the current project as unavailable, recreated only its own services, and allocated `3011, 9099, 3209, 4334, 4335, 13141` for Grafana, Prometheus, Tempo, OTLP gRPC, OTLP HTTP, and Collector health respectively. The unrelated stack remained healthy on its original ports. Collector, Tempo, Prometheus, and Grafana readiness checks passed before target preflight.

Endpoint reselection was exercised in the CLI: the saved `GET /api/orders` target was changed for one audit to `GET /api/products`; the CLI displayed the new endpoint and required an explicit `y` before load. The run plan recorded `/api/products`, while `perflens.config.json` remained unchanged with `/api/orders`. Run `pfl_20261004T174442442Z_61d68d6e-18b3-47b4-a5c8-747fb79aa111` completed with baseline 20 requests, 2.00 RPS, p50/p95/p99 1.11/3.40/18.41 ms, and normal 90 requests, 5.99 RPS, p50/p95/p99 0.77/1.90/3.24 ms; both had zero failures. The report files are `report.json`, `report.md`, and `report.html` under `/private/tmp/perflens-62-consumer/.perflens/runs/pfl_20261004T174442442Z_61d68d6e-18b3-47b4-a5c8-747fb79aa111/report/`.

A second stale-port rotation checked that an already-running instrumented consumer follows reallocated OTLP configuration. The unrelated stack occupied the consumer's current `3012, 9100, 3210, 4336, 4337, 13142` ports; recovery moved the consumer to `3013, 9101, 3211, 4338, 4339, 13143`. The external instrumentation exported a correlated preflight trace to `http://127.0.0.1:4339/v1/traces`, and the recovered Tempo at port `3211` returned run `pfl_20261004T175138286Z_3743fdde-8cc8-4849-8076-373705701b50` with service `perflens-62-consumer`, profile `preflight`, and the matching run ID. That audit completed with baseline 20 requests (2.00 RPS, p50/p95/p99 0.94/2.01/2.14 ms) and normal 90 requests (6.00 RPS, p50/p95/p99 0.95/2.13/6.36 ms), zero failures, and 23 request traces. Its report files exist under `.perflens/runs/pfl_20261004T175138286Z_3743fdde-8cc8-4849-8076-373705701b50/report/`.

The first live telemetry probe used a temporary app service name that did not match the project config; PerfLens stopped before load and correctly reported that correlated telemetry was missing. After aligning `service.name`, subsequent baseline/normal audits passed. This is recorded as a test setup correction; no measurements from the failed probe are presented as a completed audit. Dockerized-consumer OTLP networking was not tested in this acceptance.

### Phase 6.2 hardening quality results — 2026-10-04

`pnpm build`, `pnpm typecheck`, the full workspace test suite, and `git diff --check` passed. The final suite passed **115 tests**: 25 analysis-engine, 6 Node instrumentation, 67 CLI, 13 reporting, and 4 Express integration tests. The added regressions cover current-project identity, missing/stopped/partial/unrelated stacks, stale-port reallocation, healthy stack reuse, endpoint reselection, and explicit approval for a changed single endpoint. No lint script is configured.

## Phase 6.2 Dockerized consumer OTLP hardening — 2026-10-05

The external package was built with `npm pack` from `packages/cli` as `/private/tmp/perflens-phase62-docker-pack/perflens-cli-0.1.0.tgz` (89,633 bytes, 36 package entries) and installed into two projects outside the workspace. Both installations came from the tarball and have no workspace links. The external Docker consumer used `perflens-62-docker-api`, host target port `38471`, service name `perflens-docker-consumer`, and a Node 22 Alpine image containing Express and the packed CLI. The active local engine was macOS arm64 OrbStack (`docker context show` returned `orbstack`); Docker Desktop was not installed (`open -a Docker` returned “Unable to find application named 'Docker'”, and the `desktop-linux` socket was absent). This is real macOS container acceptance on OrbStack, not Docker Desktop acceptance.

The first packed Docker audit selected `OTLP_HTTP_PORT=4333`. The container-side environment was `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:4333/v1/traces`; the app mounted the project `.perflens/infra/.env` read-only. `npx --no-install perflens audit --yes` started the project stack, verified Collector, Tempo, Prometheus, and Grafana, passed the correlated telemetry preflight, and completed baseline (20 requests, 2.00 RPS, 0 failures, p50/p95/p99 2.04/7.40/24.51 ms) and normal (90 requests, 5.99 RPS, 0 failures, 1.95/8.40/17.36 ms). Run: `pfl_20261005T052643137Z_326c9158-e710-487c-b882-fed15546e346`.

For dynamic-port regression, only that test project's four PerfLens services were stopped using its packed `perflens infra down`; volumes and the consumer app remained. A separate temporary container bound the old port `127.0.0.1:4333`. The next audit detected the current project's stopped services and port conflict, recreated only its own services, and wrote `OTLP_HTTP_PORT=4334` to the authoritative `.perflens/infra/.env`. The unrelated port-holder remained bound to 4333. The Docker consumer container was not restarted or recreated. Its instrumentation had mounted the authoritative env file and followed the selected port on export while retaining the `host.docker.internal` host. The audit printed host endpoint `http://127.0.0.1:4334/v1/traces` and container endpoint `http://host.docker.internal:4334/v1/traces`; the Tempo query URL was `http://127.0.0.1:3208`.

That rotation audit passed telemetry preflight and completed baseline (20 requests, 2.00 RPS, 0 failures, p50/p95/p99 1.87/6.02/16.84 ms) and normal (90 requests, 5.99 RPS, 0 failures, 2.07/10.50/28.11 ms). Run: `pfl_20261005T052906380Z_8cc0918b-2f39-403a-b405-e1a150e2f692`. Its persisted analysis snapshot contains 23 correlated request traces / 46 spans: 20 baseline and 3 normal root server spans, all with service `perflens-docker-consumer`, route `/api/orders`, and the exact audit run ID/profile attributes. A direct Tempo trace inspection showed the same service, HTTP server span, route, and correlation attributes. The zero-finding audit generated:

- `/private/tmp/perflens-62-docker-consumer/.perflens/runs/pfl_20261005T052906380Z_8cc0918b-2f39-403a-b405-e1a150e2f692/report/report.json`
- `/private/tmp/perflens-62-docker-consumer/.perflens/runs/pfl_20261005T052906380Z_8cc0918b-2f39-403a-b405-e1a150e2f692/report/report.md`
- `/private/tmp/perflens-62-docker-consumer/.perflens/runs/pfl_20261005T052906380Z_8cc0918b-2f39-403a-b405-e1a150e2f692/report/report.html`

A separate packed host-run Express consumer on `127.0.0.1:38472` retained loopback export to `http://127.0.0.1:4336/v1/traces`; its selected Tempo query port was `3209`. Run `pfl_20261005T053355119Z_11264217-0f38-4f7b-b655-4436f0d1036d` completed baseline (20 requests, 1.99 RPS, 0 failures, p50/p95/p99 1.34/5.77/38.76 ms) and normal (90 requests, 6.00 RPS, 0 failures, 1.37/3.66/5.35 ms), with 20 correlated request traces. Reports exist at `/private/tmp/perflens-62-host-consumer/.perflens/runs/pfl_20261005T053355119Z_11264217-0f38-4f7b-b655-4436f0d1036d/report/report.{json,md,html}`.

The full workspace build, typecheck, and test suite passed after the implementation: 119 tests (25 analysis engine, 8 Node instrumentation, 69 CLI, 13 reporting, 4 Express integration). Two initial sandboxed test attempts received `listen EPERM` while probing local ports; the authorized loopback-enabled suite passed. `git diff --check` passed. The `ignoreDeprecations: "5.0"` additions to six `tsconfig.json` files were removed: they are unrelated to container OTLP, not required by the workspace's installed TypeScript 5.7.3 build/typecheck, and are not part of this hardening change. No lint script is configured.

Limitation: Docker Desktop itself was unavailable, so its macOS host alias behavior has not been independently verified. The required packed container flow was proven against the active OrbStack Docker Engine; do not treat this as a Docker Desktop acceptance claim. Linux-native Docker networking remains unverified. The packaged Collector binds published ports to host loopback for local-only safety; the integration guide describes Linux `host-gateway` setup as a prerequisite but does not claim it works with that loopback binding. No other project's containers or volumes were cleaned up.

## Phase 6.2.2 — false-ready infrastructure regression — 2026-10-05

### Root cause and correction

The earlier status hardening checked container names, published port mappings, and health endpoints, but `docker compose` was not given an explicit consumer project name. Compose can resolve its project identity from inherited `COMPOSE_PROJECT_NAME`, and host port variables can override values from `--env-file`. That allowed Compose's resolved configuration/container lookup to describe a different project or different ports while PerfLens separately printed the OTLP endpoint read directly from the consumer `.perflens/infra/.env`. In addition, the audit preflight used `states.every(...)` without checking the required service count; an empty status array therefore passed (`[].every(...) === true`). The orchestrator had a stricter count check, so the two readiness paths had diverged.

All Compose operations now pass the deterministic project name `perflens-<sha256(consumer-root)[0:10]>`, including `config`, `ps`, `up`, and `stop`. The generated Compose template uses the same identity. The Compose child process removes inherited infrastructure-port variables and supplies the values read from the current consumer's `.perflens/infra/.env`, so resolved published ports cannot silently disagree with the endpoint PerfLens reports. Reallocated `.env` state is written through an atomic rename.

Readiness is one shared fail-closed predicate used by audit startup, audit preflight, `infra up`, `infra status`, and `doctor`: exactly one status per expected service (`otel-collector`, `tempo`, `prometheus`, `grafana`), every status ready, and no unknown/duplicate names. `Infrastructure.status()` additionally requires the explicit current project identity, one matching running container per service, exact expected published bindings, container health where provided, and a successful request to that service's health endpoint. Missing services produce explicit `not created` statuses; an identity mismatch is rejected before inspecting containers. Tempo's exact project-local `/ready` endpoint is checked before the audit's correlated search uses the query URL from the same Compose configuration.

The prior synthetic tests supplied matching resolved Compose configuration and container lists, and did not combine orphaned persisted state with inherited project/port overrides. They also had no empty-status regression for the separate preflight path. New tests cover the exact saved ports below, unrelated healthy containers, an overridden Compose name, conflicting shell ports, empty/partial/duplicate statuses, and audit recovery from a four-service `not created` result.

### Packed external stale-state acceptance

`npm pack --cache /private/tmp/perflens-npm-cache --pack-destination /private/tmp/perflens-pr7-packed` built `@perflens/cli@0.1.0` from `packages/cli`. The tarball was 91.1 kB (362.7 kB unpacked, 36 files) and was installed with npm into `/private/tmp/perflens-pr7-consumer`, outside the PerfLens workspace. `npx --no-install perflens --version` returned `0.1.0`; no workspace links were used.

The isolated consumer began with the dogfood `.env` values `3003 / 9098 / 3208 / 4332 / 4333 / 13140` (Grafana / Prometheus / Tempo / OTLP gRPC / OTLP HTTP / Collector health). No current project containers existed. Its Dockerized Express service was `perflens-pr7-consumer-app-1`, reachable from the host at `http://127.0.0.1:38991`; PostgreSQL ran in `perflens-pr7-consumer-db-1`. A separate fixture service, `perflens-pr7-consumer-unrelated-port-holder-1`, held `127.0.0.1:4333`. The first command was `npx --no-install perflens audit`; no `init`, `doctor`, or `infra up` command was run manually.

The CLI printed all four services as `not created` and the recovery message; it did not say infrastructure was already ready. It kept the existing persisted ports except for the occupied OTLP HTTP port and atomically updated `OTLP_HTTP_PORT=4334`. The authoritative Compose project was `perflens-f1d3039cbf`. Its exact running containers and published ports were:

| Current consumer service container | Published endpoint |
| --- | --- |
| `perflens-f1d3039cbf-otel-collector-1` | `127.0.0.1:4332→4317`, `127.0.0.1:4334→4318`, `127.0.0.1:13140→13133` |
| `perflens-f1d3039cbf-tempo-1` | `127.0.0.1:3208→3200` |
| `perflens-f1d3039cbf-prometheus-1` | `127.0.0.1:9098→9090` |
| `perflens-f1d3039cbf-grafana-1` | `127.0.0.1:3003→3000` |

All four health checks passed. PerfLens printed host OTLP `http://127.0.0.1:4334/v1/traces`, container OTLP `http://host.docker.internal:4334/v1/traces`, and Tempo query URL `http://127.0.0.1:3208`. The Dockerized app had initially been given the old `host.docker.internal:4333` endpoint; its package instrumentation followed the updated project `.env`. The correlated preflight passed before load. The completed run ID was `pfl_20261005T172513191Z_bb710a17-4475-4edb-bcd7-50d0e466108b`:

| Profile | Requests | Failures | RPS | p50 / p95 / p99 (ms) | Configured / observed concurrency |
| --- | ---: | ---: | ---: | --- | --- |
| baseline | 5 | 0 | 0.9903 | 4.311 / 18.1512 / 20.0174 | 1 / 1 |
| normal | 10 | 0 | 1.9985 | 37.429 / 175.1073 / 175.3543 | 2 / 2 |

The first immediate analysis query ran before Tempo had indexed the just-finished profile traces; it returned zero, so the one-command audit correctly failed analysis and did not print success or generate a report. After preserving that initial empty snapshot and waiting for Tempo indexing, `npx --no-install perflens analyze <run-id>` queried the same run and found **15 correlated `/orders` request traces** (5 baseline, 10 normal), **32 PostgreSQL spans**, and no external HTTP spans. `npx --no-install perflens report <run-id>` then generated a valid zero-finding report at `/private/tmp/perflens-pr7-consumer/.perflens/runs/pfl_20261005T172513191Z_bb710a17-4475-4edb-bcd7-50d0e466108b/report/{report.json,report.md,report.html}`. A direct query to the current project's Tempo port 3208 returned the same run ID and service/route evidence. The initial timing-related analysis failure is recorded; it is distinct from infrastructure readiness and remains a limitation of immediate Tempo indexing.

With deliberately conflicting inherited values (`COMPOSE_PROJECT_NAME=perflens-old-demo`, OTLP HTTP 4318, gRPC 4317, health 13133, Tempo 3200, Prometheus 9090, Grafana 3001), the packed `npx --no-install perflens infra status` still reported the four exact current consumer services ready and printed OTLP port 4334. This verifies inherited environment values do not redirect status to the older stack or change the endpoint authority.

The Docker engine was macOS arm64 OrbStack, not Docker Desktop; the packed Dockerized-consumer run used `host.docker.internal` and was observed to deliver run-correlated traces to the current Tempo instance. Docker Desktop was not independently tested. The isolated consumer and temporary port-holder were the only test resources created; no unrelated or official-project containers, volumes, configuration, or files were removed or changed. Endpoint reselection and explicit load approval regressions passed in the CLI suite. No `tsconfig.json` or `ignoreDeprecations` changes were needed. No Phase 7 functionality was added.

### Quality results

`pnpm -r build`, `pnpm typecheck`, `pnpm test`, and `git diff --check` passed. The final test suite reported **122 passing tests**: 25 analysis-engine, 8 Node instrumentation, 72 CLI, 13 reporting, and 4 Express integration tests. The sandbox initially denied loopback port probes; the final complete suite was rerun with local socket access. No lint script is configured.

## Phase 6.2.x — package-preloaded Node instrumentation — 2026-10-06

Package installation alone did not activate telemetry: the existing Node/Express exports require an application to call the instrumentation API before importing Express/`pg`. A Dockerized app already running before PerfLens starts has already loaded those modules, and its environment does not inherit values from the host shell. The CLI now ships `@perflens/cli/preload`, selected as Express-specific when Express resolves from the consumer working directory and otherwise as generic Node instrumentation. For a local Compose service whose published port matches the configured loopback target, audit checks that the package entrypoint resolves inside the running container, asks explicit approval, writes a narrow generated override under `.perflens/runtime/`, and recreates only that exact service with `--no-deps`. No consumer Compose/source/package files are rewritten. The override uses the current project `.env` OTLP port and configured service name. A service already carrying the matching endpoint and service identity is reused. Remote explicit OTLP traces endpoints are rejected without displaying their values.

The host-run path remains explicit because PerfLens cannot safely preload an already-running process: launch it with `NODE_OPTIONS="--require @perflens/cli/preload"` and the configured `OTEL_SERVICE_NAME`. Its exporter resolves the dynamic current-project port on export, including when the app started before infrastructure created `.perflens/infra/.env`. Correlation still must pass the existing Tempo preflight before k6 starts.

An isolated external consumer installed the packed CLI tarball; no workspace import was used. On macOS with OrbStack Docker Engine, a compiled Express command (`node dist/server.js`) completed audit run `pfl_20261005T193332529Z_e3643d1f-d555-4a00-9c0a-2b7e8b0646c7`: baseline 20 requests, 2.00 RPS, 0 errors, p50/p95/p99 11.98/26.01/30.35 ms; normal 90 requests, 5.99 RPS, 0 errors, 12.62/53.33/118.34 ms. It produced 23 correlated request traces, 46 PostgreSQL spans, and a report under `.perflens/runs/<run-id>/report/report.html`.

A second isolated Compose run used `ts-node-dev --respawn --transpile-only src/server.ts`. Run `pfl_20261005T193806324Z_e3de7600-6b08-44ad-9eb4-35ee7f448145` completed with baseline 20 requests / 2.00 RPS / 0 errors / 12.09/35.33/50.69 ms; normal 90 requests / 5.99 RPS / 0 errors / 11.28/39.08/50.95 ms. It had 20 correlated request traces, 40 PostgreSQL spans, and no finding; the report was generated. A host-run external Express app also passed using the supported `NODE_OPTIONS` preload: run `pfl_20261005T193547179Z_6830d951-ec22-4567-a30c-42ed0f3ba972`, baseline 20 requests / 2.00 RPS / 0 errors / 1.04/9.07/13.52 ms; normal 90 requests / 6.00 RPS / 0 errors / 0.86/3.03/4.08 ms; 20 correlated request traces.

For port rotation, the test consumer Collector was stopped and a separate temporary container occupied its old `OTLP_HTTP_PORT=4329`. Recovery selected **4336** (intermediate ports were occupied by unrelated local stacks), recreated the exact consumer infrastructure, and updated `.perflens/infra/.env`. PerfLens detected the app's old `host.docker.internal:4329` endpoint and explicitly recreated only `backend` with `host.docker.internal:4336`; correlated preflight and both profiles passed in run `pfl_20261005T194029028Z_63766651-fb1c-4df8-a028-e4ebf0dbc0bf` (20 baseline / 90 normal, zero errors, 46 PostgreSQL spans). The separate holder continued to own 4329. The database container ID remained unchanged across application restarts. A subsequent baseline audit printed `PerfLens instrumentation already active for backend`, did not recreate backend or database, and completed run `pfl_20261005T194148385Z_c4a34e47-273b-46ef-865b-0773fa40e56b` with 20 requests, 2.00 RPS, zero errors, 7.79/12.41/12.51 ms, and 20 PostgreSQL spans.

The external fixture's application source, Compose file, Dockerfile, and package scripts were not modified by PerfLens; its test-only source/runtime changes were made before the audit. Application restart was explicitly authorized with `--restart-app`; this flag is separate from endpoint load approval. The real official consumer project was not accessed or modified and remains a required manual packed-tarball check before PR approval. Docker Desktop was not independently verified; this live result is OrbStack on macOS. Linux-native Docker networking remains unverified.

The final tarball, packed after the endpoint validation hardening, was 100.6 kB (397.8 kB unpacked, 38 files; SHA-1 `35512830fae77c23d4cef847591c8bd52effbd13`) and was installed into the isolated external consumer with `npm install ./vendor/perflens-cli-0.1.0.tgz`. Its complete Dockerized `ts-node-dev` audit is run `pfl_20261005T194647779Z_a3c135bc-8b7d-43f5-8023-fa55045e7cff`: current Collector endpoint `http://host.docker.internal:4336/v1/traces`, correlated preflight passed, baseline 20 requests / 2.00 RPS / 0 errors / p50-p95-p99 9.06/24.84/104.32 ms, normal 90 requests / 6.00 RPS / 0 errors / 12.06/28.51/32.64 ms, 23 correlated request traces, 46 PostgreSQL spans, no finding. Its report was generated under `/private/tmp/perflens-phase62x-consumer/.perflens/runs/pfl_20261005T194647779Z_a3c135bc-8b7d-43f5-8023-fa55045e7cff/report/`.

Final `pnpm -r build`, `pnpm typecheck`, and `pnpm test` passed. The suite totals **134 tests, 134 passed, 0 failed**: analysis engine 25, Node instrumentation 8, CLI 84, reporting 13, and Express integration 4. `git diff --check` passed. No lint script is configured.

## Phase 6.2.x — self-contained temporary Docker preload — 2026-10-07

The previous Docker activation wrongly assumed `@perflens/cli` installed on the host could be resolved from the consumer app image. The CLI now builds a single self-contained preload bundle with its OpenTelemetry SDK/exporter/instrumentation dependencies included; at runtime it resolves the consumer app's own Express module from the app working directory and patches the actual app-loaded Express/pg modules before the app command runs. The bundle is copied from the currently installed CLI under `.perflens/runtime/`, mounted read-only at `/opt/perflens/runtime/perflens-preload.cjs`, and activated using `NODE_OPTIONS`. Current dynamic OTLP port, configured service name, and a bundle SHA-256 marker are injected only into the selected Compose service. Custom Node options are preserved and any prior PerfLens preload is deduplicated. A new bundle hash causes service-only recreation after explicit approval; matching bundle/endpoint/service identity reuses the running app.

Packed package `/private/tmp/perflens-phase62x2-pack/perflens-cli-0.1.0.tgz` was installed from the host into external fixture `/private/tmp/perflens-cli-noimage`. Size was 560,126 bytes (39 files; unpacked size 3.5 MB), SHA-1 `b7768c11851d1ee4e93f66669eb9f8c470e65801`, SHA-256 `8637eeebd00371d00ab041f7d71a000af1d9dbc8aad57581e752151a288fb2e1`. Its Dockerfile installed Express 5.2.1 and pg 8.23.0 only, not PerfLens; before and after audit `require.resolve('@perflens/cli')` inside `backend` reported `CLI_ABSENT`. The host audit command was `npx --no-install perflens audit --yes --restart-app`. Docker engine was macOS OrbStack (not Docker Desktop).

The app service `backend` served `http://127.0.0.1:3411`; unrelated fixture database service `db` remained up with its ID unchanged (`0db539f9b54a`). PerfLens OTLP endpoints were `http://127.0.0.1:4329/v1/traces` on the host and `http://host.docker.internal:4329/v1/traces` in the container; Tempo query was `http://127.0.0.1:3206`. The selected container showed `NODE_OPTIONS=--require /opt/perflens/runtime/perflens-preload.cjs`, `OTEL_SERVICE_NAME=noimage-express-api`, and runtime bundle marker `05ad3db1225a0c754dd5312bd52987e75f38de44251c967be357da8dbc3a0029`. The generated Compose override contained only `backend` environment entries and a read-only mount from `.perflens/runtime/perflens-docker-preload.cjs`; it did not serialize the consumer environment or database credentials. Source, `package.json`, Dockerfile, and user Compose file stayed unchanged.

Successful run `pfl_20261006T181916077Z_f41654fa-f66d-4781-9e94-492305ad122f` completed correlated telemetry preflight, baseline, normal, analysis, and report. Baseline measured 20 requests, 3.98 RPS, 0% errors, p50/p95/p99 7.12/19.92/66.73 ms. Normal measured 60 requests, 11.75 RPS, 0% errors, p50/p95/p99 12.29/49.32/343.26 ms. Tempo evidence contained 77 correlated request traces (308 total spans), including 154 PostgreSQL spans and no external HTTP spans. The existing analyzer emitted an observational `load.latency-degradation` finding (P2, high confidence); it made no database diagnosis. Report artifacts: `.perflens/runs/pfl_20261006T181916077Z_f41654fa-f66d-4781-9e94-492305ad122f/report/report.json`, `report.md`, and `report.html`.

The first fixture audit exposed that Tempo indexed some load traces later than the former six-second wait. The bounded run-scoped retry now allows 40 polls, 500 ms apart (20 seconds); if no matching spans arrive it fails without persisting an empty evidence snapshot, so a later `analyze` can retry. The subsequent successful run above is the verified completion. No unrelated Compose service, image, volume, or container was removed. The official external consumer was not touched and still requires the requested fresh-tarball manual test. Linux-native Docker behavior remains unverified; no Phase 7 functionality was added.

Final quality checks passed: `CI=1 pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm typecheck`, `pnpm test`, and `git diff --check`. Tests totaled **140 passed, 0 failed** (analysis 25, Node instrumentation 8, CLI 90, reporting 13, Express integration 4). The initial sandboxed registry install returned `ENOTFOUND`; the same frozen install succeeded with network access. Loopback tests were run with local socket access.

## Phase 6.2.x — Docker application readiness polling — 2026-10-07

After a Docker service was recreated with the temporary instrumentation preload, activation used a fixed 30-second deadline with 250 ms polling and then made an additional final request. It did not inspect whether the selected service had exited during the wait. An application that began listening after that deadline was reported as an instrumentation activation failure even when it was healthy. This is now a bounded readiness stage: PerfLens immediately probes the configured GET target, retries transient connection failures every 750 ms for up to 60 seconds, bounds each HTTP attempt by the remaining time, and stops at the first response. It checks the exact selected Compose service container during the wait and fails early if that container has exited. HTTP readiness remains separate from the existing correlated Tempo preflight, which still runs before any k6 profile. Failure text now distinguishes application readiness from instrumentation activation and states that load, analysis, and reporting did not proceed.

The full test suite passed **148 tests, 0 failed**: analysis engine 25, Node instrumentation 8, CLI 98, reporting 13, and Express integration 4. New deterministic tests cover immediate readiness, repeated transient failures then success, an eight-second simulated startup, bounded timeout without an extra probe, selected-container exit, configured endpoint use, selected-service-only recreation, and orchestration ordering before audit/telemetry verification. `pnpm -r build`, `pnpm typecheck`, and `git diff --check` passed. The first sandboxed suite attempt could not bind loopback for existing HTTP instrumentation tests; the full final suite was rerun with local socket access.

For packed acceptance, `npm pack --cache /private/tmp/perflens-readiness-npm-cache --pack-destination /private/tmp/perflens-readiness-pack` produced `/private/tmp/perflens-readiness-pack/perflens-cli-0.1.0.tgz` (561,342 bytes; SHA-256 `228518204b4ed06b1179e6252738c71797dde422ce25f2242a3a29ddbeaa0d27`). It was installed into the separate `/private/tmp/perflens-slow-start-32-consumer` external project. The Docker image built from its fixture Dockerfile contains Node, Express, and `pg`; it does not install `@perflens/cli`. The host ran `npx --no-install perflens audit --restart-app`; no application source or Compose changes were made by PerfLens.

The selected `backend` container started at `2026-10-06T19:18:35.380874134Z`; its intentionally slow fixture logged that it began listening at `2026-10-06T19:19:07.809607894Z`, **32.43 seconds later**. PerfLens printed `Waiting for application readiness...` followed by `✓ Application ready`, then `✓ Correlated OpenTelemetry traces verified before load`. This exceeds the former 30-second limit and demonstrates the corrected path. The run was `pfl_20261006T191908200Z_79f78f35-6d8a-448a-999b-db59f5a73f03`; OTLP was `http://127.0.0.1:4335/v1/traces` on the host and `http://host.docker.internal:4335/v1/traces` in the app container. Baseline measured 20 requests, 3.98 RPS, 0 errors, p50/p95/p99 10.26/27.29/29.86 ms. Normal measured 60 requests, 11.98 RPS, 0 errors, p50/p95/p99 11.92/19.31/23.40 ms. Analysis collected 80 correlated request traces and 160 PostgreSQL spans; it produced no finding, which is valid for this fixture. The report generated `report.json`, `report.md`, and `report.html` under `/private/tmp/perflens-slow-start-32-consumer/.perflens/runs/pfl_20261006T191908200Z_79f78f35-6d8a-448a-999b-db59f5a73f03/report/`. The fixture database remained up; only the selected backend service was recreated. The official consumer project was not touched. No Phase 7 functionality was added.

## Phase 6.3 — commercial CLI UX and report polish — 2026-10-08

The HTML metadata grid allowed long run IDs and endpoint values to retain their intrinsic minimum width, causing Run/Endpoint overlap. The report now sets shrinkable grid children, breaks long values safely, lets comparison tables scroll horizontally, and uses responsive card/table behavior. Measured nonzero error rates are formatted as percentages and highlighted without adding a diagnosis. Regression fixtures cover the long run ID `pfl_20261007T180126602Z_20bb015a-6881-4daa-903a-73b44cb5262a`, two long endpoint paths, small-screen CSS rules, and nonzero errors. A separate generated layout artifact at `/private/tmp/perflens63-layout/report.html` contains two profiles, two long endpoints, a nonzero error rate, PostgreSQL telemetry counts, and no findings. Browser screenshot/layout tooling was unavailable, so 1440/1024/768/mobile visual rendering was **not** claimed; the HTML/CSS structure and wrapping rules were covered by tests.

Successful audit output no longer prints OTLP endpoints or manual `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` setup instructions. `doctor` and `infra status` retain detailed endpoint diagnostics, and failure remediation retains the selected endpoint. A shared approval callback presents target, exact endpoint set, profiles, and a possible local service restart in one prompt when restart is needed. Declining prevents restart/load; non-interactive load still requires `--yes`, and non-interactive Docker recreation still requires `--restart-app`.

`perflens report --open` opens the latest completed run that has an HTML artifact; `perflens report <run-id> --open` selects a specific run. `perflens audit --open` opens only the report belonging to that successful run. Openers use argument-vector process spawning (`open`, `explorer.exe`, or `xdg-open`, depending on platform); browser failure leaves the report path and report success intact. On macOS, the packed CLI opened the latest report in the default browser.

Packed acceptance used `npm pack --cache /private/tmp/perflens63-npmcache --pack-destination /private/tmp/perflens63-review-pack`, then installed the resulting tarball into `/private/tmp/perflens-slow-start-32-consumer`, an external Dockerized Express project. Tarball: `perflens-cli-0.1.0.tgz`, 564.0 kB (3.5 MB unpacked, 41 files), SHA-1 `21bbce31b93f775b9652fcd791d4eef72002db37`. The exact commands were `npm install --save-dev /private/tmp/perflens63-review-pack/perflens-cli-0.1.0.tgz --cache /private/tmp/perflens63-npmcache`, `npx --no-install perflens audit --yes`, and `npx --no-install perflens report --open`. The consumer backend container was `perflens-slow-start-32-consumer-backend-1`, host target `http://127.0.0.1:3412`, and it used the current PerfLens Collector OTLP port 4335, Tempo 3209, Grafana 3011, and Prometheus 9099.

The latest packed run ID was `pfl_20261007T192335085Z_ab682848-066f-4292-a4eb-14705af505cb`, endpoint `GET /orders`. Persisted profile evidence was:

| Profile | Requests | RPS | Errors | p50 / p95 / p99 (ms) |
| --- | ---: | ---: | ---: | --- |
| baseline | 20 | 3.9798 | 0 / 0.00% | 8.3635 / 19.16415 / 20.85363 |
| normal | 60 | 11.9837 | 0 / 0.00% | 9.946 / 16.98035 / 17.6705 |

Telemetry analysis found 80 correlated request traces, 160 PostgreSQL spans, and 0 external HTTP spans. No Phase 3 finding met its thresholds. The run completed and generated `/private/tmp/perflens-slow-start-32-consumer/.perflens/runs/pfl_20261007T192335085Z_ab682848-066f-4292-a4eb-14705af505cb/report/{report.json,report.md,report.html}`. `npx --no-install perflens report --open` resolved that same run and printed `✓ Report opened in your browser.` This proves the existing Docker instrumentation/telemetry path remained functional with the packed CLI; no consumer source, Dockerfile, or Compose file was changed during this audit.

After the final evidence-card wrapping CSS change, the review tarball above was installed again and the complete packed workflow was rerun. Final run ID: `pfl_20261007T192630963Z_25cf54d1-d829-444f-abb4-a5010c4a6394`, still `GET /orders`. Persisted measurements:

| Profile | Requests | RPS | Errors | p50 / p95 / p99 (ms) |
| --- | ---: | ---: | ---: | --- |
| baseline | 20 | 3.9879 | 0 / 0.00% | 8.0690 / 19.3522 / 23.65684 |
| normal | 60 | 11.7778 | 0 / 0.00% | 20.599 / 47.53145 / 119.83393 |

The final run produced 80 correlated request traces, 160 PostgreSQL spans, and 0 external HTTP spans. Phase 3 emitted the measured finding `load.latency-degradation`, P2 / HIGH: “Latency increased as configured concurrency increased.” This finding was carried into the generated report without reporting-layer reinterpretation. The final artifact path is `/private/tmp/perflens-slow-start-32-consumer/.perflens/runs/pfl_20261007T192630963Z_25cf54d1-d829-444f-abb4-a5010c4a6394/report/{report.json,report.md,report.html}`. `npx --no-install perflens report --open` printed that exact path and `✓ Report opened in your browser.`

Final quality checks: `pnpm build`, `pnpm typecheck`, `pnpm test`, and `git diff --check` passed. The suite reported **160 passing tests, 0 failed**: 25 analysis-engine, 8 Node instrumentation, 108 CLI, 15 reporting, and 4 Express integration tests. The full suite required local socket access for its existing loopback tests. No Phase 7 functionality was added.

## Phase 7.1 — diagnostic evidence foundation — 2026-10-10

The report model now derives versioned diagnostic coverage and HTTP status evidence from persisted profile results and sanitized analysis artifacts. It adds endpoint/profile status tables to Markdown and HTML, labels HTTP 429 as a rate rejection with possible sources (without assigning a cause), and marks unavailable historical status distributions as `Not persisted`. The test fixture covers endpoint-specific 200/429 counts and verifies that findings and their severity/confidence/evidence remain unchanged. No live performance audit or fresh Docker acceptance was run for this change.

The packed CLI was generated from `packages/cli` as `/private/tmp/perflens71-pack/perflens-cli-0.1.0.tgz` (569.8 kB compressed, 3.5 MB unpacked, 41 files; SHA-1 `01562bf5f1764a185d3e1d0ed5b2ac869f36a05d`). It was installed into the external persisted-run fixture `/private/tmp/perflens63-pr9-consumer` with `npm install --prefix ... --no-save ...`. `npx --no-install perflens --version` returned `0.1.0`; `npx --no-install perflens report pfl_20261009T174651629Z_ec072e2e-3644-4a7b-9572-55056d956081` completed and wrote JSON, Markdown, and HTML. That historical schema-v1 run had no persisted status distribution, and the generated report represented status evidence as `Not persisted`; this was report/package compatibility verification, not a new measurement or audit acceptance.

Quality verification: `pnpm build` passed, `pnpm typecheck` passed, `pnpm test` passed **173/173 tests** (analysis engine 26, reporting 24, Node instrumentation 8, CLI 111, Express integration 4), and `git diff --check` passed. No lint script is configured. The CLI tarball changed in the worktree before this task and was deliberately not included in the source changes; the packed acceptance tarball was generated separately under `/private/tmp`.
