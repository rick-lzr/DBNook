import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteEngine } from '../packages/drivers/sqlite/engine.js';
import { ProfileSchema, TableRequestSchema, parseCell } from '../packages/protocol/src/index.js';
import { exportResult } from '../packages/core/src/export.js';

const engines: SqliteEngine[] = []; const directories: string[] = [];
function engine(path?: string) {
  const db = new SqliteEngine(ProfileSchema.parse({ id: randomUUID(), driver: 'sqlite', name: 'Test', storage: path ? 'file' : 'memory', path: path ?? '', createIfMissing: Boolean(path) }));
  engines.push(db); return db;
}
afterEach(async () => { for (const db of engines.splice(0)) { try { db.close(); } catch {} } await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test('real SQLite schema preserves composite key order, generated columns, indexes and FK', () => {
  const db = engine(); db.query('CREATE TABLE parent(a INTEGER, b TEXT, PRIMARY KEY(b,a))', 10);
  db.query('CREATE TABLE child(id INTEGER PRIMARY KEY, a INTEGER, b TEXT, label TEXT GENERATED ALWAYS AS (b || a) STORED, FOREIGN KEY(b,a) REFERENCES parent(b,a))', 10);
  db.query('CREATE UNIQUE INDEX child_b ON child(b)', 10);
  assert.deepEqual(db.schema().map(item => item.name), ['child', 'parent']);
  assert.deepEqual(db.details('parent').columns.filter(c => c.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey).map(c => c.name), ['b', 'a']);
  assert.equal(db.details('child').columns.find(c => c.name === 'label')?.generated, true);
  assert.equal(db.details('child').indexes[0]?.unique, true);
  assert.equal(db.details('child').foreignKeys.length, 2);
});
test('precision, blobs, null and duplicate query names survive the runner wire model', () => {
  const db = engine();
  const result = db.query("SELECT 9223372036854775807 AS x, 2 AS x, x'0001ff' AS bytes, NULL AS missing, '' AS blank", 10);
  assert.deepEqual(result.rows[0], { c0: { type: 'integer', value: '9223372036854775807' }, c1: 2, c2: { type: 'binary', base64: 'AAH/' }, c3: null, c4: '' });
  assert.deepEqual(result.columns.map(c => c.name), ['x', 'x', 'bytes', 'missing', 'blank']);
  assert.doesNotThrow(() => JSON.stringify(result));
  const json = JSON.parse(exportResult(result, 'json'));
  assert.equal(json.format,'db-workbench.rows');assert.equal(json.version,1);
  assert.deepEqual(json.rows[0],[{type:'integer',value:'9223372036854775807'},2,{type:'binary',base64:'AAH/'},null,'']);
});
test('WHERE, identifier quoting, pagination, sorting and truncation use real database rows', () => {
  const db = engine(); db.query('CREATE TABLE "odd \'name"("a.b" INTEGER, "__rowId" TEXT)', 10);
  db.query('INSERT INTO "odd \'name" VALUES (1,\'first\'),(2,\'second\'),(3,\'third\')', 10);
  const request = TableRequestSchema.parse({ table: "odd 'name", where: '"a.b" >= 2', limit: 1, order: [{ column: 'a.b', direction: 'desc' }] });
  const result = db.table(request);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0]?.['a.b'], 3); assert.equal(result.rows[0]?.__rowId, 'third'); assert.equal(result.truncated, true);
  assert.equal(db.table({ ...request, offset: 1 }).rows[0]?.['a.b'], 2);
  assert.throws(() => db.table({ ...request, order: [{ column: 'missing', direction: 'asc' }] }), /Unknown sort/);
});
test('grid updates, inserts and deletes commit as an atomic batch', () => {
  const db = engine(); db.query('CREATE TABLE t(a INTEGER,b INTEGER,v TEXT,PRIMARY KEY(a,b))', 10);
  db.query("INSERT INTO t VALUES(1,2,'before'),(3,4,'remove')", 10);
  const rows = db.table(TableRequestSchema.parse({ table: 't' })).rows;
  assert.equal(db.apply('t', ['a', 'b'], [{ kind: 'update', original: rows[0], values: { v: 'after', a: 10 } }, { kind: 'delete', original: rows[1], values: {} }, { kind: 'insert', values: { a: 5, b: 6, v: 'new' } }]).affectedRows, 3);
  assert.deepEqual(db.table(TableRequestSchema.parse({ table: 't', order: [{ column: 'a', direction: 'asc' }] })).rows, [{ a: 5, b: 6, v: 'new' }, { a: 10, b: 2, v: 'after' }]);
});
test('a constraint failure rolls back earlier changes and preserves the data', () => {
  const db = engine(); db.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT UNIQUE)', 10); db.query("INSERT INTO t VALUES(1,'one'),(2,'two')", 10);
  const rows = db.table(TableRequestSchema.parse({ table: 't' })).rows;
  assert.throws(() => db.apply('t', ['id'], [{ kind: 'update', original: rows[0], values: { v: 'changed' } }, { kind: 'insert', values: { id: 3, v: 'two' } }]), /UNIQUE/);
  assert.equal(db.table(TableRequestSchema.parse({ table: 't' })).rows[0]?.v, 'one');
});
test('non-unique and disappeared key matches are refused without writing', () => {
  const db = engine(); db.query('CREATE TABLE t(k INTEGER,v TEXT)', 10); db.query("INSERT INTO t VALUES(1,'one'),(1,'two')", 10);
  const row = db.table(TableRequestSchema.parse({ table: 't' })).rows[0]!;
  assert.throws(() => db.apply('t', ['k'], [{ kind: 'update', original: row, values: { v: 'bad' } }]), /matched 2 rows/);
  assert.throws(() => db.apply('t', ['k'], [{ kind: 'delete', original: { ...row, k: 99 }, values: {} }]), /matched 0 rows/);
  assert.deepEqual(db.table(TableRequestSchema.parse({ table: 't' })).rows.map(row => row.v), ['one', 'two']);
});
test('external changes are detected and a real file can be reopened after close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-workbench-')); directories.push(dir); const path = join(dir, '中文 database.db');
  const db = engine(path); db.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)', 10); db.query("INSERT INTO t VALUES(1,'before')", 10);
  const original = db.table(TableRequestSchema.parse({ table: 't' })).rows[0]!;
  const other = engine(path); other.query("UPDATE t SET v='external'", 10);
  assert.throws(() => db.apply('t', ['id'], [{ kind: 'update', original, values: { v: 'overwrite' } }]), /changed since/);
  other.close(); db.close();
  const reopened = engine(path); assert.equal(reopened.table(TableRequestSchema.parse({ table: 't' })).rows[0]?.v, 'external');
});
test('read-only connections cannot write through query or grid paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-workbench-')); directories.push(dir); const path = join(dir, 'readonly.db');
  const writable = engine(path); writable.query('CREATE TABLE t(id INTEGER PRIMARY KEY)', 10); writable.close();
  const readOnly = new SqliteEngine(ProfileSchema.parse({ id: 'readonly', driver: 'sqlite', name: 'readonly', storage: 'file', path, readOnly: true })); engines.push(readOnly);
  assert.throws(() => readOnly.query('INSERT INTO t VALUES(1)', 10), /readonly|read.only/i);
  assert.throws(() => readOnly.query('PRAGMA query_only = OFF', 10), /read-only/i);
  assert.throws(() => readOnly.query("ATTACH ':memory:' AS writable", 10), /read-only/i);
  assert.throws(() => readOnly.apply('t', ['id'], [{ kind: 'insert', values: { id: 1 } }]), /read-only/);
});
test('savepoints preserve an existing explicit SQL transaction', () => {
  const db = engine(); db.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)', 10); db.query("INSERT INTO t VALUES(1,'one')", 10);
  db.query('BEGIN', 10);
  db.apply('t', ['id'], [{ kind: 'update', original: { id: 1, v: 'one' }, values: { v: 'two' } }]);
  db.query('ROLLBACK', 10); assert.equal(db.table(TableRequestSchema.parse({ table: 't' })).rows[0]?.v, 'one');
});
test('trailing statements are rejected before the first statement changes data', () => {
  const db = engine(); db.query('CREATE TABLE t(id INTEGER)', 10);
  assert.throws(() => db.query('INSERT INTO t VALUES(1); INSERT INTO t VALUES(2)', 10), /one SQL statement/);
  assert.equal(db.table(TableRequestSchema.parse({ table: 't' })).rows.length, 0);
  assert.equal(db.query('SELECT 1; -- trailing comment', 10).rows[0]?.c0, 1);
});
test('CSV escaping and typed cell parsing do not silently corrupt data', () => {
  const db = engine(); const result = db.query("SELECT 'a,b' AS a, 'line' || char(10) || 'two' AS b, 'quote\"' AS c", 10);
  assert.equal(exportResult(result, 'csv'), '\uFEFFa,b,c\r\n"a,b","line\ntwo","quote"""\r\n');
  const column = { key: 'i', name: 'i', dataType: 'INTEGER', nullable: true, primaryKey: 0, generated: false };
  assert.deepEqual(parseCell('9223372036854775807', column), { type: 'integer', value: '9223372036854775807' });
  assert.throws(() => parseCell('9223372036854775808', column), /64-bit range/);
  assert.throws(() => parseCell('', column), /requires an integer/);
});
