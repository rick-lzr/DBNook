import {randomUUID} from 'node:crypto';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import type {ConnectionManager} from './connections.js';
import type {DdlIntent,DdlPreview,DdlStep,TableStructure} from '../../protocol/src/ddl.js';
import {ddlQuote,ddlLiteral} from './ddl-syntax.js';
import {sqlTokens} from './sql-editing.js';
import {readTableStructure} from './table-structure.js';
import {parseTableScript,renameScriptTable,renameScriptIndexTable,tableIdentifier,tableNameKey,ddlCanonical,type TableScript,type TableDriver} from './table-script.js';

const q=(name:string)=>ddlQuote(name,'sqlite'),l=(value:string)=>ddlLiteral(value,'sqlite');
type Edit=Extract<DdlIntent,{action:'editDefinition'}>;
export function validateColumnRenames(before:TableStructure,after:TableScript,renames:Edit['renames'],driver:TableDriver='sqlite'){
 const key=(v:string)=>tableNameKey(v,driver),old=new Set(before.columns.map(c=>key(c.name))),next=new Set(after.columns.map(c=>key(c.name))),from=new Set<string>(),to=new Set<string>();
 for(const r of renames){if(!old.has(key(r.from))||!next.has(key(r.to)))throw new Error('Column mapping must refer to an existing source and a column in the edited definition.');if(from.has(key(r.from))||to.has(key(r.to)))throw new Error('A column can participate in only one rename mapping.');if(old.has(key(r.to))||next.has(key(r.from)))throw new Error('Use a temporary name for staged/cyclic renames; a mapped old name must disappear and the new name must be unused.');from.add(key(r.from));to.add(key(r.to));}
}
function renamedIndex(sql:string,table:string,name:string){const ts=sqlTokens(sql,'sqlite').filter(t=>t.kind!=='comment'),at=ts.findIndex(t=>t.kind==='word'&&t.text.toUpperCase()==='INDEX')+1,old=tableIdentifier(ts,at,'sqlite');return renameScriptIndexTable(sql.slice(0,ts[at]!.start)+q(name)+sql.slice(ts[old.end-1]!.end),'sqlite',table);}
async function rowidColumn(session:DriverSession,structure:TableStructure){
 const pk=structure.columns.filter(c=>c.primaryKey);if(pk.length!==1||pk[0]!.dataType.trim().toUpperCase()!=='INTEGER')return undefined;
 const indexes=await session.query(`PRAGMA index_list(${q(structure.name)})`,0);return indexes.rows.some(r=>r.c3==='pk')?undefined:pk[0]!.name;
}
function hasAuto(sql:string){return sqlTokens(sql,'sqlite').some(t=>t.kind==='word'&&t.text.toUpperCase()==='AUTOINCREMENT');}
function withoutRowid(sql:string){const ts=sqlTokens(sql,'sqlite').filter(t=>t.kind!=='comment');return ts.some((t,i)=>t.kind==='word'&&t.text.toUpperCase()==='WITHOUT'&&ts[i+1]?.kind==='word'&&ts[i+1]!.text.toUpperCase()==='ROWID');}
/** Private schema-only simulation resolves SQLite's own rename rewrites and validates the complete rebuild. */
export async function sqliteTableMigration(manager:ConnectionManager,before:TableStructure,intent:Edit):Promise<Pick<DdlPreview,'steps'|'warnings'|'policy'|'table'|'before'>>{
 const desired=parseTableScript(intent.sql,'sqlite',{label:before.label}),oldScript=parseTableScript(before.definition,'sqlite',{label:before.label});validateColumnRenames(before,desired,intent.renames);
 const currentIndexes=before.auxiliary.filter(a=>a.type==='index');
 const canonical=(s:string)=>ddlCanonical(s.trim().replace(/;\s*$/,''),'sqlite');
 const unchanged=intent.renames.length===0&&canonical(desired.createSql)===canonical(before.definition)&&desired.indexes.length===currentIndexes.length&&desired.indexes.every(i=>currentIndexes.some(a=>a.name===i.name&&canonical(a.sql)===canonical(i.sql)));
 if(unchanged)return {steps:[],warnings:['The table definition is unchanged. No rebuild is required.'],policy:'transactional',table:before.name,before:before.definition};
 return manager.withSqliteSchemaSandbox(async sandbox=>{
  const catalog=JSON.parse(before.identity) as {c0:string;c1:string;c2:string;c3:number;c4:string|null}[];
  if(!Array.isArray(catalog)||catalog.length>20000)throw new Error('The SQLite schema exceeds the planning budget.');
  const priority:Record<string,number>={table:0,index:1,view:2,trigger:3};
  for(const entry of [...catalog].sort((a,b)=>(priority[a.c0]??9)-(priority[b.c0]??9))){
   if(!entry.c4||entry.c1.startsWith('sqlite_'))continue;
   // Virtual-table creation already creates its shadow storage in the sandbox.
   if(entry.c0==='table'&&(await sandbox.query(`SELECT 1 FROM sqlite_schema WHERE name=${l(entry.c1)}`,1)).rows.length)continue;
   await sandbox.query(entry.c4,0);
  }
  await sandbox.query('PRAGMA foreign_keys=OFF');await sandbox.query('PRAGMA legacy_alter_table=ON');
  const steps:DdlStep[]=[],warnings:string[]=[],add=(sql:string)=>steps.push({sql});
  for(const rename of intent.renames){const sql=`ALTER TABLE ${q(before.name)} RENAME COLUMN ${q(rename.from)} TO ${q(rename.to)}`;await sandbox.query(sql,0);add(sql);}
  const renamed=await readTableStructure(sandbox,before.name),temp='dbw_rebuild_'+randomUUID().replaceAll('-',''),create=renameScriptTable(desired.createSql,'sqlite',temp);
  await sandbox.query(create,0);add(create);const next=await readTableStructure(sandbox,temp);
  // Native SQLite validates expression/partial indexes against the proposed columns.
  for(const [i,index] of desired.indexes.entries())await sandbox.query(renamedIndex(index.sql,temp,'dbw_validate_'+i+'_'+randomUUID().replaceAll('-','')),0);
  const oldNames=new Set(renamed.columns.map(c=>tableNameKey(c.name,'sqlite'))),copy=next.columns.filter(c=>!c.generated&&oldNames.has(tableNameKey(c.name,'sqlite'))).map(c=>({target:c.name,source:renamed.columns.find(o=>tableNameKey(o.name,'sqlite')===tableNameKey(c.name,'sqlite'))!.name}));
  const oldWithout=withoutRowid(oldScript.suffix),newWithout=withoutRowid(desired.suffix);
  if(!oldWithout&&!newWithout){
   const oldPk=await rowidColumn(sandbox,renamed),newPk=await rowidColumn(sandbox,next),alias=(s:TableStructure)=>['rowid','_rowid_','oid'].find(a=>!s.columns.some(c=>tableNameKey(c.name,'sqlite')===a));
   const source=oldPk??alias(renamed),target=newPk??alias(next);
   if(!source||!target)throw new Error('The hidden rowid is shadowed by every alias. Use a dedicated migration to preserve row identity.');
   const mapped=copy.find(c=>c.target===target);if(!mapped)copy.unshift({target,source});else if(mapped.source!==source)warnings.push('The new INTEGER PRIMARY KEY defines rowids from its mapped values; previous hidden rowids may change.');
  }else if(oldWithout!==newWithout)warnings.push('The edited WITHOUT ROWID layout changes row identity. Logical mapped columns are copied.');
  const dropped=renamed.columns.filter(c=>!next.columns.some(n=>tableNameKey(n.name,'sqlite')===tableNameKey(c.name,'sqlite'))).map(c=>c.name);if(dropped.length)warnings.push('Column data will be deleted: '+dropped.join(', '));
  let insert:string;
  if(copy.length)insert=`INSERT INTO ${q(temp)} (${copy.map(c=>q(c.target)).join(', ')}) SELECT ${copy.map(c=>q(c.source)).join(', ')} FROM ${q(before.name)}`;
  else{const writable=next.columns.filter(c=>!c.generated);if(!writable.length)throw new Error('The new table has no writable columns.');insert=`INSERT INTO ${q(temp)} (${writable.map(c=>q(c.name)).join(', ')}) SELECT ${writable.map(c=>c.defaultSql===null?'NULL':c.defaultSql).join(', ')} FROM ${q(before.name)}`;}
  add(insert);steps.push({sql:`SELECT (SELECT count(*) FROM ${q(temp)}) = (SELECT count(*) FROM ${q(before.name)})`,expect:'one'});
  if(hasAuto(before.definition)&&hasAuto(desired.createSql)){
   add(`INSERT INTO sqlite_sequence(name,seq) SELECT ${l(temp)},seq FROM sqlite_sequence WHERE name=${l(before.name)} AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name=${l(temp)})`);
   add(`UPDATE sqlite_sequence SET seq=max(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name=${l(before.name)}),0)) WHERE name=${l(temp)}`);
  }
  add(`DROP TABLE ${q(before.name)}`);add(`ALTER TABLE ${q(temp)} RENAME TO ${q(before.name)}`);
  for(const index of desired.indexes)add(index.sql);
  for(const trigger of renamed.auxiliary.filter(a=>a.type==='trigger'))add(trigger.sql);
  steps.push({sql:'PRAGMA foreign_key_check',expect:'empty'},{sql:'PRAGMA integrity_check',expect:'integrity'});
  // Execute the remaining plan only in the empty, private schema. Real data is
  // copied later under BEGIN IMMEDIATE with the same validation steps.
  for(const step of steps.slice(intent.renames.length+1)){
   const result=await sandbox.query(step.sql,step.expect?1:0);
   if(step.expect==='empty'&&result.rows.length||step.expect==='one'&&Number(result.rows[0]?.c0)!==1||step.expect==='integrity'&&result.rows[0]?.c0!=='ok')throw new Error('The proposed SQLite schema failed its private validation.');
  }
  warnings.push('SQLite rebuilds this table transactionally. Mapped values, accessible rowids, AUTOINCREMENT high-water mark, edited indexes and existing triggers are preserved. New defaults/generated expressions and affinity changes can change values; real-data constraints and foreign keys are checked before commit.');
  return {steps,warnings,policy:'sqlite-rebuild',table:before.name,before:before.definition};
 });
}
