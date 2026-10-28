import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresStatements } from '../packages/drivers/postgresql/sql.js';
import { ProfileSchema } from '../packages/protocol/src/index.js';
import { exportConnections, previewConnections } from '../packages/core/src/connection-transfer.js';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { PostgresSession } from '../packages/drivers/postgresql/session.js';
const profile=()=>ProfileSchema.parse({id:'pg',name:'PG',driver:'postgresql',storage:'server',host:'localhost',port:5432,database:'some db',user:'some user',sslMode:'verify-full'});
test('PostgreSQL profiles validate server fields without admitting plaintext passwords',()=>{
  assert.throws(()=>ProfileSchema.parse({...profile(),password:'secret'}));assert.throws(()=>ProfileSchema.parse({...profile(),storage:'memory'}));assert.throws(()=>ProfileSchema.parse({...profile(),host:''}));assert.throws(()=>ProfileSchema.parse({...profile(),sslMode:'disable',caPath:'cert'}));
  for(const format of ['json','csv'] as const) {const result=previewConnections(exportConnections([profile()],format),format,[]);assert.deepEqual(result.rows[0]?.errors,[]);assert.deepEqual(result.rows[0]?.profile,profile());}
});
test('PostgreSQL statement boundaries preserve source offsets, escaped strings, nested comments and dollar bodies',()=>{
  const sql="-- ;\nSELECT 'a;''b', E'c\\\';d', \"a;b\"; /* a /* ; */ b */ DO $$ BEGIN RAISE NOTICE 'x;y'; END; $$; -- trailing";const statements=postgresStatements(sql);assert.equal(statements.length,2);assert(statements[1]?.sql.includes('END; $$;'));for(const item of statements) assert.equal(item.sql,sql.slice(item.start,item.end));assert.equal(postgresStatements(' /* empty; */ -- no sql').length,0);
});
test('Credentials are stored separately, session overrides are not exported and removal clears the vault',async()=>{
  const vault=new Map<string,string>(),rows=[profile()];const manager=new ConnectionManager({list:()=>rows,save:async()=>{},remove:async()=>{rows.length=0;}},{runnerPath:'unused',credentials:{get:async id=>vault.get(id),store:async(id,value)=>{vault.set(id,value);},delete:async id=>{vault.delete(id);}}});
  try {await manager.setPassword('pg','private-password','remember');assert.equal(vault.get('pg'),'private-password');assert(!exportConnections(manager.profiles(),'json').includes('private-password'));await manager.setPassword('pg','temporary','session');assert.equal(vault.get('pg'),'private-password');await manager.persistPassword('pg',false);assert.equal(vault.size,0);await manager.persistPassword('pg',true);assert.equal(vault.get('pg'),'temporary');await manager.remove('pg');assert.equal(vault.size,0);} finally {await manager.close();}
});
test('PostgreSQL cancellation while awaiting credentials prevents a late database connection',async()=>{
  let release!:()=>void, entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{entered=resolve;});
  const session=new PostgresSession({...profile(),sslMode:'disable'},async()=>{entered();await gate;return 'unused';});
  const opening=session.open(),rejected=assert.rejects(opening,/closed before authentication/);await ready;assert.equal(await session.cancel(),true);release();await rejected;assert.equal(session.connected,false);
});
