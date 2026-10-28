import {backendCancellation} from './fixtures/backend-cancellation.js';
import {queryPlanContract} from './fixtures/query-plan-contract.js';
import {sqlParameterContract} from './fixtures/sql-parameter-contract.js';
import {portableStructureContract} from './fixtures/portable-structure-contract.js';
import {structureComparisonContract} from './fixtures/structure-comparison-contract.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresSession } from '../packages/drivers/postgresql/session.js';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { GridDocumentModel } from '../packages/core/src/grid-document.js';
import { ProfileSchema, type ConnectionProfile } from '../packages/protocol/src/index.js';
import {AuthenticationSchema,TunnelSchema,type ResourceSummary} from '../packages/protocol/src/index.js';
import {ConnectionResources,type ResourceStore} from '../packages/core/src/resources.js';
import {SshTunnels} from '../packages/core/src/tunnels.js';
import {sshFixture} from './fixtures/ssh-server.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverSshConfigs} from '../packages/core/src/ssh-config.js';
import {schemaContract} from './fixtures/schema-contract.js';
import {definitionContract} from './fixtures/definition-contract.js';
import {tableDefinitionContract} from './fixtures/table-definition-contract.js';
import {dataContract} from './fixtures/data-contract.js';
import {comparisonContract} from './fixtures/comparison-contract.js';
const actions: (()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const action of actions.splice(0).reverse()) await action();});
const makeProfile=(extra: Partial<ConnectionProfile>={})=>ProfileSchema.parse({id:randomUUID(),name:'PostgreSQL test',driver:'postgresql',storage:'server',host:'127.0.0.1',port:Number(process.env.DBW_PG_PORT),database:'dbworkbench',user:'dbw',sslMode:'disable',...extra});
test('PostgreSQL managed view/routine/trigger definitions preserve semantics and detect conflicts',async()=>{const p=makeProfile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});try{await manager.setPassword(p.id,process.env.DBW_PG_PASSWORD!,'session');await definitionContract(manager,p.id);}finally{await manager.close();}});
test('PostgreSQL managed table SQL migrates mapped data and preserves indexes, constraints and triggers',async()=>{const p=makeProfile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});try{await manager.setPassword(p.id,process.env.DBW_PG_PASSWORD!,'session');await tableDefinitionContract(manager,p.id);}finally{await manager.close();}});
async function fixture() {
  // Other service-contract tests create their own isolated manager and table names.
  const profile=makeProfile(), session=new PostgresSession(profile,async()=>process.env.DBW_PG_PASSWORD); await session.open();actions.push(()=>session.close());
  const name='test_'+randomUUID().replaceAll('-',''); await session.query(`CREATE SCHEMA ${name}`); actions.push(()=>session.query(`DROP SCHEMA ${name} CASCADE`));
  return {session,profile,name};
}
test('cross-engine comparison and guarded synchronization preserve exact values and reject target drift',async()=>{await comparisonContract(makeProfile({host:'localhost',sslMode:'verify-full',caPath:process.env.DBW_PG_CA}),process.env.DBW_PG_PASSWORD!);});
test('PostgreSQL authenticates, verifies TLS, rejects bad credentials and wrong CA',async()=>{
  const good=new PostgresSession(makeProfile({sslMode:'verify-full',caPath:process.env.DBW_PG_CA}),async()=>process.env.DBW_PG_PASSWORD);actions.push(()=>good.close());
  assert.match((await good.open()).serverVersion!,/^17\./);
  const encrypted=await good.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');assert.equal(encrypted.rows[0]?.c0,true);
  const wrong=new PostgresSession(makeProfile(),async()=> 'invalid-test-password');await assert.rejects(wrong.open(),/password authentication failed/);
  const noCa=new PostgresSession(makeProfile({sslMode:'verify-full'}),async()=>process.env.DBW_PG_PASSWORD);await assert.rejects(noCa.open(),/self-signed|certificate/i);
});
test('PostgreSQL table structure preview/apply manages native DDL and checks catalog conflicts',async()=>{
  const p=makeProfile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});actions.push(()=>manager.close());await manager.setPassword(p.id,process.env.DBW_PG_PASSWORD!,'session');await schemaContract(manager,p.id);
});
test('PostgreSQL cursor exports and mapped CSV/JSON imports retain precision, binary and NULL semantics',async()=>{
  const p=makeProfile(),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});actions.push(()=>manager.close());await manager.setPassword(p.id,process.env.DBW_PG_PASSWORD!,'session');await dataContract(manager,p.id);
});
test('PostgreSQL metadata preserves quoted schema/object names, composite PK, generated columns and foreign keys',async()=>{
  const {session,name}=await fixture();await session.query(`CREATE TABLE ${name}.parent(a int,b int,PRIMARY KEY(b,a))`);
  await session.query(`CREATE TABLE ${name}."复杂.name"(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,a int,b int,v text,g int GENERATED ALWAYS AS (a+1) STORED,FOREIGN KEY(a,b) REFERENCES ${name}.parent(a,b))`);
  await session.query(`CREATE VIEW ${name}.items_view AS SELECT * FROM ${name}."复杂.name"`);
  const schema=await session.schema();assert(schema.some(o=>o.name===`${name}."复杂.name"`));assert(schema.some(o=>o.name===`${name}.items_view`&&o.type==='view'));
  const pk=await session.details(`${name}.parent`);assert.equal(pk.columns.find(c=>c.name==='b')?.primaryKey,1);assert.equal(pk.columns.find(c=>c.name==='a')?.primaryKey,2);
  const details=await session.details(`${name}."复杂.name"`);assert(details.columns.find(c=>c.name==='g')?.generated);assert(details.columns.find(c=>c.name==='id')?.generated);assert.equal(details.foreignKeys.length,2);assert(details.indexes.length);
});
test('PostgreSQL rows retain bigint, decimal, bytea, JSON, timestamp microseconds, booleans, NULL and duplicate labels',async()=>{
  const {session}=await fixture();const result=await session.query("SELECT 9223372036854775807::bigint AS x, 1 AS x, 12345678901234567890.123456789::numeric, '\\x00ff'::bytea, '{\"x\":9007199254740993}'::jsonb, TIMESTAMP '2026-10-20 10:20:30.123456',true,NULL::text");
  assert.equal(result.columns[0]?.name,result.columns[1]?.name);assert.deepEqual(result.rows[0]?.c0,{type:'integer',value:'9223372036854775807'});assert.equal(result.rows[0]?.c1,1);assert.equal(result.rows[0]?.c2,'12345678901234567890.123456789');assert.deepEqual(result.rows[0]?.c3,{type:'binary',base64:'AP8='});assert.equal(result.rows[0]?.c4,'{"x": 9007199254740993}');assert.equal(result.rows[0]?.c5,'2026-10-20 10:20:30.123456');assert.equal(result.rows[0]?.c6,true);assert.equal(result.rows[0]?.c7,null);
  const capped=await session.query('SELECT generate_series(1,100000)',3);assert.equal(capped.rows.length,3);assert(capped.truncated);
});
test('PostgreSQL scripts handle dollar bodies/comments, stop after errors and retain native aborted transaction state',async()=>{
  const {session,name}=await fixture();const progress: number[]=[];
  const script=`/* outer /* inner; */ comment */ CREATE FUNCTION ${name}.f() RETURNS text LANGUAGE plpgsql AS $body$ BEGIN RETURN 'a;b'; END; $body$; SELECT ${name}.f(); BEGIN; SELECT 1/0; SELECT 'never';`;
  const run=await session.run(script,100,'run',item=>progress.push(item.index));assert.equal(run.status,'failed');assert.equal(run.statements.length,4);assert.deepEqual(progress,[0,1,2,3]);assert.equal(run.statements[1]?.result?.rows[0]?.c0,'a;b');assert.equal(session.transactionState,'active');await assert.rejects(session.query('SELECT 1'),/transaction is aborted/);await session.query('ROLLBACK');assert.equal(session.transactionState,'idle');
  await assert.rejects(session.query('SELECT 1; SELECT 2'),/multiple commands/);
});
test('PostgreSQL document leases isolate transactions and reset a cancelled long query without affecting siblings',async()=>{
  const profile=makeProfile(),rows=[profile],manager=new ConnectionManager({list:()=>rows,save:async p=>{rows[0]=p;},remove:async()=>{}},{runnerPath:'unused'});actions.push(()=>manager.close());await manager.setPassword(profile.id,process.env.DBW_PG_PASSWORD!,'session');
  const base=await manager.connect(profile.id),a=await manager.lease(profile.id,'a'),b=await manager.lease(profile.id,'b');
  await a.query('BEGIN');await a.query('CREATE TEMP TABLE hidden(v int)');await assert.rejects(b.query('SELECT * FROM hidden'),/does not exist/);assert.equal(a.transactionState,'active');assert.equal(b.transactionState,'idle');
  await manager.releaseLease('a');assert.equal((await base.query('SELECT 7')).rows[0]?.c0,7);
  const slow=b.query('SELECT pg_sleep(30)');const rejected=assert.rejects(slow,/terminated|closed|lost/i);await new Promise(resolve=>setTimeout(resolve,150));assert.equal(await manager.cancelLease('b'),true);await rejected;assert.equal(b.connected,false);await assert.rejects(manager.lease(profile.id,'b'),/lost/);assert.equal((await base.query('SELECT 8')).rows[0]?.c0,8);await manager.releaseLease('b');assert.equal((await (await manager.lease(profile.id,'b')).query('SELECT 9')).rows[0]?.c0,9);
});
test('PostgreSQL grid saves quoted values atomically, rejects stale/duplicate rows, protects generated columns and restores drafts only to the same target',async()=>{
  const {session,profile,name}=await fixture(),table=`${name}.items`;await session.query(`CREATE TABLE ${table}(id int PRIMARY KEY,v text,n numeric(30,10),b bytea,g text GENERATED ALWAYS AS (upper(v)) STORED)`);await session.query(`INSERT INTO ${table}(id,v,n,b) VALUES(1,'old',1.23,'\\x00ff'),(2,'second',2,NULL)`);
  const request={table,where:'',order:[{column:'id',direction:'asc' as const}],offset:0,limit:100};let result=await session.table(request);assert.equal(result.columns[0]?.key,'id');assert.equal(result.rows[0]?.n,'1.2300000000');
  const model=new GridDocumentModel(profile,await session.details(table),result,request);model.update(0,{keyColumns:['id'],added:[],edits:{r0:{kind:'update',original:result.rows[0],values:{v:"O'Brien; -- data"}}}});const restored=GridDocumentModel.restore(profile,table,model.backup());assert(restored.dirty);assert.throws(()=>GridDocumentModel.restore({...profile,database:'different'},table,model.backup()),/another database/);await restored.save(session);assert.equal((await session.table(request)).rows[0]?.v,"O'Brien; -- data");
  result=await session.table(request);await assert.rejects(session.apply(table,['id'],[{kind:'update',original:result.rows[0],values:{v:'must rollback'}},{kind:'insert',values:{id:2,v:'duplicate'}}]),/duplicate key/);assert.equal((await session.table(request)).rows[0]?.v,"O'Brien; -- data");
  await session.query(`UPDATE ${table} SET v='external' WHERE id=1`);await assert.rejects(session.apply(table,['id'],[{kind:'update',original:result.rows[0],values:{v:'stale'}}]),/changed since/);await assert.rejects(session.apply(table,['id'],[{kind:'insert',values:{id:3,g:'generated'}}]),/generated/);
  await session.query('BEGIN');await assert.rejects(session.apply(table,['id'],[{kind:'insert',values:{id:3}}]),/open SQL transaction/);await session.query('ROLLBACK');
});
test('PostgreSQL readonly handle rejects database writes while allowing browse',async()=>{
  const {session,name}=await fixture();await session.query(`CREATE TABLE ${name}.t(id int)`);
  const ro=new PostgresSession(makeProfile({readOnly:true}),async()=>process.env.DBW_PG_PASSWORD);actions.push(()=>ro.close());await ro.open();assert((await ro.table({table:`${name}.t`,where:'',order:[],limit:100,offset:0})).readOnly);await assert.rejects(ro.query(`INSERT INTO ${name}.t VALUES(1)`),/read-only transaction/);await assert.rejects(ro.query('BEGIN READ WRITE'),/read-only/);
});
test('TLS modes, application name and timeout options use the same parameters for test and open',async()=>{
  for(const [mode,expected] of [['prefer','encrypted'],['allow','disabled'],['require','verify-ca'],['verify-ca','verify-ca'],['verify-full','verify-full']] as const) {
    const session=new PostgresSession(makeProfile({sslMode:mode,caPath:process.env.DBW_PG_CA,applicationName:'Workbench import test',connectTimeout:10000}),async()=>process.env.DBW_PG_PASSWORD);actions.push(()=>session.close());assert.equal((await session.open()).tls,expected);assert.equal((await session.query('SHOW application_name')).rows[0]?.c0,'Workbench import test');
  }
});
test('Testing draft credentials leaves live transactions, stored passwords and document leases intact',async()=>{
  const profile=makeProfile(),rows=[profile],vault=new Map([[profile.id,process.env.DBW_PG_PASSWORD!]]);
  const manager=new ConnectionManager({list:()=>rows,save:async p=>{rows[0]=p;},remove:async()=>{}},{runnerPath:'unused',credentials:{get:async id=>vault.get(id),store:async(id,p)=>{vault.set(id,p);},delete:async id=>{vault.delete(id);}}});actions.push(()=>manager.close());
  const live=await manager.lease(profile.id,'live');await live.query('BEGIN');const revision=manager.editorRevision(profile.id);
  await assert.rejects(manager.test(profile,'wrong-draft-password'),/password authentication/);assert.equal(live.connected,true);assert.equal(live.transactionState,'active');assert.equal(await manager.lease(profile.id,'live'),live);assert.equal(manager.editorRevision(profile.id),revision);assert.equal(vault.get(profile.id),process.env.DBW_PG_PASSWORD);
  await manager.test(profile,process.env.DBW_PG_PASSWORD);assert.equal(live.transactionState,'active');await manager.save({...profile,name:'Renamed only'},{rememberPassword:false,revision});assert.equal(vault.size,0);assert.equal(live.transactionState,'active');assert.equal((await live.query('SELECT 4')).rows[0]?.c0,4);await live.query('ROLLBACK');
});
test('Shared authentication and SSH forwarding preserve PostgreSQL TLS identity and independent sessions, then fail closed after tunnel loss',async()=>{
  const ssh=await sshFixture({allowedPort:Number(process.env.DBW_PG_PORT),mapHost:()=> '127.0.0.1'});actions.push(()=>ssh.close());
  const values:ResourceSummary={authentication:[],tunnels:[]},secrets=new Map<string,string>(),rows:ConnectionProfile[]=[];
  const store:ResourceStore={list:()=>values,save:async(kind,value)=>{if(kind==='authentication')values.authentication=[value as ResourceSummary['authentication'][number]];else values.tunnels=[value as ResourceSummary['tunnels'][number]];},remove:async()=>{}};
  const resources=new ConnectionResources(store,{get:async id=>secrets.get(id),store:async(id,value)=>{secrets.set(id,value);},delete:async id=>{secrets.delete(id);}},()=>rows),tunnels=new SshTunnels(resources);actions.push(()=>tunnels.close());
  await resources.save('authentication',AuthenticationSchema.parse({id:'shared',name:'Shared PG',kind:'password',user:'dbw'}),{secret:process.env.DBW_PG_PASSWORD,remember:true,revision:resources.revision('authentication','shared')});
  await resources.save('tunnel',TunnelSchema.parse({id:'ssh',name:'SSH PG',kind:'ssh',host:'127.0.0.1',port:ssh.port,user:'ssh-user',auth:'password',fingerprint:ssh.fingerprint}),{secret:'ssh-test-password',remember:true,revision:resources.revision('tunnel','ssh')});
  const profile=makeProfile({host:'localhost',user:undefined,authRef:'shared',tunnelRef:'ssh',sslMode:'verify-full',caPath:process.env.DBW_PG_CA});rows.push(profile);
  const manager=new ConnectionManager({list:()=>rows,save:async p=>{rows[0]=p;},remove:async()=>{}},{runnerPath:'unused',resources,tunnels});actions.push(()=>manager.close());
  const base=await manager.connect(profile.id),a=await manager.lease(profile.id,'a'),b=await manager.lease(profile.id,'b');assert.equal(base.info?.tls,'verify-full');assert.equal((await base.query('SELECT current_user')).rows[0]?.c0,'dbw');assert.equal(tunnels.status().length,1);assert.equal(tunnels.status()[0]?.references,3);
  assert.notEqual((await a.query('SELECT pg_backend_pid()')).rows[0]?.c0,(await b.query('SELECT pg_backend_pid()')).rows[0]?.c0);await a.query('BEGIN');
  await assert.rejects(manager.test({...profile,id:'wrong-host',host:'wrong.invalid'}),/Hostname\/IP|not in the cert|altname/i);assert.equal(tunnels.status()[0]?.references,3);assert.equal(a.transactionState,'active');
  await assert.rejects(manager.test(profile,'invalid-draft-password'),/password authentication/);assert.equal(a.transactionState,'active');
  await backendCancellation(manager,profile.id);assert.equal(a.transactionState,'active');assert.equal((await b.query('SELECT 78')).rows[0]?.c0,78);
  ssh.drop();const deadline=Date.now()+5000;while(a.connected&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(a.connected,false);await assert.rejects(manager.lease(profile.id,'a'),/lost/);
  await manager.releaseLease('a');await manager.releaseLease('b');const renewed=await manager.lease(profile.id,'a');assert.equal((await renewed.query('SELECT 7')).rows[0]?.c0,7);assert.equal(renewed.transactionState,'idle');assert.equal(a.connected,false);await manager.close();assert.equal(tunnels.status().length,0);
});

test('Credential commands authenticate real PostgreSQL; cached resolution and failed drafts preserve active transactions',async()=>{
  const auth=AuthenticationSchema.parse({id:'command',name:'Command PG',kind:'command',user:'dbw',executable:process.execPath,args:['-e','process.stdout.write(JSON.stringify({credentials:{user:process.env.DBW_AUTH_USER,token:process.env.DBW_PG_PASSWORD},expires:(Date.now()+60000)/1000}))'],output:'json',userPath:'credentials.user',passwordPath:'credentials.token',expiresAtPath:'expires',cacheTtl:60});
  const values:ResourceSummary={authentication:[auth],tunnels:[]},resources=new ConnectionResources({list:()=>values,save:async()=>{},remove:async()=>{}},{get:async()=>undefined,store:async()=>{assert.fail('External credentials must not be persisted');},delete:async()=>{}},()=>[]);actions.push(async()=>resources.close());
  const profile=makeProfile({user:undefined,authRef:auth.id,sslMode:'verify-full',caPath:process.env.DBW_PG_CA}),manager=new ConnectionManager({list:()=>[profile],save:async()=>{},remove:async()=>{}},{runnerPath:'unused',resources});actions.push(()=>manager.close());
  const live=await manager.lease(profile.id,'command-document');assert.equal((await live.query('SELECT current_user')).rows[0]?.c0,'dbw');await live.query('BEGIN');
  await assert.rejects(manager.test(profile,'wrong-draft-password'),/password authentication/);assert.equal(live.transactionState,'active');resources.clearCredentials(auth.id);assert.equal((await manager.test(profile)).tls,'verify-full');assert.equal(live.transactionState,'active');await live.query('ROLLBACK');assert(!JSON.stringify(values).includes(process.env.DBW_PG_PASSWORD!));
});

test('pgpass uses logical PostgreSQL host and port through SSH, rereads file rotations and does not affect existing SQL transactions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'dbw-pgpass-pg-'));actions.push(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'pgpass');
  const ssh=await sshFixture({allowedPort:Number(process.env.DBW_PG_PORT),mapHost:()=> '127.0.0.1'});actions.push(()=>ssh.close());
  const auth=AuthenticationSchema.parse({id:'pgpass',name:'pgpass PG',kind:'pgpass',user:'dbw',path}),tunnel=TunnelSchema.parse({id:'ssh',name:'SSH',kind:'ssh',host:'127.0.0.1',port:ssh.port,user:'ssh-user',auth:'password',fingerprint:ssh.fingerprint});
  const values:ResourceSummary={authentication:[auth],tunnels:[tunnel]},resources=new ConnectionResources({list:()=>values,save:async()=>{},remove:async()=>{}},{get:async key=>key.includes('tunnel')?'ssh-test-password':undefined,store:async()=>{},delete:async()=>{}},()=>[]),tunnels=new SshTunnels(resources);actions.push(async()=>resources.close());actions.push(()=>tunnels.close());
  const profile=makeProfile({host:'localhost',user:undefined,authRef:auth.id,tunnelRef:tunnel.id,sslMode:'verify-full',caPath:process.env.DBW_PG_CA}),manager=new ConnectionManager({list:()=>[profile],save:async()=>{},remove:async()=>{}},{runnerPath:'unused',resources,tunnels});actions.push(()=>manager.close());
  const line=(password:string)=>`localhost:${profile.port}:dbworkbench:dbw:${password}\n`;await writeFile(path,line(process.env.DBW_PG_PASSWORD!),{mode:0o600});
  const live=await manager.lease(profile.id,'pgpass-document');assert.equal(live.info?.tls,'verify-full');assert.equal((await live.query('SELECT current_user')).rows[0]?.c0,'dbw');await live.query('BEGIN');
  await writeFile(path,line('rotated-invalid'));await assert.rejects(manager.test(profile),/password authentication/);assert.equal(live.transactionState,'active');await writeFile(path,line(process.env.DBW_PG_PASSWORD!));assert.equal((await manager.test(profile)).tls,'verify-full');assert.equal(live.transactionState,'active');await live.query('ROLLBACK');
});

test('Discovered SSH Config connects PostgreSQL with known_hosts and keeps transactions bound across source metadata edits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'dbw-config-pg-'));actions.push(()=>rm(directory,{recursive:true,force:true}));const config=join(directory,'config'),known=join(directory,'known_hosts'),ssh=await sshFixture({allowedPort:Number(process.env.DBW_PG_PORT),mapHost:()=> '127.0.0.1'});actions.push(()=>ssh.close());await writeFile(known,`[127.0.0.1]:${ssh.port} ${ssh.publicHostKey}`);const text=`Host postgres-config\n HostName 127.0.0.1\n Port ${ssh.port}\n User ssh-user\n PubkeyAuthentication no\n UserKnownHostsFile "${known}"\n GlobalKnownHostsFile none\n`;await writeFile(config,text);
  const values:ResourceSummary={authentication:[],tunnels:[]},resources=new ConnectionResources({list:()=>values,save:async()=>{assert.fail('Discovered source must not be persisted');},remove:async()=>{}},{get:async()=>undefined,store:async()=>{},delete:async()=>{}},()=>[]);actions.push(async()=>resources.close());resources.setDiscoveredTunnels((await discoverSshConfigs([config])).tunnels);const tunnel=resources.list().tunnels[0]!;await resources.saveTunnelCredentials(tunnel.id,{password:'ssh-test-password',remember:false,revision:resources.revision('tunnel',tunnel.id)});
  const tunnels=new SshTunnels(resources);actions.push(()=>tunnels.close());const profile=makeProfile({host:'localhost',tunnelRef:tunnel.id,sslMode:'verify-full',caPath:process.env.DBW_PG_CA}),manager=new ConnectionManager({list:()=>[profile],save:async()=>{},remove:async()=>{}},{runnerPath:'unused',resources,tunnels});actions.push(()=>manager.close());await manager.setPassword(profile.id,process.env.DBW_PG_PASSWORD!,'session');const lease=await manager.lease(profile.id,'config-document');await lease.query('BEGIN');assert.equal(lease.info?.tls,'verify-full');
  await writeFile(config,'# moved source line\n'+text);resources.setDiscoveredTunnels((await discoverSshConfigs([config])).tunnels);assert.equal(await manager.lease(profile.id,'config-document'),lease);assert.equal(lease.transactionState,'active');await writeFile(config,text.replace(`Port ${ssh.port}`,`Port ${ssh.port+1}`));resources.setDiscoveredTunnels((await discoverSshConfigs([config])).tunnels);await assert.rejects(manager.lease(profile.id,'config-document'),/settings changed/);await manager.disconnect(profile.id);assert.equal(tunnels.status().length,0);
});

test('PostgreSQL structure comparison synchronizes selected schema across connections and preserves target identity',async()=>{await structureComparisonContract(makeProfile(),process.env.DBW_PG_PASSWORD!);});

test('PostgreSQL and SQLite structure conversions preserve target rows and exact defaults with explicit manual choices',async()=>{await portableStructureContract(makeProfile(),process.env.DBW_PG_PASSWORD!);});

test('Real execution plans retain document sessions, distinguish execution, enforce read-only and cancel',async()=>{await queryPlanContract(makeProfile({host:'localhost',sslMode:'verify-full',caPath:process.env.DBW_PG_CA}),process.env.DBW_PG_PASSWORD!);});
test('PostgreSQL SQL parameters preserve exact values, literal modes and document transactions',async()=>{await sqlParameterContract(makeProfile({host:'localhost',sslMode:'verify-full',caPath:process.env.DBW_PG_CA}),process.env.DBW_PG_PASSWORD!);});


test('PostgreSQL cancellation uses an ordinary role and preserves encrypted prefer-mode control routing',async()=>{
 const admin=new PostgresSession(makeProfile(),async()=>process.env.DBW_PG_PASSWORD);await admin.open();const role='cancel_'+randomUUID().replaceAll('-','').slice(0,12),password=randomUUID();
 try{await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);const p=makeProfile({user:role,host:'localhost',sslMode:'prefer',caPath:process.env.DBW_PG_CA}),m=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'});
  try{await m.setPassword(p.id,password,'session');const session=await m.connect(p.id);assert.equal((await session.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.c0,false);assert.equal(session.info?.tls,'encrypted');await backendCancellation(m,p.id);assert.equal((await session.query('SELECT 43')).rows[0]?.c0,43);}finally{await m.close();}
 }finally{await admin.query(`DROP ROLE IF EXISTS "${role}"`);await admin.close();}
});
