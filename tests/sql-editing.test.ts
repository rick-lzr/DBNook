import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {currentSql,sqlSources} from '../packages/core/src/sql-editing.js';
import {sqlCompletions,type CompletionObject} from '../packages/core/src/sql-completion.js';
import {formatSql} from '../packages/core/src/sql-formatting.js';
import {QueryHistory,historyTarget} from '../packages/core/src/query-history.js';
import {ProfileSchema,type QueryRun} from '../packages/protocol/src/index.js';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {SqlDocuments} from '../packages/core/src/sql-documents.js';

test('current SQLite statement preserves trigger bodies, CASE, quoted semicolons and source offsets',()=>{
  const sql="-- lead\nSELECT 'a;b';\nCREATE TEMP TRIGGER audit AFTER INSERT ON t BEGIN INSERT INTO log VALUES(CASE WHEN NEW.id>0 THEN 'yes;' ELSE 'no' END); UPDATE t SET v=1; END;\n SELECT 42;";
  const sources=sqlSources(sql,'sqlite');assert.equal(sources.length,3);assert.match(sources[1]!.sql,/UPDATE t/);
  assert.equal(currentSql(sql,sql.indexOf('UPDATE'),'sqlite')?.sql,sources[1]!.sql);
  assert.equal(currentSql(sql,sql.indexOf('42'),'sqlite')?.sql,'SELECT 42;');
  assert.equal(currentSql(sql,sql.length,'sqlite')?.sql,'SELECT 42;');
  for(const s of sources)assert.equal(sql.slice(s.start,s.end),s.sql);
  assert.equal(currentSql('-- only comment',4,'sqlite'),undefined);
});
test('current PostgreSQL statement handles dollar strings and nested comments',()=>{
  const sql="/* a /* ; */ b */ SELECT $$a;b$$; SELECT E'c\\\'d;'; SELECT 3;";
  const sources=sqlSources(sql,'postgresql');assert.equal(sources.length,3);
  assert.match(currentSql(sql,sql.indexOf('a;b'),'postgresql')!.sql,/\$\$a;b\$\$/);
});
test('current MySQL/MariaDB routine ignores DELIMITER directives and respects session SQL mode',()=>{
  for(const driver of ['mysql','mariadb'] as const){
    const sql='DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;';
    const sources=sqlSources(sql,driver);assert.equal(sources.length,2);assert.match(currentSql(sql,sql.indexOf('SELECT 2'),driver)!.sql,/END$/);assert(!sources[0]!.sql.includes('DELIMITER'));
    assert.equal(sqlSources("SELECT 'a\\'; SELECT 2;",driver,{noBackslashEscapes:true,ansiQuotes:true}).length,2);
  }
});
const col=(name:string)=>({key:name,name,dataType:'TEXT',nullable:true,primaryKey:0,generated:false});
const objects:CompletionObject[]=[{name:'teams',type:'table',sql:null,columns:[col('id'),col('name')]},{name:'users',type:'table',sql:null,columns:[col('id'),col('team_id')]}];
test('completion resolves aliases/quoted names and qualifies ambiguous join columns',()=>{
  const sql='SELECT t.na FROM teams AS t JOIN users u ON t.id=u.team_id';
  const offset=sql.indexOf('na')+2;const result=sqlCompletions(sql,offset,'sqlite',objects);
  assert.deepEqual(result.items.map(i=>[i.label,i.insert]),[['name','"name"']]);assert.equal(result.items[0]!.start,sql.indexOf('na'));
  const join='SELECT i FROM teams t JOIN users u ON t.id=u.team_id';
  const ids=sqlCompletions(join,8,'sqlite',objects).items.filter(i=>i.label==='id');assert.deepEqual(ids.map(i=>i.insert),['"t"."id"','"u"."id"']);
  const quoted='SELECT t."na" FROM teams t';const suggestion=sqlCompletions(quoted,12,'sqlite',objects).items.find(i=>i.insert==='"name"');assert(suggestion);assert.equal(suggestion.end,13);
});
test('completion requests only referenced columns, supports schema tables and avoids ambiguous table resolution',()=>{
  const metadata:CompletionObject[]=[{name:'"public"."teams"',label:'teams',schema:'public',type:'table',sql:null},{name:'"other"."teams"',label:'teams',schema:'other',type:'table',sql:null}];
  const sql='SELECT t. FROM public.teams t';assert.deepEqual(sqlCompletions(sql,9,'postgresql',metadata).needs,['"public"."teams"']);
  assert.deepEqual(sqlCompletions('SELECT t. FROM teams t',9,'postgresql',metadata).needs,[]);
  assert.equal(sqlCompletions('SELECT * FROM public.te',23,'postgresql',metadata).items[0]?.insert,'"teams"');
  assert.equal(sqlCompletions("SELECT 'never complete",20,'sqlite',objects).items.length,0);
  assert.equal(sqlCompletions('-- no completion\nSELECT * FROM teams',5,'sqlite',objects).items.length,0);
});
test('formatting uses all four dialects, preserves literals/identifiers and rejects executable config and DELIMITER files',()=>{
  for(const driver of ['sqlite','postgresql','mysql','mariadb'] as const){const result=formatSql("select id,name from teams where name='a;中文' and id>1",driver,{},'\r\n');assert.match(result,/SELECT/);assert.match(result,/'a;中文'/);assert.match(result,/\r\n/);assert.match(result,/name/);}
  assert.throws(()=>formatSql('select 1','sqlite',{identifierCase:'upper'}));assert.throws(()=>formatSql('select 1','sqlite',{require:'evil.js'}));
  assert.throws(()=>formatSql('DELIMITER $$\nSELECT 1$$','mysql'),/selection/);
});
test('history persists across instances, isolates targets, enforces retention and skips disabled/failed entries',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'dbw-history-'));
  try{
    const settings={enabled:false,recordsPerDatabase:2,logFailedQueries:false},history=new QueryHistory(directory,()=>settings);
    const profile=ProfileSchema.parse({id:'history',name:'历史',driver:'sqlite',storage:'memory'});
    const run=(sql:string,status:QueryRun['status']='succeeded'):QueryRun=>({id:sql,sql,status,durationMs:3,statements:[],transaction:'idle'});
    await history.record(profile,run('SELECT 0'),new Date().toISOString());assert.equal((await history.list()).length,0);
    settings.enabled=true;await history.record(profile,run('bad','failed'),new Date().toISOString());assert.equal((await history.list()).length,0);
    for(let n=1;n<=3;n++)await history.record(profile,run(`SELECT ${n}; -- 中文`),new Date(2026,0,1,0,0,n).toISOString());
    const reloaded=new QueryHistory(directory,()=>settings),entries=await reloaded.list();assert.equal(entries.length,2);assert.equal((await reloaded.sql(entries[0]!.id)).sql,'SELECT 3; -- 中文');
    assert.equal((await reloaded.list({search:'中文'})).length,2);assert.equal((await reloaded.list({database:'no'})).length,0);
    const other={...profile,path:'new-target'};assert.notEqual(historyTarget(profile),historyTarget(other));await history.record(other,run('SELECT 4'),new Date().toISOString());assert.equal((await reloaded.list()).length,3);
    const concurrent=new QueryHistory(directory,()=>({...settings,recordsPerDatabase:100}));settings.recordsPerDatabase=100;
    await Promise.all([history.record(profile,run('SELECT 5'),new Date().toISOString()),concurrent.record(profile,run('SELECT 6'),new Date().toISOString())]);assert.equal((await reloaded.list()).length,5);
    await assert.rejects(reloaded.sql('../outside'));await writeFile(join(directory,'11111111-1111-4111-8111-111111111111.query'),'bad data');assert.equal((await reloaded.list()).length,5);
    await reloaded.remove(entries[0]!.id);await reloaded.clear();assert.equal((await reloaded.list()).length,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('history failures cannot change committed SQL outcomes, and formatting round-trips actual SQLite values',async()=>{
  const profile=ProfileSchema.parse({id:'memory',name:'history observer',driver:'sqlite',storage:'memory'}),errors:unknown[]=[];
  const manager=new ConnectionManager({list:()=>[profile],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')});
  try{const docs=new SqlDocuments(manager,()=>{},{finished:()=>{throw new Error('disk full');},error:e=>{errors.push(e);}});await docs.bind('a',profile.id);
    const sql=formatSql("select 'a;中文' as value, 1+2 as n",'sqlite');const run=await docs.run('a',sql);assert.equal(run.status,'succeeded');assert.equal(run.statements[0]?.result?.rows[0]?.c0,'a;中文');assert.equal(errors.length,1);
    assert.equal((await docs.execute('a','SELECT 5')).rows[0]?.c0,5);assert.equal(errors.length,2);
  }finally{await manager.close();}
});
