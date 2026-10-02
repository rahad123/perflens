import { dirname, join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { analyze } from '../analysis/service';
import { report } from '../report/service';
import { listRuns } from '../audit/storage';
import { Command } from 'commander';
import { initialize, loadProject } from '../config/project';
import { doctor, Options } from '../services/doctor';
import { assertLocalDocker, Infrastructure } from '../services/infrastructure';
import { infrastructureRoot, LABELS, otlpTracesEndpoint } from '../services/workspace';
import { runCompleteAudit } from '../audit/orchestrator';
import { ensureProjectForAudit } from '../services/onboarding';

export function registerCommands(program: Command): void {
  program.command('init').description('Guided onboarding for a local backend project; never rewrites application code')
    .action(async () => {
      let projectName = 'backend'; let express = false;
      try {
        const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Expected a JSON object.');
        projectName = String(pkg.name ?? projectName).split('/').pop() || projectName;
        express = Boolean(pkg.dependencies?.express || pkg.devDependencies?.express);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot inspect package.json: ${error instanceof Error ? error.message : String(error)}`);
      }
      let baseUrl: string | undefined, endpoint: string | undefined;
      let existingConfig = false;
      try { await access(join(process.cwd(), 'perflens.config.json')); existingConfig = true; } catch { /* first initialization */ }
      if (!existingConfig && stdin.isTTY && stdout.isTTY) {
        const prompt = createInterface({ input: stdin, output: stdout });
        try {
          baseUrl = (await prompt.question(`Local API URL [http://localhost:3000]: `)).trim() || 'http://localhost:3000';
          endpoint = (await prompt.question('GET endpoint to audit [/health]: ')).trim() || '/health';
        } finally { prompt.close(); }
      }
      const result = await initialize(process.cwd(), { projectName, baseUrl, endpoint });
      console.log(`${result.created ? 'Created' : 'Found and preserved'} ${result.path}\n${result.created ? 'Created' : 'Verified'} .perflens/{runs,results,logs}. No application source or dependencies were changed.`);
      const initializedProject = await loadProject(result.path);
      const root = await infrastructureRoot(undefined, dirname(result.path), initializedProject.config.target.baseUrl);
      console.log(`OTLP traces endpoint: ${await otlpTracesEndpoint(root)} (the PerfLens Node bootstrap configures this automatically).`);
      console.log(express ? 'Express project detected.' : 'Node project detected where package.json is present; framework support is not inferred.');
      let bootstrapped = false;
      for (const file of ['src/perflens-instrumentation.ts', 'src/perflens-instrumentation.js', 'src/instrumentation.ts', 'src/instrumentation.js', 'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'index.js', 'server.js']) {
        try { const source = await readFile(join(process.cwd(), file), 'utf8'); if (/startNodeInstrumentation/.test(source)) { bootstrapped = true; break; } } catch { /* candidate entry file missing */ }
      }
      if (bootstrapped) console.log('OpenTelemetry bootstrap reference found in a common entrypoint.');
      else console.log('Instrumentation is not confirmed. For Express, preload startExpressInstrumentation from @perflens/cli/express-instrumentation before importing Express or database clients. Generic Node apps can use startNodeInstrumentation from @perflens/cli/instrumentation.');
      console.log('Routes /health and /metrics are excluded from traced request analysis. Use representative business GET routes in audit.endpoints.');
      console.log('Next: verify target.baseUrl and audit.endpoints in perflens.config.json, start your API, then run npx perflens audit.');
    });
  program.command('doctor').description('Check local prerequisites, configuration, ports, and existing infrastructure')
    .action(async () => { if (!await doctor(program.opts<Options>())) process.exitCode = 1; });
  program.command('audit').description('Run a bounded local audit, collect telemetry, analyze evidence, and generate reports')
    .option('--profile <names>', 'Comma-separated baseline,normal,peak,stress; default: baseline,normal')
    .option('--yes', 'Explicitly authorize load against all configured local GET endpoints (for non-interactive use)')
    .action(async (options: { profile?: string; yes?: boolean }) => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const globalOptions = program.opts<Options>();
        const setup = await ensureProjectForAudit(process.cwd(), globalOptions.config, stdin.isTTY && stdout.isTTY
          ? async (question, defaultValue) => {
            const prompt = createInterface({ input: stdin, output: stdout });
            try { const answer = await prompt.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `); return answer || defaultValue || ''; }
            finally { prompt.close(); }
          }
          : undefined);
        if (setup.created) {
          console.log(`First-time setup created ${setup.path} for ${setup.projectName}.`);
          console.log(setup.framework === 'express' ? 'Express project detected.' : setup.framework === 'node' ? 'Node project detected; framework support is not inferred.' : 'Project framework could not be determined from package.json.');
          console.log('No application source or dependencies were changed.');
        }
        const project = await loadProject(globalOptions.config);
        const endpoints = project.config.audit?.endpoints ?? [];
        if (endpoints.length > 1) {
          console.log(`PerfLens will run bounded local load against:\n${endpoints.map(endpoint => `  GET ${endpoint.path}`).join('\n')}\nProfiles: ${(options.profile ?? 'baseline,normal').split(',').join(', ')}`);
          if (!options.yes) {
            if (!stdin.isTTY || !stdout.isTTY) throw new Error('Multiple configured endpoints require interactive approval. Rerun with --yes only after reviewing the endpoint list. No load was started.');
            const prompt = createInterface({ input: stdin, output: stdout });
            try { if (!/^y(?:es)?$/i.test((await prompt.question('Proceed? (y/N): ')).trim())) throw new Error('Endpoint load-test permission was not granted. No load was started.'); }
            finally { prompt.close(); }
          }
        } else if (endpoints.length === 1) console.log(`Selected endpoint: GET ${endpoints[0].path}`);
        await runCompleteAudit({ ...globalOptions, ...options, confirmMultipleEndpoints: options.yes || endpoints.length <= 1 || (stdin.isTTY && stdout.isTTY) }, abort.signal);
      }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    });
  program.command('runs').description('List local stored audit runs without modifying them')
    .action(async () => {
      const project = await loadProject(program.opts<Options>().config);
      const runs = await listRuns(dirname(project.path));
      console.log(runs.length ? 'RUN ID  STATUS  STARTED' : 'No audit runs found.');
      for (const run of runs) console.log(`${run.id}  ${run.status}  ${run.startedAt}`);
    });
  program.command('analyze [run-id]').description('Analyze a completed audit run using measured results and correlated local traces')
    .option('--offline', 'Use a previously saved telemetry evidence snapshot; do not query Tempo')
    .action(async (runId: string | undefined, options: { offline?: boolean }) => {
      await analyze({ ...program.opts<Options>(), ...options }, runId);
    });
  program.command('report [run-id]').description('Generate Markdown and HTML from a completed run and its persisted Phase 3 analysis')
    .option('--format <format>', 'Output format: all, markdown, or html', 'all')
    .action(async (runId: string | undefined, options: { format?: string }) => {
      await report({ ...program.opts<Options>(), ...options }, runId);
    });
  const infra = program.command('infra').description('Control local audit infrastructure; target application remains separate');
  async function service(): Promise<Infrastructure> {
    const options = program.opts<Options>();
    let cwd = process.cwd(), baseUrl = 'http://localhost:3000';
    try { const project = await loadProject(options.config); cwd = dirname(project.path); baseUrl = project.config.target.baseUrl; } catch { /* `infra` can bootstrap before init using the safe loopback default. */ }
    const root = await infrastructureRoot(options.infraDir, cwd, baseUrl);
    await assertLocalDocker();
    return new Infrastructure(root);
  }
  infra.command('up').description('Start Collector, Tempo, Prometheus, and Grafana; wait for readiness')
    .action(async () => {
      const control = await service();
      console.log('Starting PerfLens infrastructure (first image pulls may take several minutes)...');
      const config = await control.up();
      for (const label of Object.values(LABELS)) console.log(`✓ ${label} ready`);
      console.log('PerfLens infrastructure is ready.');
      for (const name of ['grafana', 'prometheus']) {
        for (const port of config.services[name].ports ?? []) console.log(`${LABELS[name]}: http://${port.host_ip === '::1' ? '[::1]' : '127.0.0.1'}:${port.published}`);
      }
      console.log(`OTLP traces endpoint: ${await otlpTracesEndpoint(control.root)}`);
      for (const port of config.services.tempo.ports ?? []) console.log(`Tempo query API: http://${port.host_ip === '::1' ? '[::1]' : '127.0.0.1'}:${port.published}`);
      console.log('The target application and its database are started separately.');
    });
  infra.command('status').description('Show stopped, ready, or not-ready infrastructure services')
    .action(async () => {
      console.log('PerfLens Infrastructure');
      const control = await service();
      const states = await control.status();
      for (const state of states) console.log(`${LABELS[state.service].padEnd(20)} ${state.state}`);
      console.log(`OTLP traces endpoint: ${await otlpTracesEndpoint(control.root)}`);
      if (states.some(s => s.failed)) process.exitCode = 1;
    });
  infra.command('down').description('Stop only audit infrastructure; preserve containers, volumes, and target services')
    .action(async () => { await (await service()).down(); console.log('PerfLens infrastructure stopped. Persistent volumes and target services preserved.'); });
}
