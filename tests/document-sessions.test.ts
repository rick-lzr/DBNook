import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ConnectionManager, type ProfileStore } from '../packages/core/src/connections.js';
import { ProfileSchema, type ConnectionProfile } from '../packages/protocol/src/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(storage: 'file' | 'memory' = 'file', runnerPath = resolve('dist/sqlite-runner.cjs')) {
  const root = resolve('.cache/test-sessions'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'lease-')); assert.equal(dirname(directory), root);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const profile = ProfileSchema.parse({ id: 'local', driver: 'sqlite', name: 'Document sessions', storage, path: join(directory, 'data.db'), createIfMissing: true });
  const profiles: ConnectionProfile[] = [profile];
  const store: ProfileStore = { list: () => profiles, save: async value => { profiles[0] = value; }, remove: async () => { profiles.length = 0; } };
  const manager = new ConnectionManager(store, { runnerPath }); cleanup.push(() => manager.close());
  return { manager, profile };
}

test('file SQL documents reuse their lease and keep transactions and temp tables separate', async () => {
  const { manager, profile } = await fixture();
  const metadata = await manager.connect(profile.id); await metadata.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)'); await metadata.query("INSERT INTO t VALUES(1,'original')");
  const [first, same] = await Promise.all([manager.lease(profile.id, 'sql:a'), manager.lease(profile.id, 'sql:a')]); assert.equal(first, same);
  const second = await manager.lease(profile.id, 'sql:b'); assert.notEqual(first.id, second.id); assert.notEqual(first.id, metadata.id);
  await first.query('CREATE TEMP TABLE private_state(v TEXT)'); await assert.rejects(second.query('SELECT * FROM private_state'), /no such table/);
  await first.query('BEGIN'); await first.query("UPDATE t SET v='pending' WHERE id=1");
  assert.equal(first.transactionState, 'active'); assert.equal(second.transactionState, 'idle'); assert.equal(metadata.transactionState, 'idle');
  assert.equal((await second.query('SELECT v FROM t')).rows[0]?.c0, 'original'); assert.equal((await metadata.query('SELECT v FROM t')).rows[0]?.c0, 'original');
  await first.query('COMMIT'); assert.equal(first.transactionState, 'idle'); assert.equal((await second.query('SELECT v FROM t')).rows[0]?.c0, 'pending');
});

test('closing a document rolls back its transaction while the connection and other documents remain usable', async () => {
  const { manager, profile } = await fixture(); const base = await manager.connect(profile.id);
  await base.query('CREATE TABLE t(v TEXT)'); const first = await manager.lease(profile.id, 'a'), second = await manager.lease(profile.id, 'b');
  await first.query('BEGIN'); await first.query("INSERT INTO t VALUES('unsaved')"); await manager.releaseLease('a');
  assert.equal(first.connected, false); assert.equal(second.connected, true); assert.equal(base.connected, true);
  assert.equal((await second.query('SELECT count(*) FROM t')).rows[0]?.c0, 0);
  const fresh = await manager.lease(profile.id, 'a'); assert.notEqual(fresh.id, first.id); assert.equal(fresh.transactionState, 'idle');
});

test('memory documents share real memory data with separate transaction ownership', async () => {
  const { manager, profile } = await fixture('memory'); const base = await manager.connect(profile.id);
  await base.query('CREATE TABLE t(v TEXT)'); await base.query("INSERT INTO t VALUES('original')");
  const first = await manager.lease(profile.id, 'a'), second = await manager.lease(profile.id, 'b');
  assert.equal(first.info?.path, ':memory:'); assert.equal((await second.query('SELECT v FROM t')).rows[0]?.c0, 'original');
  await first.query('BEGIN'); await first.query("UPDATE t SET v='pending'");
  assert.equal(first.transactionState, 'active'); assert.equal(second.transactionState, 'idle'); assert.equal(base.transactionState, 'idle');
  await assert.rejects(second.query('SELECT v FROM t'), /locked/);
  await manager.releaseLease('a'); assert.equal((await second.query('SELECT v FROM t')).rows[0]?.c0, 'original');
  await second.query("INSERT INTO t VALUES('shared')"); assert.equal((await base.query('SELECT count(*) FROM t')).rows[0]?.c0, 2);
});

test('SQLite automatic rollback updates only the owning document transaction state even on errors', async () => {
  const { manager, profile } = await fixture('memory'); const base = await manager.connect(profile.id);
  await base.query('CREATE TABLE t(id INTEGER PRIMARY KEY)'); await base.query('INSERT INTO t VALUES(1)');
  const session = await manager.lease(profile.id, 'a'); await session.query('BEGIN'); assert.equal(session.transactionState, 'active');
  await assert.rejects(session.query('INSERT OR ROLLBACK INTO t VALUES(1)'), /UNIQUE/);
  assert.equal(session.transactionState, 'idle'); assert.equal(base.transactionState, 'idle');
});

test('cancelling a file document stops its process without cancelling another document', { timeout: 15000 }, async () => {
  const { manager, profile } = await fixture(); const first = await manager.lease(profile.id, 'a'), second = await manager.lease(profile.id, 'b');
  const work = first.query('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n');
  const rejected = assert.rejects(work, /cancelled/); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await manager.cancelLease('a'), true); await rejected;
  assert.equal(second.connected, true); assert.equal((await second.query('SELECT 42')).rows[0]?.c0, 42);
  await assert.rejects(manager.lease(profile.id, 'a'), /Reset its session explicitly/);
  await manager.releaseLease('a'); const reset = await manager.lease(profile.id, 'a'); assert.notEqual(reset.id, first.id);
});

test('memory cancellation invalidates all shared sessions and never silently replaces them', { timeout: 15000 }, async () => {
  const { manager, profile } = await fixture('memory'); const first = await manager.lease(profile.id, 'a'), second = await manager.lease(profile.id, 'b');
  const work = first.query('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n');
  const rejected = assert.rejects(work, /cancelled/); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await manager.cancelLease('a'), true); await rejected; assert.equal(second.connected, false); assert.equal(second.transactionState, 'unknown');
  await assert.rejects(manager.lease(profile.id, 'b'), /Reset its session explicitly/);
});

test('connection disconnect releases every document lease and waits for file handles to close', async () => {
  const { manager, profile } = await fixture(); const first = await manager.lease(profile.id, 'a'), second = await manager.lease(profile.id, 'b');
  await first.query('BEGIN'); await first.query('CREATE TABLE should_rollback(v TEXT)');
  await Promise.all([manager.disconnect(profile.id), manager.disconnect(profile.id)]);
  assert.equal(first.connected, false); assert.equal(second.connected, false); assert.equal(manager.documentSessions().length, 0); assert.equal(manager.isConnected(profile.id), false);
  const reopened = await manager.connect(profile.id); assert.ok(!(await reopened.schema()).some(table => table.name === 'should_rollback'));
});

test('closing a file document during runner startup cancels its opening instead of resurrecting the lease', { timeout: 10000 }, async () => {
  const { manager, profile } = await fixture('file', resolve('tests/fixtures/hanging-runner.cjs'));
  const opening = manager.lease(profile.id, 'a'); const rejected = assert.rejects(opening, /disconnected|closed/i);
  await manager.releaseLease('a'); await rejected; assert.equal(manager.documentSessions().length, 0);
});

test('renaming or regrouping a memory connection preserves its data and document transactions', async () => {
  const { manager, profile } = await fixture('memory'); const base = await manager.connect(profile.id);
  await base.query('CREATE TABLE t(v TEXT)'); await base.query("INSERT INTO t VALUES('keep this data')");
  const document = await manager.lease(profile.id, 'a'); await document.query('BEGIN');
  const changed = { ...profile, name: 'Renamed', group: 'A group', color: '#123456', scope: 'workspace' as const };
  assert.equal(manager.willReconnect(changed), false); await manager.save(changed);
  assert.equal(base.connected, true); assert.equal(document.connected, true); assert.equal(document.transactionState, 'active');
  assert.equal((await base.query('SELECT v FROM t')).rows[0]?.c0, 'keep this data'); assert.equal(manager.profile(profile.id).name, 'Renamed');
});

test('changing connection target closes existing physical document sessions before saving settings', async () => {
  const { manager, profile } = await fixture(); const document = await manager.lease(profile.id, 'a');
  const changed = { ...profile, path: join(dirname(profile.path), 'another.db') };
  assert.equal(manager.willReconnect(changed), true); await manager.save(changed);
  assert.equal(document.connected, false); assert.equal(manager.documentSession('a'), undefined); assert.equal(manager.profile(profile.id).path, changed.path);
});

test('external configuration edits cannot reuse an old SQL session with different path or write permissions', async () => {
  const { manager, profile } = await fixture(); const metadata = await manager.connect(profile.id); const document = await manager.lease(profile.id, 'a');
  // Simulate a settings.json change bypassing ConnectionManager.save.
  await manager.store.save({ ...profile, readOnly: true });
  await assert.rejects(manager.connect(profile.id), /settings changed outside/);
  await assert.rejects(manager.lease(profile.id, 'a'), /settings changed outside/);
  assert.equal(metadata.connected, true); assert.equal(document.connected, true);
  await manager.disconnect(profile.id); const reopened = await manager.lease(profile.id, 'a');
  await assert.rejects(reopened.query('CREATE TABLE must_not_write(v TEXT)'), /read-only/);
});

test('a target change cannot reconnect the old database while settings are still being written', async () => {
  const { manager, profile } = await fixture(); const old = await manager.connect(profile.id);
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const save = manager.store.save; manager.store.save = async value => { entered(); await gate; await save(value); };
  const target = { ...profile, path: join(dirname(profile.path), 'changed.db') }; const pending = manager.save(target); await writing;
  try { assert.equal(old.connected, false); await assert.rejects(manager.connect(profile.id), /settings are being saved/); await assert.rejects(async () => manager.lease(profile.id, 'new-document'), /settings are being saved/); }
  finally { release(); await pending; }
  assert.equal((await manager.connect(profile.id)).info?.path, target.path);
});
