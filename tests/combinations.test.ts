import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {combineRows,type CombinationDataset} from '../packages/core/src/combine-rows.js';
import {Combinations} from '../packages/core/src/combinations.js';
import {Comparisons} from '../packages/core/src/comparisons.js';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {ProfileSchema,CombinationInputSchema,type CombinationInput,type CombinationSource,type ConnectionProfile} from '../packages/protocol/src/index.js';
const column=(name:string,key=name,type='TEXT')=>({key,name,dataType:type,nullable:true,primaryKey:0,generated:false,origins:[{node:'root',column:key}]});
const dataset=(id:string,rows:CombinationDataset['rows'],columns=[column('id','id','INTEGER'),column('v')]):CombinationDataset=>({id,label:id,columns,rows});
const sources=[{kind:'table' as const,profileId:'a',table:'t'},{kind:'table' as const,profileId:'b',table:'t'}];
const join=(type='inner',limit=100)=>CombinationInputSchema.parse({operation:'join',sources,type,pairs:[{left:'id',right:'id',mode:'numeric'}],limit});
const union=(limit=100)=>CombinationInputSchema.parse({operation:'union',sources,limit});
const signal=()=>new AbortController().signal;

test('all Join types preserve duplicate-key multiplicity, SQL NULL semantics and outer keys',async()=>{
  const left=dataset('L',[{id:1,v:'A'},{id:1,v:'B'},{id:null,v:'NL'},{id:2,v:'C'}]),right=dataset('R',[{id:1,v:'X'},{id:1,v:'Y'},{id:null,v:'NR'},{id:3,v:'Z'}]);
  for(const [type,count]of [['inner',4],['left',6],['right',6],['full',8],['cross',16]] as const){const r=await combineRows([left,right],join(type),100000,signal());assert.equal(r.rows.length,count,type);assert.equal(r.truncated,false);assert.equal(r.columns.length,type==='cross'?4:3);if(type==='full'){assert(r.rows.some(v=>v.c0===3&&v.c1===null&&v.c2==='Z'));assert(r.rows.some(v=>v.c1==='NL'&&v.c2===null));assert(r.rows.some(v=>v.c1===null&&v.c2==='NR'));}}
  const kept=await combineRows([left,right],{...join('full'),operation:'join',type:'full',pairs:[{left:'id',right:'id',mode:'numeric'}],keepRightKeys:true} as CombinationInput,100000,signal());assert.equal(kept.columns.length,4);assert(kept.rows.some(v=>v.c0===null&&v.c2===3));
});

test('Join matching is explicit, exact and collision-free for NUL-containing composite values',async()=>{
  const l=dataset('L',[{id:'001.00',v:'left'}]),r=dataset('R',[{id:1,v:'right'}]);assert.equal((await combineRows([l,r],join(),100000,signal())).rows.length,1);
  const text=join();if(text.operation==='join')text.pairs[0]!.mode='text';assert.equal((await combineRows([l,r],text,100000,signal())).rows.length,0);
  const composite=join();if(composite.operation==='join')composite.pairs=[{left:'id',right:'id',mode:'text'},{left:'v',right:'v',mode:'text'}];assert.equal((await combineRows([dataset('L',[{id:'a\0b',v:'c'}]),dataset('R',[{id:'a',v:'b\0c'}])],composite,100000,signal())).rows.length,0);
  assert.equal((await combineRows([dataset('L',[{id:{type:'integer',value:'9007199254740993'},v:null}]),dataset('R',[{id:{type:'integer',value:'9007199254740992'},v:null}])],join(),100000,signal())).rows.length,0);
});

test('Union aligns names and duplicate-name occurrence, preserves rows/types and cannot overwrite source metadata',async()=>{
  const columns=[column('x','a'),column('x','b'),column('__source','s')],left=dataset('L',[{a:'A',b:'B',s:'original'},{a:'A',b:'B',s:'original'}],columns),right=dataset('R',[{a:1,z:null}],[column('x','a','INTEGER'),column('other','z')]);
  const r=await combineRows([left,right],union(),100000,signal());assert.equal(r.rows.length,3);assert.deepEqual(r.columns.map(c=>c.name),['__source (origin)','x','x','__source','other']);assert.equal(r.columns[1]?.dataType,'MIXED');assert.deepEqual(r.rows[0],r.rows[1]);assert.deepEqual(r.rows[2],{c0:'R',c1:1,c2:null,c3:null,c4:null});assert.equal(r.rows[0]?.c3,'original');
});

test('empty inputs, exact row caps, byte caps and cancellation do not mislabel complete results',async()=>{
  const left=dataset('L',[{id:1,v:'long '.repeat(100)}]),right=dataset('R',[]);
  assert.equal((await combineRows([left,right],join('cross'),100000,signal())).rows.length,0);
  const exact=await combineRows([left,right],union(1),100000,signal());assert.equal(exact.rows.length,1);assert.equal(exact.truncated,false);
  const partial=await combineRows([left,left],union(1),100000,signal());assert.equal(partial.rows.length,1);assert.equal(partial.truncated,true);
  assert.equal((await combineRows([left,right],union(),10,signal())).truncated,true);
  const many=dataset('M',Array.from({length:1000},(_,id)=>({id,v:'x'}))),controller=new AbortController();const running=combineRows([many,many],join('cross',100000),10000000,controller.signal);setImmediate(()=>controller.abort());await assert.rejects(running,/cancel/i);assert.equal(many.rows.length,1000);
});

async function fixture(){let profiles:ConnectionProfile[]=[];const manager=new ConnectionManager({list:()=>profiles,save:async p=>{profiles=[...profiles.filter(x=>x.id!==p.id),p];},remove:async id=>{profiles=profiles.filter(p=>p.id!==id);}},{runnerPath:resolve('dist/sqlite-runner.cjs')});const captures=new Comparisons(manager),combinations=new Combinations(captures);for(const id of ['a','b']){await manager.save(ProfileSchema.parse({id,name:id,driver:'sqlite',storage:'memory'}));const s=await manager.connect(id);await s.query('CREATE TABLE t(id INTEGER,v TEXT)');await s.query("INSERT INTO t VALUES(1,'one'),(2,'two')");}return {manager,captures,combinations,async close(){await combinations.dispose();await captures.dispose();await manager.close();}};}

test('live tables and frozen SQL results can stack Union then Join with retained lineage and exact export',async()=>{
  const f=await fixture();try{const left=await f.manager.connect('a'),query='SELECT id,v FROM t',captured=f.captures.registerResult('a',await left.query(query),'Frozen SQL');await left.query('DELETE FROM t');const u=await f.combinations.run({...union(),sources:[captured,sources[1]!]});assert.equal(u.rows,4);assert.equal(u.truncated,false);
    const j=await f.combinations.run({...join(),sources:[{kind:'derived',id:u.id},sources[1]!],operation:'join',type:'inner',pairs:[{left:u.columns.find(c=>c.name==='id')!.key,right:'id',mode:'numeric'}],keepRightKeys:false});assert.equal(j.rows,4);f.combinations.forget(u.id);assert(f.combinations.lineage(j.id).some(n=>n.sql===query));assert(f.combinations.lineage(j.id).some(n=>n.kind==='union'));assert.equal(JSON.parse(f.combinations.export(j.id,'json')).rows.length,4);assert.match(f.combinations.export(j.id,'csv'),/__source/);assert.equal((await left.query('SELECT count(*) FROM t')).rows[0]?.c0,0);assert.throws(()=>f.combinations.page(u.id),/forgotten/);
  }finally{await f.close();}
});

test('truncated source provenance survives subsequent operations, and forgotten outputs reclaim their budget',async()=>{
  const f=await fixture();try{const sample=await f.combinations.run(union(1));assert(sample.inputTruncated);assert(sample.truncated);const next=await f.combinations.run({operation:'union',sources:[{kind:'derived',id:sample.id},sources[0]!],limit:100});assert(next.inputTruncated);assert(JSON.parse(f.combinations.export(next.id,'json')).truncated);
    const limited=new Combinations(f.captures,{datasetBytes:200,lineageBytes:5000,residentBytes:6500});try{const first=await limited.run(union());await assert.rejects(limited.run(union()),/memory budget/);limited.forget(first.id);assert.equal((await limited.run(union())).rows,4);}finally{await limited.dispose();}
  }finally{await f.close();}
});

test('twenty small Union sources fit the rolling capture reservation and retain all duplicate rows',async()=>{
  const f=await fixture();try{const result=await f.combinations.run({operation:'union',sources:Array.from({length:20},(_,i)=>sources[i%2]!),limit:100});assert.equal(result.rows,40);assert.equal(result.sources.length,20);assert.equal(result.truncated,false);}finally{await f.close();}
});

test('frozen SQL retains its original target after profile edits, and paged wire values cannot mutate retained results',async()=>{
  const f=await fixture();try{const a=await f.manager.connect('a'),sql='SELECT 9223372036854775807 AS n',captured=f.captures.registerResult('a',await a.query(sql),'Original memory query'),path=resolve('.cache',randomUUID()+'.must-not-open.db');await f.manager.save({...f.manager.profile('a'),storage:'file',path,createIfMissing:false});const result=await f.combinations.run({operation:'union',sources:[captured,captured],limit:100});assert.equal(result.rows,2);const root=f.combinations.lineage(result.id).find(n=>n.sql===sql)!;assert.equal(root.target?.storage,'memory');assert.match(root.targetRevision!,/^[a-f0-9]{64}$/);await assert.rejects(stat(path),{code:'ENOENT'});
    const page=f.combinations.page(result.id),tag=page.rows[0]?.c1;assert(tag&&typeof tag==='object'&&tag.type==='integer');tag.value='0';assert.equal(JSON.parse(f.combinations.export(result.id,'json')).rows[0][1].value,'9223372036854775807');
  }finally{await f.close();}
});
