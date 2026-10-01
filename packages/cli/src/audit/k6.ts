import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, writeFile, constants } from 'node:fs/promises';
import { AuditConfig, durationMs, ProfileName } from './config';
import { Execute, execute, k6Environment } from './process';
import { CliError } from '../utils/errors';
export interface Plan {
  schemaVersion: 1; runId: string; profile: ProfileName; baseUrl: string;
  endpoints: AuditConfig['endpoints']; workload: AuditConfig['profiles'][ProfileName]; timeoutMs: number; summaryFile: string;
}
export class K6Runner {
  constructor(private readonly run: Execute = execute) {}
  async version(signal: AbortSignal): Promise<string> {
    const result = await this.run('k6', ['version'], { env: k6Environment(), timeoutMs: 10000, signal });
    // Summary adapter is verified against the existing k6 2.3 series, not arbitrary future formats.
    if (result.code !== 0 || !/k6 v2\.3\.\d+\b/.test(result.stdout)) throw new CliError('Audit requires k6 2.3.x on PATH.', 'Install the verified k6 2.3 series; the standalone Phase 1 Docker baseline is unchanged.');
    return result.stdout.trim();
  }
  async prepare(directory: string): Promise<void> {
    const source = [resolve(__dirname, '../../assets/audit.js'), resolve(__dirname, '../assets/audit.js')].find(existsSync);
    if (!source) throw new CliError('PerfLens could not locate its packaged k6 workload.', 'Reinstall the complete @perflens/cli package; no load was started.');
    await copyFile(source, join(directory, 'load-test.js'), constants.COPYFILE_EXCL);
    await writeFile(join(directory, 'k6-options.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  }
  async profile(directory: string, plan: Plan, signal: AbortSignal) {
    const planFile = join(directory, 'raw', `${plan.profile}.plan.json`);
    await writeFile(planFile, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
    return this.run('k6', [
      'run', '--quiet', '--no-color', '--no-usage-report', '--include-system-env-vars=false',
      '--config', join(directory, 'k6-options.json'), '--summary-mode=full',
      '--out', `json=${join(directory, 'raw', `${plan.profile}.samples.ndjson`)}`,
      '--env', `PERFLENS_PLAN=${planFile}`, join(directory, 'load-test.js'),
    ], {
      cwd: directory, env: k6Environment(), signal,
      timeoutMs: durationMs(plan.workload.duration) + plan.timeoutMs + plan.workload.paceMs + 15000,
      stdoutFile: join(directory, 'logs', `${plan.profile}.stdout.log`),
      stderrFile: join(directory, 'logs', `${plan.profile}.stderr.log`),
    });
  }
}
