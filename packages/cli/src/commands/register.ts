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
