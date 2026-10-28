import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
/** Observe the real server, including when both target and control channels share SSH. */
export async function backendCancellation(manager:ConnectionManager,profileId:string){
 const owner='cancel-'+randomUUID(),pg=manager.profile(profileId).driver==='postgresql',admin=await manager.connect(profileId),session=await manager.lease(profileId,owner),pid=String((await session.query(pg?'SELECT pg_backend_pid()':'SELECT CONNECTION_ID()')).rows[0]!.c0);assert.match(pid,/^\d+$/);
 const activeSql=pg?`SELECT count(*) FROM pg_stat_activity WHERE pid=${pid} AND state='active' AND query LIKE '%pg_sleep%'`:`SELECT count(*) FROM information_schema.PROCESSLIST WHERE ID=${pid} AND COMMAND='Query' AND INFO LIKE '%SLEEP%'`;
 try{
  const slow=session.query(pg?'SELECT pg_sleep(20)':'SELECT SLEEP(20)'),rejected=assert.rejects(slow);let running=false;
  for(let i=0;i<60;i++){if(Number((await admin.query(activeSql)).rows[0]?.c0)>0){running=true;break;}await new Promise(r=>setTimeout(r,50));}assert(running);
  assert(await manager.cancelLease(owner));await rejected;let stopped=false;
  for(let i=0;i<40;i++){if(Number((await admin.query(activeSql)).rows[0]?.c0)===0){stopped=true;break;}await new Promise(r=>setTimeout(r,50));}
  if(!stopped)await admin.query(pg?`SELECT pg_terminate_backend(${pid})`:`KILL CONNECTION ${pid}`);assert(stopped,'The SSH backend query must stop after cancellation');assert.equal((await admin.query('SELECT 42')).rows[0]?.c0,42);assert.equal(session.connected,false);
 }finally{await manager.releaseLease(owner);}
}
