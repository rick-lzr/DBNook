import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ConnectionOrganization, matchesConnection, matchesObject, orderedGroups, type ConnectionFavorite } from '../packages/core/src/connection-organization.js';
import { readProfileConfiguration } from '../packages/core/src/profile-configuration.js';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { ProfileSchema } from '../packages/protocol/src/index.js';

const profile = (id = 'one', group = '') => ProfileSchema.parse({ id, driver: 'sqlite', name: 'Local development', storage: 'memory', group });
const managers: ConnectionManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); });
function fixture() {
  const profiles = [profile('one', 'Development'), profile('two', 'Testing')]; let favorites: unknown[] = [], order: string[] = [];
  const manager = new ConnectionManager({ list: () => profiles, save: async value => { profiles[profiles.findIndex(profile => profile.id === value.id)] = value; }, remove: async () => {} }, { runnerPath: resolve('dist/sqlite-runner.cjs') }); managers.push(manager);
  const preferences = { favorites: () => favorites, saveFavorites: async (values: ConnectionFavorite[]) => { favorites = values; }, groupOrder: () => order, saveGroupOrder: async (values: string[]) => { order = values; } };
  return { profiles, manager, organization: new ConnectionOrganization(manager, preferences), preferences, corruptFavorites: (values: unknown[]) => { favorites = values; } };
}
test('connection filters match all words across metadata and clear to show every profile', () => {
  assert.equal(matchesConnection({ ...profile(), path: '/project/data.db', group: 'Testing' }, 'LOCAL testing data.db'), true);
  assert.equal(matchesConnection(profile(), 'local production'), false);
  const { organization } = fixture(); organization.setFilter('testing'); assert.equal(organization.profiles()[0]?.id, 'two'); organization.setFilter(''); assert.equal(organization.profiles().length, 2);
});
test('group ordering honors configured positions and keeps unknown groups sorted', () => {
  assert.deepEqual(orderedGroups(['Z', 'B', 'A', 'B', ''], ['Z', 'Z', 'Missing']), ['Z', 'A', 'B']);
});
test('object LIKE filters support quoted patterns, inversion, escapes and Unicode characters', () => {
  assert.equal(matchesObject('AUTH_user', 'auth\_%'), true); // underscore wildcard also matches a literal underscore
  assert.equal(matchesObject('auth_user', 'LIKE \'auth\\_%\''), true);
  assert.equal(matchesObject('authXuser', 'LIKE \'auth\\_%\''), false);
  assert.equal(matchesObject('temporary_table', "NOT LIKE 'temp%'"), false);
  assert.equal(matchesObject('a\'b', "LIKE 'a''b'"), true);
  assert.equal(matchesObject('表😀', '表_'), true); assert.equal(matchesObject('table', 'tabl'), false);
  assert.equal(matchesObject('anything', ''), true); assert.throws(() => matchesObject('table', 'NOT LIKE'), /pattern/); assert.throws(() => matchesObject('table', 'text\\'), /escape/);
});
test('group moves, renames and removal preserve connections, memory rows and active transactions', async () => {
  const { manager, organization } = fixture(); const memory = await manager.connect('one'); await memory.query('CREATE TABLE t(v TEXT)'); await memory.query("INSERT INTO t VALUES('keep')");
  const session = await manager.lease('one', 'sql'); await session.query('BEGIN');
  await organization.group(['one', 'one', 'two'], 'Shared'); assert.equal(organization.groups().length, 1);
  await organization.renameGroup('Shared', 'Renamed'); assert.equal(manager.profile('one').group, 'Renamed');
  await organization.removeGroup('Renamed'); assert.equal(manager.profiles().length, 2); assert.equal(manager.profile('one').group, ''); assert.equal(session.transactionState, 'active'); assert.equal(memory.connected, true);
  assert.equal((await memory.query('SELECT v FROM t')).rows[0]?.c0, 'keep');
});
test('group order changes and favorites persist in their injected preference store', async () => {
  const { manager, organization, preferences, corruptFavorites } = fixture();
  await organization.moveGroup('Testing', -1); assert.deepEqual(organization.groups(), ['Testing', 'Development']);
  await organization.favorite('one', { name: 'weird"name', type: 'table' }, true); await organization.favorite('one', { name: 'weird"name', type: 'table' }, true);
  const reloaded = new ConnectionOrganization(manager, preferences); assert.equal(reloaded.favorites().length, 1); assert.equal(reloaded.isFavorite('one', { name: 'weird"name', type: 'table' }), true);
  await reloaded.favorite('one', { name: 'weird"name', type: 'table' }, false); assert.equal(organization.favorites().length, 0);
  corruptFavorites([{ invalid: true }, { profileId: 'one', name: 't', type: 'table' }, { profileId: 'one', name: 't', type: 'table' }]); assert.equal(organization.favorites().length, 1);
});
test('duplicate IDs are diagnosed and no ambiguous connection can become active', () => {
  const read = readProfileConfiguration([profile(), { ...profile(), name: 'Ambiguous' }, profile('other')], undefined);
  assert.deepEqual(read.profiles.map(profile => profile.id), ['other']); assert.equal(read.issues.filter(issue => issue.code === 'duplicate-id').length, 2);
});

test('forgetting a removed connection clears only its favorites and object filter', async () => {
  const { organization } = fixture();
  await organization.favorite('one', { name: 'first', type: 'table' }, true); await organization.favorite('two', { name: 'second', type: 'view' }, true);
  organization.setObjectFilter('one', 'first%'); organization.setObjectFilter('two', 'second%'); await organization.forget('one');
  assert.deepEqual(organization.favorites().map(value => value.profileId), ['two']); assert.equal(organization.objectFilter('one'), ''); assert.equal(organization.objectFilter('two'), 'second%');
});
test('workspace overrides are explicit and an invalid override cannot activate an older global target', () => {
  const global = { ...profile(), readOnly: false }, workspace = { ...profile(), name: 'Workspace', readOnly: true };
  const valid = readProfileConfiguration([global], [workspace]); assert.equal(valid.profiles[0]?.scope, 'workspace'); assert.equal(valid.profiles[0]?.readOnly, true); assert.equal(valid.issues[0]?.code, 'shadowed');
  const invalid = readProfileConfiguration([global], [{ ...workspace, readOnly: 'bad' }]); assert.equal(invalid.profiles.length, 0); assert.equal(invalid.issues[0]?.code, 'invalid');
});
test('malformed configuration arrays and rows report locations instead of throwing', () => {
  const result = readProfileConfiguration('not an array', [null, profile('valid')]);
  assert.equal(result.profiles.length, 1); assert.equal(result.issues.length, 2); assert.equal(result.issues[0]?.index, -1); assert.equal(result.issues[1]?.index, 0);
});
