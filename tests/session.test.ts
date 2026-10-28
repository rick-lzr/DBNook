import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProfileSchema, TableRequestSchema, type ConnectionProfile } from '../packages/protocol/src/index.js';
import { SqliteSession } from '../packages/drivers/sqlite/session.js';
import { ConnectionManager, type ProfileStore } from '../packages/core/src/connections.js';

const runtime = { runnerPath: resolve('dist/sqlite-runner.cjs') };
const profile = () => ProfileSchema.parse({ id: 'memory', driver: 'sqlite', name: 'Memory', storage: 'memory' });
test('isolated runner keeps memory alive across calls and transmits exact values', async () => {
  const session = new SqliteSession(profile(), runtime);
  try {
    assert.match((await session.open()).sqlite, /^3\./);
    await session.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)'); await session.query("INSERT INTO t VALUES(9223372036854775807,'hello')");
    const result = await session.table(TableRequestSchema.parse({ table: 't' }));
    assert.deepEqual(result.rows[0]?.id, { type: 'integer', value: '9223372036854775807' });
    await session.apply('t', ['id'], [{ kind: 'update', original: result.rows[0], values: { v: 'updated' } }]);
    assert.equal((await session.query('SELECT v FROM t')).rows[0]?.c0, 'updated');
  } finally { await session.close(); }
  assert.equal(session.connected, false);
});
test('cancellation terminates the busy database process and makes the session unusable', { timeout: 15000 }, async () => {
  const session = new SqliteSession(profile(), runtime); await session.open();
  try {
    const query = session.query('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n');
    const rejection = assert.rejects(query, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await session.cancel(), true); await rejection;
    assert.equal(session.connected, false); await assert.rejects(session.query('SELECT 1'), /closed/);
  } finally { await session.close(); }
});
test('connection manager deduplicates opens and an idle cancellation preserves the memory database', async () => {
  const rows = [profile()];
  const store: ProfileStore = { list: () => rows, save: async p => { rows.splice(0, rows.length, p); }, remove: async () => {} };
  const manager = new ConnectionManager(store, runtime);
  try {
    const [first, second] = await Promise.all([manager.connect('memory'), manager.connect('memory')]); assert.equal(first, second);
    await first.query('CREATE TABLE t(id INTEGER)'); assert.equal(await manager.cancel('memory'), false);
    assert.equal(await manager.connect('memory'), first); assert.equal((await first.schema())[0]?.name, 't');
  } finally { await manager.close(); }
});
test('connection testing for a new file checks the runtime without creating the target file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'db-workbench-test-'));
  const target = join(directory, 'new.db');
  const manager = new ConnectionManager({ list: () => [], save: async () => {}, remove: async () => {} }, runtime);
  try {
    const draft: ConnectionProfile = { ...profile(), storage: 'file', path: target, createIfMissing: true };
    assert.match((await manager.test(draft)).sqlite, /^3\./);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    await assert.rejects(manager.test({ ...draft, readOnly: true }), /existing database file/);
    await assert.rejects(manager.test({ ...draft, createIfMissing: false }), { code: 'ENOENT' });
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
test('cancellation also stops a connection whose runner has not finished opening', { timeout: 10000 }, async () => {
  const p = profile();
  const manager = new ConnectionManager({ list: () => [p], save: async () => {}, remove: async () => {} }, { runnerPath: resolve('tests/fixtures/hanging-runner.cjs') });
  try {
    const opening = manager.connect(p.id); const rejection = assert.rejects(opening, /cancelled/);
    assert.equal(await manager.cancel(p.id), true); await rejection; assert.equal(manager.isConnected(p.id), false);
  } finally { await manager.close(); }
});
