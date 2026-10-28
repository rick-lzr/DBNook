import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import {SchemaChanges} from '../../packages/core/src/schema-changes.js';
import {DdlIntentSchema} from '../../packages/protocol/src/index.js';
import {ddlQuote} from '../../packages/core/src/ddl-syntax.js';
export async function schemaContract(manager:ConnectionManager,id:string){
  const service=new SchemaChanges(manager),p=manager.profile(id),driver=p.driver,mysql=driver==='mysql'||driver==='mariadb',q=(s:string)=>ddlQuote(s,driver),schema=mysql?p.database!:'public';
  const name='ddl_'+randomUUID().replaceAll('-','').slice(0,12),parent=name+'_parent',qualified=(n:string)=>`${q(schema)}.${q(n)}`,table=qualified(name),base=await manager.connect(id);
  const apply=async(target:string|undefined,input:unknown)=>{const plan=await service.preview(id,target,DdlIntentSchema.parse(input));assert.equal(plan.policy,mysql?'implicit-commit':'transactional');const r=await service.apply(id,plan.token);assert.equal(r.status,'succeeded',r.error);return r;};
  await base.query(`CREATE TABLE ${qualified(parent)}(id INT PRIMARY KEY)`);
  await apply(undefined,{action:'createTable',schema,name,columns:[{name:'id',dataType:'INT',nullable:false},{name:'v',dataType:'VARCHAR(40)',defaultSql:"'keep'"},{name:'n',dataType:'INT'}],constraints:[{name:name+'_pk',kind:'primary',columns:['id']}]});
  await base.query(`INSERT INTO ${table}(id,v) VALUES(1,'before')`);
  if(mysql)await base.query(`ALTER TABLE ${table} MODIFY v VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'keep' COMMENT 'retain comment'`);
  let s=await service.structure(id,table);assert(s.definition.includes('CREATE TABLE'));assert(s.columns.find(c=>c.name==='v')?.definition);
  await apply(table,{action:'alterColumn',column:'v',change:'type',value:'VARCHAR(80)'});s=await service.structure(id,table);if(mysql){assert.match(s.definition,/retain comment/);assert.match(s.definition,/utf8mb4_bin/);}
  await apply(table,{action:'addColumn',column:{name:'status',dataType:'VARCHAR(30)',nullable:false,defaultSql:"'active'"}});
  await apply(table,{action:'alterColumn',column:'status',change:'default',value:"'ready'"});
  await apply(table,{action:'alterColumn',column:'v',change:'nullable',value:false});
  await apply(table,{action:'renameColumn',column:'n',name:'score'});
  await apply(table,{action:'addIndex',name:name+'_ix',unique:true,columns:[{name:'v'}]});
  await apply(table,{action:'addConstraint',constraint:{name:name+'_uq',kind:'unique',columns:['score']}});
  await apply(table,{action:'addConstraint',constraint:{name:name+'_fk',kind:'foreign',columns:['score'],targetSchema:schema,targetTable:parent,targetColumns:['id'],onDelete:'RESTRICT'}});
  await apply(table,{action:'addConstraint',constraint:{name:name+'_ck',kind:'check',expression:"status <> ''"}});
  s=await service.structure(id,table);assert(s.constraints.some(c=>c.name===name+'_fk'));assert(s.constraints.some(c=>c.name===name+'_ck'));await assert.rejects(base.query(`UPDATE ${table} SET status=''`),/check|constraint/i);
  const preview=await service.preview(id,table,DdlIntentSchema.parse({action:'renameTable',name:name+'_stale'}));await base.query(`ALTER TABLE ${table} ADD external INT`);const stale=await service.apply(id,preview.token);assert.equal(stale.status,'failed');assert.match(stale.error!,/changed after preview/);
  for(const suffix of ['fk','ck','uq'])await apply(table,{action:'dropConstraint',name:name+'_'+suffix});
  await apply(table,{action:'dropIndex',name:name+'_ix'});await apply(table,{action:'dropColumn',column:'external'});
  const pk=(await service.structure(id,table)).constraints.find(c=>c.kind==='primary');assert(pk);await apply(table,{action:'dropConstraint',name:pk.name});
  const renamed=name+'_new';await apply(table,{action:'renameTable',name:renamed});assert.equal((await base.query(`SELECT v FROM ${qualified(renamed)}`)).rows[0]?.c0,'before');
  await apply(qualified(renamed),{action:'dropTable'});await base.query(`DROP TABLE ${qualified(parent)}`);
}
