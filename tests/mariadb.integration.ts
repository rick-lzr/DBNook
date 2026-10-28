import './mysql.integration.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { open, table, request } from './mysql.integration.js';
import { MysqlSession } from '../packages/drivers/mysql/session.js';

test('MariaDB preserves JSON text, executable comments, generated/invisible columns and composite foreign keys',async()=>{
  const s=await open(),name=table(),child=table();
  await s.query(`CREATE TABLE ${name}(a INT,b INT,j JSON,hidden INT INVISIBLE DEFAULT 9,n INT GENERATED ALWAYS AS (a+b) PERSISTENT,PRIMARY KEY(a,b))`);
  await s.query(`CREATE TABLE ${child}(id INT PRIMARY KEY,a INT,b INT,CONSTRAINT composite_fk FOREIGN KEY(a,b) REFERENCES ${name}(a,b) ON UPDATE CASCADE ON DELETE RESTRICT)`);
  const d=await s.details(child);assert.deepEqual(d.foreignKeys.map(f=>[f.from,f.to,f.onUpdate,f.onDelete]),[['a','a','CASCADE','RESTRICT'],['b','b','CASCADE','RESTRICT']]);
  const json='{ "integer": 9007199254740993, "nested": [1, 2], "duplicate": 1, "duplicate": 2 }';
  await s.apply(name,[],[{kind:'insert',values:{a:1,b:2,j:json}}]);let rows=await s.table(request(name));assert.equal(rows.rows[0]?.j,json);assert.equal(rows.rows[0]?.hidden,9);assert.equal(rows.rows[0]?.n,3);assert((await s.details(name)).columns.find(c=>c.name==='n')?.generated);
  await s.apply(name,['a','b'],[{kind:'update',original:rows.rows[0],values:{j:'[3, 4]'}}]);rows=await s.table(request(name));assert.equal(rows.rows[0]?.j,'[3, 4]');
  const run=await s.run('/*M! SET @maria_value=42 */;SELECT @maria_value;',100,'maria-comments');assert.equal(run.status,'succeeded');assert.equal(run.statements.length,2);assert.equal(run.statements[1]?.result?.rows[0]?.c0,42);
  await assert.rejects(s.apply(name,['a','b'],[{kind:'update',original:rows.rows[0],values:{n:999}}]),/generated/);
});

test('MariaDB endpoint cannot be silently opened as a MySQL profile; Aria grids are read-only',async()=>{
  const s=await open(),name=table();await s.query(`CREATE TABLE ${name}(id INT) ENGINE=Aria`);assert((await s.table(request(name))).readOnly);await assert.rejects(s.apply(name,[],[{kind:'insert',values:{id:1}}]),/InnoDB/);
  const sequence=table();await s.query(`CREATE SEQUENCE ${sequence}`);assert(!(await s.schema()).some(o=>o.label===sequence));await assert.rejects(s.details(sequence),/object type/);
  const wrong=new MysqlSession({...s.profile,id:'wrong-engine',driver:'mysql'},async()=>process.env.DBW_MYSQL_PASSWORD);
  try{await assert.rejects(wrong.open(),/This is a MariaDB server.*Select MariaDB/);}finally{await wrong.close();}
  const ro=await open({readOnly:true});await assert.rejects(ro.query(`/*M! INSERT INTO ${name} VALUES(1) */ SELECT 1`),/read-only/);
});
