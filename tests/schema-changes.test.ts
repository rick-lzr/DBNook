import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {SchemaChanges,structureFingerprint} from '../packages/core/src/schema-changes.js';
import {ProfileSchema,DdlIntentSchema,type DdlIntent} from '../packages/protocol/src/index.js';
import {ddlSegments,alterColumnDefinition,ddlFragment,ddlQuote} from '../packages/core/src/ddl-syntax.js';
import {renderDdl} from '../packages/core/src/ddl-renderer.js';
import {previewSql} from '../packages/core/src/ddl-script.js';
async function fixture(){
  const rows=[ProfileSchema.parse({id:'ddl-memory',name:'DDL test',driver:'sqlite',storage:'memory'})];const manager=new ConnectionManager({list:()=>rows,save:async p=>{rows[0]=p;},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')});
  const changes=new SchemaChanges(manager),session=await manager.connect(rows[0]!.id),id=rows[0]!.id;
  const apply=async(table:string|undefined,intent:unknown)=>{const p=await changes.preview(id,table,DdlIntentSchema.parse(intent));return changes.apply(id,p.token);};
  return {manager,changes,session,id,apply,rows};
}
test('DDL lexical edits preserve collations, generated/check clauses, comments, identity attributes and SQL-mode literals',()=>{
  const sql='CREATE TABLE "odd,table" ("a,b" VARCHAR(20) COLLATE NOCASE NOT NULL DEFAULT (lower(\'x,y\')) CHECK(length("a,b")>0), n INTEGER GENERATED ALWAYS AS (length("a,b")) STORED, CONSTRAINT uq UNIQUE("a,b")) STRICT';
  const p=ddlSegments(sql,'sqlite');assert.equal(p.segments.length,3);assert.equal(p.segments[0]!.column,'a,b');
  assert.match(alterColumnDefinition(p.segments[0]!.text,'sqlite','type','TEXT'),/"a,b" TEXT COLLATE NOCASE NOT NULL DEFAULT/);
  assert.match(alterColumnDefinition(p.segments[0]!.text,'sqlite','default',"'new'"),/DEFAULT 'new' CHECK/);
  assert.match(alterColumnDefinition('`v` varchar(40) COLLATE utf8mb4_bin DEFAULT \'x\' COMMENT \'keep\' INVISIBLE','mysql','type','varchar(80)'),/varchar\(80\) COLLATE utf8mb4_bin DEFAULT 'x' COMMENT 'keep' INVISIBLE/);
  assert.equal(alterColumnDefinition('v TEXT CONSTRAINT must NOT NULL ON CONFLICT FAIL DEFAULT NULL','sqlite','nullable',true).trim(),'v TEXT  DEFAULT NULL');
  assert.throws(()=>ddlFragment('TEXT); DROP TABLE t;--','sqlite'));assert.throws(()=>ddlQuote('长'.repeat(22),'postgresql'),/limit/);
  assert.throws(()=>alterColumnDefinition('`v` text','mysql','default',"'x\\'; SELECT 1",{noBackslashEscapes:true,ansiQuotes:false}),/separators/);
});
test('SQLite create/add/rename/index/constraint/drop workflow previews without changes and preserves user data',async()=>{
  const f=await fixture();try{
    const create=DdlIntentSchema.parse({action:'createTable',name:'team,中文',columns:[{name:'id',dataType:'INTEGER',nullable:false},{name:'name',dataType:'TEXT'}],constraints:[{name:'pk',kind:'primary',columns:['id']}]});
    const p=await f.changes.preview(f.id,undefined,create);assert.equal((await f.session.schema()).length,0);assert(p.steps[0]?.sql.includes('"team,中文"'));assert.equal((await f.changes.apply(f.id,p.token)).status,'succeeded');await assert.rejects(f.changes.apply(f.id,p.token),/expired/);
    await f.session.query(`INSERT INTO "team,中文" VALUES(1,'before')`);
    assert.equal((await f.apply('team,中文',{action:'addColumn',column:{name:'status',dataType:'TEXT',nullable:false,defaultSql:"'active'"}})).status,'succeeded');
    assert.equal((await f.apply('team,中文',{action:'renameColumn',column:'name',name:'label'})).status,'succeeded');
    assert.equal((await f.apply('team,中文',{action:'addIndex',name:'label_idx',columns:[{name:'label'}],where:'id > 0'})).status,'succeeded');
    let structure=await f.changes.structure(f.id,'team,中文');assert.match(structure.indexes[0]!.definition,/WHERE id > 0/);
    assert.equal((await f.apply('team,中文',{action:'addConstraint',constraint:{name:'status_check',kind:'check',expression:"status <> ''"}})).status,'succeeded');
    structure=await f.changes.structure(f.id,'team,中文');assert(structure.constraints.some(c=>c.name==='status_check'));await assert.rejects(f.session.query(`UPDATE "team,中文" SET status=''`),/CHECK/);
    assert.equal((await f.apply('team,中文',{action:'dropConstraint',name:'status_check'})).status,'succeeded');assert.equal((await f.apply('team,中文',{action:'dropIndex',name:'label_idx'})).status,'succeeded');
    assert.equal((await f.apply('team,中文',{action:'renameTable',name:'renamed'})).status,'succeeded');assert.equal((await f.session.query('SELECT label FROM renamed')).rows[0]?.c0,'before');
    assert.equal((await f.apply('renamed',{action:'dropColumn',column:'status'})).status,'succeeded');assert.equal((await f.apply('renamed',{action:'dropTable'})).removed,true);
  }finally{await f.manager.close();}
});
test('SQLite rebuild preserves sparse rowids, AUTOINCREMENT high-water mark, generated data, indexes, views, triggers and incoming foreign keys',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT COLLATE NOCASE NOT NULL DEFAULT \'x\',g INT GENERATED ALWAYS AS (length(v)) STORED,CONSTRAINT positive CHECK(id>0))');
    await f.session.query('CREATE TABLE child(id INT REFERENCES parent(id) ON DELETE CASCADE)');await f.session.query('CREATE TABLE audit(v TEXT)');
    await f.session.query('CREATE INDEX parent_idx ON parent(v) WHERE id>0');await f.session.query('CREATE TRIGGER parent_audit AFTER UPDATE ON parent BEGIN INSERT INTO audit VALUES(NEW.v); END');await f.session.query('CREATE VIEW parent_view AS SELECT id,v FROM parent');
    await f.session.query("INSERT INTO parent(id,v) VALUES(1,'one'),(100,'removed')");await f.session.query('DELETE FROM parent WHERE id=100');await f.session.query('INSERT INTO child VALUES(1)');
    const report=await f.apply('parent',{action:'alterColumn',column:'v',change:'type',value:'VARCHAR(80)'});assert.equal(report.status,'succeeded',report.error);
    assert.equal((await f.session.query('SELECT id FROM child')).rows[0]?.c0,1);assert.equal((await f.session.query('SELECT v FROM parent_view')).rows[0]?.c0,'one');
    await f.session.query("UPDATE parent SET v='changed' WHERE id=1");assert.equal((await f.session.query('SELECT v FROM audit')).rows[0]?.c0,'changed');
    await f.session.query("INSERT INTO parent(v) VALUES('next')");assert.equal((await f.session.query('SELECT max(id) FROM parent')).rows[0]?.c0,101);
    assert.equal((await f.session.query('SELECT g FROM parent WHERE id=1')).rows[0]?.c0,7);assert((await f.changes.structure(f.id,'parent')).indexes.some(i=>i.name==='parent_idx'));
    await f.session.query('CREATE TABLE sparse(v TEXT)');await f.session.query("INSERT INTO sparse(rowid,v) VALUES(7,'a'),(42,'b')");
    assert.equal((await f.apply('sparse',{action:'alterColumn',column:'v',change:'default',value:"'new'"})).status,'succeeded');assert.deepEqual((await f.session.query('SELECT rowid FROM sparse ORDER BY rowid')).rows.map(r=>r.c0),[7,42]);
  }finally{await f.manager.close();}
});
test('SQLite rejected rebuild and referenced-table drop leave data/schema intact; WITHOUT ROWID and STRICT survive successful rebuilds',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(a TEXT,b TEXT,PRIMARY KEY(a)) WITHOUT ROWID, STRICT');await f.session.query("INSERT INTO t VALUES('key',NULL)");
    const before=await f.changes.structure(f.id,'t');let report=await f.apply('t',{action:'alterColumn',column:'b',change:'nullable',value:false});assert.equal(report.status,'failed');assert(report.rolledBack);assert.equal(structureFingerprint(await f.changes.structure(f.id,'t'),'sqlite'),structureFingerprint(before,'sqlite'));
    report=await f.apply('t',{action:'alterColumn',column:'b',change:'default',value:"'x'"});assert.equal(report.status,'succeeded',report.error);assert.match((await f.changes.structure(f.id,'t')).definition,/WITHOUT ROWID, STRICT/);
    await f.session.query('CREATE TABLE child(a TEXT REFERENCES t(a) ON DELETE CASCADE)');await f.session.query("INSERT INTO child VALUES('key')");report=await f.apply('t',{action:'dropTable'});assert.equal(report.status,'failed');assert(report.rolledBack);assert.equal((await f.session.query('SELECT count(*) FROM child')).rows[0]?.c0,1);
  }finally{await f.manager.close();}
});
test('SQL preview rejects stale structure/target, active transactions, read-only connections and per-connection running DDL',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(id INT)');const intent:DdlIntent={action:'renameTable',name:'next'};
    let p=await f.changes.preview(f.id,'t',intent);await f.session.query('ALTER TABLE t ADD COLUMN external TEXT');let report=await f.changes.apply(f.id,p.token);assert.equal(report.status,'failed');assert.match(report.error!,/changed after preview/);assert(report.rolledBack);
    p=await f.changes.preview(f.id,'t',intent);await f.session.query('BEGIN');report=await f.changes.apply(f.id,p.token);assert.match(report.error!,/transactions/);assert.equal(f.session.transactionState,'active');await f.session.query('ROLLBACK');
    f.rows[0]={...f.rows[0]!,name:'renamed profile'};await assert.rejects(f.changes.apply(f.id,p.token),/settings changed/);f.rows[0]={...f.rows[0]!,readOnly:true};await assert.rejects(f.changes.preview(f.id,'t',intent),/read-only/);
    assert.equal((await f.session.schema()).some(t=>t.name==='t'),true);
  }finally{await f.manager.close();}
});
test('DDL renderers use native database constraints and preserve attributes during MySQL/MariaDB modifications',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(id INT,v TEXT)');const s=await f.changes.structure(f.id,'t');s.name='"public"."t"';s.schema='public';
    assert.match(renderDdl('postgresql',{action:'alterColumn',column:'v',change:'default',value:"'x'"},s).steps[0]!.sql,/ALTER COLUMN "v" SET DEFAULT 'x'/);
    const mysql={...s,name:'`db`.`t`',schema:'db',columns:s.columns.map(c=>({...c,definition:'`'+c.name+'` varchar(40) COLLATE utf8mb4_bin DEFAULT \'keep\' COMMENT \'retained\''}))};
    for(const d of ['mysql','mariadb'] as const){const p=renderDdl(d,{action:'alterColumn',column:'v',change:'type',value:'varchar(80)'},mysql);assert.equal(p.policy,'implicit-commit');assert.match(p.steps[0]!.sql,/COLLATE utf8mb4_bin DEFAULT 'keep' COMMENT 'retained'/);}
  }finally{await f.manager.close();}
});
test('Manual migration scripts enforce SQLite validations before COMMIT and leave failed work available for explicit rollback',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT)');await f.session.query("INSERT INTO t VALUES(1,'value')");
    let p=await f.changes.preview(f.id,'t',DdlIntentSchema.parse({action:'alterColumn',column:'v',change:'default',value:"'new'"}));
    const successful=await f.session.run(previewSql(p,'sqlite'),0,'manual');assert.equal(successful.status,'succeeded',successful.error);assert.equal(f.session.transactionState,'idle');assert.equal((await f.session.query('SELECT v FROM t')).rows[0]?.c0,'value');
    await f.session.query('CREATE TABLE child(id INT REFERENCES t(id))');await f.session.query('INSERT INTO child VALUES(1)');p=await f.changes.preview(f.id,'t',{action:'dropTable'});
    const failed=await f.session.run(previewSql(p,'sqlite'),0,'manual-failed');assert.equal(failed.status,'failed');assert.equal(f.session.transactionState,'active');await f.session.query('ROLLBACK');await f.session.query('PRAGMA foreign_keys=ON');assert.equal((await f.session.query('SELECT count(*) FROM t')).rows[0]?.c0,1);
  }finally{await f.manager.close();}
});
test('Concurrent DDL requests cannot execute the same reviewed plan twice',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(id INT)');const p=await f.changes.preview(f.id,'t',{action:'renameTable',name:'next'}),first=f.changes.apply(f.id,p.token);await assert.rejects(f.changes.apply(f.id,p.token),/already running/);assert.equal((await first).status,'succeeded');assert.equal((await f.session.schema())[0]?.name,'next');
  }finally{await f.manager.close();}
});
test('SQLite virtual/shadow tables are inspection-only and AUTOINCREMENT string literals do not trigger sequence rewriting',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE VIRTUAL TABLE search USING fts5(content)');assert.equal((await f.changes.structure(f.id,'search')).editable,false);assert.equal((await f.changes.structure(f.id,'search_data')).editable,false);await assert.rejects(f.changes.preview(f.id,'search_data',{action:'dropTable'}),/cannot be changed/);
    await f.session.query("CREATE TABLE literal(v TEXT DEFAULT 'AUTOINCREMENT')");const r=await f.apply('literal',{action:'alterColumn',column:'v',change:'type',value:'VARCHAR(50)'});assert.equal(r.status,'succeeded',r.error);
  }finally{await f.manager.close();}
});
