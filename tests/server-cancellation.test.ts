import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cancelServerRequest} from '../packages/core/src/server-cancellation.js';
import {ProfileSchema,type QueryResult} from '../packages/protocol/src/index.js';
const result=(rows:QueryResult['rows']):QueryResult=>({columns:[{key:'id',name:'Id',dataType:'INT',nullable:false,primaryKey:0,generated:false},{key:'info',name:'Info',dataType:'TEXT',nullable:true,primaryKey:0,generated:false}],rows,sql:'',durationMs:0,affectedRows:0,readOnly:true,truncated:false});
test('Cancellation never kills a backend whose active query lacks the original session marker',async()=>{
 const calls:string[]=[];let closed=false;const control={profile:ProfileSchema.parse({id:'control',name:'control',driver:'mysql',storage:'server',host:'localhost',user:'test'}),open:async()=>({sqlite:'',node:'test',path:'test'}),close:async()=>{closed=true;},query:async(sql:string)=>{calls.push(sql);return result([{id:7,info:'/* another session */ SELECT 1'}]);}};
 await assert.rejects(cancelServerRequest(control,7,'/* original */',()=>true),/could not be confirmed/);assert.equal(closed,true);assert.deepEqual(calls,['SHOW FULL PROCESSLIST']);
});
test('Natural completion and control-connection failure clean up without replaying or sending speculative KILL',async()=>{
 let closed=0,queries=0;const profile=ProfileSchema.parse({id:'control',name:'control',driver:'postgresql',storage:'server',host:'localhost',user:'test',database:'test'}),control={profile,open:async()=>({sqlite:'',node:'test',path:'test'}),close:async()=>{closed++;},query:async()=>{queries++;return result([]);}};
 await cancelServerRequest(control,7,'/* original */',()=>false);assert.equal(queries,0);assert.equal(closed,1);
 await assert.rejects(cancelServerRequest({...control,open:async()=>{throw new Error('Authentication unavailable');}},7,'/* original */',()=>true),/Authentication unavailable/);assert.equal(closed,2);assert.equal(queries,0);
 await assert.rejects(cancelServerRequest(control,7,'/* original */',()=>true),/could not be confirmed/);assert.equal(closed,3);
});
