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
