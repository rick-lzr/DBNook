import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionString, connectionString } from '../packages/core/src/connection-strings.js';
import { previewConnections, exportConnections, ConnectionTransfers } from '../packages/core/src/connection-transfer.js';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { ProfileSchema, type ConnectionProfile } from '../packages/protocol/src/index.js';
test('PostgreSQL URIs decode Unicode and reserved characters without form-decoding plus signs',()=>{
  const p=parseConnectionString('postgres://u%40x:p%3A%2F%3F%23%25+@localhost/db');assert.equal(p.password,'p:/?#%+');
  const value=parseConnectionString('postgresql://user%20%E7%94%A8:secret%40%3A%2B@[::1]:5433/%E6%95%B0%E6%8D%AE%20db?sslmode=verify-full&application_name=app+literal&connect_timeout=12');
  assert.equal(value.driver,'postgresql');assert.equal(value.host,'::1');assert.equal(value.user,'user 用');assert.equal(value.database,'数据 db');assert.equal(value.password,'secret@:+');assert.equal(value.applicationName,'app+literal');assert.equal(value.connectTimeout,12000);assert.equal(value.port,5433);
});
test('libpq keywords support quoted spaces, escaped quotes/backslashes, empty passwords and last-value overrides',()=>{
  const value=parseConnectionString("host = localhost port=5432 dbname='team db' user='O\\'Brien' password='a\\\\b \\'c' sslmode=disable port=5544 connect_timeout=0");assert.equal(value.user,"O'Brien");assert.equal(value.password,"a\\b 'c");assert.equal(value.database,'team db');assert.equal(value.port,5544);assert.equal(value.connectTimeout,0);
  assert.equal(parseConnectionString("host=localhost user=test password='' ").password,'');assert.equal(parseConnectionString('postgresql:///db?host=server&user=first&user=last').user,'last');
});
test('JDBC PostgreSQL strings support full and local forms and ssl=true verifies server identity',()=>{
  const full=parseConnectionString('jdbc:postgresql://localhost:5433/db?user=alice&password=p%40ss&ssl=true&ApplicationName=workbench');assert.equal(full.sslMode,'verify-full');assert.equal(full.applicationName,'workbench');assert.equal(full.password,'p@ss');assert.equal(parseConnectionString('jdbc:postgresql:local').database,'local');assert.equal(parseConnectionString('postgresql://alice@localhost').database,'alice');
});
test('Canonical PostgreSQL strings exclude passwords and round-trip supported endpoint/TLS metadata',()=>{
  const profile=ProfileSchema.parse({id:'one',name:'PG',driver:'postgresql',storage:'server',host:'::1',port:5555,user:'用 户',database:'db/name',sslMode:'verify-ca',caPath:'D:\\certs\\root +.crt',certPath:'D:\\certs\\client.crt',keyPath:'D:\\certs\\client.key',connectTimeout:12000,applicationName:'App + name'});
  const value=parseConnectionString(connectionString(profile));for(const key of ['host','port','user','database','sslMode','caPath','certPath','keyPath','connectTimeout','applicationName'] as const)assert.equal(value[key],profile[key]);assert.equal(value.password,undefined);
});
test('Malformed/unsupported PostgreSQL strings fail without echoing embedded credentials',()=>{
  const inputs=['postgresql://user:private-password@a,b/db','postgresql://user:private-password@host/db?unknown=value',"host=localhost user=test password='private-password",'postgresql://user:private-password@host:0/db','postgresql://user:private-password@host/db?sslmode=unknown','postgresql://user:private-password@host/db#fragment','postgresql://user:private-password@host/db?user=%ZZ'];
  for(const input of inputs)assert.throws(()=>parseConnectionString(input),(error:unknown)=>error instanceof Error&&!error.message.includes('private-password'));
});
test('Connection import keeps URI/CSV passwords outside previews, reports and exported profiles',async()=>{
  const rows:ConnectionProfile[]=[],vault=new Map<string,string>();const manager=new ConnectionManager({list:()=>rows,save:async p=>{rows.push(p);},remove:async()=>{}},{runnerPath:'unused',credentials:{get:async id=>vault.get(id),store:async(id,p)=>{vault.set(id,p);},delete:async id=>{vault.delete(id);}}});
  try{
    const transfers=new ConnectionTransfers(manager),preview=transfers.preview(JSON.stringify([{name:'URI import',connectionString:'postgresql://user:private-password@localhost/db?sslmode=disable'}]),'json');assert(preview.rows[0]?.hasPassword);assert(!JSON.stringify(preview).includes('private-password'));
    const report=await transfers.apply(preview.token,[{index:0,action:'create'}],'workspace',true);assert.equal(report.rows[0]?.status,'created');assert.equal(vault.get(rows[0]!.id),'private-password');assert(!JSON.stringify(report).includes('private-password'));for(const format of ['json','csv'] as const)assert(!exportConnections(rows,format).includes('private-password'));
    const csv='name,host,user,database,driver,password\nCSV import,localhost,user,db,postgresql,temporary-password';const parsed=previewConnections(csv,'csv',[]);assert(parsed.rows[0]?.hasPassword);assert(!JSON.stringify(parsed).includes('temporary-password'));
  }finally{await manager.close();}
});
