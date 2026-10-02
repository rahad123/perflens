export type Severity = 'P0' | 'P1' | 'P2';
export interface ReportProfile {
  name: string;
  startedAt: string | null;
  endedAt: string | null;
  observedDurationMs: number | null;
  workload: { executor: string | null; vus: number | null; durationMs: number | null; configured: Record<string, unknown> };
  metrics: Record<string, unknown>;
}
export interface ReportFinding {
  id: string; ruleId: string; category: string; title: string; summary: string;
  severity: Severity; confidence: 'high' | 'medium' | 'low';
  target: { method: string; path: string }; profiles: string[];
  evidence: { observation: string; source: string; value?: unknown }[];
  metrics: Record<string, unknown>;
}
export interface ReportModel {
  schemaVersion: 1; perflensVersion: string; reportVersion: 1; generatedAt: string;
  run: { id: string; target: string; method: string; path: string; endpoints: { method: string; path: string }[]; startedAt: string; completedAt: string; serviceName: string; loadEngine: { name: string | null; version: string | null } };
  workload: { profiles: ReportProfile[] };
  performanceSummary: { profiles: ReportProfile[] };
  findingsSummary: { total: number; bySeverity: Record<Severity, number> };
  findings: ReportFinding[];
  evidenceSummary: { requestTraces: number | null; databaseSpans: number | null; externalHttpSpans: number | null; traceAvailable: boolean; snapshotTraceCount: number | null; snapshotSpanCount: number | null; snapshotTruncated: boolean | null; profiles: string[] };
  limitations: string[];
}

function fail(message: string): never { throw new Error(message); }
function safeText(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '');
  return value
    .replace(/\bPERFLENS_TEST_SECRET_[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:proxy-)?authorization\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\r\n;,]+/gi, 'Authorization: [REDACTED]')
    .replace(/\b(?:set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi, 'Cookie: [REDACTED]')
    .replace(/\b((?:https?|postgres(?:ql)?|redis|rediss):\/\/)([^/\s?#@]*:[^/\s?#@]*@)/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|password|passwd|secret|token|client[_-]?secret|auth(?:orization)?)=)[^&#\s"'<>]*/gi, '$1[REDACTED]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*(['"])[^'"]*\2/gi, '$1=[REDACTED]')
    .replace(/\b(?:select|insert|update|delete)\b[\s\S]*/i, match => match.replace(/'(?:''|[^'])*'|\$[A-Za-z_0-9]*\$[\s\S]*?\$[A-Za-z_0-9]*\$/g, '?'));
}
function sanitize(value: unknown): any {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|cookie|password|secret|token|api[_-]?key|credential|request.?body/i.test(key)) continue;
      result[key] = sanitize(item);
    }
    return result;
  }
  return typeof value === 'string' ? safeText(value) : value;
}
function safeEndpointPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) fail('Analysis contains an invalid target path.');
  return value.split(/[?#]/, 1)[0].replace(/\/(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi, '/:id');
}
function safeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') fail('Audit run target is invalid.');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) fail('Audit run target protocol is unsupported.');
    return `${url.protocol}//${url.host}`;
  } catch { return fail('Audit run target URL is invalid.'); }
}
function finiteOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function validDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`Invalid ${label} in audit artifacts.`);
  return value;
}
function makeProfile(runProfile: any, result: any): ReportProfile {
  if (!result || result.schemaVersion !== 1 || result.status !== 'completed' || result.profile !== runProfile.name || !result.workload || !result.metrics) fail(`Profile evidence for ${String(runProfile?.name)} is missing or unsupported.`);
  const workload = result.workload;
  const metrics = sanitize(result.metrics) as Record<string, unknown>;
  const vus = finiteOrNull(workload.vus);
  const durationMs = finiteOrNull(workload.durationMs);
  const startedAt = typeof runProfile.startedAt === 'string' ? runProfile.startedAt : null;
  const endedAt = typeof runProfile.endedAt === 'string' ? runProfile.endedAt : null;
  return {
    name: safeText(runProfile.name), startedAt, endedAt,
    observedDurationMs: startedAt && endedAt && Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(endedAt)) ? Date.parse(endedAt) - Date.parse(startedAt) : null,
    workload: { executor: typeof workload.executor === 'string' ? safeText(workload.executor) : null, vus, durationMs, configured: sanitize(workload) },
    metrics,
  };
}
function validFinding(raw: any, target: { method: string; path: string }): ReportFinding {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.ruleId !== 'string' || typeof raw.category !== 'string' || typeof raw.title !== 'string' || typeof raw.summary !== 'string' || !['P0', 'P1', 'P2'].includes(raw.severity) || !['high', 'medium', 'low'].includes(raw.confidence) || !Array.isArray(raw.profiles) || !Array.isArray(raw.evidence) || !raw.metrics || typeof raw.metrics !== 'object') fail('Analysis findings artifact is malformed or unsupported.');
  const sanitized = sanitize(raw);
  const findingTarget = raw.target && typeof raw.target.method === 'string' && typeof raw.target.path === 'string'
    ? { method: safeText(raw.target.method), path: safeEndpointPath(raw.target.path) } : target;
  return {
    id: safeText(sanitized.id), ruleId: safeText(sanitized.ruleId), category: safeText(sanitized.category),
    title: safeText(sanitized.title), summary: safeText(sanitized.summary), severity: raw.severity,
    confidence: raw.confidence, target: findingTarget, profiles: raw.profiles.map(safeText).sort(),
    evidence: raw.evidence.map((item: any) => {
      if (!item || typeof item.observation !== 'string' || typeof item.source !== 'string') fail('Analysis evidence entry is malformed.');
      return { observation: safeText(item.observation), source: safeText(item.source), ...(item.value === undefined ? {} : { value: sanitize(item.value) }) };
    }), metrics: sanitize(raw.metrics),
  };
}

export function buildReportModel(input: { run: any; profiles: { runProfile: any; result: any }[]; analysis: any; findingsArtifact: any; evidence: any; generatedAt?: string; perflensVersion?: string }): ReportModel {
  const { run, analysis, findingsArtifact, evidence } = input;
  if (!run || run.schemaVersion !== 1 || run.status !== 'completed' || typeof run.runId !== 'string' || !Array.isArray(run.profiles)) fail('Only completed schema version 1 audit runs can be reported.');
  if (!analysis || analysis.schemaVersion !== 1 || analysis.runId !== run.runId || !Array.isArray(analysis.findings) || !analysis.traceSummary || !analysis.availability) fail('Analysis artifact is malformed or unsupported.');
  if (!findingsArtifact || findingsArtifact.schemaVersion !== 1 || findingsArtifact.runId !== run.runId || !Array.isArray(findingsArtifact.findings)) fail('Findings artifact is malformed or unsupported.');
  if (JSON.stringify(analysis.findings) !== JSON.stringify(findingsArtifact.findings)) fail('Analysis and findings artifacts disagree; refusing to generate a misleading report.');
  if (!evidence || evidence.schemaVersion !== 1 || evidence.runId !== run.runId || !Array.isArray(evidence.traces) || !evidence.telemetry) fail('Analysis evidence snapshot is malformed or unsupported.');
  const endpoints = input.profiles[0]?.result?.target?.endpoints ?? [];
  const first = endpoints[0];
  if (!first || typeof first.method !== 'string') fail('Audit run does not contain a supported endpoint target.');
  const safeEndpoints = endpoints.map((endpoint: any) => {
    if (!endpoint || typeof endpoint.method !== 'string') fail('Audit run contains an invalid endpoint target.');
    return { method: safeText(endpoint.method.toUpperCase()), path: safeEndpointPath(endpoint.path) };
  });
  const target = safeEndpoints[0];
  const endpointKey = (items: any[]) => JSON.stringify(items.map(item => `${String(item.method).toUpperCase()} ${safeEndpointPath(item.path)}`).sort());
  const expectedEndpoints = endpointKey(endpoints);
  if (input.profiles.some(item => !Array.isArray(item.result?.target?.endpoints) || endpointKey(item.result.target.endpoints) !== expectedEndpoints)) fail('Audit profile endpoint sets differ; report model does not currently support mixed targets.');
  const profiles = input.profiles.map(item => makeProfile(item.runProfile, item.result));
  const findings = findingsArtifact.findings.map((finding: any) => validFinding(finding, target)).sort((a: ReportFinding, b: ReportFinding) => ['P0', 'P1', 'P2'].indexOf(a.severity) - ['P0', 'P1', 'P2'].indexOf(b.severity) || a.ruleId.localeCompare(b.ruleId) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const bySeverity: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const finding of findings as ReportFinding[]) bySeverity[finding.severity]++;
  const limitations = [...new Set([...(Array.isArray(analysis.unsupported) ? analysis.unsupported.map(safeText) : []), ...(analysis.availability.traces ? [] : ['Trace evidence was unavailable for this analysis.']), 'This report contains only configured audit targets and does not represent untested production traffic.'])].sort();
  return {
    schemaVersion: 1, perflensVersion: safeText(input.perflensVersion ?? 'unknown'), reportVersion: 1, generatedAt: validDate(input.generatedAt ?? new Date().toISOString(), 'report generation timestamp'),
    run: { id: run.runId, target: safeBaseUrl(run.target?.baseUrl), method: target.method, path: target.path, endpoints: safeEndpoints, startedAt: validDate(run.startedAt, 'audit start time'), completedAt: validDate(run.endedAt, 'audit completion time'), serviceName: safeText(run.serviceName ?? analysis.target?.serviceName ?? 'unknown'), loadEngine: { name: typeof run.engine?.name === 'string' ? safeText(run.engine.name) : null, version: typeof run.engine?.version === 'string' ? safeText(run.engine.version) : null } },
    workload: { profiles }, performanceSummary: { profiles },
    findingsSummary: { total: findings.length, bySeverity }, findings,
    evidenceSummary: { requestTraces: finiteOrNull(analysis.traceSummary.requests), databaseSpans: finiteOrNull(analysis.traceSummary.databaseSpans), externalHttpSpans: finiteOrNull(analysis.traceSummary.externalClientSpans), traceAvailable: Boolean(analysis.availability.traces), snapshotTraceCount: finiteOrNull(evidence.telemetry.traceCount), snapshotSpanCount: finiteOrNull(evidence.telemetry.spanCount), snapshotTruncated: typeof evidence.telemetry.truncated === 'boolean' ? evidence.telemetry.truncated : null, profiles: profiles.map(profile => profile.name) },
    limitations,
  };
}

const escHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escMd = (text: string) => safeText(text).replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#!|])/g, '\\$1').replace(/\r?\n/g, ' ');
const value = (data: unknown): string => data === null || data === undefined ? 'Not available' : typeof data === 'number' ? String(data) : typeof data === 'object' ? JSON.stringify(data) : String(data);
const metric = (metrics: Record<string, any>, key: string) => metrics[key] === null || metrics[key] === undefined ? 'Not available' : String(metrics[key]);

export function renderMarkdown(model: ReportModel): string {
  const lines = ['# PerfLens Backend Performance Audit', '', `**Run:** ${escMd(model.run.id)}  `, `**Target:** ${escMd(model.run.target)}  `, `**Endpoint:** ${escMd(model.run.method)} ${escMd(model.run.path)}  `, `**Audit period:** ${escMd(model.run.startedAt)} – ${escMd(model.run.completedAt)}  `, `**Generated:** ${escMd(model.generatedAt)} · PerfLens ${escMd(model.perflensVersion)} · Report version ${model.reportVersion}`, '', '## Executive summary', ''];
  lines.push(model.findings.length ? `${model.findings.length} evidence-backed finding${model.findings.length === 1 ? '' : 's'} were identified: ${model.findingsSummary.bySeverity.P0} P0, ${model.findingsSummary.bySeverity.P1} P1, and ${model.findingsSummary.bySeverity.P2} P2.` : 'No evidence-backed performance bottleneck met the configured detection thresholds for this audit run.');
  lines.push('', '## Test scope', '', `Target service: ${escMd(model.run.serviceName)}. Load engine: ${escMd(model.run.loadEngine.name ?? 'Not available')} ${escMd(model.run.loadEngine.version ?? '')}. Configured endpoints: ${model.run.endpoints.map(endpoint => `${escMd(endpoint.method)} ${escMd(endpoint.path)}`).join(', ')}.`, '', '## Performance summary', '', '| Profile | Configured VUs | Configured duration (ms) | Observed duration (ms) | Max observed in-flight | Requests | Successful | Failed | Error rate | RPS | min (ms) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | max (ms) |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const profile of model.performanceSummary.profiles) {
    const metrics: any = profile.metrics; const latency: any = metrics.latencyMs ?? {};
    lines.push(`| ${escMd(profile.name)} | ${value(profile.workload.vus)} | ${value(profile.workload.durationMs)} | ${value(profile.observedDurationMs)} | ${value(metrics.concurrency?.maxObservedInFlight)} | ${metric(metrics, 'requests')} | ${metric(metrics, 'successfulRequests')} | ${metric(metrics, 'failedRequests')} | ${metric(metrics, 'errorRate')} | ${metric(metrics, 'rps')} | ${value(latency.min)} | ${value(latency.p50)} | ${value(latency.p90)} | ${value(latency.p95)} | ${value(latency.p99)} | ${value(latency.max)} |`);
  }
  if (model.run.endpoints.length > 1) {
    lines.push('', '## Endpoint comparison', '', '| Profile | Endpoint | Requests | RPS | Error rate | p50 (ms) | p95 (ms) | p99 (ms) | Findings |', '|---|---|---:|---:|---:|---:|---:|---:|---|');
    for (const profile of model.performanceSummary.profiles) for (const endpoint of (profile.metrics as any).endpointResults ?? []) {
      const target = endpoint.target, m = endpoint.metrics ?? {}, l = m.latencyMs ?? {};
      const related = model.findings.filter(finding => finding.target.method === target.method && finding.target.path === target.path).map(finding => `${finding.severity} ${finding.title}`);
      lines.push(`| ${escMd(profile.name)} | ${escMd(target.method)} ${escMd(target.path)} | ${value(m.requests)} | ${value(m.rps)} | ${value(m.errorRate)} | ${value(l.p50)} | ${value(l.p95)} | ${value(l.p99)} | ${related.length ? related.map(escMd).join('; ') : 'None'} |`);
    }
  }
  lines.push('', 'Configured workload values describe the test setup; the remaining columns describe observed results.', '', '## Findings summary', '');
  if (!model.findings.length) lines.push('No findings were recorded by Phase 3.');
  else for (const severity of ['P0', 'P1', 'P2'] as const) {
    const group = model.findings.filter(finding => finding.severity === severity); if (!group.length) continue;
    lines.push(`### ${severity}`, '');
    for (const finding of group) lines.push(`- **${escMd(finding.title)}** (${escMd(finding.category)}; ${escMd(finding.ruleId)}; confidence: ${finding.confidence.toUpperCase()}) — ${escMd(finding.summary)}`);
    lines.push('');
  }
  lines.push('## Detailed findings', '');
  if (!model.findings.length) lines.push('There are no Phase 3 findings to detail.', '');
  for (const finding of model.findings) {
    lines.push(`### ${escMd(finding.severity)} — ${escMd(finding.title)}`, '', `**Category:** ${escMd(finding.category)} · **Rule:** \`${escMd(finding.ruleId)}\` · **Confidence:** ${finding.confidence.toUpperCase()}  `, `**Target:** ${escMd(finding.target.method)} ${escMd(finding.target.path)} · **Profiles:** ${escMd(finding.profiles.join(', '))}`, '', '**What was observed**', '', escMd(finding.summary), '', '**Why the rule triggered / evidence**', '');
    for (const evidence of finding.evidence) lines.push(`- ${escMd(evidence.observation)} _(${escMd(evidence.source)})_`);
    lines.push('', '**Supporting measurements**', '', `\`${escMd(JSON.stringify(finding.metrics))}\``, '');
  }
  lines.push('## Evidence coverage', '', `- Request traces analyzed: ${value(model.evidenceSummary.requestTraces)}`, `- PostgreSQL spans analyzed: ${value(model.evidenceSummary.databaseSpans)}`, `- External HTTP spans analyzed: ${value(model.evidenceSummary.externalHttpSpans)}`, `- Persisted snapshot: ${value(model.evidenceSummary.snapshotTraceCount)} traces / ${value(model.evidenceSummary.snapshotSpanCount)} spans`, `- Snapshot truncated: ${value(model.evidenceSummary.snapshotTruncated)}`, `- Trace evidence available: ${model.evidenceSummary.traceAvailable ? 'Yes' : 'No'}`, `- Profiles: ${model.evidenceSummary.profiles.map(escMd).join(', ') || 'None'}`, '', '## Limitations', '');
  for (const limitation of model.limitations) lines.push(`- ${escMd(limitation)}`);
  lines.push('', '---', '', 'Generated by PerfLens. Findings and severity are carried from the persisted Phase 3 analysis; this report does not perform additional diagnosis.', '');
  return lines.join('\n');
}

export function renderHtml(model: ReportModel): string {
  const h = (v: unknown) => escHtml(safeText(typeof v === 'string' ? v : value(v)));
  const profileRows = model.performanceSummary.profiles.map(profile => { const m: any = profile.metrics; const latency: any = m.latencyMs ?? {}; return `<tr><th scope="row">${h(profile.name)}</th><td>${h(value(profile.workload.vus))}</td><td>${h(value(profile.workload.durationMs))}</td><td>${h(value(profile.observedDurationMs))}</td><td>${h(value(m.concurrency?.maxObservedInFlight))}</td><td>${h(metric(m, 'requests'))}</td><td>${h(metric(m, 'successfulRequests'))}</td><td>${h(metric(m, 'failedRequests'))}</td><td>${h(metric(m, 'errorRate'))}</td><td>${h(metric(m, 'rps'))}</td><td>${h(value(latency.min))}</td><td>${h(value(latency.p50))}</td><td>${h(value(latency.p90))}</td><td>${h(value(latency.p95))}</td><td>${h(value(latency.p99))}</td><td>${h(value(latency.max))}</td></tr>`; }).join('');
  const endpointRows = model.performanceSummary.profiles.flatMap(profile => ((profile.metrics as any).endpointResults ?? []).map((endpoint: any) => {
    const m = endpoint.metrics ?? {}, latency = m.latencyMs ?? {};
    const related = model.findings.filter(finding => finding.target.method === endpoint.target.method && finding.target.path === endpoint.target.path).map(finding => `${finding.severity} ${finding.title}`).join('; ') || 'None';
    return `<tr><th scope="row">${h(profile.name)}</th><td>${h(endpoint.target.method)} ${h(endpoint.target.path)}</td><td>${h(value(m.requests))}</td><td>${h(value(m.rps))}</td><td>${h(value(m.errorRate))}</td><td>${h(value(latency.p50))}</td><td>${h(value(latency.p95))}</td><td>${h(value(latency.p99))}</td><td>${h(related)}</td></tr>`;
  })).join('');
  const latencyValues = model.performanceSummary.profiles.flatMap(profile => {
    const latency = (profile.metrics as any).latencyMs ?? {};
    return ['p50', 'p95', 'p99'].map(key => typeof latency[key] === 'number' && Number.isFinite(latency[key]) && latency[key] >= 0 ? latency[key] as number : null);
  });
  const latencyMax = Math.max(0, ...latencyValues.filter((item): item is number => item !== null));
  const latencyChart = latencyMax > 0 ? `<svg class="chart" viewBox="0 0 900 ${Math.max(110, model.performanceSummary.profiles.length * 92 + 42)}" role="img" aria-label="p50, p95, and p99 latency by load profile"><text x="0" y="18" class="axis">Latency (milliseconds)</text>${model.performanceSummary.profiles.map((profile, index) => {
    const latency = (profile.metrics as any).latencyMs ?? {};
    const y = 42 + index * 92;
    const bars = (['p50', 'p95', 'p99'] as const).map((key, barIndex) => {
      const raw = latency[key];
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return '';
      const width = Math.min(710, raw / latencyMax * 710);
      const barY = y + barIndex * 22;
      return `<text x="0" y="${barY + 13}" class="axis">${h(key)}</text><rect x="64" y="${barY}" width="${width.toFixed(2)}" height="16" rx="3" class="${key}"/><text x="${Math.min(785, 72 + width)}" y="${barY + 13}" class="value">${h(raw)} ms</text>`;
    }).join('');
    return `<g><text x="830" y="${y + 15}" class="profile-label">${h(profile.name)}</text>${bars}</g>`;
  }).join('')}</svg>` : '<p class="subtle">Latency chart unavailable because no profile contains measured latency percentiles.</p>';
  const databaseFindings = model.findings.filter(finding => finding.category === 'database');
  const dependencyFindings = model.findings.filter(finding => finding.category === 'dependency');
  const evidenceCards = (items: ReportFinding[]) => items.map(finding => `<article class="evidence-card"><strong>${h(finding.severity)} · ${h(finding.title)}</strong><p>${h(finding.summary)}</p><ul>${finding.evidence.slice(0, 4).map(item => `<li>${h(item.observation)}</li>`).join('')}</ul></article>`).join('');
  const findings = model.findings.length ? model.findings.map(finding => `<article class="finding ${finding.severity.toLowerCase()}"><div class="finding-head"><span class="severity">${h(finding.severity)}</span><h3>${h(finding.title)}</h3><span class="confidence">${h(finding.confidence.toUpperCase())} confidence</span></div><p class="meta">${h(finding.category)} · <code>${h(finding.ruleId)}</code> · ${h(finding.target.method)} ${h(finding.target.path)} · ${h(finding.profiles.join(', '))}</p><h4>What was observed</h4><p>${h(finding.summary)}</p><h4>Evidence</h4><ul>${finding.evidence.map(item => `<li>${h(item.observation)} <span class="source">(${h(item.source)})</span></li>`).join('')}</ul><h4>Supporting measurements</h4><pre>${h(JSON.stringify(finding.metrics, null, 2))}</pre></article>`).join('') : '<p>No Phase 3 findings were recorded.</p>';
  const count = (severity: Severity) => model.findingsSummary.bySeverity[severity];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PerfLens Backend Performance Audit</title><style>
 .chart{display:block;width:100%;height:auto;max-height:500px}.chart .axis{font:12px system-ui;fill:var(--muted)}.chart .profile-label{font:12px system-ui;fill:var(--ink)}.chart .value{font:12px system-ui;fill:var(--ink)}.chart rect{fill:var(--blue)}.chart rect.p95{fill:#3682ad}.chart rect.p99{fill:#82b4cc}.evidence-card{background:var(--wash);border-left:4px solid var(--blue);padding:12px 16px;margin:12px 0}.evidence-card p{margin:6px 0}.evidence-card li{margin:4px 0}
:root{color-scheme:light;--ink:#17212b;--muted:#5d6a76;--line:#d8e0e6;--paper:#fff;--wash:#f3f6f8;--blue:#175b8e;--p0:#a62b2b;--p1:#986000;--p2:#315d75}*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1100px;margin:36px auto;background:var(--paper);padding:42px 52px;box-shadow:0 8px 32px #17212b12}header{border-bottom:3px solid var(--blue);padding-bottom:22px}header .brand{font-weight:800;letter-spacing:.08em;color:var(--blue);text-transform:uppercase;font-size:13px}h1{font-size:30px;margin:8px 0}h2{font-size:21px;margin-top:34px;border-bottom:1px solid var(--line);padding-bottom:8px}h3{font-size:18px;margin:0}h4{font-size:14px;margin:16px 0 4px}.meta,.subtle,.source{color:var(--muted)}.metadata{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:22px}.metadata div{background:var(--wash);padding:12px;border-radius:5px}.metadata strong{display:block;font-size:12px;color:var(--muted);text-transform:uppercase}.counts{display:flex;gap:10px;flex-wrap:wrap}.counts span{border:1px solid var(--line);padding:7px 12px;border-radius:4px}.counts b{margin-right:5px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}thead{background:var(--wash)}.finding{border:1px solid var(--line);border-left:5px solid var(--p2);padding:20px;margin:16px 0}.finding.p0{border-left-color:var(--p0)}.finding.p1{border-left-color:var(--p1)}.finding-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.severity{font-weight:800;color:var(--p2)}.p0 .severity{color:var(--p0)}.p1 .severity{color:var(--p1)}.confidence{margin-left:auto;color:var(--muted);font-size:13px}.finding li{margin:7px 0}code{overflow-wrap:anywhere;background:var(--wash);padding:2px 4px}footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}@media(max-width:700px){main{margin:0;padding:25px 18px}h1{font-size:25px}}@media print{body{background:#fff}main{margin:0;max-width:none;box-shadow:none;padding:0}.finding{break-inside:avoid}h2{break-after:avoid}}
</style></head><body><main><header><div class="brand">PerfLens</div><h1>Backend Performance Audit</h1><p class="subtle">A factual report generated from persisted audit measurements and Phase 3 findings.</p><div class="metadata"><div><strong>Run</strong>${h(model.run.id)}</div><div><strong>Target</strong>${h(model.run.target)}</div><div><strong>Endpoint</strong>${h(model.run.method)} ${h(model.run.path)}</div><div><strong>Audit period</strong>${h(model.run.startedAt)} – ${h(model.run.completedAt)}</div><div><strong>Report generated</strong>${h(model.generatedAt)}</div><div><strong>Service</strong>${h(model.run.serviceName)}</div></div></header>
<section><h2>Executive summary</h2><p>${model.findings.length ? `${h(model.findings.length)} evidence-backed finding(s) were identified.` : 'No evidence-backed performance bottleneck met the configured detection thresholds for this audit run.'}</p><div class="counts"><span><b class="severity">P0</b>${count('P0')}</span><span><b style="color:var(--p1)">P1</b>${count('P1')}</span><span><b style="color:var(--p2)">P2</b>${count('P2')}</span></div></section>
<section><h2>Test scope and performance overview</h2><p>Load engine: ${h(model.run.loadEngine.name ?? 'Not available')} ${h(model.run.loadEngine.version ?? '')}. Configured endpoints: <strong>${h(model.run.endpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`).join(', '))}</strong>. Configured workload values describe test setup; measurements describe observed results.</p><div class="table-wrap"><table><thead><tr><th>Profile</th><th>Configured VUs</th><th>Configured duration ms</th><th>Observed duration ms</th><th>Max in-flight</th><th>Requests</th><th>Success</th><th>Failed</th><th>Error rate</th><th>RPS</th><th>min ms</th><th>p50 ms</th><th>p90 ms</th><th>p95 ms</th><th>p99 ms</th><th>max ms</th></tr></thead><tbody>${profileRows}</tbody></table></div><h3>Latency by profile</h3>${latencyChart}</section>
${model.run.endpoints.length > 1 ? `<section><h2>Endpoint comparison</h2><p>Endpoint latency percentiles are calculated from raw per-request k6 samples for each route. Aggregate profile metrics above cover the full selected endpoint set.</p><div class="table-wrap"><table><thead><tr><th>Profile</th><th>Endpoint</th><th>Requests</th><th>RPS</th><th>Error rate</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Phase 3 finding</th></tr></thead><tbody>${endpointRows}</tbody></table></div></section>` : ''}
${databaseFindings.length ? `<section><h2>Database evidence</h2><p>PostgreSQL spans analyzed: ${h(value(model.evidenceSummary.databaseSpans))}. The following evidence is carried from Phase 3 findings.</p>${evidenceCards(databaseFindings)}</section>` : ''}${dependencyFindings.length ? `<section><h2>External dependency evidence</h2><p>External HTTP spans analyzed: ${h(value(model.evidenceSummary.externalHttpSpans))}. The following evidence is carried from Phase 3 findings.</p>${evidenceCards(dependencyFindings)}</section>` : ''}<section><h2>Detailed findings</h2>${findings}</section><section><h2>Evidence coverage</h2><ul><li>Request traces analyzed: ${h(value(model.evidenceSummary.requestTraces))}</li><li>PostgreSQL spans analyzed: ${h(value(model.evidenceSummary.databaseSpans))}</li><li>External HTTP spans analyzed: ${h(value(model.evidenceSummary.externalHttpSpans))}</li><li>Persisted snapshot: ${h(value(model.evidenceSummary.snapshotTraceCount))} traces / ${h(value(model.evidenceSummary.snapshotSpanCount))} spans</li><li>Snapshot truncated: ${h(value(model.evidenceSummary.snapshotTruncated))}</li><li>Trace evidence available: ${model.evidenceSummary.traceAvailable ? 'Yes' : 'No'}</li><li>Profiles: ${h(model.evidenceSummary.profiles.join(', ') || 'None')}</li></ul></section><section><h2>Limitations</h2><ul>${model.limitations.map(item => `<li>${h(item)}</li>`).join('')}</ul></section><footer>Generated by PerfLens ${h(model.perflensVersion)} · Report version ${model.reportVersion}. Findings, severity, and confidence are carried from the persisted Phase 3 analysis. This report does not perform additional diagnosis.</footer></main></body></html>`;
}
