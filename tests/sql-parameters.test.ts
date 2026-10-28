import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {SqlDocuments} from '../packages/core/src/sql-documents.js';
import {ProfileSchema,type SqlParameterValue,type QueryRun} from '../packages/protocol/src/index.js';
import {sqlParameters,renderSqlParameters,currentParameterizedSql,maskSqlParameters} from '../packages/core/src/sql-parameters.js';
import {runParameterizedSql} from '../packages/core/src/sql-parameter-run.js';
import type {DriverSession} from '../packages/driver-sdk/src/index.js';
const render=(sql:string,values:SqlParameterValue[],driver:'sqlite'|'postgresql'|'mysql'|'mariadb'='sqlite',mode?:DriverSession['sqlMode'])=>renderSqlParameters(sql,sqlParameters(sql,driver,mode),values,driver,mode);

test('SQL parameter definitions share bare aliases in either order and preserve exact defaults',()=>{
 const sql='SELECT &actorId, &actorId||9223372036854775807||number, ${Long Name||0050||string}, %(day||2024-02-29||date), $1, :{empty||||string}';
 const scan=sqlParameters(sql,'sqlite');assert.deepEqual(scan.parameters.map(p=>[p.key,p.type,p.defaultValue,p.occurrences]),[['&actorId','number','9223372036854775807',2],['$Long Name','string','0050',1],['%day','date','2024-02-29',1],['$1','auto',undefined,1],[':empty','string','',1]]);
 const values=scan.parameters.map(p=>({key:p.key,type:p.type,value:p.defaultValue??'12'}));assert.equal(renderSqlParameters(sql,scan,values,'sqlite'),"SELECT 9223372036854775807, 9223372036854775807, '0050', '2024-02-29', 12, ''");
 assert.throws(()=>sqlParameters('SELECT :{x||1||number}, :{x||2||number}','sqlite'),/Conflicting/);assert.throws(()=>sqlParameters('SELECT :{x||1||raw}','sqlite'),/Invalid parameter type/);
});
test('parameter scanning excludes literals, comments, identifiers, PostgreSQL casts and function bodies',()=>{
 const sql=`SELECT :id, ':id', E'\\\\:id', "a:id", col::text, '$.json', $$ :id $1 $$, $body$ :id $2 $body$, $1 -- :id\n/* :id /* $1 */ :id */`;
 const scan=sqlParameters(sql,'postgresql');assert.deepEqual(scan.parameters.map(p=>p.key),[':id','$1']);assert.equal(scan.occurrences.length,2);
 const actual=renderSqlParameters(sql,scan,[{key:':id',type:'number',value:'7'},{key:'$1',type:'number',value:'9'}],'postgresql');assert.ok(actual.startsWith("SELECT 7, ':id'"));assert.ok(actual.includes('col::text'));assert.ok(actual.includes('$$ :id $1 $$'));
 assert.deepEqual(sqlParameters('SELECT @user, @@sql_mode, 100 % 3, %s, a$name, "$.x", :id # :hidden','mysql').parameters.map(p=>p.key),[':id']);
});
test('masked defaults containing quotes, semicolons and newlines do not change source ranges',()=>{
 const sql="SELECT :{text||O'Reilly;\n你好||string};\nSELECT :id;",scan=sqlParameters(sql,'sqlite'),masked=maskSqlParameters(sql,scan);assert.equal(masked.length,sql.length);assert.equal(masked.split('\n').length,sql.split('\n').length);
 assert.equal(currentParameterizedSql(sql,5,'sqlite')?.sql,"SELECT :{text||O'Reilly;\n你好||string};");assert.equal(currentParameterizedSql(sql,sql.length,'sqlite')?.sql,'SELECT :id;');
});
test('string and identifier parameters quote values using the target dialect and SQL mode',()=>{
 const v="O'Reilly\\'; DROP TABLE t; -- 你好\n";
 assert.equal(render('SELECT :x',[{key:':x',type:'string',value:v}],'postgresql'),"SELECT E'"+v.replaceAll('\\','\\\\').replaceAll("'","''")+"'");
 for(const driver of ['mysql','mariadb'] as const){const ordinary=render('SELECT :x',[{key:':x',type:'string',value:v}],driver),nbe=render('SELECT :x',[{key:':x',type:'string',value:v}],driver,{noBackslashEscapes:true,ansiQuotes:true});assert.ok(ordinary.includes('\\\\'));assert.equal(nbe,"SELECT '"+v.replaceAll("'","''")+"'");}
 assert.equal(render('SELECT :x',[{key:':x',type:'identifier',value:'public."name.with.dot"'}],'postgresql'),'SELECT "public"."name.with.dot"');
 assert.equal(render('SELECT :x',[{key:':x',type:'identifier',value:'table.*'}],'mysql'),'SELECT `table`.*');
 assert.throws(()=>render('SELECT :x',[{key:':x',type:'identifier',value:'a..b'}]),/empty/);assert.throws(()=>render('SELECT :x',[{key:':x',type:'string',value:'x\0y'}]),/NUL/);
});
test('number inputs reject expressions and date inputs preserve database text without normalization',()=>{
 for(const value of ['NaN','Infinity','1; SELECT 2','0 OR 1=1','0x10',''])assert.throws(()=>render('SELECT :x',[{key:':x',type:'number',value}]),/finite SQL number/);
 for(const value of ['now','infinity','2026/10/28','2023-02-29','2024-02-29','2026-10-28T12:30:59.123456+08:00'])assert.equal(render('SELECT :x',[{key:':x',type:'date',value}]),"SELECT '"+value+"'");
 assert.equal(render('SELECT :x',[{key:':x',type:'number',value:'-9223372036854775808'}]),'SELECT -9223372036854775808');assert.equal(render('SELECT :x',[{key:':x',type:'string',value:'0001'}]),"SELECT '0001'");assert.equal(render('SELECT :x',[{key:':x',type:'string',value:null}]),'SELECT NULL');
 assert.throws(()=>render('SELECT :x',[{key:':x',type:'identifier',value:null}]),/cannot be NULL/);
});
test('PostgreSQL cast suffixes are preserved and unexpected parameter values are rejected',()=>{
 assert.equal(render('SELECT :id::bigint, $1::text',[{key:':id',type:'number',value:'9223372036854775807'},{key:'$1',type:'string',value:'text'}],'postgresql'),"SELECT 9223372036854775807::bigint, E'text'::text");
 assert.throws(()=>render('SELECT :x',[{key:':x',type:'number',value:'1'},{key:':extra',type:'number',value:'2'}]),/Unexpected/);assert.throws(()=>sqlParameters('SELECT :{x||1||auto}','sqlite'),/Invalid parameter type/);
});
test('MySQL parameter execution re-renders statements after sql_mode changes and keeps source ranges',async()=>{
 const executed:string[]=[],mode={noBackslashEscapes:false,ansiQuotes:false};
 const session={profile:ProfileSchema.parse({id:'m',name:'m',driver:'mysql',storage:'server',host:'localhost',user:'u'}),sqlMode:mode,transactionState:'idle',async run(sql:string,_limit:number,id:string,progress:(s:unknown)=>void){executed.push(sql);if(sql.trimStart().startsWith('SET'))mode.noBackslashEscapes=true;const s={index:0,start:0,end:sql.length,sql,status:'succeeded'};progress(s);return {id,sql,status:'succeeded',statements:[s],transaction:'idle',durationMs:0};}} as unknown as DriverSession;
 const sql="SELECT :x; SET sql_mode='NO_BACKSLASH_ESCAPES'; SELECT :x;",progress:unknown[]=[];let inputs=0;
 const run=await runParameterizedSql(session,sql,100,'run',new AbortController().signal,async form=>{inputs++;return form.values.map(v=>({...v,type:'string',value:"\\'"}));},s=>progress.push(s));
 assert.equal(run.status,'succeeded');assert.equal(inputs,1);assert.equal(executed[0],"SELECT '\\\\'''");assert.equal(executed[2]?.trimStart(),"SELECT '\\'''");assert.equal(run.sql,sql);assert.equal(run.statements[2]?.sql.trimStart(),'SELECT :x');assert.equal(progress.length,3);
});
async function fixture(){const profile=ProfileSchema.parse({id:'params',name:'Parameters',driver:'sqlite',storage:'memory'}),manager=new ConnectionManager({list:()=>[profile],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')}),observed:QueryRun[]=[],docs=new SqlDocuments(manager,()=>{},{finished:(_p,r)=>{observed.push(r);},error:()=>{}});await docs.bind('a',profile.id);return {manager,docs,observed};}
test('real SQLite parameter execution preserves int64, aliases, strings, session transactions and history templates',async()=>{
 const {manager,docs,observed}=await fixture();try{let requests=0;docs.configureParameters(async form=>{requests++;return form.values.map(v=>({...v,value:v.key===':text'?"O'Reilly\\你好":v.value}));});
 const sql="CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT); INSERT INTO t VALUES(:{id||9223372036854775807||number},:text); SELECT :id AS input,id,v FROM t;";
 const run=await docs.run('a',sql);assert.equal(run.status,'succeeded',run.error);assert.equal(requests,1);assert.equal(run.statements.length,3);assert.deepEqual(run.statements[2]?.result?.rows[0],{c0:{type:'integer',value:'9223372036854775807'},c1:{type:'integer',value:'9223372036854775807'},c2:"O'Reilly\\你好"});
 assert.equal(observed[0]?.sql,sql);assert.ok(!(JSON.stringify(observed[0]?.error)??'').includes('Reilly'));
 await docs.transaction('a','begin');await docs.execute('a','UPDATE t SET v=:{v||pending||string}');await docs.transaction('a','rollback');assert.equal((await docs.execute('a','SELECT v FROM t')).rows[0]?.c0,"O'Reilly\\你好");
 }finally{await manager.close();}
});
test('parameter cancellation and stale source guards send no pending statement',async()=>{
 const {manager,docs}=await fixture();try{
 let opened!:()=>void;const ready=new Promise<void>(r=>{opened=r;});docs.configureParameters((_form,_session,signal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('input cancelled')),{once:true});opened();}));
 const pending=docs.run('a','CREATE TABLE forbidden AS SELECT :value');await ready;assert.equal(docs.state('a').busy,true);await docs.cancel('a');assert.equal((await pending).status,'cancelled');assert.equal((await manager.documentSession('a')!.schema()).some(o=>o.name==='forbidden'),false);
 let stale=false;docs.configureParameters(async form=>{stale=true;return form.values;});const run=await docs.run('a','CREATE TABLE forbidden AS SELECT :value',100,0,false,()=>{if(stale)throw new Error('source changed');});assert.equal(run.status,'failed');assert.match(run.error??'',/source changed/);assert.equal((await manager.documentSession('a')!.schema()).some(o=>o.name==='forbidden'),false);
 }finally{await manager.close();}
});
test('document parameter values are reused in memory and clearing/resetting removes them',async()=>{
 const {manager,docs}=await fixture();try{
 const inputs:string[]=[];docs.configureParameters(async form=>{inputs.push(form.values[0]!.value??'NULL');return form.values.map(v=>({...v,type:'string',value:'remembered'}));});
 const sql='SELECT :{value||default||string}';await docs.execute('a',sql);await docs.execute('a',sql);assert.deepEqual(inputs,['default','remembered']);
 docs.clearParameters('a');await docs.execute('a',sql);assert.equal(inputs.at(-1),'default');await docs.reset('a');await docs.execute('a',sql);assert.equal(inputs.at(-1),'default');
 assert.equal((await docs.execute('a','SELECT :{value||default||string||a,b}')).rows[0]?.c0,'remembered');
 }finally{await manager.close();}
});
