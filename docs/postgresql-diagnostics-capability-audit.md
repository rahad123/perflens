# Phase 7.3 PostgreSQL capability audit

## Existing capabilities and extension points

| Capability | Existing state before 7.3 | Phase 7.3 behavior | Evidence limits |
|---|---|---|---|
| PostgreSQL instrumentation | The generic Node preload enables OpenTelemetry PostgreSQL instrumentation before application modules load; Express and TypeORM consumers use the same trace pipeline. | Reused unchanged. | Coverage depends on sampled/exported traces and compatible instrumentation. |
| Operation spans and timing | Tempo snapshots already persisted sanitized spans with trace/span/parent IDs, profile, nanosecond start/end times, and PostgreSQL system attributes. | Report model derives duration, operation label, and references from those persisted spans. | Missing timestamps/system tags remain unavailable or unclassified. |
| Query shape | The Tempo importer already normalizes `db.query.text`, `db.statement`, or `pg.query:` span names with SQL literals removed. | Sanitized relation-bearing query shapes are used as report fingerprints; unidentifiable SQL stays operation-only. | No raw SQL or bind parameters are persisted by this extension. Fingerprints can be absent. |
| Request and endpoint correlation | Phase 3 groups spans by trace and correlated server request; parent span IDs are persisted. | Report walks parent chains first, then uses trace-only association only when one correlated request root exists. Ambiguous/unmatched spans are not assigned to an endpoint. | Trace-level association is weaker than a parent-chain association. Bounded/truncated snapshots reduce coverage. |
| Repeated query / likely N+1 | Phase 3 already detects repeated equivalent database operations within request traces and applies minimum-operation, trace-count, consistency, severity, and confidence rules. | Reused without threshold changes. Report separately displays within-trace repetition evidence and labels it a potential pattern, not proof of ORM-level N+1. | Intentional repetition, retries, and batching semantics are not inferred. A report candidate alone is not a finding. |
| Slow query evidence | Phase 3 already emits `database.slow-operation` only for a sanitized equivalent operation repeated across enough requests with median duration at least 100 ms. | Reused without threshold changes. Report adds measured per-query-shape count, mean, p95 when at least five samples exist, maximum, and top individual spans. | Short audits may not provide enough samples. A top individual span is an observation, not a universal slow-query diagnosis. |
| Database request-time contribution | Phase 3 computes a union of database span intervals clipped to the server request window, so overlapping spans are not double-counted for its contribution finding. | Reused unchanged. Report labels raw summed span durations as overlap-prone and does not call them exclusive wall-clock contribution. | Only Phase 3's interval-union result supports request-window contribution claims. |
| PostgreSQL operation errors | Earlier sanitized evidence did not persist OTel span status. | Tempo normalization now persists only `error` / `ok` / `unset` status codes when recognized; no status message or exception text is persisted. | Historical spans and exporters omitting status remain unknown; HTTP errors are not attributed to PostgreSQL. |
| Connection pool | No generic pool instrumentation or persisted active/idle/waiting/acquisition metrics exist. | Coverage remains `Not collected`. | A future safe adapter must use a supported client API without requiring consumer TypeORM configuration changes. |

## Evidence and privacy contract

The authoritative input is the immutable `analysis/evidence.json` snapshot already collected for the run. It contains sanitized trace spans scoped to the run and profile. Phase 7.3 adds an optional normalized span `status` enum for new evidence and derives `postgresDiagnostics` in `report.json` (`schemaVersion: 1`, report version 5). Historical schema-v1 evidence without status remains valid and yields unknown status coverage. No separate database polling or live Tempo query is performed while rendering reports.

Raw SQL literals, bind values, comments, exception text, and database namespaces are never copied into newly imported diagnostic evidence. Query shapes are produced by the bounded SQL lexer: literals and positional parameters become `?`, comments are removed, identifiers are NFC-normalized and limited to PostgreSQL identifier syntax and length, and token spacing is canonical. Conservative identifiers are retained because relation identity supports repeated-query grouping; they can reveal schema names and must not be used to encode secrets or customer values. Quoted identifiers containing escapes or other non-standard content, malformed strings/comments, unsupported punctuation, and unterminated dollar-quoted strings fail closed and produce no fingerprint. Database operation and system attributes are allowlisted; arbitrary exporter-supplied values are omitted. Shapes are escaped again at render time. Trace/span IDs are retained as evidence references. PostgreSQL errors are counted only from an explicit OpenTelemetry error status; neither HTTP 429 nor a generic failed HTTP request implies a database error.

## Phase 3 rule semantics reused

The analyzer's current rules remain the source of findings and severity:

- `database.repeated-operation`: at least 8 query-shaped database spans in an affected request, one equivalent fingerprint at least 5 times and at least 60% of those operations, repeated in at least 5 traces and at least 70% of analyzed requests.
- `database.slow-operation`: at least 5 equivalent spans across at least 5 traces, meeting the existing 70% consistency threshold and 100 ms median duration threshold.
- `database.time-dominance`: database span interval union meets the existing request-window impact, minimum-duration, and consistency thresholds. Overlaps count once.

Severity/confidence thresholds are unchanged. Phase 7.3 adds descriptive operation summaries and error-status evidence; it does not create a second findings engine. A within-trace repeat table can show evidence below the multi-trace Phase 3 finding threshold.

## Remaining gaps and sequence

Connection-pool metrics are not exposed by the current generic instrumentation and remain `Not collected`. Better pool visibility should be a separate, client-specific integration after a stable low-impact collection interface is established. Broader query-plan automation is out of scope: reports suggest investigating a plan in a safe environment only when an existing Phase 3 slow-operation finding exists. Redis and external dependency details remain future work.
