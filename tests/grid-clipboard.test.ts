import test from 'node:test';
import assert from 'node:assert/strict';
import {copyGridValues,parseGridClipboard,pastedCell} from '../packages/core/src/grid-clipboard.js';
import {type ColumnMeta,type CellValue,WebRequestSchema} from '../packages/protocol/src/index.js';
import {SqliteSession} from '../packages/drivers/sqlite/session.js';
import {GridDocumentModel} from '../packages/core/src/grid-document.js';
import {ProfileSchema,TableRequestSchema} from '../packages/protocol/src/index.js';
import {resolve} from 'node:path';
const column=(dataType='TEXT',nullable=true):ColumnMeta=>({key:'v',name:'v',dataType,nullable,primaryKey:0,generated:false});
test('Clipboard TSV preserves Chinese, quotes, multiline, tabs, NULL, empty and literal null marker',()=>{
 const values:CellValue[]=['中文 O\'Reilly','"quoted"','a\nb\r\nc','a\tb',null,'','\\N','NULL','0001'];
 const parsed=parseGridClipboard(copyGridValues([values]));
 assert.deepEqual(parsed[0]!.map(f=>pastedCell(f,column())),values);
 assert.deepEqual(parseGridClipboard('a\tb\r\nc\td\r\n').map(row=>row.map(f=>f.text)),[['a','b'],['c','d']]);
 assert.deepEqual(parseGridClipboard('""'),[[{text:'',null:false}]]);
});
test('Clipboard conversion retains exact int64, DECIMAL, binary and booleans without writing data',()=>{
 const values:CellValue[]=[{type:'integer',value:'9223372036854775807'},'12345678901234567890.123456789',{type:'binary',base64:'AP8='},false];
 const fields=parseGridClipboard(copyGridValues([values]))[0]!;
 assert.deepEqual(fields.map((f,i)=>pastedCell(f,column(['BIGINT','DECIMAL(40,10)','BLOB','BOOLEAN'][i]),values[i])),values);
 assert.equal(pastedCell({text:'NULL',null:false},column()),'NULL');
 assert.throws(()=>pastedCell({text:'\\N',null:true},column('TEXT',false)),/does not allow NULL/);
 assert.throws(()=>pastedCell({text:'x',null:false},column('INT')),/integer/);
 assert.throws(()=>pastedCell({text:'1.2oops',null:false},column('DECIMAL')),/exact numeric/);
 assert.throws(()=>pastedCell({text:'not binary!',null:false},column('BLOB')),/Base64/);
 assert.throws(()=>pastedCell({text:'x',null:false},{...column(),generated:true}),/generated/);
});
test('Clipboard rejects malformed shapes, excessive data and unknown RPC fields',()=>{
 assert.throws(()=>parseGridClipboard('"unclosed'),/Unclosed/);
 assert.throws(()=>parseGridClipboard('"closed"oops'),/Unexpected/);
 assert.throws(()=>parseGridClipboard('a\tb\nc'),/rectangular/);
 assert.throws(()=>parseGridClipboard('x'.repeat(2_000_001)),/2 million/);
 assert.throws(()=>parseGridClipboard(Array(10_001).fill('x').join('\t')),/10,000/);
 assert(WebRequestSchema.safeParse({method:'clipboard.write',params:{text:'中文'}}).success);
 assert(!WebRequestSchema.safeParse({method:'clipboard.write',params:{text:'x',extra:true}}).success);
});
test('Clipboard typed values stage, undo and redo without writing SQLite, then save exact text/int64/binary',async()=>{
 const profile=ProfileSchema.parse({id:'clipboard-contract',name:'Clipboard contract',driver:'sqlite',storage:'memory'});
 const session=new SqliteSession(profile,{runnerPath:resolve('dist/sqlite-runner.cjs')});
 try{
  await session.open();await session.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT,i BIGINT,b BLOB)');
  await session.query("INSERT INTO t VALUES(1,'before',10,x'00')");
  const request=TableRequestSchema.parse({table:'t'}),rows=await session.table(request),details=await session.details('t');
  const model=new GridDocumentModel(profile,details,rows,request);
  const values:CellValue[]=["中文\nO'Reilly\t\"quote\"",{type:'integer',value:'9223372036854775807'},{type:'binary',base64:'AP8='}];
  const fields=parseGridClipboard(copyGridValues([values]))[0]!;
  const changes=Object.fromEntries(['v','i','b'].map((name,i)=>[name,pastedCell(fields[i]!,details.columns.find(c=>c.name===name)!,rows.rows[0]![name])]));
  const before=await session.table(request);
  const edit=model.update(0,{keyColumns:['id'],added:[],edits:{r0:{kind:'update',original:rows.rows[0],values:changes}}});assert(edit);
  assert(model.dirty);assert.deepEqual((await session.table(request)).rows,before.rows);
  edit.undo();assert(!model.dirty);assert.deepEqual((await session.table(request)).rows,before.rows);
  edit.redo();assert(model.dirty);assert.deepEqual((await session.table(request)).rows,before.rows);
  await model.save(session);assert(!model.dirty);
  assert.deepEqual((await session.table(request)).rows[0],{id:1,v:values[0],i:values[1],b:values[2]});
 }finally{await session.close();}
});
