import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { GridDocumentModel } from '../packages/core/src/grid-document.js';
import { SqliteSession } from '../packages/drivers/sqlite/session.js';
import { ProfileSchema, TableRequestSchema, type GridEditState } from '../packages/protocol/src/index.js';
import type { DriverSession } from '../packages/driver-sdk/src/index.js';

const sessions: SqliteSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });
async function fixture() {
  const profile = ProfileSchema.parse({ id: randomUUID(), driver: 'sqlite', name: 'Draft test', storage: 'memory' });
  const session = new SqliteSession(profile, { runnerPath: resolve('dist/sqlite-runner.cjs') }); sessions.push(session); await session.open();
  await session.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT UNIQUE,calculated TEXT GENERATED ALWAYS AS (v || id) VIRTUAL)');
  await session.query("INSERT INTO t VALUES(1,'one'),(2,'two')");
  const request = TableRequestSchema.parse({ table: 't' }), details = await session.details('t'), result = await session.table(request);
  return { profile, session, model: new GridDocumentModel(profile, details, result, request) };
}
function edit(model: GridDocumentModel, value = 'changed'): GridEditState {
  const state = model.state(); return { keyColumns: state.edits.keyColumns, added: [], edits: { r0: { kind: 'update', original: state.result.rows[0], values: { v: value } } } };
}
test('staging, native edit transitions and revert never write the database', async () => {
  const { model, session } = await fixture(); const transition = model.update(0, edit(model))!;
  assert.equal(model.dirty, true); assert.equal(model.state().canUndo, true);
  assert.equal((await session.query('SELECT v FROM t WHERE id=1')).rows[0]?.c0, 'one');
  transition.undo(); assert.equal(model.dirty, false); assert.equal(model.state().canRedo, true);
  transition.redo(); assert.equal(model.dirty, true);
  model.revert(); assert.equal(model.dirty, false); assert.throws(() => transition.redo(), /earlier saved result/);
  assert.equal((await session.query('SELECT v FROM t WHERE id=1')).rows[0]?.c0, 'one');
});
test('draft backups recover original values and edits without applying them', async () => {
  const { model, profile, session } = await fixture(); model.update(0, edit(model));
  const restored = GridDocumentModel.restore(profile, 't', model.backup());
  assert.equal(restored.dirty, true); assert.deepEqual(restored.state().edits, model.state().edits);
  assert.match(restored.state().message!, /Recovered unsaved edits/);
  assert.equal((await session.query('SELECT v FROM t WHERE id=1')).rows[0]?.c0, 'one');
  await restored.save(session); assert.equal((await session.query('SELECT v FROM t WHERE id=1')).rows[0]?.c0, 'changed');
});
test('backup identity prevents edits being restored onto another connection or table', async () => {
  const { model, profile } = await fixture(); model.update(0, edit(model)); const backup = model.backup();
  assert.throws(() => GridDocumentModel.restore({ ...profile, id: 'other' }, 't', backup), /another database/);
  assert.throws(() => GridDocumentModel.restore({ ...profile, storage: 'file', path: '/other.db' }, 't', backup), /another database/);
  assert.throws(() => GridDocumentModel.restore(profile, 'another_table', backup), /another database/);
  assert.throws(() => GridDocumentModel.restore(profile, 't', '{malformed'), /JSON|property/i);
});
test('stale, forged or generated-column edits are rejected before database writes', async () => {
  const { model } = await fixture(); model.update(0, edit(model));
  assert.throws(() => model.update(0, edit(model, 'late')), /pending/);
  const state = edit(model); state.edits.r0!.original = { id: 1, v: 'forged' };
  assert.throws(() => model.update(model.state().revision, state), /snapshot/);
  const generated = edit(model); generated.edits.r0!.values = { calculated: 'overwrite' };
  assert.throws(() => model.update(model.state().revision, generated), /generated/);
  const duplicate = edit(model); duplicate.added = [{ id: 'new1', values: { id: 3 } }, { id: 'new1', values: { id: 4 } }];
  assert.throws(() => model.update(model.state().revision, duplicate), /Duplicate/);
});
test('a failed save keeps staged data and a successful save creates an undo boundary', async () => {
  const { model, session } = await fixture(); const transition = model.update(0, edit(model, 'two'))!;
  await assert.rejects(model.save(session), /UNIQUE/); assert.equal(model.dirty, true); assert.equal(model.state().edits.edits.r0?.values.v, 'two');
  assert.match(model.state().error!, /Changes were not saved:.*UNIQUE/);
  model.update(model.state().revision, edit(model, 'updated'));
  assert.equal((await model.save(session)).affectedRows, 1); assert.equal(model.dirty, false); assert.equal(model.state().canUndo, false);
  assert.throws(() => transition.undo(), /earlier saved result/);
});
test('reload failure after a committed insertion does not restage it for another Save', async () => {
  const { model, session } = await fixture();
  model.update(0, { edits: {}, added: [{ id: 'new1', values: { id: 3, v: 'three' } }], keyColumns: ['id'] });
  const adapter = { apply: session.apply.bind(session), details: async () => { throw new Error('network unavailable'); } } as unknown as DriverSession;
  assert.equal((await model.save(adapter)).affectedRows, 1); assert.equal(model.dirty, false); assert.equal(model.state().result.readOnly, true);
  assert.match(model.state().error!, /Changes were saved, but reloading failed/);
  assert.throws(() => model.save(adapter), /read-only/);
  assert.equal((await session.query('SELECT count(*) FROM t WHERE id=3')).rows[0]?.c0, 1);
  await model.load(session, model.state().request); assert.equal(model.state().result.readOnly, false);
});
test('loading another page cannot silently discard staged changes', async () => {
  const { model, session } = await fixture(); model.update(0, edit(model));
  await assert.rejects(model.load(session, { ...model.state().request, offset: 1 }), /Save or discard/);
  assert.equal(model.dirty, true);
  model.revert(); await model.load(session, { ...model.state().request, offset: 1 }); assert.equal(model.state().result.rows[0]?.id, 2);
});

test('grid Save refuses an existing SQL transaction and keeps its draft until rollback', async () => {
  const { model, session } = await fixture(); model.update(0, edit(model, 'independent grid edit'));
  await session.query('BEGIN');
  await session.query("INSERT INTO t(id,v) VALUES(3,'uncommitted SQL edit')");
  await assert.rejects(model.save(session), /open SQL transaction/);
  assert.equal(model.dirty, true); assert.match(model.state().error!, /Changes were not saved/);
  assert.equal((await session.query('SELECT v FROM t WHERE id=1')).rows[0]?.c0, 'one');
  await session.query('ROLLBACK');
  assert.equal((await session.query('SELECT count(*) FROM t WHERE id=3')).rows[0]?.c0, 0);
  await model.save(session); assert.equal(model.dirty, false);
  assert.equal((await session.query('SELECT v FROM t WHERE id=1')).rows[0]?.c0, 'independent grid edit');
});
test('inserting into a table without a primary key does not require a fabricated key', async () => {
  const { session, profile } = await fixture(); await session.query('CREATE TABLE no_key(v TEXT)');
  const request = TableRequestSchema.parse({ table: 'no_key' }); const model = new GridDocumentModel(profile, await session.details('no_key'), await session.table(request), request);
  model.update(0, { edits: {}, added: [{ id: 'new1', values: { v: 'new row' } }], keyColumns: [] });
  assert.equal((await model.save(session)).affectedRows, 1); assert.equal(model.state().result.rows[0]?.v, 'new row');
});
