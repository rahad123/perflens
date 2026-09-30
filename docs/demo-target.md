# Demo target reference

The NestJS app is a synthetic audit target, not PerfLens itself. Start audit infrastructure with the CLI described in the root README. The commands below also retain the original all-in-one Compose workflow.

## Prerequisites

- Docker with a running engine and Docker Compose v2.
- Internet access for the first image/dependency download.
- k6 on the host **or** the Docker command below.
- Node.js 24 LTS and pnpm 10.12.4 only for development outside Docker. The container build installs its own tools.

## Quick start

Run from the repository root:

```sh
cp .env.example .env
docker compose up --build -d
docker compose ps
curl --fail http://localhost:3000/health
```

Wait for `demo-api` to become healthy. Its first startup applies a migration and seeds 2,000 customers, 500 products, 20,000 orders, and 80,000 order items. Subsequent starts preserve data and skip seeding when customers exist. Initial image downloads can take several minutes.

The health response should be `{"status":"ok","database":"up"}`. It executes `SELECT 1`, so it also verifies database connectivity.

```sh
docker compose logs --tail=100 demo-api otel-collector tempo
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM orders;"'
```

Stop with `docker compose down`; named volumes persist. **Destructive reset:** `docker compose down -v` deletes all demo and telemetry data. PostgreSQL credentials in `.env` initialize a fresh volume; changing them does not change existing database passwords.

## Service URLs

| Service | Default URL | Purpose |
| --- | --- | --- |
| Demo API | http://localhost:3000 | API and `/health` |
| Metrics | http://localhost:3000/metrics | Prometheus text exposition |
| Grafana | http://localhost:3001 | Anonymous local Explore access; no login |
| Prometheus | http://localhost:9090 | Queries and target status |

Ports can be changed in `.env`; adjust host-side commands accordingly. PostgreSQL, Tempo, and Collector ports are internal to the Compose network. Grafana datasources point to Docker service names, not `localhost`.

## Demo endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /` | Service name and available API endpoints |
| `GET /health` | Readiness check including a database query |
| `GET /orders?limit=20&offset=0` | Latest orders; limit 1–100, offset 0–1,000,000 |
| `GET /orders/:id` | Order, customer, and joined product/item details; 404 if absent |
| `POST /orders` | Validated transactional creation using database product prices |
| `GET /performance/slow-query` | **Intentional bottleneck:** correlated item totals with a cast that prevents use of the ordinary order-ID index; bounded to 100 seeded orders |
| `GET /performance/n-plus-one` | **Intentional bottleneck:** one query for 20 orders, then 20 sequential item queries |
| `GET /performance/external-call` | **Intentional bottleneck:** HTTP dependency fixture delays its response by 750 ms |
| `GET /metrics` | Request counts, latency histograms, Node.js/process metrics |

All deliberately inefficient application code is in the performance controller or its private dependency fixture. The fixture binds only to `127.0.0.1:4001` inside the API container and has no public route or Compose service. Its delay is a configured simulation, not a benchmark result.

```sh
curl --fail http://localhost:3000/orders
curl --fail http://localhost:3000/orders/1
curl --fail -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":1,"items":[{"productId":1,"quantity":2},{"productId":2,"quantity":1}]}'
```

Prices use integer cents. Unknown customers/products return 400. Payloads reject unknown fields and limit orders to 50 items with quantities 1–100. No payment, inventory, or authentication logic is included.

## Verify tracing

1. Generate requests:

   ```sh
   curl --fail http://localhost:3000/orders/1
   curl --fail http://localhost:3000/performance/slow-query
   curl --fail http://localhost:3000/performance/n-plus-one
   curl --fail http://localhost:3000/performance/external-call
   ```

2. Open http://localhost:3001/explore and select **Tempo**.
3. Set the time range to **Last 15 minutes**, select the TraceQL/code query editor, and run:

   ```traceql
   { resource.service.name = "perflens-demo-api" }
   ```

4. Allow several seconds for SDK export and Collector batching; refresh the query if necessary. Open a matching HTTP server trace and expand its waterfall.
5. For order requests, inspect PostgreSQL child spans and SQL attributes. For `n-plus-one`, compare repeated item-query spans with the bounded ordinary detail endpoint. For `external-call`, inspect the outbound HTTP client span and its nested loopback server span.
6. Inspect resource attributes: `service.name`, `service.version`, `deployment.environment`.

Tracing is preloaded with `node --require ./dist/instrumentation.js dist/main.js`. Starting `dist/main.js` without preloading can load HTTP/pg before instrumentation and lose spans. Health and metrics requests are excluded from tracing and request metrics to keep probes out of audit measurements.

If traces are missing, inspect `docker compose logs otel-collector tempo demo-api`. Check that Grafana's Tempo datasource URL is `http://tempo:3200`. PostgreSQL query parameters and request bodies are not intentionally captured; SQL text may still contain sensitive literals in future changes.

## Verify metrics

Open http://localhost:9090/targets and confirm `demo-api` is **UP**. Generate traffic, wait for at least two scrapes, then use Grafana Explore with **Prometheus** or the Prometheus query UI:

```promql
# Completed requests per second, grouped by route
sum by (route) (rate(perflens_http_requests_total[1m]))

# p95 request latency, in seconds
histogram_quantile(0.95, sum by (le, route) (rate(perflens_http_request_duration_seconds_bucket[1m])))

# Server error ratio (5xx); zero under successful traffic
sum(rate(perflens_http_requests_total{status_code=~"5.."}[1m]))
  / clamp_min(sum(rate(perflens_http_requests_total[1m])), 0.000001)

# Process resident memory bytes
perflens_process_resident_memory_bytes
```

A 5xx series does not exist until the first server error; an empty error-ratio result is therefore possible. Use `(sum(rate(perflens_http_requests_total{status_code=~"5.."}[1m])) or vector(0)) / clamp_min(sum(rate(perflens_http_requests_total[1m])), 0.000001)` when you want a displayed zero. 4xx responses are separately queryable by status code. Route templates, not raw order IDs, label metrics.

## Run the load test

With k6 installed:

```sh
k6 run -e BASE_URL=http://localhost:3000 load-tests/baseline.js
```

Or with Docker, using the existing Compose network (works across host platforms):

```sh
docker run --rm -i --network perflens_default \
  -e BASE_URL=http://demo-api:3000 \
  grafana/k6:2.3.0 run - < load-tests/baseline.js
```

The test runs five virtual users for 30 seconds with a one-second pause between requests. Read `http_req_duration`, `http_req_failed`, and the rate beside `http_reqs` in the final k6 summary. Thresholds require less than 1% request failure and more than 99% successful checks; these are smoke checks, not a client latency SLO. No latency threshold is invented for an unmeasured environment.

## Expected observations

- Ordinary `/orders` reads return bounded results; POST persists an order and its items atomically.
- The slow-query trace concentrates time in one database operation. PostgreSQL's query plan should show repeated item scans; actual duration depends on hardware, cache, and concurrent load.
- N+1 traces contain many sequential database spans. On local PostgreSQL the latency penalty may be modest even though the query-count problem is visible.
- The external-call trace contains a long HTTP child span corresponding to the fixture's delay.
- Prometheus counters increase, latency histograms populate, and process/runtime metrics remain available during load.
- k6 reports observed latency, failure rate, and throughput. Comparing runs requires the same environment, data, workload, and warm-up conditions.

## Development checks

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
docker compose config --quiet
pnpm test:smoke # Requires the running stack; creates one order
# After several seconds for trace export and metric scrapes:
docker compose exec -T demo-api node --input-type=module < apps/demo-api/test/telemetry.mjs
docker compose run --rm --no-deps --entrypoint /bin/promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose run --rm --no-deps otel-collector validate --config=/etc/otelcol/config.yaml
```

Strict TypeScript checking is configured; there is no separate lint configuration. See [verification](architecture/verification.md) for checks actually executed and their outcomes, and [decisions](architecture/decisions.md) for scope and tradeoffs.

## Security and operational scope

This toolkit is for controlled/local performance auditing. **Do not blindly expose it publicly.** Published ports bind to host loopback. Grafana permits anonymous Editor access for local Explore; there are no application accounts or authentication features. `.env.example` contains an explicitly disposable local password; real credentials belong in ignored `.env`, never source control. Internal OTLP is unencrypted.

Intentional slow endpoints consume resources, all traces are sampled, and seed data is synthetic. Collector buffering is in memory; a Collector restart can lose pending spans. Tempo retains local traces for 24 hours and Prometheus retains metrics for seven days. These are workstation defaults, not durability, capacity, or availability guarantees. Host/container-wide monitoring, database server metrics, alerting, and production hardening are outside this slice.

