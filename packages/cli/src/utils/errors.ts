export class CliError extends Error {
  constructor(message: string, readonly remediation: string, readonly exitCode = 1) {
    super(message);
  }
}
export function formatError(error: unknown): string {
  if (error instanceof CliError) return `✗ ${error.message}\n${error.remediation}`;
  return `✗ PerfLens could not complete the command.\n${error instanceof Error ? error.message : String(error)}`;
}
