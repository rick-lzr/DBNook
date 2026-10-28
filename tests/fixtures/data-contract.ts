import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import {DataTransfers} from '../../packages/core/src/data-transfers.js';
import {ddlQuote} from '../../packages/core/src/ddl-syntax.js';
export async function dataContract(manager:ConnectionManager,id:string){
  const p=manager.profile(id),mysql=p.driver!=='postgresql',q=(s:string)=>ddlQuote(s,p.driver),name='data_'+randomUUID().replaceAll('-','').slice(0,12),table=(s:string)=>`${q(mysql?p.database!:'public')}.${q(s)}`,directory=await mkdtemp(join(tmpdir(),'dbw-data-contract-')),service=new DataTransfers(manager,join(directory,'cache')),session=await manager.connect(id);
  try{
    for(const n of [name,name+'_csv',name+'_json'])await session.query(`CREATE TABLE ${table(n)}(id BIGINT PRIMARY KEY,v TEXT,amount DECIMAL(30,10),b ${mysql?'BLOB':'BYTEA'},n TEXT)${mysql?' ENGINE=InnoDB':''}`);
    for(let i=0;i<6;i++)await session.apply(table(name),[],[{kind:'insert',values:{id:i===5?{type:'integer',value:'9223372036854775807'}:i+1,v:i===0?null:i===1?'':i===2?'\\N':'"中文\nquote',amount:'12345678901234567890.0123456789',b:{type:'binary',base64:i?'AP8=':''},n:null}}]);
    for(const format of ['csv','json']as const){const path=join(directory,'rows.'+format),counts:number[]=[];const result=await service.exportFile(id,{sql:`SELECT * FROM ${table(name)} ORDER BY id`},path,{format,batchSize:2},p=>counts.push(p.rows));assert.equal(result.rows,6);assert(counts.length>=3);
      const source=await service.inspect(path,{format,delimiter:',',header:true,nullToken:'\\N'});assert.equal(source.rows,6);const preview=await service.preview(source.token,id,table(name+'_'+format),{id:0,v:1,amount:2,b:3,n:4});assert.equal(preview.invalid,0,JSON.stringify(preview.errors));const report=await service.apply(id,preview.token,{batchSize:2,reportPath:join(directory,format+'.report')});assert.equal(report.status,'succeeded',report.error);assert.equal(report.affectedRows,6);const rows=await session.query(`SELECT * FROM ${table(name+'_'+format)} ORDER BY id`);assert.equal(rows.rows[0]?.c1,null);assert.equal(rows.rows[1]?.c1,'');assert.equal(rows.rows[2]?.c1,'\\N');assert.equal(rows.rows[5]?.c2,'12345678901234567890.0123456789');assert.deepEqual(rows.rows[5]?.c0,{type:'integer',value:'9223372036854775807'});assert.deepEqual(rows.rows[5]?.c3,{type:'binary',base64:'AP8='});
    }
    const context=await manager.lease(id,'data-context-'+name),temp=q('context_'+name);await context.query(`CREATE TEMPORARY TABLE ${temp}(v TEXT)`);await context.query(`INSERT INTO ${temp} VALUES('session context')`);if(mysql){await context.query("SET @export_context='same session'");await context.query("SET sql_mode='NO_BACKSLASH_ESCAPES'");}
    const contextPath=join(directory,'context.json');await service.exportFile(id,{sql:mysql?`SELECT v,@export_context AS ctx,'a\\n' AS literal FROM ${temp}`:`SELECT v FROM ${temp}`},contextPath,{format:'json'},undefined,undefined,context);const contextResult=JSON.parse(await readFile(contextPath,'utf8'));assert.equal(contextResult.rows[0][0],'session context');if(mysql){assert.equal(contextResult.rows[0][1],'same session');assert.equal(contextResult.rows[0][2],'a\\n');}assert(context.connected);await context.query(`INSERT INTO ${temp} VALUES('still writable')`);await manager.releaseLease('data-context-'+name);
    const abort=new AbortController(),path=join(directory,'cancel.json');await assert.rejects(service.exportFile(id,{table:table(name)},path,{format:'json',batchSize:1},()=>abort.abort(),abort.signal),/cancel|closed|lost|disconnect/i);assert.equal((await session.query(`SELECT count(*) FROM ${table(name)}`)).rows[0]?.c0,6);
  }finally{await service.dispose();await rm(directory,{recursive:true,force:true});}
}
