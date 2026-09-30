import { Command, CommanderError } from 'commander';
import { registerCommands } from './commands/register';
import { CliError, formatError } from './utils/errors';
const { version } = require('../package.json') as { version: string };
const program = new Command();
program.name('perflens').description('PerfLens — Backend Performance Audit CLI').version(version)
  .option('--config <path>', 'Path to perflens.config.json (otherwise search current directory and parents)')
  .option('--infra-dir <path>', 'PerfLens checkout containing the existing Docker Compose infrastructure')
  .showHelpAfterError().exitOverride();
registerCommands(program);
void program.parseAsync().catch(error => {
  if (error instanceof CommanderError) { process.exitCode = error.exitCode === 0 ? 0 : 2; return; }
  console.error(formatError(error));
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
