import { CliError } from '../utils/errors';
export const PROFILE_NAMES = ['baseline', 'normal', 'peak', 'stress'] as const;
export type ProfileName = typeof PROFILE_NAMES[number];
export interface Endpoint { method: 'GET'; path: string }
export interface Profile { vus: number; duration: string; paceMs: number }
export interface AuditConfig {
  endpoints: Endpoint[];
  timeoutMs: number;
  profiles: Record<ProfileName, Profile>;
}
export const DEFAULT_PROFILES: Record<ProfileName, Profile> = {
  baseline: { vus: 1, duration: '10s', paceMs: 500 },
  normal: { vus: 3, duration: '15s', paceMs: 500 },
  peak: { vus: 6, duration: '15s', paceMs: 500 },
  stress: { vus: 10, duration: '15s', paceMs: 500 },
};
function invalid(message: string): never { throw new CliError(message, 'Review audit configuration and the documented safety limits.', 2); }
function fields(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(`Invalid ${label} fields.`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}
export function durationMs(duration: unknown): number {
  if (typeof duration !== 'string' || !/^[1-9]\d?s$|^1[01]\ds$|^120s$/.test(duration)) invalid('Profile duration must be 1s–120s (whole seconds).');
  return Number(duration.slice(0, -1)) * 1000;
}
export function validateAudit(value: unknown): AuditConfig {
  const input = fields(value, ['endpoints', 'profiles', 'timeoutMs'], 'audit');
  if (!Array.isArray(input.endpoints) || input.endpoints.length < 1 || input.endpoints.length > 8) invalid('Configure 1–8 audit endpoints.');
  const endpoints = input.endpoints.map(item => {
    const endpoint = fields(item, ['method', 'path'], 'endpoint');
    if (endpoint.method !== 'GET') invalid('Phase 2 audit endpoints must use GET.');
    if (typeof endpoint.path !== 'string' || endpoint.path.length > 200 || !/^\/[a-zA-Z0-9._~/-]*$/.test(endpoint.path) || endpoint.path.includes('//') || endpoint.path.split('/').some(part => ['.', '..'].includes(part))) {
      invalid('Endpoint paths must be absolute paths without query, fragment, encoding, credentials, or dot segments.');
    }
    return { method: 'GET' as const, path: endpoint.path };
  });
  if (new Set(endpoints.map(e => e.path)).size !== endpoints.length) invalid('Duplicate audit endpoints are not allowed.');
  const overrides = input.profiles === undefined ? {} : fields(input.profiles, [...PROFILE_NAMES], 'profiles');
  const profiles = {} as Record<ProfileName, Profile>;
  for (const name of PROFILE_NAMES) {
    const custom = overrides[name] === undefined ? {} : fields(overrides[name], ['vus', 'duration', 'paceMs'], `profile ${name}`);
    const profile = { ...DEFAULT_PROFILES[name], ...custom };
    durationMs(profile.duration);
    profiles[name] = { vus: integer(profile.vus, 1, 50, 'VUs'), duration: profile.duration as string, paceMs: integer(profile.paceMs, 250, 5000, 'paceMs') };
  }
  return { endpoints, profiles, timeoutMs: integer(input.timeoutMs ?? 5000, 100, 15000, 'timeoutMs') };
}
export function selectProfiles(selection?: string): ProfileName[] {
  if (selection === undefined) return ['baseline', 'normal'];
  const names = selection.split(',').map(name => name.trim());
  if (!names.length || names.some(name => !PROFILE_NAMES.includes(name as ProfileName)) || new Set(names).size !== names.length) {
    throw new CliError('Invalid audit profile selection.', 'Use a comma-separated, non-duplicated selection of baseline,normal,peak,stress.', 2);
  }
  // Consistent low-to-high conceptual order, independent of flag ordering.
  return PROFILE_NAMES.filter(name => names.includes(name));
}
export function targetUrl(baseUrl: string, endpoint: Endpoint): string {
  return baseUrl.replace(/\/$/, '') + endpoint.path;
}
