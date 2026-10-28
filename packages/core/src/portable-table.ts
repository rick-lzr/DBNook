import {createHash} from 'node:crypto';
import type {DefinitionSnapshot} from '../../protocol/src/definitions.js';
import type {TableStructure} from '../../protocol/src/ddl.js';
import {parseTableScript,tableIdentifier,columnNameKey,tableNameKey,scriptObjectKey,type TableScript,type ScriptObject} from './table-script.js';
import {sqlTokens,sqlIdentifier,type SqlToken} from './sql-editing.js';
import {ddlQuote} from './ddl-syntax.js';
import {portableColumn,renderPortableColumn,hasEngineColumnAttributes,targetString,sqlStringValue,mysqlDialect} from './portable-types.js';
import {canonicalCell} from './compare-values.js';

export interface ColumnTranslation {name:string;sql?:string;reason?:string;warnings:string[];manual:boolean;}
export interface TableTranslation {model:TableScript;columns:ColumnTranslation[];issues:Record<string,string>;warnings:Record<string,string[]>;notes:string[];}
const word=(t:SqlToken|undefined)=>t?.kind==='word'?t.text.toUpperCase():'';
const tokens=(sql:string,s:DefinitionSnapshot)=>sqlTokens(sql,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment');
const model=(s:DefinitionSnapshot)=>parseTableScript(s.sql,s.driver,s.tableStructure!,s.tableStructure?.sqlMode);
const qualified=(s:DefinitionSnapshot)=>[s.ref.schema,s.ref.name].filter((v):v is string=>v!==undefined).map(v=>ddlQuote(v,s.driver)).join('.');
export const translationObjectId=(o:Pick<ScriptObject,'name'|'kind'>,target:DefinitionSnapshot)=>scriptObjectKey(o,target.driver);
function objectName(target:DefinitionSnapshot,name:string){let body=target.ref.name+'__'+name;const limit=target.driver==='postgresql'?63:mysqlDialect(target.driver)?64:255;if(Buffer.byteLength(body)<=limit)return body;const hash=createHash('sha256').update(body).digest('hex').slice(0,10),full=body;body='';for(const c of full){if(Buffer.byteLength(body+c)>limit-12)break;body+=c;}return body+'__'+hash;}
export function declaredColumnType(definition:string,s:DefinitionSnapshot){const ts=tokens(definition,s);let end=definition.length;for(let i=2;i<ts.length;i++)if(ts[i]!.depth===0&&['DEFAULT','NOT','NULL','PRIMARY','UNIQUE','CHECK','REFERENCES','CONSTRAINT','GENERATED','AUTO_INCREMENT','AUTOINCREMENT','COLLATE','COMMENT','ON','INVISIBLE','VISIBLE','STORAGE','SRID'].includes(word(ts[i]))||i>=2&&ts[i]!.depth===0&&word(ts[i])==='CHARACTER'&&word(ts[i+1])==='SET'){end=ts[i]!.start;break;}return definition.slice(ts[0]?.end??0,end).trim();}
/** A comparison key for the represented target attributes, including primitive default casts/aliases. */
export function translatedColumnKey(definition:string,s:DefinitionSnapshot,primaryKey=0,primaryShape=s.tableStructure!.columns.filter(c=>c.primaryKey).sort((a,b)=>a.primaryKey-b.primaryKey).map(c=>c.name)){
 const ts=tokens(definition,s),name=sqlIdentifier(ts[0]!.text),type=declaredColumnType(definition,s),column={name,dataType:type,definition,nullable:!ts.some((t,i)=>t.depth===0&&word(t)==='NOT'&&word(ts[i+1])==='NULL'),primaryKey,generated:ts.some(t=>word(t)==='GENERATED')};
 const p=portableColumn({...column,defaultSql:null},s),normalizedType=mysqlDialect(s.driver)&&p.type.kind==='boolean'?{kind:'integer',bits:8,unsigned:false}:p.type;let value:unknown=p.value;
 if(p.value.kind==='none'||p.value.kind==='null')value=null;
 else if(['integer','decimal','float'].includes(normalizedType.kind)&&(p.value.kind==='number'||p.value.kind==='string'))value=canonicalCell(p.value.value,'numeric');
 else if(mysqlDialect(s.driver)&&p.value.kind==='boolean')value=canonicalCell(p.value.value?'1':'0','numeric');
 else if(p.type.kind==='boolean'&&(p.value.kind==='boolean'||p.value.kind==='number'))value=p.value.kind==='boolean'?p.value.value:p.value.value==='1'?true:p.value.value==='0'?false:p.value;
 const storage=mysqlDialect(s.driver)?/^(?:(?:tiny|medium|long)?(?:text|blob)|datetime|timestamp)(?=\s|\(|$)/i.exec(type)?.[0].toLowerCase():undefined;
 return JSON.stringify({name:columnNameKey(name,s.driver),type:normalizedType,storage,nullable:p.nullable,value,identity:p.identity,primaryKey,primaryShape:primaryKey?primaryShape.map(n=>columnNameKey(n,s.driver)):undefined});
}
export function validateColumnOverride(sql:string,name:string,target:DefinitionSnapshot){const p=parseTableScript(`CREATE TABLE ${qualified(target)} (${sql})`,target.driver,target.tableStructure!,target.tableStructure?.sqlMode);if(p.columns.length!==1||p.objects.length||p.indexes.length||p.columns[0]!.name!==name||p.suffix.trim()!==')')throw new Error('Enter exactly one target column definition with the original source column name, without additional statements or table options.');return p.columns[0]!.definition;}
function preserveTargetComment(sql:string,name:string,target:DefinitionSnapshot){const c=target.tableStructure!.columns.find(c=>columnNameKey(c.name,target.driver)===columnNameKey(name,target.driver));if(!c)return sql;const ts=tokens(c.definition,target);if(hasEngineColumnAttributes(c.definition,target))throw new Error('The existing target column has engine-specific attributes. Supply a complete target definition to preserve or change them explicitly.');if(ts.some((t,i)=>i>0&&t.depth===0&&['CHECK','UNIQUE','REFERENCES'].includes(word(t))))throw new Error('The target column has inline constraints. Supply a complete target definition to preserve or change their policy explicitly.');const i=ts.findIndex((t,i)=>i>0&&t.depth===0&&word(t)==='COMMENT');if(i>=0){if(ts[i+1]?.kind!=='string')throw new Error('The target comment needs explicit handling.');sql+=' COMMENT '+ts[i+1]!.text;}return sql;}
function columnsAt(ts:SqlToken[],at:number,source:DefinitionSnapshot,local=false){
 if(ts[at]?.text!=='(')throw new Error('Expected a simple column list.');const depth=ts[at]!.depth+1,columns:{name:string;direction:'ASC'|'DESC'}[]=[];let i=at+1;
 while(ts[i]&&!(ts[i]!.text===')'&&ts[i]!.depth<depth)){
  const token=ts[i]!;if(token.depth!==depth||!['word','identifier'].includes(token.kind))throw new Error('Expressions, prefix lengths and operator classes need a target index definition.');let name=sqlIdentifier(token.text);if(source.driver==='postgresql'&&token.kind==='word')name=name.toLowerCase();if(local){const actual=source.tableStructure!.columns.find(c=>columnNameKey(c.name,source.driver)===columnNameKey(name,source.driver));if(!actual)throw new Error('The source object references an unknown column.');name=actual.name;}i++;let direction:'ASC'|'DESC'='ASC';if(['ASC','DESC'].includes(word(ts[i])))direction=word(ts[i++]) as 'ASC'|'DESC';columns.push({name,direction});if(ts[i]?.text===','){i++;continue;}if(ts[i]?.text!==')')throw new Error('Only plain columns and ASC/DESC are portable here.');
 }
 if(!ts[i]||!columns.length)throw new Error('The column list is incomplete.');return {columns,end:i+1};
}
/** InnoDB creates a nonunique local index for a foreign key if the source engine did not need one. */
export function requiredSupportingIndexes(desired:TableScript,current:TableScript,target:DefinitionSnapshot,issues:Record<string,string>={}):Set<string>{
 const retained=new Set<string>();if(!mysqlDialect(target.driver))return retained;
 const list=(o:ScriptObject)=>{try{const ts=tokens(o.definition,target);if(ts.some((t,i)=>['FULLTEXT','SPATIAL'].includes(word(t))||word(t)==='USING'&&word(ts[i+1])!=='BTREE'))return;const open=ts.findIndex(t=>t.text==='('),parsed=columnsAt(ts,open,target);if(parsed.columns.some(c=>c.direction!=='ASC'))return;return parsed.columns.map(c=>columnNameKey(c.name,target.driver));}catch{return;}};
 const covers=(columns:string[]|undefined,key:string[])=>columns!==undefined&&columns.length>=key.length&&key.every((v,i)=>columns[i]===v);
 const indexes=desired.objects.filter(o=>['primary','unique','index'].includes(o.kind)&&!issues[scriptObjectKey(o,target.driver)]);
 for(const fk of desired.objects.filter(o=>o.kind==='foreign'&&!issues[scriptObjectKey(o,target.driver)])){
  const key=list(fk);if(!key?.length||indexes.some(o=>covers(list(o),key)))continue;
  const candidates=current.objects.filter(o=>o.kind==='index'&&covers(list(o),key)).sort((a,b)=>Number(b.name===fk.name)-Number(a.name===fk.name)||(list(a)?.length??0)-(list(b)?.length??0)||a.name.localeCompare(b.name));
  if(candidates[0])retained.add(candidates[0].name);
 }return retained;
}
function expression(text:string,source:DefinitionSnapshot,target:DefinitionSnapshot){
 const ts=tokens(text,source),names=source.tableStructure!.columns.map(c=>c.name),out:string[]=[];
 const keywords=new Set(['AND','OR','NOT','IS','NULL','IN','BETWEEN','LIKE','ESCAPE','CASE','WHEN','THEN','ELSE','END']),functions=new Set(['LENGTH','CHAR_LENGTH','COALESCE','LOWER','UPPER','ABS','ROUND']);
 for(let i=0;i<ts.length;i++){const t=ts[i]!;
  if(t.kind==='word'&&/^\d/.test(t.text)||t.text==='.'&&/^\d/.test(ts[i+1]?.text??'')){const value=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(t.start))?.[0];if(value&&t.end<=t.start+value.length){const end=t.start+value.length;while(ts[i+1]&&ts[i+1]!.end<=end)i++;if(ts[i]!.end===end){out.push(value);continue;}}}
  if(t.kind==='string'){out.push(targetString(sqlStringValue(t.text,source.driver,source.tableStructure?.sqlMode?.noBackslashEscapes),target.driver,target.tableStructure?.sqlMode));continue;}
  if(t.kind==='word'&&functions.has(word(t))&&ts[i+1]?.text==='('){const w=word(t);out.push(w==='LENGTH'&&mysqlDialect(target.driver)?'CHAR_LENGTH':w==='CHAR_LENGTH'&&target.driver==='sqlite'?'LENGTH':w);continue;}
  if(t.kind==='identifier'||t.kind==='word'&&names.some(n=>columnNameKey(n,source.driver)===columnNameKey(t.text,source.driver))){const name=t.kind==='identifier'?sqlIdentifier(t.text):source.driver==='postgresql'?t.text.toLowerCase():t.text,actual=names.find(n=>columnNameKey(n,source.driver)===columnNameKey(name,source.driver));if(!actual)throw new Error('Unknown quoted column in expression.');out.push(ddlQuote(actual,target.driver));continue;}
  if(t.kind==='word'){const w=word(t);if(/^(?:\d+(?:e[+-]?\d+)?)$/i.test(t.text)||keywords.has(w)){out.push(t.text);continue;}if(w==='TRUE'||w==='FALSE'){out.push(target.driver==='postgresql'?w:w==='TRUE'?'1':'0');continue;}if(functions.has(w)&&ts[i+1]?.text==='('){out.push(w==='LENGTH'&&mysqlDialect(target.driver)?'CHAR_LENGTH':w==='CHAR_LENGTH'&&target.driver==='sqlite'?'LENGTH':w);continue;}throw new Error(`Expression token ${t.text} needs an explicit target definition.`);}
  if(!['(',')',',','.','+','-','*','/','%','=','!','<','>'].includes(t.text))throw new Error('This expression operator needs explicit target handling.');
  if(t.text==='='&&ts[i+1]?.text==='='){out.push('=');i++;}else if(t.text==='!'&&ts[i+1]?.text==='='){out.push('<>');i++;}else out.push(t.text);
 }
 return out.join(' ');
}

export function translateTable(source:DefinitionSnapshot,target:DefinitionSnapshot,overrides:Record<string,string>={}):TableTranslation{
 const original=model(source),existing=model(target),q=(n:string)=>ddlQuote(n,target.driver),issues:Record<string,string>={},warnings:Record<string,string[]>={},columns:ColumnTranslation[]=[],objects:ScriptObject[]=[],notes:string[]=[];
 const names=new Set<string>();for(const c of source.tableStructure!.columns){const key=columnNameKey(c.name,target.driver);if(names.has(key))throw new Error('Source column names collide under target identifier rules. Choose an explicit target column-name mapping before migration.');names.add(key);}
 for(const c of source.tableStructure!.columns){const entry:ColumnTranslation={name:c.name,warnings:[],manual:false};try{
  if(Object.hasOwn(overrides,c.name)){entry.sql=validateColumnOverride(overrides[c.name]!,c.name,target);entry.manual=true;entry.warnings.push('An explicit target column definition overrides automatic conversion.');}
  else{const p=portableColumn(c,source),rendered=renderPortableColumn(p,target);entry.sql=preserveTargetComment(rendered.sql,c.name,target);entry.warnings=rendered.warnings;
   // A non-identity single-column INTEGER primary key would become an automatic rowid alias in SQLite.
   if(target.driver==='sqlite'&&p.identity==='none'&&c.primaryKey&&source.tableStructure!.columns.filter(v=>v.primaryKey).length===1){if(p.type.kind==='integer')entry.sql=entry.sql.replace(q(c.name)+' INTEGER',q(c.name)+' INT');entry.sql+=' PRIMARY KEY';}
  }
 }catch(e){entry.reason=e instanceof Error?e.message:String(e);}columns.push(entry);}
 const sourcePrimary=source.tableStructure!.columns.filter(c=>c.primaryKey).sort((a,b)=>a.primaryKey-b.primaryKey).map(c=>c.name),inlineIdentity=target.driver==='sqlite'&&sourcePrimary.length===1&&columns.some(c=>{const ts=c.sql?tokens(c.sql,target):[];return c.name===sourcePrimary[0]&&ts.some((t,i)=>t.depth===0&&word(t)==='PRIMARY'&&word(ts[i+1])==='KEY');});
 const targetPrimary=existing.objects.find(o=>o.kind==='primary');
 if(sourcePrimary.length&&!inlineIdentity){const name=target.driver==='mysql'||target.driver==='mariadb'?'PRIMARY':targetPrimary?.name??objectName(target,'primary');objects.push({name,kind:'primary',definition:`${mysqlDialect(target.driver)?'':`CONSTRAINT ${q(name)} `}PRIMARY KEY (${sourcePrimary.map(q).join(', ')})`});}
 const add=(object:ScriptObject)=>{if(objects.some(o=>scriptObjectKey(o,target.driver)===scriptObjectKey(object,target.driver)))throw new Error('Converted object names collide; choose an explicit target definition.');objects.push(object);};
 const convertObject=(o:ScriptObject)=>{
  if(o.kind==='primary')return;let name=objectName(target,o.name),definition=o.definition,resultKind=o.kind;
  if(existing.objects.some(v=>v.name===o.name&&v.kind===o.kind))name=o.name;
  const objectId=scriptObjectKey({name,kind:o.kind},target.driver);
  try{
   if(sqlTokens(o.definition,source.driver,source.tableStructure?.sqlMode).some(t=>t.kind==='comment'&&/^\/\*(?:!|[mM]!)/.test(t.text)))throw new Error('Version-specific object attributes need a target definition.');
   const ts=tokens(o.definition,source),open=ts.findIndex(t=>t.text==='(');if(open<0)throw new Error('Object definition has no supported column/expression list.');
   if(o.kind==='check'){
    const close=ts.find(t=>t.text===')'&&t.depth===0&&t.start>ts[open]!.start);if(!close||ts.at(-1)!==close)throw new Error('CHECK enforcement/deferrability needs explicit target handling.');definition=`CONSTRAINT ${q(name)} CHECK (${expression(o.definition.slice(ts[open]!.end,close.start),source,target)})`;warnings[objectId]=['CHECK expressions use target functions, types, collation and evaluation semantics.'];
   }else if(o.kind==='foreign'){
    const local=columnsAt(ts,open,source,true),refAt=ts.findIndex((t,i)=>i>=local.end&&word(t)==='REFERENCES');if(refAt<0)throw new Error('The foreign key has no REFERENCES target.');const ref=tableIdentifier(ts,refAt+1,source.driver);let schema=ref.parts.length===2?ref.parts[0]:source.ref.schema,label=ref.parts.at(-1)!;
    const self=schema===source.ref.schema&&tableNameKey(label,source.driver)===tableNameKey(source.ref.name,source.driver),remote=columnsAt(ts,ref.end,source,self);
    if(schema!==source.ref.schema)throw new Error('An external source schema needs an explicit target dependency mapping.');schema=target.ref.schema;if(self)label=target.ref.name;
    let tail='';for(let i=remote.end;i<ts.length;){if(word(ts[i])!=='ON'||!['DELETE','UPDATE'].includes(word(ts[i+1])))throw new Error('MATCH, deferred or other foreign-key attributes need explicit target handling.');const event=word(ts[i+1]);i+=2;let action=word(ts[i++]);if(['NO','SET'].includes(action))action+=' '+word(ts[i++]);if(!['NO ACTION','RESTRICT','CASCADE','SET NULL','SET DEFAULT'].includes(action)||mysqlDialect(target.driver)&&action==='SET DEFAULT')throw new Error('The target does not support this foreign-key action.');tail+=' ON '+event+' '+action;}
    const owner=target.driver==='sqlite'?q(label):[schema,label].filter((v):v is string=>v!==undefined).map(q).join('.');definition=`CONSTRAINT ${q(name)} FOREIGN KEY (${local.columns.map(c=>q(c.name)).join(', ')}) REFERENCES ${owner} (${remote.columns.map(c=>q(c.name)).join(', ')})${tail}`;warnings[objectId]=['Same-schema references are resolved in the target schema; verify referenced tables, column types and keys.'];
   }else if(o.kind==='unique'||o.kind==='index'){
    if(ts.some(t=>['FULLTEXT','SPATIAL','NULLS','INCLUDE','CONCURRENTLY'].includes(word(t))))throw new Error('Special indexes/unique semantics need an explicit target definition.');const parsed=columnsAt(ts,open,source,true);
    // A regular btree method before the list is portable; index tails/predicates/prefixes are not silently dropped.
    if(ts.slice(0,open).some((t,i,a)=>word(t)==='USING'&&word(a[i+1])!=='BTREE')||parsed.end<ts.length)throw new Error('Index method, predicate, collation or options need a target definition.');
    if(mysqlDialect(target.driver)&&parsed.columns.some(c=>{const sql=columns.find(v=>v.name===c.name)?.sql;return sql&&/^(?:LONGTEXT|LONGBLOB|TEXT|BLOB|JSON)$/i.test(declaredColumnType(sql,target));}))throw new Error('Choose a target index prefix/column type explicitly for unbounded text/binary/JSON.');
    if(o.kind==='unique'&&target.driver==='postgresql'&&parsed.columns.some(c=>c.direction==='DESC'))throw new Error('Choose a target unique-index/constraint ordering policy explicitly.');
    const list=parsed.columns.map(c=>q(c.name)+(c.direction==='DESC'?' DESC':'')).join(', ');
    const unique=o.kind==='unique'||original.indexes.some(i=>i.name===o.name&&/^CREATE\s+UNIQUE\b/i.test(i.sql));
    if(mysqlDialect(target.driver))resultKind=unique?'unique':'index';
    definition=mysqlDialect(target.driver)?`${unique?'UNIQUE KEY':'KEY'} ${q(name)} (${list})`:o.kind==='unique'?`CONSTRAINT ${q(name)} UNIQUE (${list})`:`CREATE ${unique?'UNIQUE ':''}INDEX ${q(name)} ON ${qualified(target)}${target.driver==='postgresql'?' USING btree':''} (${list})`;
   }else throw new Error('This constraint kind needs an explicit target definition.');
   add({name,kind:resultKind,definition});
  }catch(e){issues[objectId]=e instanceof Error?e.message:String(e);add({name,kind:o.kind,definition:o.definition});}
 };
 for(const o of original.objects)convertObject(o);
 // SQLite inline UNIQUE constraints and REFERENCES are absent from the table-level object list.
 if(source.driver==='sqlite'){
  for(const index of source.tableStructure!.indexes.filter(i=>i.protected&&i.unique&&JSON.stringify(i.columns)!==JSON.stringify(sourcePrimary))){const name=objectName(target,index.name);if(!objects.some(o=>o.kind==='unique'&&o.definition.endsWith('('+index.columns.map(q).join(', ')+')')))convertObject({name:index.name,kind:'unique',definition:'UNIQUE ('+index.columns.map(n=>ddlQuote(n,'sqlite')).join(', ')+')'});}
  for(const c of source.tableStructure!.columns){const ts=tokens(c.definition,source),at=ts.findIndex(t=>t.depth===0&&word(t)==='REFERENCES');if(at>=0)convertObject({name:c.name+'_fk',kind:'foreign',definition:`FOREIGN KEY (${ddlQuote(c.name,'sqlite')}) `+c.definition.slice(ts[at]!.start)});
   const check=ts.findIndex(t=>t.depth===0&&word(t)==='CHECK');if(check>=0){const close=ts.find(t=>t.text===')'&&t.depth===0&&t.start>ts[check]!.start);if(close)convertObject({name:c.name+'_check',kind:'check',definition:c.definition.slice(ts[check]!.start,close.end)});}
  }
 }
 for(const entry of columns){if(entry.reason)issues['column:'+entry.name]=entry.reason;if(entry.warnings.length)warnings['column:'+entry.name]=entry.warnings;}
 notes.push('Cross-engine conversion prepares target-dialect SQL; it does not copy source rows or promise identical type enforcement.','Target table storage/options, ownership, triggers and existing sequence counters are retained unless explicitly edited in the resulting draft.','Items requiring semantic review are not selected automatically. Unsupported items need explicit target SQL; no source expression is executed to infer a value.');
 return {model:{...original,columns:columns.map(c=>({name:c.name,definition:c.sql??source.tableStructure!.columns.find(v=>v.name===c.name)!.definition})),objects,indexes:objects.filter(o=>o.kind==='index'&&!mysqlDialect(target.driver)).map(o=>({name:o.name,sql:o.definition})),suffix:existing.suffix,unlogged:existing.unlogged},columns,issues,warnings,notes};
}
