import { z } from 'zod';
import type { ConnectionProfile, SchemaObject } from '../../protocol/src/index.js';
import type { ConnectionManager } from './connections.js';

export const FavoriteSchema = z.object({ profileId: z.string().min(1).max(100), name: z.string().min(1).max(10000), type: z.enum(['table', 'view']) }).strict();
export type ConnectionFavorite = z.infer<typeof FavoriteSchema>;
interface Preferences {
  favorites(): unknown[]; saveFavorites(values: ConnectionFavorite[]): PromiseLike<void>;
  groupOrder(): string[]; saveGroupOrder(values: string[]): PromiseLike<void>;
}
export function matchesConnection(profile: ConnectionProfile, text: string): boolean {
  const haystack = `${profile.name} ${profile.group} ${profile.path} ${profile.driver} ${profile.host ?? ''} ${profile.database ?? ''} ${profile.user ?? ''}`.toLowerCase();
  return text.toLowerCase().trim().split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}
export function orderedGroups(names: string[], order: string[]): string[] {
  const positions = new Map([...new Set(order)].map((name, index) => [name, index]));
  return [...new Set(names.filter(Boolean))].sort((first, second) => (positions.get(first) ?? Infinity) - (positions.get(second) ?? Infinity) || first.localeCompare(second));
}
export function matchesObject(name: string, input: string): boolean {
  if (!input.trim()) return true;
  if (input.length > 200) throw new Error('Use at most 200 characters for an object filter.');
  let pattern = input.trim(), invert = false;
  if (/^(?:NOT\s+)?LIKE$/i.test(pattern)) throw new Error('Enter a pattern after LIKE.');
  if (/^NOT\s+LIKE\s+/i.test(pattern)) { invert = true; pattern = pattern.replace(/^NOT\s+LIKE\s+/i, ''); }
  else pattern = pattern.replace(/^LIKE\s+/i, '');
  if (pattern.startsWith("'")) { if (!pattern.endsWith("'") || pattern.length < 2) throw new Error('Close the quoted LIKE pattern.'); pattern = pattern.slice(1, -1).replaceAll("''", "'"); }
  const tokens: { type: 'any' | 'one' | 'literal'; value?: string }[] = [];
  const source = Array.from(pattern.toLowerCase());
  for (let index = 0; index < source.length; index++) {
    const value = source[index]!;
    if (value === '\\') { const escaped = source[++index]; if (escaped === undefined) throw new Error('The LIKE pattern ends with an incomplete escape.'); tokens.push({ type: 'literal', value: escaped }); }
    else tokens.push(value === '%' ? { type: 'any' } : value === '_' ? { type: 'one' } : { type: 'literal', value });
  }
  const text = Array.from(name.toLowerCase()); let previous = Array<boolean>(text.length + 1).fill(false); previous[0] = true;
  for (const token of tokens) {
    const current = Array<boolean>(text.length + 1).fill(false); if (token.type === 'any') current[0] = previous[0]!;
    for (let index = 1; index <= text.length; index++) current[index] = token.type === 'any' ? previous[index]! || current[index - 1]! : previous[index - 1]! && (token.type === 'one' || token.value === text[index - 1]);
    previous = current;
  }
  return invert ? !previous[text.length] : previous[text.length]!;
}
export class ConnectionOrganization {
  filter = '';
  private objectFilters = new Map<string, string>();
  constructor(private manager: ConnectionManager, private preferences: Preferences, private changed: () => void = () => {}) {}
  profiles(): ConnectionProfile[] { return this.manager.profiles().filter(profile => matchesConnection(profile, this.filter)); }
  groups(): string[] { return orderedGroups(this.manager.profiles().map(profile => profile.group), this.preferences.groupOrder()); }
  setFilter(value: string): void { this.filter = value.trim(); this.changed(); }
  objectFilter(profileId: string): string { return this.objectFilters.get(profileId) ?? ''; }
  setObjectFilter(profileId: string, value: string): void { this.manager.profile(profileId); matchesObject('', value); if (value.trim()) this.objectFilters.set(profileId, value.trim()); else this.objectFilters.delete(profileId); this.changed(); }
  async group(ids: string[], group: string): Promise<void> {
    group = group.trim(); if (group.length > 120) throw new Error('Group names must be at most 120 characters.');
    const values = [...new Set(ids)].map(id => ({ ...this.manager.profile(id), group }));
    for (const profile of values) await this.manager.save(profile); this.changed();
  }
  async renameGroup(before: string, after: string): Promise<void> {
    if (!after.trim()) throw new Error('Enter a group name.');
    await this.group(this.manager.profiles().filter(profile => profile.group === before).map(profile => profile.id), after);
    await this.preferences.saveGroupOrder([...new Set(this.preferences.groupOrder().map(name => name === before ? after.trim() : name))]); this.changed();
  }
  async removeGroup(name: string): Promise<void> {
    await this.group(this.manager.profiles().filter(profile => profile.group === name).map(profile => profile.id), '');
    await this.preferences.saveGroupOrder(this.preferences.groupOrder().filter(group => group !== name)); this.changed();
  }
  async moveGroup(name: string, direction: -1 | 1): Promise<void> {
    const groups = this.groups(), index = groups.indexOf(name), target = index + direction;
    if (index < 0 || target < 0 || target >= groups.length) return;
    [groups[index], groups[target]] = [groups[target]!, groups[index]!]; await this.preferences.saveGroupOrder(groups); this.changed();
  }
  favorites(): ConnectionFavorite[] {
    const values: ConnectionFavorite[] = []; const seen = new Set<string>();
    for (const raw of this.preferences.favorites()) { const parsed = FavoriteSchema.safeParse(raw); if (parsed.success) { const key = JSON.stringify(parsed.data); if (!seen.has(key)) { seen.add(key); values.push(parsed.data); } } }
    return values;
  }
  isFavorite(profileId: string, object: Pick<SchemaObject, 'name' | 'type'>): boolean { return this.favorites().some(value => value.profileId === profileId && value.name === object.name && value.type === object.type); }
  async favorite(profileId: string, object: Pick<SchemaObject, 'name' | 'type'>, enabled: boolean): Promise<void> {
    this.manager.profile(profileId); const value = FavoriteSchema.parse({ profileId, name: object.name, type: object.type });
    const remaining = this.favorites().filter(item => item.profileId !== profileId || item.name !== object.name || item.type !== object.type);
    if (enabled) remaining.push(value); await this.preferences.saveFavorites(remaining); this.changed();
  }
  async forget(profileId: string): Promise<void> { await this.preferences.saveFavorites(this.favorites().filter(value => value.profileId !== profileId)); this.objectFilters.delete(profileId); this.changed(); }
}
