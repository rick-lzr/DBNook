import { ProfileSchema, type ConnectionProfile } from '../../protocol/src/index.js';
export interface ProfileIssue { scope: 'global' | 'workspace'; index: number; code: 'invalid' | 'duplicate-id' | 'shadowed'; message: string; }
export function readProfileConfiguration(globalValue: unknown, workspaceValue: unknown): { profiles: ConnectionProfile[]; issues: ProfileIssue[] } {
  const profiles: ConnectionProfile[] = [], issues: ProfileIssue[] = [], blocked = new Set<string>();
  for (const [scope, input] of [['global', globalValue], ['workspace', workspaceValue]] as const) {
    if (input === undefined) continue;
    if (!Array.isArray(input)) { issues.push({ scope, index: -1, code: 'invalid', message: 'connections must be an array.' }); continue; }
    const ids = new Map<string, number>();
    for (const value of input) if (typeof value === 'object' && value && typeof value.id === 'string') ids.set(value.id, (ids.get(value.id) ?? 0) + 1);
    input.forEach((value, index) => {
      const parsed = ProfileSchema.safeParse(value);
      if (!parsed.success) {
        if (typeof value === 'object' && value && typeof value.id === 'string') blocked.add(value.id);
        issues.push({ scope, index, code: 'invalid', message: parsed.error.issues.map(issue => `${issue.path.join('.') || 'connection'}: ${issue.message}`).join('; ') }); return;
      }
      if (ids.get(parsed.data.id)! > 1) { blocked.add(parsed.data.id); issues.push({ scope, index, code: 'duplicate-id', message: `Duplicate connection ID: ${parsed.data.id}. Give every entry in this scope a unique ID.` }); return; }
      const previous = profiles.findIndex(profile => profile.id === parsed.data.id);
      if (previous >= 0) { profiles.splice(previous, 1); issues.push({ scope, index, code: 'shadowed', message: `Workspace connection ${parsed.data.id} overrides the global entry with the same ID.` }); }
      profiles.push({ ...parsed.data, scope });
    });
  }
  return { profiles: profiles.filter(profile => !blocked.has(profile.id)), issues };
}
