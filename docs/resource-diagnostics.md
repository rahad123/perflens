# CPU and memory diagnostics

Phase 7.2 adds bounded, run-scoped CPU and memory observations for supported Node.js applications and the selected Docker Compose backend service. It does not add CPU or memory bottleneck findings.

## Process samples

The package preload reads a small PerfLens-owned `phase.json` marker at one-second intervals. It samples only while the marker has a valid audit run ID and an active supported profile. It records `process.cpuUsage()` deltas against `process.hrtime.bigint()` elapsed time and `process.memoryUsage()` values. It does not inspect requests, environment variables, or application payloads.

Process CPU percent is:

```text
(user CPU microseconds + system CPU microseconds) / elapsed microseconds × 100
```

This is normalized to **one logical CPU**. A process using two logical CPUs continuously can exceed 100%. It is not host-wide CPU utilization and is not container-quota-normalized. RSS, heap used, heap total, and external memory are persisted in bytes and displayed in MiB. Samples include both the OS PID and an ID for the lifetime of the sampler process. A changed PID/instance ID proves that distinct Node processes sampled, but does not distinguish a worker from a restart. The instance ID also prevents a reused PID from being mistaken for a continuous process when measuring RSS window change.

For host-run applications, the supported PerfLens Node preload must already run before the app modules and use the consumer project as its working directory. PerfLens cannot safely inject this into an arbitrary already-running host process. If those conditions are not met, process coverage is reported as unavailable/not collected rather than estimated.

## Container samples

When runtime detection identifies a Docker Compose Node application service, the CLI samples Docker stats for that exact selected container while a profile runs. It records Docker-reported CPU percentage, memory used, selected container identity, observed host logical CPU count, configured CPU quota where available, and configured memory limit where finite. Other Compose services are not sampled. Docker CPU is shown on Docker's reported host logical CPU basis; the report does not convert it to quota utilization. An unlimited or unknown memory limit remains unavailable. When a finite configured memory limit is known, the report derives peak observed memory as a percentage of that limit; it does not infer pressure from the percentage.

Container sampling is optional. If the Docker engine or stats endpoint cannot provide measurements, the run continues and records the container metrics as unavailable.

## Persistence and report semantics

Each audit stores `resources/evidence.json` with `schemaVersion: 1`, the run ID, a one-second interval, explicit collection status, and samples tagged by run ID, profile, timestamp, source, process lifetime where available, units, and normalization. Raw samples are retained separately in the same run artifact. Reports without this file remain readable and mark resources Not collected. Partial evidence is not filled with zeroes. CPU averages require at least two valid samples; memory summaries can use a single observed sample, with the sample count visible.

The sampler marks the first CPU delta after a run/profile marker change unavailable because its interval could straddle the boundary. It still records the point-in-time memory observation with the new profile. This keeps CPU deltas from inactive time or a preceding profile out of the next profile's summary; very short profiles may consequently have insufficient CPU evidence.

Per-profile Node CPU/RSS/heap averages are arithmetic means of individual process sample observations; peaks are the largest observation from one process. They are not summed service totals. The report shows how many process lifetimes contributed and keeps each process lifetime as a separate SVG series rather than connecting samples from different processes. RSS window change is only shown when samples identify one process lifetime; otherwise it is unavailable because the evidence does not establish continuity. Older artifacts without the lifetime ID use PID to count distinct observed identities, but do not support an RSS continuity calculation.

CLI and HTML reports show baseline/normal (and any other executed profile) summaries, including average/peak container memory and process external-memory observations. HTML line charts are inline SVG generated from the persisted samples, with numerical tables alongside them; they work offline. Existing Phase 3 findings and severity are unchanged. 7.2 adds no resource-pressure rule: high CPU or memory measurements alone do not prove saturation, a memory leak, or root cause. Resource findings require a later phase to define justified thresholds, sample duration, normalization, and confidence semantics.

## Limits

Sampling is approximately one hertz and bounded to 3,600 samples per source in a run. Very short profiles may have too few CPU samples to summarize. Docker CPU values are not quota-normalized. Host-run resource collection depends on the supported preload being active early and the project working directory matching the configured consumer. No host-wide CPU, GPU, cgroup pressure, garbage-collection pause, or memory leak diagnosis is provided. Metrics correlate with profile windows; they do not establish causation.
