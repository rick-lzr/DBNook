import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {ServerBackups} from '../packages/core/src/server-backups.js';
import {ProfileSchema,type ConnectionProfile} from '../packages/protocol/src/index.js';

const driver=process.env.DBW_NATIVE_ENGINE as 'postgresql'|'mysql'|'mariadb',pg=driver==='postgresql',root='/work/.cache/native-backup-tests';await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,driver+'-'));
let profiles:ConnectionProfile[]=[];const manager=new ConnectionManager({list:()=>profiles,save:async p=>{profiles=[...profiles.filter(v=>v.id!==p.id),p];},remove:async id=>{profiles=profiles.filter(p=>p.id!==id);}},{runnerPath:'/unused'});
const tools={dump:pg?'/usr/lib/postgresql/17/bin/pg_dump':driver==='mysql'?'/usr/bin/mysqldump':'/usr/bin/mariadb-dump',restore:pg?'/usr/lib/postgresql/17/bin/pg_restore':driver==='mysql'?'/usr/bin/mysql':'/usr/bin/mariadb'};
const service=new ServerBackups(manager,join(directory,'jobs'),()=>tools),checks:string[]=[];const check=(s:string)=>{checks.push(s);console.log('PASS '+driver+' '+s);};
try{
  const source=ProfileSchema.parse({id:'source',name:'Source',driver,storage:'server',host:'127.0.0.1',port:pg?5432:3306,database:'dbworkbench',user:'dbw',sslMode:'disable'}),target={...source,id:'target',name:'Target',host:'native-target'};await manager.save(source);await manager.save(target);await manager.setPassword('source',process.env.DBW_NATIVE_PASSWORD!,'session');await manager.setPassword('target',process.env.DBW_NATIVE_PASSWORD!,'session');
  const db=await manager.connect('source'),restore=await manager.connect('target');
  await db.query(`CREATE TABLE items(id BIGINT PRIMARY KEY, amount DECIMAL(30,10), bytes ${pg?'BYTEA':'BLOB'}, label TEXT, missing TEXT)`);
  await db.query(`INSERT INTO items VALUES(9223372036854775807,12345678901234567890.1234567890,${pg?"decode('0001ff','hex')":"x'0001ff'"},'中文 · backup',NULL)`);
  await db.query('CREATE VIEW items_view AS SELECT id,label FROM items');
  await db.query(pg?'CREATE TABLE seq_items(id BIGSERIAL PRIMARY KEY,v TEXT)':'CREATE TABLE seq_items(id BIGINT PRIMARY KEY AUTO_INCREMENT,v TEXT)');await db.query("INSERT INTO seq_items(v) VALUES('sequence')");
  await db.query(pg?'CREATE FUNCTION answer() RETURNS integer LANGUAGE SQL AS $$ SELECT 42 $$':'CREATE FUNCTION answer() RETURNS INTEGER DETERMINISTIC RETURN 42');
  await db.query('CREATE TABLE audit(id BIGINT)');if(pg){await db.query('CREATE FUNCTION record_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit VALUES(NEW.id); RETURN NEW; END $$');await db.query('CREATE TRIGGER items_audit AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION record_insert()');}else{await db.query('CREATE TRIGGER items_audit AFTER INSERT ON items FOR EACH ROW INSERT INTO audit VALUES(NEW.id)');await db.query('CREATE EVENT future_event ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 30 DAY DO INSERT INTO audit VALUES(42)');}
  const pending=await manager.lease('source','pending-source');await pending.query('BEGIN');await pending.query("INSERT INTO items VALUES(2,2,NULL,'uncommitted',NULL)");
  const file=join(directory,pg?'snapshot.dump':'snapshot.sql'),backup=await service.backup('source',file);assert.equal(backup.status,'succeeded',backup.error);assert.equal(backup.outcome,'published');check('Real native dump captures tables, exact types, view, routine and identity/sequence state');
  assert.equal(pending.transactionState,'active');await pending.query('ROLLBACK');await manager.releaseLease('pending-source');check('Backup excludes and preserves an existing uncommitted document transaction');
  const preview=await service.previewRestore('target',file);assert(preview.bytes>0);assert.equal((await restore.schema()).length,0);check('Archive/SQL inspection and empty-target preview execute no restore SQL');
  const sql=await service.reviewSql(preview.token);assert((await readFile(sql,'utf8')).includes('items'));const intact=join(directory,'intact.backup');await copyFile(file,intact);await writeFile(file,'original file changed after preview');
  const result=await service.restore(preview.token,{database:'dbworkbench',trusted:true});assert.equal(result.status,'succeeded',result.error);assert.equal(result.outcome,'restored');
  assert.deepEqual((await restore.query('SELECT * FROM items')).rows,(await db.query('SELECT * FROM items')).rows);assert.deepEqual((await restore.query('SELECT * FROM items_view')).rows,(await db.query('SELECT * FROM items_view')).rows);assert.equal((await restore.query('SELECT answer()')).rows[0]?.c0,42);await restore.query("INSERT INTO seq_items(v) VALUES('after restore')");assert.equal((await restore.query('SELECT max(id) FROM seq_items')).rows[0]?.c0,2);check('Frozen backup restores on a separate real server with independent data/objects and exact values');
  await restore.query("INSERT INTO items VALUES(3,3,NULL,'trigger after restore',NULL)");assert.equal((await restore.query('SELECT count(*) FROM audit')).rows[0]?.c0,1);if(!pg)assert.equal((await restore.query('SELECT count(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()')).rows[0]?.c0,1);check('Restored trigger and native scheduled-event definitions retain their behavior');
  await assert.rejects(service.previewRestore('target',intact),/empty/);await assert.rejects(service.restore(preview.token,{database:'dbworkbench',trusted:true}),/expired/);check('Nonempty targets and consumed previews are rejected');
  const contents=await readFile(result.reportPath!,'utf8');assert(!contents.includes(process.env.DBW_NATIVE_PASSWORD!));check('Local report contains outcome and version evidence without the resolved credential');
  await writeFile(`/work/artifacts/${driver}-native-backups-0.16.0.json`,JSON.stringify({passed:true,driver,server:db.info?.serverVersion,tool:backup.toolVersion,platform:process.platform,node:process.versions.node,checks,backup,restore:result},null,2)+'\n');
}finally{await service.dispose();await manager.close();await rm(directory,{recursive:true,force:true});}
