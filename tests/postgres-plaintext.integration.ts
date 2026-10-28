import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSession } from '../packages/drivers/postgresql/session.js';
import { ProfileSchema, type ConnectionProfile } from '../packages/protocol/src/index.js';
const profile=(sslMode:ConnectionProfile['sslMode'])=>ProfileSchema.parse({id:'plain',name:'Plaintext-only integration',driver:'postgresql',storage:'server',host:'127.0.0.1',port:Number(process.env.DBW_PG_PORT),database:'dbworkbench',user:'dbw',sslMode,connectTimeout:10000});
test('TLS prefer falls back only within the chosen policy and reports plaintext; required TLS never falls back',async()=>{
  for(const mode of ['disable','allow','prefer'] as const){const session=new PostgresSession(profile(mode),async()=>process.env.DBW_PG_PASSWORD);try{assert.equal((await session.open()).tls,'disabled');assert.equal((await session.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.c0,false);}finally{await session.close();}}
  for(const mode of ['require','verify-ca','verify-full'] as const){const session=new PostgresSession(profile(mode),async()=>process.env.DBW_PG_PASSWORD);await assert.rejects(session.open(),/does not support SSL/);assert.equal(session.connected,false);}
});
