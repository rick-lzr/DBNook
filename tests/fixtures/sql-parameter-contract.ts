import assert from 'node:assert/strict';
import type {ConnectionProfile,QueryRun} from '../../packages/protocol/src/index.js';
import {ConnectionManager} from '../../packages/core/src/connections.js';
import {SqlDocuments} from '../../packages/core/src/sql-documents.js';
import {QueryPlans} from '../../packages/core/src/query-plans.js';
import {formatSql} from '../../packages/core/src/sql-formatting.js';
import {scriptSqlParameters} from '../../packages/core/src/sql-script-parameters.js';
import {renderSqlParameters} from '../../packages/core/src/sql-parameters.js';

export async function sqlParameterContract(profile:ConnectionProfile,password:string){
 const manager=new ConnectionManager({list:()=>[profile],save:async()=>{},remove:async()=>{}},{runnerPath:'unused'}),history:QueryRun[]=[],documents=new SqlDocuments(manager,()=>{},{finished:(_p,run)=>{history.push(run);},error:()=>{}}),owner='parameter-contract.sql',value="O'Reilly\\'; DELETE FROM parameter_values; -- 中文\n",pg=profile.driver==='postgresql';let forms=0;
 try{
  await manager.setPassword(profile.id,password,'session');await documents.bind(owner,profile.id);documents.configureParameters(async form=>{forms++;return form.values.map(v=>v.key===':text'?{...v,type:'string',value}:v);});
  const sql="CREATE TEMPORARY TABLE parameter_values(id BIGINT PRIMARY KEY,v TEXT); INSERT INTO parameter_values VALUES(:{id||9223372036854775807||number},:text); SELECT id,v,:id AS input FROM parameter_values;";
  const run=await documents.run(owner,sql);assert.equal(run.status,'succeeded',run.error);assert.equal(forms,1);const last=run.statements.at(-1)?.result!;assert.deepEqual(last.rows[0]?.[last.columns[0]!.key],{type:'integer',value:'9223372036854775807'});assert.equal(last.rows[0]?.[last.columns[1]!.key],value);assert.deepEqual(last.rows[0]?.[last.columns[2]!.key],{type:'integer',value:'9223372036854775807'});assert.equal(history[0]?.sql,sql);
  await documents.transaction(owner,'begin');await documents.execute(owner,"UPDATE parameter_values SET v=:{replacement||pending||string}");await documents.transaction(owner,'rollback');assert.equal((await documents.execute(owner,'SELECT v FROM parameter_values')).rows[0]?.c0,value);
  if(pg){await documents.execute(owner,"SET standard_conforming_strings=off");assert.equal((await documents.execute(owner,'SELECT :text AS value')).rows[0]?.c0,value);await documents.execute(owner,"SET standard_conforming_strings=on");}
  else{const modes=await documents.run(owner,"SET sql_mode=''; SELECT :text AS value; SET sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'; SELECT :text AS value;");assert.equal(modes.status,'succeeded',modes.error);assert.equal(modes.statements[1]?.result?.rows[0]?.c0,value);assert.equal(modes.statements[3]?.result?.rows[0]?.c0,value);}
  assert.equal((await documents.execute(owner,'SELECT :{code||0001||||opaque} AS code')).rows[0]?.c0,'0001');
  if(pg)assert.equal((await documents.execute(owner,'SELECT :{day||infinity||date}::date')).rows[0]?.c0,'infinity');else assert.equal((await documents.execute(owner,'SELECT CAST(:{day||2026/10/28||date} AS DATE)')).rows[0]?.c0,'2026-10-28');
  const raw="SELECT 'x\ny' AS v, :{code||0001||||opaque} AS code",formatted=formatSql(raw,profile.driver,{},'\r\n',{mode:manager.documentSession(owner)!.sqlMode});assert.deepEqual((await documents.execute(owner,formatted)).rows,(await documents.execute(owner,raw)).rows);
  if(!pg){
   const script=String.raw`SET sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'; SELECT '\' AS value,:{code||0001} AS code; SET sql_mode='ANSI'; SELECT '\\' AS value,:code AS code;`,initialMode=manager.documentSession(owner)!.sqlMode;
   const scan=scriptSqlParameters(script,profile.driver,initialMode),preview=renderSqlParameters(script,scan,scan.parameters.map(p=>({key:p.key,type:'string',value:p.defaultValue??''})),profile.driver,initialMode);
   const before=await documents.run(owner,script);assert.equal(before.status,'succeeded',before.error);assert.equal(before.statements[1]?.result?.rows[0]?.c0,'\\');assert.equal(before.statements[3]?.result?.rows[0]?.c0,'\\');assert.equal(before.statements[3]?.result?.rows[0]?.c1,'0001');
   const after=await documents.run(owner,formatSql(script,profile.driver,{},'\r\n',{mode:initialMode}));assert.equal(after.status,'succeeded',after.error);assert.deepEqual(after.statements[1]?.result?.rows,before.statements[1]?.result?.rows);assert.deepEqual(after.statements[3]?.result?.rows,before.statements[3]?.result?.rows);
   const previewRun=await manager.documentSession(owner)!.run(preview,100,'parameter-preview');assert.equal(previewRun.status,'succeeded',previewRun.error);assert.deepEqual(previewRun.statements[3]?.result?.rows,before.statements[3]?.result?.rows);
   const dynamic=await documents.run(owner,"SET sql_mode=:{mode||NO_BACKSLASH_ESCAPES||string}; SELECT '\\' AS value,:{code||0001} AS code;");assert.equal(dynamic.status,'succeeded',dynamic.error);assert.equal(dynamic.statements[1]?.result?.rows[0]?.c0,'\\');assert.equal(dynamic.statements[1]?.result?.rows[0]?.c1,'0001');
   const delimited=await documents.run(owner,'DELIMITER $$\nSET sql_mode=:{mode||||string}$$\nSELECT :{code||0001} AS code$$\nDELIMITER ;\nSELECT :code AS code;');assert.equal(delimited.status,'succeeded',delimited.error);assert.equal(delimited.statements[1]?.result?.rows[0]?.c0,'0001');assert.equal(delimited.statements[2]?.result?.rows[0]?.c0,'0001');
  }
  const plans=new QueryPlans(manager,documents),plan=await plans.prepare(owner,'SELECT * FROM parameter_values WHERE id=:{id||9223372036854775807||number}','explain');assert.ok(!plan.executedSql.includes(':{id'));assert.ok((await plans.run(plan.token)).raw.length);
  const failed=await documents.run(owner,'SELECT :{missing||private_column||identifier} FROM parameter_values');assert.equal(failed.status,'failed');assert.ok(!(history.at(-1)?.error??'').includes('private_column'));
  assert.equal((await documents.execute(owner,'SELECT count(*) FROM parameter_values')).rows[0]?.c0,1);
  const pid=String((await documents.execute(owner,pg?'SELECT pg_backend_pid()':'SELECT CONNECTION_ID()')).rows[0]?.c0);assert.match(pid,/^\d+$/);
  const admin=await manager.connect(profile.id),activeSql=pg?`SELECT count(*) FROM pg_stat_activity WHERE pid=${pid} AND state='active' AND query LIKE '%pg_sleep%'`:`SELECT count(*) FROM information_schema.PROCESSLIST WHERE ID=${pid} AND COMMAND='Query' AND INFO LIKE '%SLEEP%'`;
  const pending=documents.run(owner,pg?'SELECT pg_sleep(:{seconds||20||number})':'SELECT SLEEP(:{seconds||20||number})');let running=false;
  for(let i=0;i<60;i++){if(Number((await admin.query(activeSql)).rows[0]?.c0)>0){running=true;break;}await new Promise(r=>setTimeout(r,50));}assert(running,'Parameterized SQL must reach the actual server before cancellation');
  assert(await documents.cancel(owner));const cancelled=await pending;assert.equal(cancelled.status,'cancelled',cancelled.error);let stopped=false;
  for(let i=0;i<40;i++){if(Number((await admin.query(activeSql)).rows[0]?.c0)===0){stopped=true;break;}await new Promise(r=>setTimeout(r,50));}if(!stopped)await admin.query(pg?`SELECT pg_terminate_backend(${pid})`:`KILL CONNECTION ${pid}`);assert(stopped,'Cancelling parameterized execution must stop the backend query');assert.equal(documents.state(owner).lost,true);await documents.reset(owner);assert.equal((await documents.execute(owner,'SELECT 42')).rows[0]?.c0,42);
 }finally{await manager.close();}
}
