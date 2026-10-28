import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { SqlDocuments } from '../packages/core/src/sql-documents.js';
import { ProfileSchema } from '../packages/protocol/src/index.js';

const managers: ConnectionManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); });
async function fixture() {
  const profile = ProfileSchema.parse({ id: 'memory', driver: 'sqlite', name: 'SQL documents', storage: 'memory' });
  const manager = new ConnectionManager({ list: () => [profile], save: async () => {}, remove: async () => {} }, { runnerPath: resolve('dist/sqlite-runner.cjs') }); managers.push(manager);
  const states: boolean[] = []; const documents = new SqlDocuments(manager, () => states.push(documents.state('a').busy));
  await documents.bind('a', profile.id); await documents.bind('b', profile.id);
  return { manager, documents, states };
}
test('SQL controls and literal transaction statements keep the same owning document state', async () => {
  const { documents, states } = await fixture();
  await documents.execute('a', 'CREATE TABLE t(id INTEGER PRIMARY KEY)');
  await documents.transaction('a', 'begin'); assert.equal(documents.state('a').transaction, 'active'); assert.equal(documents.state('b').transaction, 'unknown');
  await documents.execute('a', 'INSERT INTO t VALUES(1)'); await documents.transaction('a', 'commit');
  assert.equal(documents.state('a').transaction, 'idle'); assert.equal((await documents.execute('b', 'SELECT count(*) FROM t')).rows[0]?.c0, 1);
  await documents.execute('a', 'SAVEPOINT nested'); assert.equal(documents.state('a').transaction, 'active');
  await documents.execute('a', 'RELEASE nested'); assert.equal(documents.state('a').transaction, 'idle');
  await assert.rejects(documents.transaction('a', 'commit'), /no active transaction/);
  assert.ok(states.includes(true)); assert.equal(states.at(-1), false);
});
test('reset creates an explicit fresh session and rolls back pending work', async () => {
  const { documents, manager } = await fixture();
  await documents.execute('a', 'CREATE TABLE t(v TEXT)'); await documents.transaction('a', 'begin'); await documents.execute('a', "INSERT INTO t VALUES('pending')");
  const before = manager.documentSession('a')!; await documents.reset('a');
  assert.notEqual(manager.documentSession('a')?.id, before.id); assert.equal(before.connected, false);
  assert.equal(documents.state('a').transaction, 'idle'); assert.equal((await documents.execute('a', 'SELECT count(*) FROM t')).rows[0]?.c0, 0);
});
test('one SQL document rejects overlapping executions and closing it stops its pending operation', { timeout: 10000 }, async () => {
  const { documents, manager } = await fixture();
  await documents.execute('a', 'SELECT 1');
  const work = documents.execute('a', 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n');
  const rejected = assert.rejects(work, /cancelled|disconnected|closed/i);
  await assert.rejects(documents.execute('a', 'SELECT 2'), /running operation/);
  await documents.close('a'); await rejected;
  assert.equal(documents.connection('a'), undefined); assert.equal(documents.state('a').busy, false); assert.equal(manager.documentSession('a'), undefined);
  await assert.rejects(documents.execute('a', 'SELECT 3'), /source SQL document is closed/);
});
test('closing during a reset cannot resurrect a document session', async () => {
  const { documents, manager } = await fixture(); await documents.execute('a', 'SELECT 1');
  const reset = documents.reset('a'); const rejected = assert.rejects(reset, /closed while resetting/);
  await documents.close('a'); await rejected;
  assert.equal(documents.connection('a'), undefined); assert.equal(manager.documentSession('a'), undefined);
});
