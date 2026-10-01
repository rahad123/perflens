# PerfLens architecture

PerfLens is an installable Backend Performance Audit CLI / Developer Toolkit. This repository is its early, checkout-based foundation. The demo backend is a test target, not the product. The CLI controls infrastructure, validates projects, runs bounded local k6 audits, and analyzes completed runs using deterministic, evidence-backed rules. It does not automatically instrument arbitrary applications or edit source.

## Preserved Phase 1, Phase 2, and Phase 3 — implemented

```mermaid
flowchart TB
    Config[Project config: JSON] --> CLI[PerfLens CLI]
    CLI -->|doctor / lifecycle / readiness| Compose[Single existing Compose definition]
    Compose --> Collector[OTel Collector]
    Compose --> Tempo[Tempo]
    Compose --> Prometheus[Prometheus]
    Compose --> Grafana[Grafana]
    subgraph Targets[Separately managed reference targets]
        API[NestJS Demo API] --> DB[(PostgreSQL)]
        Express[Express Demo API - opt-in] --> DB
        API --> External[Loopback HTTP fixture]
        Express --> ExpressDep[Loopback HTTP fixture]
        API --> SDK[Shared Node OpenTelemetry bootstrap]
        Express --> SDK
        API --> Metrics[Prometheus registry]
        Express --> Metrics
    end
    SDK -->|OTLP HTTP traces| Collector
    Collector -->|OTLP gRPC traces| Tempo
    Metrics -->|scrape| Prometheus
    Tempo --> Grafana
    Prometheus --> Grafana
    CLI --> Preflight[Audit preflight]
    Preflight --> k6[k6 constant-VU profiles]
    k6 -->|GET with run/profile headers| API
    k6 -->|same workflow and config contract| Express
    k6 --> Raw[Raw summary and samples]
    Raw --> Results[Normalized measurement results]
    CLI --> Windows[Run/profile metadata and time windows]
    Results --> Runs[Unique local run directory]
    Windows --> Runs
    CLI -->|loopback TraceQL query, scoped by run/profile| Tempo
    Runs --> Analysis[Framework-independent analysis engine]
    Analysis --> Evidence[Sanitized analysis evidence + findings]
    Evidence --> Runs
```

### Boundaries

- `packages/cli` owns command orchestration, project validation, subprocess execution, diagnostics, and readiness checks. Commander parses arguments; reusable functions/services handle operations.
- `apps/demo-api` owns the NestJS/TypeORM target; `apps/express-demo-api` owns a separate Express/pg target. Each has local fixture routes and neither is part of the CLI or analysis engine.
- `packages/node-instrumentation` owns shared NodeSDK resource/exporter/HTTP/PostgreSQL setup and bounded audit correlation. Express opts into `ExpressInstrumentation` before importing Express. The Compose profile reuses the existing database and telemetry services.
- `infra` and `docker-compose.yml` remain the only infrastructure definitions. No second infrastructure stack is introduced.
- Metrics flow directly from the target to Prometheus. Tempo stores traces, not the application's Prometheus metrics.
- `packages/cli/src/audit` owns bounded profile validation, preflight, child execution, k6 integration, normalization, and run storage. `packages/cli/src/analysis` retrieves correlated trace snapshots and renders results. `packages/analysis-engine` has no CLI, NestJS, TypeORM, or Express dependency.
- `.perflens/runs/<run-id>` stores measurements, analysis evidence/findings, and generated report files. Reports are rendered from persisted Phase 3 analysis without rediagnosis.

### Configuration and resolution

`perflens.config.json` contains `project.name`, `target.baseUrl`, `observability.serviceName`, and optional `audit` with endpoints, timeout, and profile overrides. JSON avoids executable config and an extra parser dependency. Strict validation rejects unknown keys, credential-bearing URLs, unsafe paths, unsupported methods, and out-of-bound workload values. Only loopback target URLs are permitted. Old Phase 1 configs remain valid for existing commands; auditing requires explicit endpoints. No credential fields exist; users must not put secrets in names/paths.

Doctor, audit, and runs find project config in the current directory or its parents, or accept `--config`. Artifacts are adjacent to that config. Infrastructure resolves relative to the CLI's checkout or explicit `--infra-dir`. This separates the target directory from the toolkit's infrastructure location. A future distributable needs an infrastructure asset/version strategy; the current package only bundles its own k6 script, not the infrastructure.

`init` uses exclusive file creation and never overwrites existing configuration. It creates no instrumentation, dependency changes, Git edits, Docker changes, or framework guesses. All target integration remains explicit.

### Lifecycle and readiness

The infrastructure service allowlist is Collector, Tempo, Prometheus, and Grafana. `infra up` checks rendered Compose config and port conflicts, starts the allowlist using Compose health waits, then verifies service endpoints. The existing Prometheus image supplies `wget` for internal-network probes, avoiding a helper image or dependency on the demo. Tempo's query API is additionally published only on loopback so the independent CLI can collect correlated evidence.

`infra status` reports absent/stopped/running-not-ready/ready states and fails for crashed/unhealthy services. `infra down` uses `compose stop` only for the allowlist and verifies stopped states. It retains containers, networks, volumes, PostgreSQL, and target services. This deliberate meaning of `down` is documented in command help.

Doctor is read-only. Ports owned by the matching service in the selected Compose project count as correctly allocated; unrelated listeners are failures. The target API port and application health are separate from infrastructure readiness. Config rendering is never printed because it can contain `.env` credentials.

### Safety and network behavior

Shell-free argument arrays, local Docker checks, loopback bindings, bounded process timeouts, and nonzero errors form the preserved safety baseline. Audit adds bounded VUs/duration/request timeouts/pacing, explicit high-load selection, no redirects, and a project lock. Analysis only reads completed run artifacts and local Tempo, stores allowlisted sanitized spans, and does not mutate application or database state. Reporting formats persisted inputs and does no new diagnosis. Remote target URLs remain rejected without an override; CI cannot implicitly authorize remote load.

Grafana and Tempo anonymous reporting is disabled. Grafana automatic preinstallation, plugin updates, update checks, and public-key downloads are disabled; required datasources are already bundled. Images and dependencies still require explicit registry downloads at installation/startup. These configuration guarantees are not a network firewall or a security review of third-party software.

### Audit execution and evidence boundaries

`audit` resolves config and profiles, exclusively allocates a UUID run, checks k6 2.3.x plus existing infrastructure readiness, and preflights each endpoint. It then runs profiles sequentially through the reusable process boundary. The process receives no inherited proxy/K6/secret settings; an explicit empty k6 config prevents ambient overrides. Ctrl+C/deadlines stop the child and wait for exit. A hard crash can leave an incomplete run and lock, requiring manual inspection.

The k6 script executes concurrent constant-VU GET requests with pacing and explicit timeouts. It writes its structured summary and raw metric points. The parser produces schema-versioned counts, status distribution, error rate, RPS, percentiles, workload, and approximate client overlap evidence. It contains no root-cause rules. HTTP failures under load are measurements; subprocess/evidence failures make the run fail. Profiles and runs preserve partial status and available evidence.

`RunStore` uses exclusive run-directory creation, atomic state writes, and finalization. Later commands never resume or overwrite a completed directory. This is application-level immutability, not OS protection against file owners. Raw evidence stays local; filesystem history needs no database.

Both Node reference apps use the shared HTTP/PostgreSQL bootstrap. Server spans capture only valid, bounded audit run/profile headers; OpenTelemetry remains responsible for trace IDs and context propagation. Express adds its framework layer instrumentation. Analysis queries Tempo by service, run ID, profile, and profile UTC window, then stores normalized span evidence. The analysis rules depend on span kinds, semantic HTTP/database attributes, service identity, timing, and correlation—not NestJS or Express internals. Prometheus metric snapshots and resource-saturation findings remain unsupported because Phase 2 does not persist reliable per-run system metrics.

The full measurement contract is in [audit methodology](../audit-methodology.md); Phase 3 rules and thresholds are in [analysis methodology](../analysis-methodology.md).

## Current-to-future workflow

```mermaid
flowchart TB
    Backend[Existing Backend Project] --> PerfLens[PerfLens CLI]
    PerfLens --> Instrument[Node instrumentation: NestJS and Express verified]
    Instrument --> Observe[Local observability infrastructure: implemented]
    Observe --> Load[Local controlled k6 audits: implemented]
    Load --> Collect[Stored measurements and telemetry correlation: implemented]
    Collect --> Analyze[Analysis engine: implemented]
    Analyze --> Findings[Evidence-backed P0 / P1 / P2 findings: implemented]
    Findings --> Report[Markdown / HTML reports: implemented]
    Report --> More[Other framework/language integrations: future]
```

`analyze` consumes validated run artifacts and correlated telemetry, rather than framework controllers or demo-specific SQL. `audit` currently targets local GET endpoints. Phase 5 verifies generic Node instrumentation with NestJS and Express reference targets. Other frameworks/languages and recommendations remain future work.

Analysis remains separate from audit execution; offline replay uses the saved evidence snapshot. Missing optional trace evidence is reported explicitly, and unsupported resource rules do not infer saturation from latency.
