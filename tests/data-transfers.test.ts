import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {SqlDocuments} from '../packages/core/src/sql-documents.js';
import {DataTransfers} from '../packages/core/src/data-transfers.js';
import {fileRows,emptyMetadata,parseExactJSON,exactJson} from '../packages/core/src/data-files.js';
import {ProfileSchema} from '../packages/protocol/src/index.js';
const csv={format:'csv' as const,delimiter:',' as const,header:true,nullToken:'\\N'},json={...csv,format:'json' as const};
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'dbw-data-')),p=ProfileSchema.parse({id:'data-memory',name:'Data transfers',driver:'sqlite',storage:'memory'}),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')});const service=new DataTransfers(manager,join(directory,'cache'));return {directory,p,manager,service,session:await manager.connect(p.id),close:async()=>{await service.dispose();await manager.close();await rm(directory,{recursive:true,force:true});}};}
test('Streaming CSV/JSON preserve multiline fields, quote state, exact numeric lexemes and strict syntax',async()=>{
  const f=await fixture();try{
    assert.equal(exactJson(parseExactJSON('{"n":123456789012345678901,"d":0.123456789012345678901}')),'{"n":123456789012345678901,"d":0.123456789012345678901}');assert.throws(()=>parseExactJSON('{"a":1,"a":2}'),/Duplicate/);
    const path=join(f.directory,'source.csv'),long='中'.repeat(22000)+'"\r\nend';await writeFile(path,'\uFEFFid,v\r\n1,"'+long.replaceAll('"','""')+'"\r\n2,""\r\n3,\\N\r\n');let m=emptyMetadata(),rows=[];for await(const r of fileRows(path,csv,m))rows.push(r);assert.equal(rows[0]!.cells![1]!.text,long);assert.equal(rows[1]!.cells![1]!.quoted,true);assert.equal(rows[2]!.cells![1]!.quoted,false);assert.equal(m.rows,3);
    const jp=join(f.directory,'source.json');await writeFile(jp,'{"rows":[{"n":123456789012345678901,"v":"'+('x'.repeat(65530))+'中文"}],"columns":["n","v"]}');const source=await f.service.inspect(jp,json);assert.equal(source.rows,1);assert.equal(source.headers[0],'n');assert.equal(source.sample[0]!.cells[0],'123456789012345678901');
    await writeFile(jp,'[{},]');await assert.rejects(f.service.inspect(jp,json));await writeFile(path,'id,v\n1,"unclosed');await assert.rejects(f.service.inspect(path,csv),/quoted/);
  }finally{await f.close();}
});
test('SQLite full CSV/typed JSON exports exceed UI paging and round-trip NULL/empty/text marker, bigint and binary',async()=>{
  const f=await fixture();try{
    for(const table of ['source','csv_target','json_target'])await f.session.query(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,v TEXT,b BLOB,n TEXT)`);
    await f.session.query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2500) INSERT INTO source SELECT x,CASE x%3 WHEN 0 THEN NULL WHEN 1 THEN '' ELSE '\\N' END,X'00FF','12345678901234567890.01234567890123456789' FROM n");
    await f.session.apply('source',[],[{kind:'insert',values:{id:{type:'integer',value:'9223372036854775807'},v:'quote"\n中文',b:{type:'binary',base64:''},n:null}}]);
    for(const format of ['csv','json'] as const){const path=join(f.directory,'all.'+format),progress:number[]=[];const exported=await f.service.exportFile(f.p.id,{table:'source'},path,{format,batchSize:97},p=>progress.push(p.rows));assert.equal(exported.rows,2501);assert(progress.length>20);const source=await f.service.inspect(path,format==='csv'?csv:json);assert.equal(source.rows,2501);
      const preview=await f.service.preview(source.token,f.p.id,format+'_target',{id:0,v:1,b:2,n:3});assert.equal(preview.invalid,0,JSON.stringify(preview.errors));const report=await f.service.apply(f.p.id,preview.token,{batchSize:211,reportPath:join(f.directory,format+'.report')});assert.equal(report.status,'succeeded',report.error);assert.equal(report.affectedRows,2501);
      const rows=await f.session.query(`SELECT v,hex(b),n FROM ${format}_target WHERE id=9223372036854775807`);assert.equal(rows.rows[0]?.c0,'quote"\n中文');assert.equal(rows.rows[0]?.c1,'');assert.equal(rows.rows[0]?.c2,null);assert.equal((await f.session.query(`SELECT v FROM ${format}_target WHERE id=2`)).rows[0]?.c0,'\\N');assert.equal((await f.session.query(`SELECT v FROM ${format}_target WHERE id=3`)).rows[0]?.c0,null);
    }
  }finally{await f.close();}
});
test('Export cancellation preserves an existing file and shared memory data; non-read statements are rejected',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(id INT)');await f.session.query('INSERT INTO t VALUES(1),(2),(3)');const path=join(f.directory,'cancel.csv');await writeFile(path,'original');const abort=new AbortController();await assert.rejects(f.service.exportFile(f.p.id,{table:'t'},path,{format:'csv',overwrite:true,batchSize:1},()=>abort.abort(),abort.signal),/cancelled/);assert.equal(await readFile(path,'utf8'),'original');assert.equal((await f.session.query('SELECT count(*) FROM t')).rows[0]?.c0,3);assert(!(await readdir(f.directory)).some(s=>s.endsWith('.tmp')));
    await assert.rejects(f.service.exportFile(f.p.id,{sql:'DELETE FROM t RETURNING *'},path,{format:'json'}),/read/);await assert.rejects(f.service.exportFile(f.p.id,{sql:'SELECT 1;DELETE FROM t'},path,{format:'csv'}),/one SELECT/);
    const scalar=await f.service.exportFile(f.p.id,{sql:"SELECT replace('/*!x*/','x','y')"},join(f.directory,'scalar.json'),{format:'json',batchSize:1.5});assert.equal(scalar.rows,1);
  }finally{await f.close();}
});
test('Import cancellation stops between committed batches and legal prototype-like column names survive RPC validation',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t("__proto__" TEXT,"constructor" TEXT)');const path=join(f.directory,'odd.csv');await writeFile(path,'__proto__,constructor\nfirst,one\nsecond,two\nthird,three\n');const source=await f.service.inspect(path,csv),mapping=JSON.parse('{"__proto__":0,"constructor":1}');
    const {WebRequestSchema}=await import('../packages/protocol/src/index.js');const request=WebRequestSchema.parse({method:'data.preview',params:{source:source.token,mapping}});assert.equal(request.method,'data.preview');assert(Object.hasOwn((request as any).params.mapping,'__proto__'));
    const p=await f.service.preview(source.token,f.p.id,'t',mapping),abort=new AbortController();const report=await f.service.apply(f.p.id,p.token,{batchSize:1,reportPath:join(f.directory,'cancel.report')},()=>abort.abort(),abort.signal);assert.equal(report.status,'cancelled');assert.equal(report.processed,1);assert.equal(report.remaining,2);assert.equal((await f.session.query('SELECT "__proto__", "constructor" FROM t')).rows[0]?.c0,'first');
  }finally{await f.close();}
});
test('SQL document export preserves temporary session context, serialization and query-only state without closing the document lease',async()=>{
  const f=await fixture();try{
    const docs=new SqlDocuments(f.manager);await docs.bind('document',f.p.id);await docs.execute('document','CREATE TEMP TABLE context(v TEXT)');await docs.execute('document',"INSERT INTO context VALUES('same session')");const path=join(f.directory,'context.json');let sawBusy=false;
    await docs.useSession('document',session=>f.service.exportFile(f.p.id,{sql:'SELECT * FROM context'},path,{format:'json'},()=>{sawBusy=docs.state('document').busy;},undefined,session));assert(sawBusy);assert.equal(docs.state('document').busy,false);assert(f.manager.documentSession('document')?.connected);assert.match(await readFile(path,'utf8'),/same session/);
    await docs.execute('document',"INSERT INTO context VALUES('writable again')");await docs.transaction('document','begin');await assert.rejects(docs.useSession('document',session=>f.service.exportFile(f.p.id,{sql:'SELECT * FROM context'},join(f.directory,'active.csv'),{format:'csv'},undefined,undefined,session)),/roll back/);assert.equal(docs.state('document').transaction,'active');await docs.transaction('document','rollback');
    await assert.rejects(docs.useSession('document',(session,signal)=>f.service.exportFile(f.p.id,{sql:'SELECT * FROM context'},join(f.directory,'cancel-doc.csv'),{format:'csv',batchSize:1},()=>{void docs.cancel('document');},signal,session)),/cancel/);assert.equal((await docs.execute('document','SELECT count(*) FROM context')).rows[0]?.c0,2);
    await assert.rejects(f.service.exportFile(f.p.id,{sql:'SELECT 1e999'},join(f.directory,'infinite.json'),{format:'json'}),/Non-finite/);
    let closed:Promise<boolean>|undefined;await assert.rejects(docs.useSession('document',(session,signal)=>f.service.exportFile(f.p.id,{sql:'SELECT * FROM context'},join(f.directory,'close-doc.csv'),{format:'csv',batchSize:1},()=>{closed=docs.close('document');},signal,session)),/cancel/);await closed;assert.equal(f.manager.documentSession('document'),undefined);assert.equal((await f.session.query('SELECT 42')).rows[0]?.c0,42);
  }finally{await f.close();}
});
test('Committed import counts survive view-refresh failure and a consumed preview cannot insert the same rows again',async()=>{
  const f=await fixture(),service=new DataTransfers(f.manager,join(f.directory,'refresh-cache'),async()=>{},async()=>{throw new Error('View disposed');});try{
    await f.session.query('CREATE TABLE t(id INT)');const path=join(f.directory,'one.csv');await writeFile(path,'id\n1\n');const source=await service.inspect(path,csv),preview=await service.preview(source.token,f.p.id,'t',{id:0}),report=await service.apply(f.p.id,preview.token,{reportPath:join(f.directory,'refresh.report')});assert.equal(report.status,'succeeded');assert.equal(report.processed,1);assert.match(report.error!,/already committed/);assert.equal((await f.session.query('SELECT count(*) FROM t')).rows[0]?.c0,1);await assert.rejects(service.apply(f.p.id,preview.token,{reportPath:join(f.directory,'again.report')}),/expired/);assert.match(await readFile(report.reportPath,'utf8'),/View disposed/);
  }finally{await service.dispose();await f.close();}
});
test('Import preview is non-mutating, invalid rows require explicit skipping, source/target changes invalidate previews, and batch failures report committed counts',async()=>{
  const f=await fixture();try{
    await f.session.query('CREATE TABLE t(id INT PRIMARY KEY,v TEXT NOT NULL)');const path=join(f.directory,'rows.csv');await writeFile(path,'id,v\n1,one\n2,two\n1,duplicate\n');let source=await f.service.inspect(path,csv),preview=await f.service.preview(source.token,f.p.id,'t',{id:0,v:1});assert.equal((await f.session.query('SELECT count(*) FROM t')).rows[0]?.c0,0);
    const result=await f.service.apply(f.p.id,preview.token,{batchSize:1,reportPath:join(f.directory,'batch.report')});assert.equal(result.status,'failed');assert.equal(result.processed,2);assert.equal(result.remaining,1);assert.equal((await f.session.query('SELECT count(*) FROM t')).rows[0]?.c0,2);assert.match(await readFile(result.reportPath,'utf8'),/"status":"committed"/);await assert.rejects(f.service.apply(f.p.id,preview.token,{reportPath:join(f.directory,'retry.report')}),/expired/);
    await writeFile(path,'id,v\n3,\\N\n4,four\n');source=await f.service.inspect(path,csv);preview=await f.service.preview(source.token,f.p.id,'t',{id:0,v:1});assert.equal(preview.invalid,1);await assert.rejects(f.service.apply(f.p.id,preview.token,{reportPath:join(f.directory,'invalid.report')}),/invalid rows/);assert.equal((await f.service.apply(f.p.id,preview.token,{skipInvalid:true,reportPath:join(f.directory,'skip.report')})).processed,1);
    source=await f.service.inspect(path,csv);await writeFile(path,'id,v\n8,changed\n');await assert.rejects(f.service.preview(source.token,f.p.id,'t',{id:0,v:1}),/Source file changed/);
    source=await f.service.inspect(path,csv);preview=await f.service.preview(source.token,f.p.id,'t',{id:0,v:1});await f.session.query('ALTER TABLE t ADD external INT');assert.match((await f.service.apply(f.p.id,preview.token,{reportPath:join(f.directory,'stale.report')})).error!,/structure changed/);
  }finally{await f.close();}
});
