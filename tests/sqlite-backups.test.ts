import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {SqliteBackups} from '../packages/core/src/sqlite-backups.js';
import {ProfileSchema,type ConnectionProfile} from '../packages/protocol/src/index.js';
async function fixture(memory=false){const directory=await mkdtemp(join(tmpdir(),'dbw-backup-')),profile=ProfileSchema.parse({id:'backup',name:'Backup',driver:'sqlite',storage:memory?'memory':'file',path:join(directory,'source.db'),createIfMissing:true});let profiles:ConnectionProfile[]=[profile];const manager=new ConnectionManager({list:()=>profiles,save:async p=>{profiles=[...profiles.filter(v=>v.id!==p.id),p];},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')}),service=new SqliteBackups(manager,join(directory,'jobs'));return {directory,profile,manager,service,session:await manager.connect(profile.id),close:async()=>{await service.dispose();await manager.close();await rm(directory,{recursive:true,force:true});}};}
test('Online SQLite backup includes live WAL, exact values, schema dependencies, metadata and sequences',async()=>{
  const f=await fixture();try{
    await f.session.query('PRAGMA journal_mode=WAL');await f.session.query('PRAGMA wal_autocheckpoint=0');
    await f.session.run("PRAGMA user_version=17; PRAGMA application_id=1234; CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT,b BLOB,n INTEGER);CREATE TABLE log(v TEXT);CREATE INDEX t_v ON t(v);CREATE VIEW tv AS SELECT * FROM t;CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES(new.v); END;INSERT INTO t VALUES(100,'中文',X'00FF',9223372036854775807);DELETE FROM t;INSERT INTO t(v,b,n) VALUES('kept',X'00FF',9223372036854775807)",100,'setup');
    assert((await stat(f.profile.path+'-wal')).size>0);const path=join(f.directory,'backup.db'),events:string[]=[];const report=await f.service.backup(f.profile.id,path,p=>events.push(p.phase));assert.equal(report.status,'succeeded',report.error);assert(report.published);assert.equal(report.info?.userVersion,17);assert.equal(report.info?.applicationId,1234);assert(events.includes('Checking integrity'));assert(report.reportPath);assert.equal(JSON.parse(await readFile(report.reportPath,'utf8')).published,true);
    const db=new DatabaseSync(path);try{const q=db.prepare('SELECT id,v,hex(b) b,n FROM t');q.setReadBigInts(true);assert.deepEqual({...q.get()},{id:101n,v:'kept',b:'00FF',n:9223372036854775807n});assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name IN('tv','tr','t_v')").get()!.n,3);db.exec("INSERT INTO t(v) VALUES('after restore')");assert.equal(db.prepare('SELECT max(id) id FROM t').get()!.id,102);assert.equal(db.prepare("SELECT count(*) n FROM log WHERE v='after restore'").get()!.n,1);}finally{db.close();}
    assert.equal((await f.session.query('SELECT count(*) FROM t')).rows[0]?.c0,1);
  }finally{await f.close();}
});
test('Restore publishes only the reviewed snapshot and never overwrites a destination or configured connection',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(v TEXT)');await f.session.query("INSERT INTO t VALUES('reviewed')");const source=join(f.directory,'saved.db');assert.equal((await f.service.backup(f.profile.id,source)).status,'succeeded');const destination=join(f.directory,'restored.db');const preview=await f.service.previewRestore(source,destination);assert(preview.info.objects.some(o=>o.name==='t'));const modify=new DatabaseSync(source);modify.exec("INSERT INTO t VALUES('later source change')");modify.close();
    const result=await f.service.restore(preview.token);assert.equal(result.status,'succeeded',result.error);const db=new DatabaseSync(destination,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM t').get()!.n,1);db.close();await assert.rejects(f.service.restore(preview.token),/expired/);await assert.rejects(f.service.previewRestore(source,destination),/already exists/);assert.equal((await f.service.backup(f.profile.id,destination)).status,'failed');
    const reserved=join(f.directory,'reserved.db');await f.manager.save({...f.profile,id:'configured-missing',path:reserved});await assert.rejects(f.service.previewRestore(source,reserved),/configured/);assert.equal((await readFile(destination)).subarray(0,15).toString(),'SQLite format 3');
  }finally{await f.close();}
});
test('Shared memory online backup cancellation is cooperative, preserves every session and publishes nothing',async()=>{
  const f=await fixture(true);try{
    await f.session.query('CREATE TABLE t(id INTEGER PRIMARY KEY,b BLOB)');await f.session.query('WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO t SELECT x,randomblob(8192) FROM n');const sibling=await f.manager.lease(f.profile.id,'sibling');await sibling.query('BEGIN');const path=join(f.directory,'cancel.db'),abort=new AbortController();
    const report=await f.service.backup(f.profile.id,path,p=>{if(p.phase==='Copying pages')abort.abort();},abort.signal);assert.equal(report.status,'cancelled',report.error);assert.equal(report.published,false);await assert.rejects(stat(path),{code:'ENOENT'});assert(f.session.connected);assert(sibling.connected);assert.equal(sibling.transactionState,'active');await sibling.query('ROLLBACK');assert.equal((await f.session.query('SELECT count(*) FROM t')).rows[0]?.c0,1000);assert(!(await readdir(f.directory)).some(p=>p.endsWith('.tmp')));
    const success=await f.service.backup(f.profile.id,path);assert.equal(success.status,'succeeded',success.error);await f.manager.releaseLease('sibling');
  }finally{await f.close();}
});
test('Restore rejects corrupt sources and sidecars, rechecks target collisions and verifies the private snapshot hash',async()=>{
  const f=await fixture();try{
    const bad=join(f.directory,'bad.db');await writeFile(bad,'not SQLite');await assert.rejects(f.service.previewRestore(bad,join(f.directory,'new.db')));assert(!(await readdir(join(f.directory,'jobs'))).some(p=>p.endsWith('.snapshot')));
    await f.session.query('CREATE TABLE t(v TEXT)');const source=join(f.directory,'saved.db');await f.service.backup(f.profile.id,source);const target=join(f.directory,'target.db');await writeFile(target+'-wal','sentinel');await assert.rejects(f.service.previewRestore(source,target),/sidecar/);await rm(target+'-wal');
    const p=await f.service.previewRestore(source,target);await writeFile(target,'existing');const collision=await f.service.restore(p.token);assert.equal(collision.published,false);assert.equal(collision.status,'failed');assert.equal(await readFile(target,'utf8'),'existing');
    const changed=await f.service.previewRestore(source,join(f.directory,'changed.db'));await writeFile(join(f.directory,'jobs',changed.token+'.snapshot'),'modified');await assert.rejects(f.service.restore(changed.token),/changed/);assert(!(await readdir(join(f.directory,'jobs'))).some(p=>p.endsWith('.snapshot')));
  }finally{await f.close();}
});
test('A restore cancelled after review and service disposal cannot publish or leave private review files',async()=>{
  const f=await fixture(true);try{
    await f.session.query('CREATE TABLE t(v TEXT)');const source=join(f.directory,'saved.db');await f.service.backup(f.profile.id,source);const dest=join(f.directory,'restored.db'),p=await f.service.previewRestore(source,dest),abort=new AbortController();const report=await f.service.restore(p.token,()=>abort.abort(),abort.signal);assert.equal(report.status,'cancelled');assert(!report.published);await assert.rejects(stat(dest));
    await f.service.previewRestore(source,dest);await f.service.dispose();assert(!(await readdir(join(f.directory,'jobs'))).some(p=>p.endsWith('.snapshot')));await assert.rejects(f.service.backup(f.profile.id,dest),/closed/);
  }finally{await f.close();}
});
test('A failed progress consumer cannot kill a shared SQLite process or turn a cancelled job into a publication',async()=>{
  const f=await fixture(true);try{
    await f.session.query('CREATE TABLE t(b BLOB)');await f.session.query('INSERT INTO t VALUES(zeroblob(2000000))');
    const report=await f.service.backup(f.profile.id,join(f.directory,'observer.db'),p=>{if(p.phase==='Copying pages')throw new Error('observer failed');});assert.equal(report.status,'failed');assert.match(report.error??'',/observer failed/);assert.equal(report.published,false);assert(f.session.connected);assert.equal((await f.session.query('SELECT length(b) FROM t')).rows[0]?.c0,2000000);
  }finally{await f.close();}
});
test('Backup excludes uncommitted WAL data without committing the source; cancellation at publication still preserves the destination',async()=>{
  const f=await fixture();try{
    await f.session.query('PRAGMA journal_mode=WAL');await f.session.query('CREATE TABLE t(v TEXT)');await f.session.query("INSERT INTO t VALUES('committed')");await f.session.query('BEGIN');await f.session.query("INSERT INTO t VALUES('uncommitted')");
    const path=join(f.directory,'committed.db'),report=await f.service.backup(f.profile.id,path);assert.equal(report.status,'succeeded',report.error);assert.equal(f.session.transactionState,'active');const db=new DatabaseSync(path,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM t').get()!.n,1);db.close();await f.session.query('ROLLBACK');
    const abort=new AbortController(),dest=join(f.directory,'cancel-final.db'),cancelled=await f.service.backup(f.profile.id,dest,p=>{if(p.phase==='Publishing verified database')abort.abort();},abort.signal);assert.equal(cancelled.status,'cancelled');assert(!cancelled.published);await assert.rejects(stat(dest));
    const outputs=await Promise.all([f.service.backup(f.profile.id,dest),f.service.backup(f.profile.id,dest)]);assert.equal(outputs.filter(r=>r.published).length,1);assert.equal(outputs.filter(r=>r.status==='failed').length,1);
  }finally{await f.close();}
});
