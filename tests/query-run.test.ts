import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { SqliteEngine } from '../packages/drivers/sqlite/engine.js';
import { ProfileSchema } from '../packages/protocol/src/index.js';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { SqlDocuments } from '../packages/core/src/sql-documents.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(readOnly = false) {
  const profile = ProfileSchema.parse({ id: 'run', driver: 'sqlite', name: 'Run tests', storage: 'memory', readOnly });
  const engine = new SqliteEngine(profile); cleanup.push(() => engine.close()); return engine;
}
test('SQLite parses strings, comments, quoted names and full trigger bodies into independent results', () => {
  const engine = fixture();
  const sql = `-- script\r\nCREATE TABLE "semi;table"(id INTEGER PRIMARY KEY,v TEXT);
    CREATE TABLE audit(v TEXT);
    CREATE TRIGGER "semi;trigger" AFTER INSERT ON "semi;table" BEGIN
      INSERT INTO audit VALUES(CASE WHEN NEW.id=1 THEN 'first;row' ELSE 'other;row' END);
      INSERT INTO audit VALUES('quoted'';value');
    END;
    INSERT INTO "semi;table"(v) VALUES('中文;😀'),('second');
    /* SELECT 'not a statement'; */ SELECT id,v FROM "semi;table" ORDER BY id;
    SELECT count(*) AS n FROM audit;`;
  const run = engine.run(sql, 100, 'native-parser');
  assert.equal(run.status, 'succeeded'); assert.equal(run.statements.length, 6);
  assert.equal(run.statements[3]?.result?.affectedRows, 2); assert.equal(run.statements[4]?.result?.rows[0]?.c1, '中文;😀'); assert.equal(run.statements[5]?.result?.rows[0]?.c0, 4);
  for (const statement of run.statements) assert.equal(sql.slice(statement.start, statement.end), statement.sql);
});
test('a run stops at the first error and preserves prior committed effects and result sets', () => {
  const engine = fixture();
  const sql = "  SELECT '😀';\r\n/* comment */ CREATE TABLE t(v TEXT); INSERT INTO t VALUES('earlier'); SELECT absent FROM t; INSERT INTO t VALUES('must not run');";
  const run = engine.run(sql, 100, 'partial');
  assert.equal(run.status, 'failed'); assert.equal(run.statements.length, 4); assert.match(run.error!, /no such column/);
  assert.equal(run.statements[0]?.result?.rows[0]?.c0, '😀'); assert.equal(run.statements[3]?.start, sql.indexOf('SELECT absent'));
  assert.equal(engine.query('SELECT count(*) FROM t', 100).rows[0]?.c0, 1); assert.equal(run.transaction, 'idle');
});
test('explicit script transactions remain owned and are not implicitly committed or rolled back on an ordinary error', () => {
  const engine = fixture(); engine.query('CREATE TABLE t(id INTEGER PRIMARY KEY)', 100);
  const run = engine.run('BEGIN; INSERT INTO t VALUES(1); INSERT INTO t VALUES(1); COMMIT;', 100, 'transaction');
  assert.equal(run.status, 'failed'); assert.equal(run.transaction, 'active'); assert.equal(run.statements.length, 3);
  engine.query('ROLLBACK', 100); assert.equal(engine.query('SELECT count(*) FROM t', 100).rows[0]?.c0, 0);
  const aborted = engine.run('BEGIN; INSERT INTO t VALUES(1); INSERT OR ROLLBACK INTO t VALUES(1);', 100, 'automatic-rollback');
  assert.equal(aborted.status, 'failed'); assert.equal(aborted.transaction, 'idle'); assert.equal(engine.query('SELECT count(*) FROM t', 100).rows[0]?.c0, 0);
});
test('row limits apply independently and later DDL or SELECT does not inherit old DML row counts', () => {
  const engine = fixture();
  const run = engine.run('CREATE TABLE t(v INTEGER); INSERT INTO t VALUES(1),(2),(3); CREATE TABLE empty(v TEXT); SELECT v FROM t; SELECT v FROM t;', 2, 'limits');
  assert.equal(run.status, 'succeeded'); assert.equal(run.statements[1]?.result?.affectedRows, 3); assert.equal(run.statements[2]?.result?.affectedRows, 0);
  assert.equal(run.statements[3]?.result?.rows.length, 2); assert.equal(run.statements[3]?.result?.truncated, true); assert.equal(run.statements[3]?.result?.affectedRows, 0); assert.equal(run.statements[4]?.result?.rows.length, 2);
  const returning = engine.run('UPDATE t SET v=v+10 RETURNING v; SELECT sum(v) FROM t;', 1, 'returning');
  assert.equal(returning.statements[0]?.result?.affectedRows, 3); assert.equal(returning.statements[0]?.result?.truncated, true); assert.equal(returning.statements[1]?.result?.rows[0]?.c0, 36);
});
test('read-only scripts allow transaction controls while blocking writes and protection-disabling PRAGMA', () => {
  const engine = fixture(true); const read = engine.run(' ; BEGIN; SELECT 1; COMMIT;', 100, 'readonly');
  assert.equal(read.status, 'succeeded'); assert.equal(read.transaction, 'idle'); assert.equal(read.statements[1]?.result?.rows[0]?.c0, 1);
  assert.equal(engine.run('SELECT 1; PRAGMA query_only=OFF; CREATE TABLE t(v TEXT);', 100, 'guard').status, 'failed');
  assert.equal(engine.run('CREATE TABLE t(v TEXT)', 100, 'write').status, 'failed');
});
test('comment-only scripts are no-ops and statement offsets retain leading trivia', () => {
  const engine = fixture(); assert.equal(engine.run(' ; /* comments; */ -- nothing\r\n', 100, 'empty').statements.length, 0);
  const sql = "\r\n; /* skip */ SELECT 'one'; -- skip\nSELECT 'two';"; const run = engine.run(sql, 100, 'offsets');
  assert.equal(run.statements[0]?.start, sql.indexOf("SELECT 'one'")); assert.equal(run.statements[1]?.start, sql.indexOf("SELECT 'two'"));
});
test('cancelled runs keep completed results received before the busy statement was terminated', { timeout: 15000 }, async () => {
  const profile = ProfileSchema.parse({ id: 'cancel-run', driver: 'sqlite', name: 'Run cancellation', storage: 'memory' });
  const manager = new ConnectionManager({ list: () => [profile], save: async () => {}, remove: async () => {} }, { runnerPath: resolve('dist/sqlite-runner.cjs') }); cleanup.push(() => manager.close());
  const documents = new SqlDocuments(manager); await documents.bind('sql:a', profile.id);
  const work = documents.run('sql:a', "SELECT 'completed first'; WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n; SELECT 'must not run';");
  const deadline = Date.now() + 7000;
  while (!documents.lastRun('sql:a')?.statements.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(documents.lastRun('sql:a')?.status, 'running'); assert.equal(documents.lastRun('sql:a')?.statements[0]?.result?.rows[0]?.c0, 'completed first');
  assert.equal(await documents.cancel('sql:a'), true); const run = await work;
  assert.equal(run.status, 'cancelled'); assert.equal(run.statements.length, 1); assert.equal(run.transaction, 'unknown'); assert.equal(documents.state('sql:a').lost, true);
  await assert.rejects(documents.run('sql:a', 'SELECT 1'), /Reset its session explicitly/);
  await documents.reset('sql:a'); assert.equal((await documents.run('sql:a', 'SELECT 42')).statements[0]?.result?.rows[0]?.c0, 42);
});
