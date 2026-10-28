import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {planStatement,planTree,QueryPlans} from '../packages/core/src/query-plans.js';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {SqlDocuments} from '../packages/core/src/sql-documents.js';
import {ProfileSchema,type QueryResult} from '../packages/protocol/src/index.js';

test('Plan syntax preserves one source statement and distinguishes four engine execution semantics',()=>{
 const sql="SELECT 'a;中文' /* keep */;";
 assert.equal(planStatement(sql,'sqlite','explain','3.51.2').executedSql,'EXPLAIN QUERY PLAN\n'+sql);
 assert.match(planStatement(sql,'postgresql','analyze','17.11').executedSql,/^EXPLAIN \(ANALYZE TRUE, BUFFERS TRUE, VERBOSE TRUE, FORMAT JSON\)/);
 assert.match(planStatement(sql,'mariadb','analyze','11.4.13-MariaDB').executedSql,/^ANALYZE FORMAT=JSON/);
 assert.match(planStatement(sql,'mysql','analyze','8.4.11').executedSql,/^EXPLAIN ANALYZE FORMAT=TREE/);
 assert.throws(()=>planStatement(sql,'sqlite','analyze','3.51.2'),/statistics/);
 for(const bad of ['SELECT 1; DELETE FROM items','BEGIN','ANALYZE items','EXPLAIN SELECT 1','CREATE TABLE x(id int)','/*!50000 SELECT */ 1'])assert.throws(()=>planStatement(bad,'mysql','explain','8.4.11'));
 assert.throws(()=>planStatement('DELIMITER $$\nSELECT 1; DELETE FROM items$$','mysql','explain','8.4.11'),/multiple commands/);
});
test('Version gates select supported MySQL syntax without claiming older server acceptance',()=>{
 assert.equal(planStatement('SELECT 1','mysql','analyze','8.0.18').executedSql,'EXPLAIN ANALYZE\nSELECT 1');
 assert.match(planStatement('SELECT 1','mysql','explain','5.7.44').executedSql,/FORMAT=JSON/);
 for(const v of ['5.7.44','8.0.17','unknown'])assert.throws(()=>planStatement('SELECT 1','mysql','analyze',v));
 assert.match(planStatement('SELECT 1','mariadb','analyze','5.5.5-10.3.0-MariaDB').executedSql,/^ANALYZE FORMAT=JSON/);
 assert.throws(()=>planStatement('SELECT 1','mariadb','analyze','5.5.5-10.0.0-MariaDB'));
});
test('JSON plan nodes preserve exact numeric lexemes, literal HTML and unknown server properties',()=>{
 const raw='[{"Plan":{"Node Type":"Index Scan","Plan Rows":9007199254740993,"Total Cost":1.2300,"custom":"<script>bad()</script>","Plans":[{"Node Type":"Nested Loop"}]}}]';
 const result=planTree(raw,'json');assert.deepEqual(result.warnings,[]);const p=result.nodes[0]!.children[0]!.children[0]!;
 assert.equal(p.label,'Index Scan');assert.equal(p.attributes.find(a=>a.name==='Plan Rows')!.value,'9007199254740993');assert.equal(p.attributes.find(a=>a.name==='Total Cost')!.value,'1.2300');assert.equal(p.attributes.find(a=>a.name==='custom')!.value,'<script>bad()</script>');
 assert(planTree('{"bad":','json').warnings.length);assert.equal(planTree('{"bad":','json').nodes.length,0);
});
test('Text plan hierarchy uses indentation while unknown text stays visible',()=>{
 const r=planTree('-> Filter: id > 1 (rows=2)\n    -> Table scan on items (actual time=0.1..0.2 rows=3 loops=1)\n','text');assert.equal(r.nodes[0]!.children.length,1);assert(r.nodes[0]!.children[0]!.label.includes('actual time='));
 const c=planTree('unrecognized\nraw text','text');assert.equal(c.nodes.length,2);
 const cols=['id','parent','notused','detail'].map((name,i)=>({key:'c'+i,name,dataType:'',nullable:false,primaryKey:0,generated:false}));
 const cyclic:QueryResult={durationMs:0,affectedRows:0,truncated:false,sql:'',readOnly:true,columns:cols,rows:[{c0:1,c1:2,c2:0,c3:'one'},{c0:2,c1:1,c2:0,c3:'two'}]};assert.match(planTree('', 'sqlite',cyclic).warnings[0]!,/cyclic/);
});
test('Real SQLite Explain reuses document temporary objects and transactions without applying explained updates',async()=>{
 const p=ProfileSchema.parse({id:'plan-sqlite',name:'Plan SQLite',driver:'sqlite',storage:'memory'}),m=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')}),docs=new SqlDocuments(m),plans=new QueryPlans(m,docs),owner='plan.sql';
 try{await docs.bind(owner,p.id);await docs.execute(owner,'CREATE TEMP TABLE temp_plan(id INTEGER PRIMARY KEY,v TEXT)');await docs.execute(owner,"INSERT INTO temp_plan VALUES(1,'kept')");await docs.transaction(owner,'begin');
  const proposal=await plans.prepare(owner,"UPDATE temp_plan SET v='changed' WHERE id=1",'explain');proposal.executedSql='DELETE FROM temp_plan';const report=await plans.run(proposal.token);assert.equal(report.transactionAfter,'active');assert(report.executedSql.startsWith('EXPLAIN QUERY PLAN'));assert.equal((await docs.execute(owner,'SELECT v FROM temp_plan')).rows[0]?.c0,'kept');
  const select=await plans.run((await plans.prepare(owner,'SELECT * FROM temp_plan WHERE id=1','explain')).token);assert(select.nodes.some(n=>/SEARCH/.test(n.label)));assert.equal(select.truncated,false);await docs.transaction(owner,'rollback');
  await assert.rejects(plans.run(proposal.token),/expired/);await assert.rejects(plans.prepare(owner,'SELECT 1','analyze'),/statistics/);
 }finally{await m.close();}
});
test('Session reset, connection rebinding and credential revision invalidate a prepared plan',async()=>{
 const p=ProfileSchema.parse({id:'plan-stale',name:'Plan stale',driver:'sqlite',storage:'memory'}),other={...p,id:'plan-other'},m=new ConnectionManager({list:()=>[p,other],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')}),docs=new SqlDocuments(m),plans=new QueryPlans(m,docs),owner='stale.sql';
 try{await docs.bind(owner,p.id);let q=await plans.prepare(owner,'SELECT 1','explain');await docs.reset(owner);await assert.rejects(plans.run(q.token),/changed/);q=await plans.prepare(owner,'SELECT 1','explain');await docs.bind(owner,other.id);await assert.rejects(plans.run(q.token),/changed/);await docs.bind(owner,p.id);q=await plans.prepare(owner,'SELECT 1','explain');await m.setPassword(p.id,'revision-only','session');await assert.rejects(plans.run(q.token),/changed/);
 }finally{await m.close();}
});
test('SQLite ATTACH changes invalidate the captured database context before executing a reviewed plan',async()=>{
 const p=ProfileSchema.parse({id:'plan-attached',name:'Plan attached',driver:'sqlite',storage:'memory'}),m=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')}),docs=new SqlDocuments(m),plans=new QueryPlans(m,docs),owner='attach.sql';
 try{await docs.bind(owner,p.id);const q=await plans.prepare(owner,'SELECT 1','explain');assert(q.context.some(c=>c.name==='Database main'));await m.documentSession(owner)!.query("ATTACH ':memory:' AS extra");await assert.rejects(plans.run(q.token),/Database/);const next=await plans.prepare(owner,'SELECT 1','explain');assert(next.context.some(c=>c.name==='Database extra'));assert.equal((await plans.run(next.token)).transactionAfter,'idle');const changed=await plans.prepare(owner,'SELECT 1','explain');await docs.execute(owner,'SELECT 7');await assert.rejects(plans.run(changed.token),/operation/);}finally{await m.close();}
});
