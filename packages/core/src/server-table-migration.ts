import type {DdlIntent,DdlPreview,TableStructure,DdlStep} from '../../protocol/src/ddl.js';
import type {TableDriver,TableScript,ScriptObject} from './table-script.js';
import {parseTableScript,ddlCanonical,tableIdentifier,columnNameKey,scriptObjectKey} from './table-script.js';
import {ddlQuote} from './ddl-syntax.js';
import {sqlTokens,type SqlToken} from './sql-editing.js';

type Edit=Extract<DdlIntent,{action:'editDefinition'}>;
const word=(t:SqlToken|undefined)=>t?.kind==='word'?t.text.toUpperCase():'';
/** Normalize only known column-list positions, never expressions, literals, function names or remote FK columns. */
function objectKey(object:ScriptObject,d:TableDriver,s:TableStructure,renames:Edit['renames']=[]){
 const ts=sqlTokens(object.definition,d,s.sqlMode).filter(t=>t.kind!=='comment'),edits:{start:number;end:number;text:string}[]=[];
 const open=ts.findIndex(t=>t.text==='(');if(open<0||!['primary','unique','foreign','index'].includes(object.kind))return ddlCanonical(object.definition,d,s.sqlMode);
 let first=true;const depth=ts[open]!.depth+1;
 for(let i=open+1;i<ts.length;i++){
  const t=ts[i]!;if(t.text===')'&&t.depth<depth)break;if(t.text===','&&t.depth===depth){first=true;continue;}
  if(!first||t.depth!==depth)continue;first=false;
  if(!['word','identifier'].includes(t.kind)||ts[i+1]?.text==='('||ts[i+1]?.text==='.')continue;
  const id=tableIdentifier(ts,i,d).parts[0]!,name=renames.find(r=>r.from===id)?.to??id;edits.push({start:t.start,end:t.end,text:ddlQuote(columnNameKey(name,d),d)});
 }
 let sql=object.definition;for(const e of edits.reverse())sql=sql.slice(0,e.start)+e.text+sql.slice(e.end);return ddlCanonical(sql,d,s.sqlMode);
}
function validateMappings(s:TableStructure,next:TableScript,renames:Edit['renames']){
 const from=new Set<string>(),to=new Set<string>();for(const r of renames){
  if(!s.columns.some(c=>c.name===r.from)||!next.columns.some(c=>c.name===r.to)||next.columns.some(c=>c.name===r.from)||s.columns.some(c=>c.name===r.to))throw new Error('Map a removed source column to a new name. Stage cyclic/colliding renames using temporary names.');
  if(from.has(r.from)||to.has(r.to))throw new Error('Column rename mappings must be one-to-one.');from.add(r.from);to.add(r.to);
 }
}
function suffixOptions(suffix:string,d:TableDriver,mode:TableStructure['sqlMode']){
 const tokens=sqlTokens(suffix,d,mode).filter(t=>t.kind!=='comment');const edits:{start:number;end:number}[]=[];let counter:string|undefined;
 for(let i=1;i<tokens.length-2;i++)if(word(tokens[i])==='AUTO_INCREMENT'&&tokens[i+1]?.text==='='&&/^\d+$/.test(tokens[i+2]?.text??'')){counter=tokens[i+2]!.text;edits.push({start:tokens[i]!.start,end:tokens[i+2]!.end});}
 let rest=suffix.slice(1);for(const e of edits.reverse())rest=rest.slice(0,e.start-1)+rest.slice(e.end-1);return {counter,sql:rest.trim().replace(/;\s*$/,'')};
}
function pgColumn(definition:string){
 const ts=sqlTokens(definition,'postgresql').filter(t=>t.kind!=='comment'),parts={type:'',collation:'',defaultSql:null as string|null,nullable:true,generated:'',generation:'none' as 'none'|'identity'|'stored'};
 const boundaries:number[]=[];for(let i=1;i<ts.length;i++){const t=ts[i]!;if(t.depth!==0||t.kind!=='word')continue;
  if(['COLLATE','DEFAULT','GENERATED','CONSTRAINT','PRIMARY','REFERENCES','UNIQUE','CHECK'].includes(word(t))||word(t)==='NOT'&&word(ts[i+1])==='NULL'||word(t)==='NULL'&&i===1)boundaries.push(i);
 }
 const first=boundaries[0]??ts.length;parts.type=definition.slice(ts[1]?.start??definition.length,ts[first]?.start??definition.length).trim();
 if(!parts.type)throw new Error('PostgreSQL column type is missing.');
 for(let n=0;n<boundaries.length;n++){
  const at=boundaries[n]!,end=boundaries[n+1]??ts.length,w=word(ts[at]),text=definition.slice(ts[at]!.end,ts[end]?.start??definition.length).trim();
  if(w==='COLLATE')parts.collation=text;
  else if(w==='DEFAULT'){
   // BY DEFAULT is part of GENERATED ... AS IDENTITY, not a column default.
   if(word(ts[at-1])==='BY')continue;parts.defaultSql=text;
  }else if(w==='NOT'){parts.nullable=false;}
  else if(w==='NULL')parts.nullable=true;
  else if(w==='GENERATED'){
   let stop=end;if(word(ts[end])==='DEFAULT'&&word(ts[end-1])==='BY')stop=boundaries[n+2]??ts.length;
   parts.generated=definition.slice(ts[at]!.start,ts[stop]?.start??definition.length).trim();parts.generation=/\bAS\s+IDENTITY\b/i.test(parts.generated)?'identity':'stored';
  }else throw new Error('Keep PostgreSQL column constraints as named table constraints in the CREATE definition.');
 }
 return parts;
}
function generatedExpression(fragment:string){const ts=sqlTokens(fragment,'postgresql').filter(t=>t.kind!=='comment'),as=ts.findIndex(t=>word(t)==='AS'),open=ts[as+1],close=ts.find(t=>t.text===')'&&t.depth===0&&t.start>(open?.start??Infinity));if(open?.text!=='('||!close||word(ts.at(-1))!=='STORED')throw new Error('Use GENERATED ALWAYS AS (expression) STORED.');return fragment.slice(open.end,close.start);}
/** Generate native ALTER operations. PostgreSQL retains the table OID, grants and dependants. */
export function serverTableMigration(driver:'postgresql'|'mysql'|'mariadb',s:TableStructure,intent:Edit):Pick<DdlPreview,'steps'|'warnings'|'policy'|'table'|'before'>{
 const next=parseTableScript(intent.sql,driver,{label:s.label,schema:s.schema},s.sqlMode),old=parseTableScript(s.definition,driver,{label:s.label,schema:s.schema},s.sqlMode);validateMappings(s,next,intent.renames);
 const q=(n:string)=>ddlQuote(n,driver),canon=(sql:string)=>ddlCanonical(sql,driver,s.sqlMode),warnings:string[]=[],steps:DdlStep[]=[],add=(sql:string)=>steps.push({sql}),mysql=driver!=='postgresql';
 const sourceFor=(name:string)=>intent.renames.find(r=>r.to===name)?.from??(mysql?s.columns.find(c=>columnNameKey(c.name,driver)===columnNameKey(name,driver))?.name:undefined)??name,renamed=(name:string)=>intent.renames.find(r=>r.from===name)?.to??name;
 const removed=s.columns.filter(c=>!next.columns.some(n=>sourceFor(n.name)===c.name));if(removed.length)warnings.push('Column data will be deleted: '+removed.map(c=>c.name).join(', '));
 const objectId=(o:ScriptObject)=>scriptObjectKey(o,driver);
 const dropped=old.objects.filter(o=>{const n=next.objects.find(n=>objectId(n)===objectId(o));return !n||objectKey(o,driver,s,intent.renames)!==objectKey(n,driver,s);});
 const added=next.objects.filter(o=>{const b=old.objects.find(b=>objectId(b)===objectId(o));return !b||dropped.some(d=>objectId(d)===objectId(o));});
 if(mysql){
  const clauses:string[]=[];
  for(const o of dropped)clauses.push(o.kind==='primary'?'DROP PRIMARY KEY':o.kind==='foreign'?'DROP FOREIGN KEY '+q(o.name):o.kind==='check'?(driver==='mysql'?'DROP CHECK ':'DROP CONSTRAINT ')+q(o.name):'DROP INDEX '+q(o.name));
  for(const c of removed)clauses.push('DROP COLUMN '+q(c.name));
  for(const [i,c] of next.columns.entries()){
   const source=sourceFor(c.name),before=s.columns.find(o=>o.name===source),position=i?' AFTER '+q(next.columns[i-1]!.name):' FIRST';
   if(!before)clauses.push('ADD COLUMN '+c.definition+position);
   else if(source!==c.name||canon(before.definition)!==canon(c.definition)||s.columns.findIndex(o=>o.name===source)!==i||intent.renames.length>0)clauses.push(`CHANGE COLUMN ${q(source)} ${c.definition}${position}`);
  }
  for(const o of added){
   const standalone=next.indexes.find(i=>i.name===o.name);if(!standalone){clauses.push('ADD '+o.definition);continue;}
   const ts=sqlTokens(standalone.sql,driver,s.sqlMode).filter(t=>t.kind!=='comment'),on=ts.findIndex(t=>word(t)==='ON'),owner=tableIdentifier(ts,on+1,driver),tail=standalone.sql.slice(ts[owner.end-1]!.end);
   clauses.push('ADD '+(word(ts[1])==='UNIQUE'?'UNIQUE ':'')+'INDEX '+q(o.name)+tail);
  }
  const beforeSuffix=suffixOptions(old.suffix,driver,s.sqlMode),afterSuffix=suffixOptions(next.suffix,driver,s.sqlMode);
  // A saved draft counter must not reset a counter advanced by ordinary inserts.
  const original=intent.baselineSql?parseTableScript(intent.baselineSql,driver,{label:s.label,schema:s.schema},s.sqlMode):old;
  const originalCounter=suffixOptions(original.suffix,driver,s.sqlMode).counter;
  if(canon(beforeSuffix.sql)!==canon(afterSuffix.sql)){
   if(/\bPARTITION\b/i.test(beforeSuffix.sql+' '+afterSuffix.sql))throw new Error('Changing partition/table options together needs a dedicated partition migration.');
   if(!afterSuffix.sql)throw new Error('Specify the desired table options explicitly.');clauses.push(afterSuffix.sql);
  }
  if(afterSuffix.counter!==originalCounter&&afterSuffix.counter)clauses.push('AUTO_INCREMENT='+afterSuffix.counter);
  if(clauses.length){add("SET SESSION sql_mode=IF(FIND_IN_SET('STRICT_ALL_TABLES',@@SESSION.sql_mode),@@SESSION.sql_mode,CONCAT_WS(',',NULLIF(@@SESSION.sql_mode,''),'STRICT_ALL_TABLES'))");if(s.schema)add('USE '+q(s.schema));add(`ALTER TABLE ${s.name}\n  ${clauses.join(',\n  ')}`);}
  warnings.push('MySQL/MariaDB DDL implicitly commits. One ALTER groups the requested changes, but external DDL and engine/version-specific rollback limits still apply. Native metadata locks and conversions may take time.');
  warnings.push('The dedicated migration session enables strict conversion checks. Existing invalid values or lossy conversions may reject the ALTER instead of being silently truncated.');
  if(intent.renames.length)warnings.push('Renaming MySQL/MariaDB columns can require updating dependent views, routines and triggers separately. Review those objects before applying.');
 }else{
  for(const o of dropped)add(o.kind==='index'?`DROP INDEX ${s.schema?q(s.schema)+'.':''}${q(o.name)}`:`ALTER TABLE ${s.name} DROP CONSTRAINT ${q(o.name)}`);
  for(const r of intent.renames)add(`ALTER TABLE ${s.name} RENAME COLUMN ${q(r.from)} TO ${q(r.to)}`);
  for(const c of removed)add(`ALTER TABLE ${s.name} DROP COLUMN ${q(c.name)}`);
  const retained=s.columns.filter(c=>!removed.includes(c)).map(c=>renamed(c.name)),existingOrder=next.columns.filter(c=>s.columns.some(o=>o.name===sourceFor(c.name))).map(c=>c.name);
  if(JSON.stringify(retained)!==JSON.stringify(existingOrder))throw new Error('PostgreSQL cannot reorder existing columns with ALTER TABLE. Keep their order or use a dedicated rebuild migration.');
  for(const [i,c] of next.columns.entries()){
   const before=s.columns.find(o=>o.name===sourceFor(c.name));if(!before){if(i<retained.length)throw new Error('PostgreSQL adds new columns at the end. Move new columns after existing columns.');add(`ALTER TABLE ${s.name} ADD COLUMN ${c.definition}`);continue;}
   const a=pgColumn(before.definition),b=pgColumn(c.definition),prefix=`ALTER TABLE ${s.name} ALTER COLUMN ${q(c.name)} `,typeChanged=canon(a.type)!==canon(b.type)||canon(a.collation)!==canon(b.collation);
   if(a.generation==='identity'&&b.generation!=='identity')add(prefix+'DROP IDENTITY');
   if(a.generation==='stored'&&b.generation!=='stored')add(prefix+'DROP EXPRESSION');
   if(typeChanged&&a.defaultSql!==null&&a.generation==='none')add(prefix+'DROP DEFAULT');
   if(typeChanged)add(prefix+'TYPE '+b.type+(b.collation?' COLLATE '+b.collation:''));
   if(a.nullable!==b.nullable)add(prefix+(b.nullable?'DROP':'SET')+' NOT NULL');
   if(b.generation==='identity'){
    if(a.generation==='identity'){
     if(/\bIDENTITY\s*\(/i.test(b.generated))throw new Error('Editing identity sequence options requires an explicit sequence migration.');
     if(canon(a.generated)!==canon(b.generated))add(prefix+'SET GENERATED '+(/\bBY\s+DEFAULT\b/i.test(b.generated)?'BY DEFAULT':'ALWAYS'));
    }else{
     if(a.defaultSql!==null&&!typeChanged)add(prefix+'DROP DEFAULT');if(b.nullable)throw new Error('An identity column must be NOT NULL.');
     add(prefix+'ADD '+b.generated);
     const tableLiteral="'"+s.name.replaceAll("'","''")+"'",columnLiteral="'"+c.name.replaceAll("'","''")+"'";
     add(`SELECT pg_catalog.setval(seq.seqrelid::regclass,CASE WHEN seq.seqincrement>0 THEN GREATEST(COALESCE(bounds.hi,seq.seqstart),seq.seqstart) ELSE LEAST(COALESCE(bounds.lo,seq.seqstart),seq.seqstart) END,CASE WHEN seq.seqincrement>0 THEN COALESCE(bounds.hi>=seq.seqstart,false) ELSE COALESCE(bounds.lo<=seq.seqstart,false) END) FROM pg_catalog.pg_sequence seq CROSS JOIN (SELECT max(${q(c.name)})::bigint AS hi,min(${q(c.name)})::bigint AS lo FROM ${s.name}) bounds WHERE seq.seqrelid=pg_catalog.pg_get_serial_sequence(${tableLiteral},${columnLiteral})::regclass`);
    }
   }else if(b.generation==='stored'){
    if(a.generation!=='stored')throw new Error('Converting an existing ordinary column to generated needs a dedicated rebuild. New generated columns can be added normally.');
    if(canon(a.generated)!==canon(b.generated))add(prefix+'SET EXPRESSION AS ('+generatedExpression(b.generated)+')');
   }else if(a.generation!=='none'||typeChanged||canon(a.defaultSql??'')!==canon(b.defaultSql??''))add(prefix+(b.defaultSql===null?'DROP DEFAULT':'SET DEFAULT '+b.defaultSql));
  }
  for(const o of added)add(o.kind==='index'?o.definition:`ALTER TABLE ${s.name} ADD ${o.definition}`);
  for(const o of added){
   if(o.kind==='index'){const index=s.indexes.find(i=>i.name===o.name);if(index?.comment!==undefined&&index.comment!==null)add(`COMMENT ON INDEX ${s.schema?q(s.schema)+'.':''}${q(o.name)} IS '`+index.comment.replaceAll("'","''")+"'");if(index?.replicaIdentity)add(`ALTER TABLE ${s.name} REPLICA IDENTITY USING INDEX ${q(o.name)}`);if(index?.clustered)add(`ALTER TABLE ${s.name} CLUSTER ON ${q(o.name)}`);}
   else{const c=s.constraints.find(c=>c.name===o.name);if(c?.comment!==undefined&&c.comment!==null)add(`COMMENT ON CONSTRAINT ${q(o.name)} ON ${s.name} IS '`+c.comment.replaceAll("'","''")+"'");}
  }
  if(canon(old.suffix)!==canon(next.suffix))throw new Error('Changing physical PostgreSQL table options requires an explicit options migration. Column/index/constraint changes preserve the current options.');
  if(old.unlogged!==next.unlogged)add(`ALTER TABLE ${s.name} SET ${next.unlogged?'UNLOGGED':'LOGGED'}`);
  warnings.push('PostgreSQL ALTER retains table identity, ownership, grants, policies and untouched objects. Types use native casts; conversions needing USING require an explicit SQL migration. Existing row order is not guaranteed.');
  if(intent.renames.length)warnings.push('Review column names inside stored routine/trigger function bodies separately; native column rename does not rewrite all stored program text.');
 }
 if(!steps.length)warnings.push('The table definition is unchanged. No migration statements will be sent.');
 return {steps,warnings,policy:mysql?'implicit-commit':'transactional',table:s.name,before:s.definition};
}
