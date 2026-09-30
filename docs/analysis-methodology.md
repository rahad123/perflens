# Phase 3 analysis methodology

PerfLens analyzes only completed Phase 2 runs. It does not run load, change application code, call external reasoning services, or infer a component cause from latency alone. Rules operate on normalized k6 results and trace spans correlated to the audit run ID and profile. Every finding states its rule ID and links its claims to source artifacts or a normalized trace snapshot.

## Analysis flow

```text
completed run.json + normalized profile results
                      +
Tempo traces matched by service.name, audit run ID, profile, and UTC window
                      ↓
sanitized analysis/evidence.json
                      ↓
versioned deterministic rules
                      ↓
analysis/findings.json + analysis/analysis.json
```

The CLI queries Tempo only on the first analysis when the run has no evidence snapshot. It uses the exact Phase 2 `perflens.audit.run_id` and `perflens.audit.profile` span attributes, along with the configured service name and profile time window. It fetches each matching trace and retains only the relevant same-service span evidence. Each profile query is capped at 500 traces; if Tempo returns more, `telemetry.truncated` is set and the result represents a bounded sample. There is no unscoped trace-history scan. An existing evidence snapshot is reused, so later analysis can run offline and is independent of live Tempo retention.

OpenTelemetry owns trace IDs and propagation. The PerfLens audit run ID is separate metadata. For the bundled demo, the preloaded HTTP instrumentation validates the audit headers and adds those two attributes to server spans. A custom target must implement equivalent capture to enable trace rules. Missing correlated traces do not invalidate load measurements; the result states that trace evidence was unavailable, and trace-based rules emit no finding.

## Supported rules and guards

All rule thresholds are centralized in `packages/analysis-engine/src/index.ts`. They are conservative initial values for this local toolkit, not universal SLOs. Configuration does not currently expose per-rule tuning.

| Rule | Minimum evidence and trigger | Interpretation |
| --- | --- | --- |
| `load.latency-degradation` | Two completed profile results for one identical single endpoint; both use the same recorded `constant-vus` executor, request pacing, timeout, and other supported test semantics; the later profile has strictly more configured VUs; at least 20 requests per result; p95 rises by both at least 30% and 25 ms. | Reports latency increased as configured concurrency increased. VU count is used only for this explicitly supported constant-VU model, not as a universal workload measure. It does not attribute a component cause or establish production saturation. |
| `load.error-degradation` | Same comparable-profile, endpoint, request-count, and increased-configured-VU guards; error rate rises by at least 2 percentage points. | Reports the measured failure-rate change only. |
| `load.throughput-degradation` | Same comparable-profile, endpoint, request-count, and increased-configured-VU guards; measured RPS decreases by at least 10%. | Reports an observed throughput decrease between comparable workloads, including both VU counts and RPS values. It does not establish CPU/database saturation, capacity limits, or a root cause. |
| `database.repeated-operation` | At least 5 correlated request traces in a profile; at least 70% show 8+ DB spans and one relation-bearing safe equivalent operation appears at least 5 times and represents at least 60% of that request's query-shaped DB spans. | Calls this a repeated database query pattern and a **likely N+1 pattern candidate**, not a confirmed code defect. Pattern detection is separate from impact: P1 requires at least 70% of all sampled requests to individually meet both the 50% request-window and 50 ms DB contribution guards; otherwise a repeated pattern is P2. |
| `database.time-dominance` | At least 5 request traces; in at least 70% the union of DB intervals accounts for at least 50% of the request interval and at least 50 ms absolute time. | Reports relative and absolute database activity; it does not imply missing indexes or pool exhaustion. Suppressed when a slow-operation finding for that same endpoint/profile already explains the dominant DB evidence. |
| `database.slow-operation` | A sanitized equivalent DB operation occurs at least 5 times across at least 5 traces and at least 70% of sampled requests, with median span duration at least 100 ms. | Reports recurrence, median and p95 span durations. It does not guess why the query is slow. |
| `dependency.latency-dominance` | At least 5 sampled requests; the dependency appears in at least 70% of requests; in at least 70% of all requests its overlap-safe interval union occupies at least 50% of the request window; median request-level contribution among affected requests is at least 100 ms. | Reports sanitized dependency identity and request-level median/p95 interval contribution. Calls are supporting counts only; they do not weight the request-level aggregate or severity. It does not claim ownership or root cause. |

Rules with fewer than the minimum sample or consistency requirements emit no finding. Confidence is `high` only with at least 20 traces and 90% consistency; evidence meeting the rule floor but not the high-confidence floor is `medium`. The implementation does not emit `low` confidence findings. Direct load-profile findings are high confidence only after their explicit request and profile-comparison checks.

When identical trace findings are consolidated across profiles, the reported confidence is the strongest individually supported profile confidence. Each profile's trace counts and measurements remain separately represented in `metrics.profileMetrics` and in the evidence list. Findings include up to ten Tempo trace IDs per affected profile as direct evidence references; the full normalized span snapshot remains available in `evidence.json`.

## Span timing calculation

For each sampled server request, database contribution is:

```text
duration(union of DB span intervals clipped to server span)
÷ duration(server span)
```

Intervals are sorted and overlapping/touching DB spans are merged before summation. This avoids double counting concurrent query spans and bounds the ratio to the request interval. It is an interval-occupancy estimate, not a critical-path reconstruction: DB spans may overlap other component work and therefore this ratio is not a claim that removing DB time would improve latency by the same amount.

Repeated-operation grouping uses the `pg.query:` span name when present, removes comments and literal/numeric values, lowercases and compacts whitespace. Generic operation labels such as `SELECT` alone are not enough to assert equivalent queries. No general SQL parser is used.

## Severity and confidence

Severity describes measured impact and uses centralized thresholds. Repeated-query pattern severity is distinct from pattern confidence:

- **P0:** measured error rate is at least 10%, p95 is at least 2 seconds, DB interval occupancy is at least 75% with at least 1 second median DB contribution, or dependency interval occupancy is at least 80% with at least 1 second median request contribution.
- **P1:** repeated-query pattern where at least 70% of requests individually meet both DB contribution thresholds; a qualifying slow-operation pattern; error-rate increase of at least 2 percentage points; p95 of at least 500 ms; DB interval occupancy of at least 50%; or dependency interval occupancy of at least 50% based on request-level medians.
- **P2:** measured load degradation that qualifies but does not cross the higher impact thresholds.

Severity and confidence answer different questions. Severity describes impact under this test; confidence describes how consistently and directly the evidence supports the rule. These are not production SLOs. A severe local result does not mean PerfLens has established production impact.

## Deduplication and limits

Trace findings with the same rule, target, and normalized operation/dependency are combined across profiles into one finding with per-profile evidence and metrics. When repeated-query evidence already qualifies for one endpoint/profile, a second DB time-dominance finding is omitted; its measured contribution remains supporting evidence on the repeated-operation finding. A recurring slow DB operation similarly takes precedence over a generic DB-dominance finding for the same endpoint/profile. Error, latency, and throughput change for the same profile pair are combined into the measured load finding instead of repeated as duplicate profile-pair findings.

Trace results are grouped by configured route for multi-endpoint audits. In a single-endpoint audit, run/profile correlation scopes all matched request traces to that configured endpoint even when the safe route template differs from a literal path such as `/orders/123`. Load result metrics aggregate all endpoints in a run; because Phase 2 does not persist per-endpoint latency histograms, endpoint-specific degradation analysis is skipped for multi-endpoint runs. Results from `/orders` and other endpoints are not falsely assigned to the first configured path.

The Phase 2 pipeline has no reliable per-run CPU, memory, event-loop, or database-pool snapshots. Resource saturation, connection-pool exhaustion, index recommendations, and other unsupported detectors are listed as unavailable in `analysis.json`. Prometheus is not used to invent these measurements.

## Sanitization and artifacts

The analysis snapshot keeps only safe span data needed by current rules: span IDs/times/kind, the run/profile markers on matching server spans, HTTP route/method/status fields, sanitized dependency identity, database system/operation/namespace, and normalized SQL shape. It does not persist raw URL query strings, URL credentials, authorization/cookie headers, request bodies, or raw `db.statement` values. Numeric/UUID path segments outside configured route prefixes are redacted. SQL literals and numeric values are normalized before storage. Resource identity is checked against the configured service.

Artifacts are JSON with `schemaVersion: 1`; the aggregate records `analysisVersion` and `ruleSetVersion`. `analysis/evidence.json` is the exact normalized input snapshot used by the rules, `findings.json` is the structured finding list, and `analysis.json` includes both run summary and unsupported evidence notes. Finding metrics preserve measured values; missing values stay null. Analysis can be repeated using the saved evidence without Tempo.

## Current boundaries

There is no N+1 certainty score, generic root-cause ranking, CPU or memory saturation detector, recommendation engine, report generator, before/after comparison, or automatic source modification. Trace schema varies across SDKs, so custom instrumentation may not provide sufficient safe query shapes for the DB repetition rule. A capped sample or short low-load audit can miss intermittent behavior; no finding is not a claim that the application has no bottlenecks.

Phase 4 reporting and richer recommendations remain future work.
