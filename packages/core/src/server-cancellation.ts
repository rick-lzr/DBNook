import type {DriverSession} from '../../driver-sdk/src/index.js';
import {errorMessage} from '../../protocol/src/index.js';
/** A separate authenticated/TLS connection targets only the marked original request. */
export async function cancelServerRequest(control:Pick<DriverSession,'open'|'close'|'query'|'profile'>,id:number,marker:string,active:()=>boolean):Promise<void>{
 if(!Number.isSafeInteger(id)||id<=0)throw new Error('The original backend identity is unavailable; server cancellation is unconfirmed.');
 const timer=setTimeout(()=>{void control.close().catch(()=>{});},5000);
 try{
  await control.open();if(!active())return;
  if(control.profile.driver==='postgresql'){
   const literal="'"+marker.replaceAll("'","''")+"'",result=await control.query(`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE pid=${id} AND left(query,${marker.length})=${literal}`);
   if(result.rows[0]?.c0!==true&&active())throw new Error('The marked PostgreSQL request was not found or termination was refused.');
  }else{
   const result=await control.query('SHOW FULL PROCESSLIST'),key=(name:string)=>result.columns.find(c=>c.name.toLowerCase()===name)?.key,idKey=key('id'),info=key('info');
   const row=idKey?result.rows.find(r=>String(r[idKey])===String(id)):undefined;
   if(!active())return;if(!row||!info||typeof row[info]!=='string'||!(row[info] as string).startsWith(marker))throw new Error('The marked MySQL/MariaDB request was not found.');
   await control.query(`KILL CONNECTION ${id}`);
  }
 }catch(error){throw new Error(`Server cancellation could not be confirmed. The local session will close; inspect the server before repeating the statement. ${errorMessage(error)}`,{cause:error});}
 finally{clearTimeout(timer);await control.close().catch(()=>{});}
}
