# Express integration

The Express demo is a reference **target application**, not part of the PerfLens analysis engine. It demonstrates the existing audit → analyze → report workflow with another Node.js framework. The only verified framework targets in this repository are NestJS and Express; this does not imply support for every Node.js framework.

## Prerequisites and startup

Use the root `.env.example` for local PostgreSQL credentials and image versions, and run all published services only on loopback. Docker with a local daemon, Docker Compose, Node.js/pnpm for workspace commands, and k6 for audits are required.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
pnpm perflens infra up
docker compose --profile express up -d --build express-demo-api
curl http://localhost:3003/health
```

The target is an opt-in Compose profile. It shares the existing PostgreSQL and OTel Collector services, binds its API to `127.0.0.1:${EXPRESS_API_PORT:-3003}`, and identifies itself as `perflens-express-demo-api`. It creates the same deterministic local data used by the NestJS demo if the database is empty. Both seeders use a PostgreSQL advisory lock to serialize initial seeding.

If `EXPRESS_API_PORT` is changed in `.env`, update `target.baseUrl` in this app's `perflens.config.json` to the same loopback port.

## Instrumentation bootstrap

`packages/node-instrumentation` contains framework-neutral NodeSDK resource, OTLP, HTTP, PostgreSQL, and correlation setup. `apps/express-demo-api/src/instrumentation.ts` opts into `ExpressInstrumentation`; the generic bootstrap itself does not depend on Express. The container preloads the compiled instrumentation entry using Node's `--require` before `main.js` loads Express or `pg`. Keep this startup ordering when launching the app outside Compose:

```sh
node --require apps/express-demo-api/dist/instrumentation.js apps/express-demo-api/dist/main.js
```

The generic bootstrap sets `service.name`, `service.version`, and `deployment.environment`, exports traces to the configured local OTLP endpoint, and instruments HTTP and PostgreSQL. Express instrumentation adds framework route-layer context; audit analysis still consumes server/client span kinds, semantic HTTP/database attributes, timing, and correlation rather than Express internals.

## Configuration and workflow

`apps/express-demo-api/perflens.config.json` is an example using the existing PerfLens JSON configuration model. It targets only `http://localhost:3003`; the CLI's local-target safety validation remains unchanged.

```sh
pnpm perflens --config apps/express-demo-api/perflens.config.json doctor
pnpm perflens --config apps/express-demo-api/perflens.config.json audit --profile baseline,normal
pnpm perflens --config apps/express-demo-api/perflens.config.json analyze
pnpm perflens --config apps/express-demo-api/perflens.config.json report
```

Change the configured endpoint path to one of the explicit performance fixtures when needed. `GET /orders` is a bounded database read without intentional delay. The three `/performance/*` routes are intentional fixtures solely for local analysis. They are not production examples.

## Correlation and privacy

Audit requests retain the existing `X-PerfLens-Run-Id` and `X-PerfLens-Profile` contract. The shared HTTP hook maps valid values to `perflens.audit.run_id` and `perflens.audit.profile`; run IDs and profile names are allowlisted and length-bounded. They are observability metadata, never authorization. OpenTelemetry creates and propagates trace IDs normally. Tempo analysis filters by service, run, profile, and time window.

Only those two PerfLens headers are copied to span attributes. Authorization, Cookie, arbitrary headers, bodies, and unbounded values are not captured by this integration. PostgreSQL enhanced statement reporting is disabled; existing SQL normalization/privacy handling remains in the CLI evidence path.

## Known limits

This target uses PostgreSQL and local synthetic data. The external-call fixture makes a real HTTP request to a latency simulator bound to the app container's loopback interface. Trace attribute details must be checked against the installed OpenTelemetry instrumentation versions; framework integrations and route instrumentation not verified here should not be assumed supported. Only loopback auditing is allowed. No remote targets, automatic instrumentation edits, or other language/framework integrations are included.
