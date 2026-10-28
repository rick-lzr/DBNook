import {backendCancellation} from './fixtures/backend-cancellation.js';
import {queryPlanContract} from './fixtures/query-plan-contract.js';
import {sqlParameterContract} from './fixtures/sql-parameter-contract.js';
import {portableStructureContract} from './fixtures/portable-structure-contract.js';
import {structureComparisonContract} from './fixtures/structure-comparison-contract.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { MysqlSession } from '../packages/drivers/mysql/session.js';
import { ProfileSchema, AuthenticationSchema, TunnelSchema, type ConnectionProfile, type ResourceSummary, type ConnectionResource } from '../packages/protocol/src/index.js';
import { ConnectionResources } from '../packages/core/src/resources.js';
import { SshTunnels } from '../packages/core/src/tunnels.js';
import { sshFixture } from './fixtures/ssh-server.js';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { GridDocumentModel } from '../packages/core/src/grid-document.js';
import {currentSql} from '../packages/core/src/sql-editing.js';
import {formatSql} from '../packages/core/src/sql-formatting.js';
import {sqlCompletions} from '../packages/core/src/sql-completion.js';
import {schemaContract} from './fixtures/schema-contract.js';
import {definitionContract} from './fixtures/definition-contract.js';
import {tableDefinitionContract} from './fixtures/table-definition-contract.js';
import {dataContract} from './fixtures/data-contract.js';
import {comparisonContract} from './fixtures/comparison-contract.js';
import {SchemaChanges} from '../packages/core/src/schema-changes.js';
import {DdlIntentSchema} from '../packages/protocol/src/index.js';
const actions:(()=>Promise<void>)[]=[];after(async()=>{for(const action of actions.reverse())await action();});
export const engine=process.env.DBW_TEST_ENGINE==='mariadb'?'mariadb':'mysql';
const profile=(extra:Partial<ConnectionProfile>={})=>ProfileSchema.parse({id:'mysql-test',name:'MySQL test',driver:engine,storage:'server',host:'localhost',port:Number(process.env.DBW_MYSQL_PORT),database:'dbworkbench',user:'dbw',sslMode:'verify-full',caPath:process.env.DBW_MYSQL_CA,...extra});
test(`${engine} managed view/routine/trigger definitions preserve semantics and detect conflicts`,async()=>{const p=profile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});try{await manager.setPassword(p.id,process.env.DBW_MYSQL_PASSWORD!,'session');await definitionContract(manager,p.id);}finally{await manager.close();}});
test(`${engine} managed table SQL migrates mapped data and preserves indexes, constraints and triggers`,async()=>{const p=profile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});try{await manager.setPassword(p.id,process.env.DBW_MYSQL_PASSWORD!,'session');await tableDefinitionContract(manager,p.id);}finally{await manager.close();}});
export async function open(extra:Partial<ConnectionProfile>={}){const session=new MysqlSession(profile(extra),async()=>process.env.DBW_MYSQL_PASSWORD);actions.push(()=>session.close());await session.open();return session;}
let sequence=0;export const table=()=>`mysql_test_${Date.now()}_${sequence++}`;
export const request=(table:string)=>({table,where:'',limit:100,offset:0,order:[]});
test('non-strict server truncation warnings roll the whole grid batch back instead of silently changing values',async()=>{const s=await open(),name=table();await s.query(`CREATE TABLE ${name}(id INT PRIMARY KEY,v VARCHAR(2))`);await s.query(`INSERT INTO ${name} VALUES(1,'ok')`);await s.query("SET SESSION sql_mode=''");const original=(await s.table(request(name))).rows[0]!;await assert.rejects(s.apply(name,['id'],[{kind:'update',original,values:{v:'hi'}},{kind:'insert',values:{id:2,v:'too long'}}]),/warning|truncation/i);assert.deepEqual((await s.table(request(name))).rows,[original]);});
test('cross-engine comparison and guarded synchronization preserve exact values and reject target drift',async()=>{await comparisonContract(profile(),process.env.DBW_MYSQL_PASSWORD!);});
test(`${engine} verified TLS, authentication errors, optional database and schema metadata`,async()=>{
  const s=await open();assert.equal(s.info?.tls,'verify-full');assert.match(s.info!.serverVersion!,engine==='mariadb'?/MariaDB/:/^8\.4\./);assert.equal(s.transactionState,'idle');
  const bad=new MysqlSession(profile(),async()=> 'incorrect');actions.push(()=>bad.close());await assert.rejects(bad.open(),/Access denied/);
  const all=await open({database:undefined});assert((await all.databases()).includes('dbworkbench'));
  const name=table();await s.query(`CREATE TABLE ${name}(id INT PRIMARY KEY,name VARCHAR(80) NOT NULL UNIQUE,hidden INT INVISIBLE DEFAULT 7,computed INT GENERATED ALWAYS AS (id*2) STORED)`);
  const objects=await s.schema();assert(objects.some(o=>o.label===name&&o.schema==='dbworkbench'));const d=await s.details(name);assert.equal(d.columns.find(c=>c.name==='id')?.primaryKey,1);assert(d.columns.find(c=>c.name==='computed')?.generated);assert(d.indexes.some(i=>i.unique));
  await s.query(`INSERT INTO ${name}(id,name) VALUES(1,'你好')`);const r=await s.table(request(name));assert.equal(r.rows[0]?.hidden,7);assert.equal(r.rows[0]?.computed,2);assert.equal(r.readOnly,false);
});
test(`${engine} table structure preview/apply preserves column attributes, manages indexes/constraints and rejects stale metadata`,async()=>{
  const p=profile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});actions.push(()=>manager.close());await manager.setPassword(p.id,process.env.DBW_MYSQL_PASSWORD!,'session');await schemaContract(manager,p.id);
  const base=await manager.connect(p.id),name=table();await base.query(`CREATE TABLE ${name}(id INT PRIMARY KEY AUTO_INCREMENT,v INT)`);
  const changes=new SchemaChanges(manager),preview=await changes.preview(p.id,name,DdlIntentSchema.parse({action:'addIndex',name:name+'_v',columns:[{name:'v'}]}));await base.query(`INSERT INTO ${name}(v) VALUES(1)`);const r=await changes.apply(p.id,preview.token);assert.equal(r.status,'succeeded',r.error);
});
test(`${engine} streamed CSV/JSON data round trips preserve exact types and cancellation leaves sibling sessions alive`,async()=>{
  const p=profile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});actions.push(()=>manager.close());await manager.setPassword(p.id,process.env.DBW_MYSQL_PASSWORD!,'session');await dataContract(manager,p.id);
});
test(`${engine} grid insert/update/delete, precision, binary, defaults, quoting and independent reads`,async()=>{
  const s=await open(),other=await open(),name=table();await s.query(`CREATE TABLE ${name}(id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,name VARCHAR(100) UNIQUE NOT NULL,n DECIMAL(50,20),b BLOB,created DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6))`);
  await s.apply(name,[],[{kind:'insert',values:{name:"O'Reilly\\中文?",n:'12345678901234567890.12345678901234567890',b:{type:'binary',base64:'AP8BAg=='}}}]);
  let r=await s.table(request(name));assert.equal(r.rows[0]?.name,"O'Reilly\\中文?");assert.equal(r.rows[0]?.n,'12345678901234567890.12345678901234567890');assert.deepEqual(r.rows[0]?.b,{type:'binary',base64:'AP8BAg=='});
  await s.apply(name,['id'],[{kind:'update',original:r.rows[0],values:{id:{type:'integer',value:'18446744073709551615'},name:'updated'}}]);r=await other.table(request(name));assert.deepEqual(r.rows[0]?.id,{type:'integer',value:'18446744073709551615'});assert.equal(r.rows[0]?.name,'updated');
  const details=await s.details(name),model=new GridDocumentModel(s.profile,details,r,request(name));assert(GridDocumentModel.restore(s.profile,name,model.backup()));
  await s.apply(name,['id'],[{kind:'delete',original:r.rows[0],values:{}}]);assert.equal((await other.table(request(name))).rows.length,0);
});
test(`${engine} batch constraint failure and stale/duplicate keys roll back the entire batch`,async()=>{
  const s=await open(),other=await open(),name=table();await s.query(`CREATE TABLE ${name}(id INT PRIMARY KEY,name VARCHAR(40) UNIQUE,group_id INT)`);await s.query(`INSERT INTO ${name} VALUES(1,'one',7),(2,'two',7)`);const r=await s.table(request(name));
  await assert.rejects(s.apply(name,['id'],[{kind:'update',original:r.rows[0],values:{name:'new'}},{kind:'insert',values:{id:3,name:'two'}}]),/Duplicate/);assert.equal((await other.table(request(name))).rows[0]?.name,'one');
  await other.query(`UPDATE ${name} SET name='external' WHERE id=1`);await assert.rejects(s.apply(name,['id'],[{kind:'update',original:r.rows[0],values:{name:'overwrite'}}]),/row changed/);
  const current=await s.table(request(name));await assert.rejects(s.apply(name,['group_id'],[{kind:'delete',original:current.rows[0],values:{}}]),/matched 2/);assert.equal((await s.table(request(name))).rows.length,2);assert.equal(s.transactionState,'idle');
});

test(`${engine} current routine execution, dialect formatting and completion use actual schema and runtime SQL mode`,async()=>{
  const s=await open(),procedure=table(),script=`DELIMITER $$\nCREATE PROCEDURE ${procedure}() BEGIN SELECT 'first;中文'; SELECT 20; END$$\nDELIMITER ;\nSELECT 999;`;
  const source=currentSql(script,script.indexOf('SELECT 20'),engine,s.sqlMode)!;
  assert.equal((await s.run(source.sql,100,'current',undefined,{singleStatement:true})).status,'succeeded');
  const called=await s.run(`CALL ${procedure}()`,100,'call',undefined,{singleStatement:true});assert.equal(called.status,'succeeded');assert.equal(called.statements[0]?.result?.rows[0]?.c0,'first;中文');assert.equal(called.statements[1]?.result?.rows[0]?.c0,20);
  const name=table();await s.query(`CREATE TABLE ${name}(id INT PRIMARY KEY,name VARCHAR(40))`);await s.query(`INSERT INTO ${name} VALUES(1,'a;中文')`);
  const metadata=await s.schema(),object=metadata.find(o=>o.label===name)!;object.columns=(await s.details(object.name)).columns;
  const text=`SELECT t.na FROM ${object.name} t`;assert(sqlCompletions(text,11,engine,[object],s.sqlMode).items.some(i=>i.insert==='`name`'));
  assert.equal((await s.query(formatSql(`select name from ${name} where id=1`,engine))).rows[0]?.c0,'a;中文');
  await s.query("SET sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'");assert(s.sqlMode.ansiQuotes&&s.sqlMode.noBackslashEscapes);assert.equal(currentSql("SELECT 'a\\'; SELECT 2;",18,engine,s.sqlMode)?.sql,' SELECT 2');
});
test(`${engine} SQL documents use separate connections and server transaction state including implicit DDL commit`,async()=>{
  const rows=[profile()],manager=new ConnectionManager({list:()=>rows,save:async p=>{rows[0]=p;},remove:async()=>{}},{runnerPath:'unused'});actions.push(()=>manager.close());await manager.setPassword(rows[0]!.id,process.env.DBW_MYSQL_PASSWORD!,'session');
  const a=await manager.lease(rows[0]!.id,'mysql-a'),b=await manager.lease(rows[0]!.id,'mysql-b');assert.notEqual((await a.query('SELECT CONNECTION_ID()')).rows[0]?.c0,(await b.query('SELECT CONNECTION_ID()')).rows[0]?.c0);
  const name=table();await a.query(`CREATE TABLE ${name}(id INT PRIMARY KEY)`);await a.query('BEGIN');assert.equal(a.transactionState,'active');await a.query(`INSERT INTO ${name} VALUES(1)`);assert.equal((await b.table(request(name))).rows.length,0);await a.query('ROLLBACK');assert.equal(a.transactionState,'idle');assert.equal((await b.table(request(name))).rows.length,0);
  await a.query('BEGIN');await a.query(`INSERT INTO ${name} VALUES(2)`);await a.query('COMMIT');assert.equal((await b.table(request(name))).rows.length,1);
  await a.query('BEGIN');await a.query(`CREATE TABLE ${table()}(id INT)`);assert.equal(a.transactionState,'idle');await a.query('SET autocommit=0');await a.query(`SELECT * FROM ${name}`);assert.equal(a.transactionState,'active');await a.query('ROLLBACK');await assert.rejects(a.apply(name,[],[{kind:'insert',values:{id:3}}]),/autocommit/);await a.query('SET autocommit=1');
});
test(`${engine} script results, DELIMITER procedures, sql_mode changes, stop on error, paging and cancellation`,async()=>{
  const s=await open(),name=table();await s.query(`CREATE TABLE ${name}(id INT PRIMARY KEY)`);await s.query(`INSERT INTO ${name} VALUES(1),(2),(3)`);
  const page=await s.table({...request(name),where:'id > 0',limit:1,offset:1});assert.equal(page.rows[0]?.id,2);assert(page.truncated);
  const run=await s.run(`SELECT 1 AS duplicate,2 AS duplicate;SELECT * FROM ${name};SELECT missing_column;SELECT 999`,1,'run');assert.equal(run.status,'failed');assert.equal(run.statements.length,3);assert.deepEqual(run.statements[0]?.result?.rows[0],{c0:1,c1:2});assert(run.statements[1]?.result?.truncated);
  const procedure=table();const routine=await s.run(`DELIMITER $$\nCREATE PROCEDURE ${procedure}() BEGIN SELECT 10;SELECT 20;END$$\nDELIMITER ;\nCALL ${procedure}();`,100,'procedure');assert.equal(routine.status,'succeeded');assert.equal(routine.statements.length,4);assert.equal(routine.statements[1]?.result?.rows[0]?.c0,10);assert.equal(routine.statements[2]?.result?.rows[0]?.c0,20);
  const modes=await s.run("SET sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES';SELECT 'a\\';SELECT 7;",100,'modes');assert.equal(modes.status,'succeeded');assert.equal(modes.statements.length,3);await s.apply(name,[],[{kind:'insert',values:{id:4}}]);
  const long=s.run('SELECT SLEEP(30)',100,'cancel');await new Promise(r=>setTimeout(r,100));assert(await s.cancel());assert.equal((await long).status,'cancelled');assert.equal(s.connected,false);
});
test(`${engine} views/MyISAM and read-only connections refuse grid writes; draft Test preserves transactions`,async()=>{
  const s=await open(),name=table();await s.query(`CREATE TABLE ${name}(id INT) ENGINE=MyISAM`);assert((await s.table(request(name))).readOnly);await assert.rejects(s.apply(name,[],[{kind:'insert',values:{id:1}}]),/InnoDB/);
  const v=table();await s.query(`CREATE VIEW ${v} AS SELECT * FROM ${name}`);assert((await s.table(request(v))).readOnly);
  const ro=await open({readOnly:true});await assert.rejects(ro.query(`INSERT INTO ${name} VALUES(1)`),/read-only/);await assert.rejects(ro.query('SET SESSION TRANSACTION READ WRITE'),/read-only/);await ro.query('BEGIN');await ro.query('ROLLBACK');
  const p=profile(),vault=new Map([[p.id,process.env.DBW_MYSQL_PASSWORD!]]),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused',credentials:{get:async id=>vault.get(id),store:async(id,value)=>{vault.set(id,value);},delete:async id=>{vault.delete(id);}}});actions.push(()=>manager.close());const live=await manager.lease(p.id,'live');await live.query('BEGIN');await assert.rejects(manager.test(p,'wrong'),/Access denied/);assert.equal(live.transactionState,'active');await manager.test(p);assert.equal(live.transactionState,'active');await live.query('ROLLBACK');
});
test(`${engine} TLS policies and parameter binding remain exact with NO_BACKSLASH_ESCAPES`,async()=>{
  for(const [mode,expected]of [['disable','disabled'],['require','encrypted'],['verify-ca','verify-ca'],['verify-full','verify-full']]as const){const s=await open({sslMode:mode,caPath:mode==='disable'||mode==='require'?undefined:process.env.DBW_MYSQL_CA});assert.equal(s.info?.tls,expected);}
  const s=await open(),name=table();await s.query(`CREATE TABLE ${name}(id INT PRIMARY KEY,v TEXT)`);await s.query("SET sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'");await s.apply(name,[],[{kind:'insert',values:{id:1,v:"' \\ ? -- ; 中文"}}]);const r=await s.table({...request(name),where:"v <> '?'"});assert.equal(r.rows[0]?.v,"' \\ ? -- ; 中文");await s.apply(name,['id'],[{kind:'update',original:r.rows[0],values:{v:'back\\slash'}}]);assert.equal((await s.table(request(name))).rows[0]?.v,'back\\slash');
});
test(`${engine} shared authentication and SSH preserve logical TLS hostname; wrong hostname is rejected`,async()=>{
  const ssh=await sshFixture({allowedPort:Number(process.env.DBW_MYSQL_PORT),mapHost:()=> '127.0.0.1'});actions.push(()=>ssh.close());
  const data:ResourceSummary={authentication:[],tunnels:[]},secrets=new Map<string,string>(),rows:ConnectionProfile[]=[];
  const resources=new ConnectionResources({list:()=>data,save:async(kind,value)=>{const list=kind==='authentication'?data.authentication:data.tunnels;(list as ConnectionResource[]).push(value);},remove:async()=>{}},{get:async id=>secrets.get(id),store:async(id,value)=>{secrets.set(id,value);},delete:async id=>{secrets.delete(id);}},()=>rows);actions.push(async()=>resources.close());
  const tunnels=new SshTunnels(resources);actions.push(()=>tunnels.close());
  const auth=AuthenticationSchema.parse({id:'mysql-auth',name:'Shared MySQL',kind:'password',user:'dbw'}),tunnel=TunnelSchema.parse({id:'mysql-ssh',name:'MySQL SSH',kind:'ssh',host:'127.0.0.1',port:ssh.port,user:'ssh-user',auth:'password',fingerprint:ssh.fingerprint});
  await resources.save('authentication',auth,{secret:process.env.DBW_MYSQL_PASSWORD,remember:true,revision:resources.revision('authentication',auth.id)});await resources.save('tunnel',tunnel,{secret:'ssh-test-password',remember:true,revision:resources.revision('tunnel',tunnel.id)});
  const p=profile({user:undefined,authRef:auth.id,tunnelRef:tunnel.id});rows.push(p);const manager=new ConnectionManager({list:()=>rows,save:async()=>{},remove:async()=>{}},{runnerPath:'unused',resources,tunnels});actions.push(()=>manager.close());
  const a=await manager.lease(p.id,'shared-a'),b=await manager.lease(p.id,'shared-b');assert.equal(a.info?.tls,'verify-full');assert.equal(tunnels.status()[0]?.references,2);await a.query('BEGIN');await assert.rejects(manager.test({...p,host:'wrong.invalid'}),/Hostname\/IP|not in the cert|altname/i);assert.equal(a.transactionState,'active');assert.equal((await b.query('SELECT 77')).rows[0]?.c0,77);await a.query('ROLLBACK');await backendCancellation(manager,p.id);assert.equal((await b.query('SELECT 78')).rows[0]?.c0,78);await manager.close();assert.equal(tunnels.status().length,0);
});

test(`${engine} structure comparison synchronizes selected schema across connections and preserves target data`,async()=>{await structureComparisonContract(profile(),process.env.DBW_MYSQL_PASSWORD!);});

test(`${engine} and SQLite structure conversions preserve target rows and exact defaults with explicit manual choices`,async()=>{await portableStructureContract(profile(),process.env.DBW_MYSQL_PASSWORD!);});

test('Real execution plans retain document sessions, distinguish execution, enforce read-only and cancel',async()=>{await queryPlanContract(profile(),process.env.DBW_MYSQL_PASSWORD!);});
test(`${engine} SQL parameters retain exact values, transaction ownership and live SQL mode`,async()=>{await sqlParameterContract(profile(),process.env.DBW_MYSQL_PASSWORD!);});
