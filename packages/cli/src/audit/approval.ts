import { Endpoint } from './config';

export interface AuditApprovalInput {
  target: string;
  endpoints: Endpoint[];
  profiles: string[];
  prompt: (message: string) => Promise<boolean>;
}

/** Shares one interactive consent when application restart and bounded load are both needed. */
export function createAuditApprovals(input: AuditApprovalInput): { approveLoad: () => Promise<boolean>; approveRestart: (service: string) => Promise<boolean> } {
  let granted = false;
  const request = async (service?: string) => {
    if (granted) return true;
    const targets = input.endpoints.map(endpoint => `  ${endpoint.method} ${endpoint.path}`).join('\n');
    const restart = service ? `\n\nThis may temporarily restart the local Node service "${service}" to enable audit instrumentation. No application source or Docker configuration will be modified.` : '';
    const accepted = await input.prompt(`PerfLens will audit:\n\n  Target: ${input.target}\n  Endpoints: ${input.endpoints.length}\n  Profiles: ${input.profiles.join(', ')}\n\n${targets}${restart}\n\nProceed? (y/N): `);
    granted = accepted;
    return accepted;
  };
  return { approveLoad: () => request(), approveRestart: service => request(service) };
}
