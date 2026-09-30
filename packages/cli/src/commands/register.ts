import { dirname } from 'node:path';
import { analyze } from '../analysis/service';
import { report } from '../report/service';
import { audit } from '../audit/service';
import { listRuns } from '../audit/storage';
import { loadProject } from '../config/project';
import { Command } from 'commander';
import { initialize } from '../config/project';
import { doctor, Options } from '../services/doctor';
import { assertLocalDocker, Infrastructure } from '../services/infrastructure';
import { infrastructureRoot, LABELS } from '../services/workspace';

export function registerCommands(program: Command): void {
  program.command('init').description('Create a local project config and .perflens working directories; never overwrite')
    .action(async () => { console.log(`Created ${await initialize()}\nCreated .perflens/{runs,results,logs}. No application source was modified.`); });
  program.command('doctor').description('Check local prerequisites, configuration, ports, and existing infrastructure')
    .action(async () => { if (!await doctor(program.opts<Options>())) process.exitCode = 1; });
  program.command('audit').description('Run bounded local GET load profiles and store measurements (no root-cause analysis)')
    .option('--profile <names>', 'Comma-separated baseline,normal,peak,stress; default: baseline,normal')
    .action(async (options: { profile?: string }) => {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try { await audit({ ...program.opts<Options>(), ...options }, abort.signal); }
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
    const root = await infrastructureRoot(program.opts<Options>().infraDir);
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
      for (const port of config.services.tempo.ports ?? []) console.log(`Tempo query API: http://${port.host_ip === '::1' ? '[::1]' : '127.0.0.1'}:${port.published}`);
      console.log('The target application and its database are started separately.');
    });
  infra.command('status').description('Show stopped, ready, or not-ready infrastructure services')
    .action(async () => {
      console.log('PerfLens Infrastructure');
      const states = await (await service()).status();
      for (const state of states) console.log(`${LABELS[state.service].padEnd(20)} ${state.state}`);
      if (states.some(s => s.failed)) process.exitCode = 1;
    });
  infra.command('down').description('Stop only audit infrastructure; preserve containers, volumes, and target services')
    .action(async () => { await (await service()).down(); console.log('PerfLens infrastructure stopped. Persistent volumes and target services preserved.'); });
}
