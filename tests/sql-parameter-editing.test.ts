import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {formatSql} from '../packages/core/src/sql-formatting.js';
import {sqlCompletions,type SqlSuggestion} from '../packages/core/src/sql-completion.js';
import {sqlParameters} from '../packages/core/src/sql-parameters.js';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {SqlDocuments} from '../packages/core/src/sql-documents.js';
import {ProfileSchema} from '../packages/protocol/src/index.js';
import {scriptSqlParameters} from '../packages/core/src/sql-script-parameters.js';
import {renderSqlParameters} from '../packages/core/src/sql-parameters.js';
import {runParameterizedSql} from '../packages/core/src/sql-parameter-run.js';
import type {DriverSession} from '../packages/driver-sdk/src/index.js';
const apply=(sql:string,item:SqlSuggestion)=>sql.slice(0,item.start)+item.insert+sql.slice(item.end);
const parameterText=(sql:string,driver:'sqlite'|'mysql'|'mariadb'|'postgresql')=>sqlParameters(sql,driver).occurrences.map(o=>sql.slice(o.start,o.end));

test('reference form defaults to String and opaque fourth-field metadata does not restrict values',async()=>{
 const p=ProfileSchema.parse({id:'parameter-defaults',name:'defaults',driver:'sqlite',storage:'memory'}),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')}),docs=new SqlDocuments(manager);
 try{await docs.bind('a',p.id);docs.configureParameters(async form=>{assert.deepEqual(form.values.map(v=>v.type),['string','string']);assert.equal(form.parameters[0]?.options,'first,second');return form.values;});
 const run=await docs.run('a','SELECT :{code||0001||||first,second} AS code, :{big||9223372036854775807} AS big');assert.equal(run.status,'succeeded',run.error);assert.deepEqual(run.statements[0]?.result?.rows[0],{c0:'0001',c1:'9223372036854775807'});
 }finally{await manager.close();}
});
test('formatting all four dialects preserves complete parameter tokens and comment contents',()=>{
 for(const driver of ['sqlite','postgresql','mysql','mariadb'] as const){
  const sql="-- keep :comment exactly\nselect :{text||O'Reilly;\nDELIMITER $$||string||opaque} as value,:{id||9223372036854775807||number},:id from teams where id=:id;";
  const formatted=formatSql(sql,driver,{},'\r\n');assert.match(formatted,/SELECT/);assert.deepEqual(parameterText(formatted,driver),parameterText(sql,driver));assert.ok(formatted.includes('-- keep :comment exactly'));assert.ok(!formatted.includes('__dbw'));
 }
});
test('formatting preserves literal bytes, binary prefixes, dollar bodies and colliding marker names',async()=>{
 const p=ProfileSchema.parse({id:'format-values',name:'format',driver:'sqlite',storage:'memory'}),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')}),docs=new SqlDocuments(manager);
 try{await docs.bind('a',p.id);docs.configureParameters(async form=>form.values);const sql="select :{v||a\r\nb||string},'x\ny' as \"__dbw0\",x'0001ff','__dbw1'";
  const before=await docs.execute('a',sql),formatted=formatSql(sql,'sqlite',{},'\r\n'),after=await docs.execute('a',formatted);assert.deepEqual(after.rows,before.rows);assert.ok(formatted.includes("'x\ny'"));assert.ok(formatted.includes('a\r\nb'));assert.ok(formatted.includes("x'0001ff'"));
 }finally{await manager.close();}
 const pg="select E'a\\\'b\nline',U&'d\\0061t',B'101',X'ff',$body$begin\n:ignored;\nend$body$";const formatted=formatSql(pg,'postgresql',{},'\r\n');for(const token of ["E'a\\\'b\nline'","U&'d\\0061t'","B'101'","X'ff'","$body$begin\n:ignored;\nend$body$"])assert.ok(formatted.includes(token),token);
});
test('formatter follows literal SQL mode changes without rewriting quoted values or executable comments',()=>{
 for(const driver of ['mysql','mariadb'] as const){
  const sql=String.raw`set sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'; select '\' as "a"; set sql_mode='ANSI'; select '\\' as "b";`;
  const formatted=formatSql(sql,driver);assert.ok(formatted.includes(String.raw`'\'`));assert.ok(formatted.includes(String.raw`'\\'`));assert.match(formatted,/SELECT/);
  const comment="/*! SELECT 'a\nb' */; SELECT 1";assert.ok(formatSql(comment,driver,{},'\r\n').includes("/*! SELECT 'a\nb' */"));
  assert.throws(()=>formatSql("SET sql_mode=:mode; SELECT '\\'",driver),/dynamic SQL mode/);
  assert.doesNotThrow(()=>formatSql('SET sql_mode=:mode',driver));
  assert.throws(()=>formatSql("/*! SET sql_mode='ANSI' */; SELECT 1",driver),/Conditional SQL mode/);
 }
});
test('partial-parameter formatting selections are rejected and complete tokens remain editable',()=>{
 const text="SELECT :{name||O'Reilly||string};",start=text.indexOf('name'),end=start+4;
 assert.throws(()=>formatSql(text.slice(start,end),'sqlite',{},'\n',{selection:{text,start,end}}),/complete SQL parameter/);
 const scan=sqlParameters(text,'sqlite'),o=scan.occurrences[0]!;assert.equal(formatSql(text.slice(o.start,o.end),'sqlite',{},'\n',{selection:{text,start:o.start,end:o.end}}),text.slice(o.start,o.end));
 assert.throws(()=>formatSql('SELECT :{unclosed||value','sqlite'),/Unclosed SQL parameter/);
});
test('parameter-name completion preserves surrounding definitions and wraps long bare names',()=>{
 const sql='SELECT :{account||1||number}, :acc||1||number',at=sql.lastIndexOf(':acc')+4,result=sqlCompletions(sql,at,'sqlite',[],undefined,true),item=result.items.find(i=>i.label===':account');assert(item);assert.equal(item.kind,'parameter');assert.ok(apply(sql,item).endsWith(':account||1||number'));
 const long='SELECT ${Long Name||hi||string}, $Lo',suggestion=sqlCompletions(long,long.length,'postgresql',[],undefined,true).items.find(i=>i.label==='$Long Name');assert(suggestion);assert.ok(apply(long,suggestion).endsWith('${Long Name}'));
 const open='SELECT :{account||1||number}, :{ac',openItem=sqlCompletions(open,open.length,'sqlite',[],undefined,true).items.find(i=>i.label===':account');assert(openItem);assert.ok(apply(open,openItem).endsWith(':{account}'));
});
test('parameter type completion tolerates unfinished definitions and avoids values, strings and comments',()=>{
 for(const sql of ['SELECT :{id||1||num}', 'SELECT :{id||1||num']){const offset=sql.indexOf('num')+3,item=sqlCompletions(sql,offset,'sqlite',[],undefined,true).items.find(i=>i.label==='number');assert(item);assert.ok(apply(sql,item).includes('||number'));}
 for(const tail of ["':acc'",'-- :acc','/* :acc */','$$ :acc $$']){const sql='SELECT :{account||1||number}; '+tail,at=sql.lastIndexOf(':acc')+4;assert.equal(sqlCompletions(sql,at,'postgresql',[],undefined,true).items.length,0);}
 const value="SELECT :{label||na||string}",offset=value.indexOf('na||')+2;assert.equal(sqlCompletions(value,offset,'sqlite',[],undefined,true).items.length,0);
});
test('ordinary column completion keeps exact ranges after defaults containing SQL punctuation',()=>{
 const sql="SELECT :{label||O'Reilly;\nother||string},t.na FROM teams t",offset=sql.indexOf('t.na')+4;
 const result=sqlCompletions(sql,offset,'sqlite',[{name:'teams',type:'table',sql:null,columns:[{key:'name',name:'name',dataType:'TEXT',nullable:true,primaryKey:0,generated:false}]}],undefined,true),item=result.items.find(i=>i.label==='name');assert(item);assert.equal(item.start,offset-2);assert.equal(item.end,offset);assert.ok(apply(sql,item).includes('t."name" FROM'));
});
test('script parameter discovery and preview use the lexical mode at each occurrence',()=>{
 const sql=String.raw`SET sql_mode='NO_BACKSLASH_ESCAPES'; SELECT '\', :{code||0001}, :text; SET sql_mode='ANSI'; SELECT '\\', :code, :text;`;
 const scan=scriptSqlParameters(sql,'mysql',{noBackslashEscapes:false,ansiQuotes:false});assert.equal(scan.deferredAt,undefined);assert.deepEqual(scan.parameters.map(p=>[p.key,p.defaultValue,p.occurrences]),[[':code','0001',2],[':text',undefined,2]]);
 const expanded=renderSqlParameters(sql,scan,[{key:':code',type:'string',value:'0001'},{key:':text',type:'string',value:"\\'"}],'mysql');
 assert.ok(expanded.includes("'0001', '\\'''"));assert.ok(expanded.includes("'0001', '\\\\'''"));
 const formatted=formatSql(sql,'mysql');assert.deepEqual(scriptSqlParameters(formatted,'mysql').parameters.map(p=>p.key),[':code',':text']);
});
test('dynamic SQL mode changes defer new parameter input even if the mode flags remain unchanged',async()=>{
 const actual:string[]=[],seen:{keys:string[];deferred?:boolean}[]=[],mode={noBackslashEscapes:false,ansiQuotes:false},session={profile:ProfileSchema.parse({id:'m',name:'m',driver:'mysql',storage:'server',host:'localhost',user:'u'}),sqlMode:mode,transactionState:'idle',async run(sql:string,_limit:number,id:string,progress:(s:unknown)=>void){actual.push(sql);const statement={index:0,start:0,end:sql.length,sql,status:'succeeded'};progress(statement);return {id,sql,status:'succeeded',statements:[statement],durationMs:0,transaction:'idle'};}} as unknown as DriverSession;
 const sql='SET sql_mode=:{mode||||string}; SELECT :{code||0001};',run=await runParameterizedSql(session,sql,100,'dynamic',new AbortController().signal,async form=>{seen.push({keys:form.parameters.map(p=>p.key),deferred:form.deferred});return form.values;},()=>{});
 assert.equal(run.status,'succeeded',run.error);assert.deepEqual(seen.map(s=>s.keys),[[':mode'],[':code']]);assert.equal(seen[0]?.deferred,true);assert.equal(actual.length,2);assert.ok(actual[1]?.includes("'0001'"));
});
test('deferred parameter discovery retains custom client delimiters across separate forms',async()=>{
 const actual:string[]=[],seen:string[]=[],mode={noBackslashEscapes:false,ansiQuotes:false},session={profile:ProfileSchema.parse({id:'m',name:'m',driver:'mysql',storage:'server',host:'localhost',user:'u'}),sqlMode:mode,transactionState:'idle',async run(sql:string,_limit:number,id:string,progress:(s:unknown)=>void){actual.push(sql);const statement={index:0,start:0,end:sql.length,sql,status:'succeeded'};progress(statement);return {id,sql,status:'succeeded',statements:[statement],durationMs:0,transaction:'idle'};}} as unknown as DriverSession;
 const sql='DELIMITER $$\nSET sql_mode=:{mode||||string}$$\nSELECT :{code||0001}$$\nDELIMITER ;\nSELECT :code;';
 const run=await runParameterizedSql(session,sql,100,'delimited',new AbortController().signal,async form=>{seen.push(form.delimiter??';');return form.values;},()=>{});
 assert.equal(run.status,'succeeded',run.error);assert.deepEqual(seen,[';','$$']);assert.equal(actual.length,3);assert.ok(actual[1]?.includes("'0001'"));assert.ok(actual[2]?.includes("'0001'"));assert.ok(actual.every(s=>!s.includes('DELIMITER')));
});
