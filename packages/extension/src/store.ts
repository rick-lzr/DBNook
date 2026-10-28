import * as vscode from 'vscode';
import type { ProfileStore } from '../../core/src/connections.js';
import { ProfileSchema, type ConnectionProfile } from '../../protocol/src/index.js';
import { readProfileConfiguration, type ProfileIssue } from '../../core/src/profile-configuration.js';
import { commitProfileSettings, type SettingWrite } from '../../core/src/profile-write.js';

export class VscodeProfileStore implements ProfileStore {
  private lastReport = '';
  private issues: ProfileIssue[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private mutate(action: ()=>Promise<void>): Promise<void> { const result=this.pending.then(action);this.pending=result.catch(()=>{});return result; }
  constructor(private report: (message: string) => void) {}
  list(): ConnectionProfile[] {
    const inspect = vscode.workspace.getConfiguration('dbWorkbench').inspect<unknown[]>('connections');
    const result = readProfileConfiguration(inspect?.globalValue, inspect?.workspaceValue); this.issues = result.issues;
    const signature = JSON.stringify(result.issues); if (signature !== this.lastReport) { this.lastReport = signature; for (const issue of result.issues) if (issue.code !== 'shadowed') this.report(`Connection settings (${issue.scope}, row ${issue.index + 1}): ${issue.message}`); }
    return result.profiles;
  }
  diagnostics(): ProfileIssue[] { this.list(); return [...this.issues]; }
  allProfiles():ConnectionProfile[]{const inspect=vscode.workspace.getConfiguration('dbWorkbench').inspect<unknown[]>('connections');return [inspect?.globalValue,inspect?.workspaceValue].flatMap(values=>Array.isArray(values)?values.flatMap(value=>{const parsed=ProfileSchema.safeParse(value);return parsed.success?[parsed.data]:[];}):[]);}
  save(profile: ConnectionProfile): Promise<void> { return this.mutate(()=>this.saveProfile(profile)); }
  private async saveProfile(profile: ConnectionProfile): Promise<void> {
    if (profile.scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace before saving a workspace connection.');
    const configuration = vscode.workspace.getConfiguration('dbWorkbench');
    const inspected = configuration.inspect<ConnectionProfile[]>('connections');
    const original = profile.scope === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue;
    const previousOther = profile.scope === 'workspace' ? inspected?.globalValue : inspected?.workspaceValue;
    if (original !== undefined && !Array.isArray(original)) throw new Error('Fix the connections array in the selected settings scope before saving.');
    const hasId = (value: unknown): boolean => typeof value === 'object' && value !== null && (value as { id?: unknown }).id === profile.id;
    for (const values of [inspected?.globalValue, inspected?.workspaceValue]) if (Array.isArray(values)) {
      const matching = values.filter(hasId); if (matching.length > 1 || matching.some(value => !ProfileSchema.safeParse(value).success)) throw new Error('Fix duplicate or invalid configurations for this connection ID before saving.');
    }
    const scope=profile.scope;
    const writes: SettingWrite[]=[{scope,before:original,after:[...(original??[]).filter(value=>!hasId(value)),profile]}];
    if(Array.isArray(previousOther)&&previousOther.some(hasId))writes.push({scope:scope==='workspace'?'global':'workspace',before:previousOther,after:previousOther.filter(value=>!hasId(value))});
    await commitProfileSettings(writes,(scope,value)=>configuration.update('connections',value,scope==='workspace'?vscode.ConfigurationTarget.Workspace:vscode.ConfigurationTarget.Global));
  }
  remove(id: string): Promise<void> { return this.mutate(()=>this.removeProfile(id)); }
  private async removeProfile(id: string): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('dbWorkbench');
    const inspected = configuration.inspect<ConnectionProfile[]>('connections');
    const hasId = (value: unknown): boolean => typeof value === 'object' && value !== null && (value as { id?: unknown }).id === id;
    const writes: SettingWrite[]=[];
    if(Array.isArray(inspected?.globalValue)&&inspected.globalValue.some(hasId))writes.push({scope:'global',before:inspected.globalValue,after:inspected.globalValue.filter(value=>!hasId(value))});
    if(Array.isArray(inspected?.workspaceValue)&&inspected.workspaceValue.some(hasId))writes.push({scope:'workspace',before:inspected.workspaceValue,after:inspected.workspaceValue.filter(value=>!hasId(value))});
    await commitProfileSettings(writes,(scope,value)=>configuration.update('connections',value,scope==='workspace'?vscode.ConfigurationTarget.Workspace:vscode.ConfigurationTarget.Global));
  }
}
