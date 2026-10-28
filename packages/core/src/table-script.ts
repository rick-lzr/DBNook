import type {ConnectionProfile} from '../../protocol/src/index.js';
import type {TableStructure} from '../../protocol/src/ddl.js';
import {ddlQuote,ddlSegments} from './ddl-syntax.js';
import {sqlTokens,sqlSources,sqlIdentifier,type SqlToken} from './sql-editing.js';

export type TableDriver=ConnectionProfile['driver'];
type Mode=NonNullable<TableStructure['sqlMode']>;
export interface ScriptObject {name:string;kind:'primary'|'unique'|'foreign'|'check'|'exclusion'|'index';definition:string;}
/** MySQL supporting indexes and foreign-key constraints commonly share a name. */
export const scriptObjectKey=(o:Pick<ScriptObject,'name'|'kind'>,d:TableDriver)=>((d==='mysql'||d==='mariadb')?o.kind==='foreign'?'foreign':o.kind==='check'?'check':'index':o.kind==='index'?'index':'constraint')+':'+columnNameKey(o.name,d);
export interface ScriptColumn {name:string;definition:string;}
export interface TableScript {sql:string;createSql:string;prefix:string;suffix:string;name:string;schema?:string;columns:ScriptColumn[];objects:ScriptObject[];indexes:{name:string;sql:string}[];unlogged:boolean;}
const words=(sql:string,d:TableDriver,mode?:Mode)=>sqlTokens(sql,d,mode).filter(t=>t.kind!=='comment');
const upper=(t:SqlToken|undefined)=>t?.kind==='word'?t.text.toUpperCase():'';
/** SQLite only folds ASCII identifier letters; non-ASCII names can be distinct. */
export const tableNameKey=(name:string,d:TableDriver)=>d==='sqlite'?name.replace(/[A-Z]/g,c=>c.toLowerCase()):name;
export const columnNameKey=(name:string,d:TableDriver)=>d==='postgresql'?name:name.replace(/[A-Z]/g,c=>c.toLowerCase());
export function tableIdentifier(tokens:SqlToken[],at:number,d:TableDriver){
  const parts:string[]=[];let i=at;
  while(tokens[i]&&(tokens[i]!.kind==='word'||tokens[i]!.kind==='identifier')){
    const t=tokens[i]!;parts.push(d==='postgresql'&&t.kind==='word'?t.text.toLowerCase():sqlIdentifier(t.text));i++;
    if(tokens[i]?.text!=='.')break;i++;
  }
  if(!parts.length||parts.length>2||tokens[i-1]?.text==='.')throw new Error('Expected an SQL object name.');
  return {parts,end:i};
}
const executable=(t:SqlToken,d:TableDriver)=>t.kind==='comment'&&(d==='mysql'||d==='mariadb')&&(/^\/\*!/.test(t.text)||d==='mariadb'&&/^\/\*[mM]!/.test(t.text));
const safeAttribute=(t:SqlToken)=>t.depth===1&&/^\/\*(?:!|[mM]!)\d{5,6}\s+(?:INVISIBLE|VISIBLE|NOT\s+ENFORCED|ENFORCED)\s*\*\/$/i.test(t.text);
export function ddlCanonical(sql:string,d:TableDriver,mode?:Mode){return JSON.stringify(sqlTokens(sql,d,mode).filter(t=>t.kind!=='comment'||executable(t,d)).map(t=>executable(t,d)?['exec-comment',t.text.replace(/\s+/g,' ').toUpperCase()]:t.kind==='word'?['word',t.text.toUpperCase()]:t.kind==='identifier'?['id',tableNameKey(sqlIdentifier(t.text),d)]:[t.kind,t.text]));}
function sameTarget(parts:string[],s:Pick<TableStructure,'label'|'schema'>,d:TableDriver){
  const expected=s.schema?[s.schema,s.label]:[s.label],actual=parts.length===1&&s.schema&&d!=='postgresql'?[s.schema,...parts]:parts;
  return JSON.stringify(actual.map(n=>tableNameKey(n,d)))===JSON.stringify(expected.map(n=>tableNameKey(n,d)));
}
/** CREATE options must not become unrelated ALTER actions when emitted in a migration. */
function mysqlOptions(tokens:SqlToken[],start:number,index=false){
 const tableOptions=new Set(['ENGINE','AUTO_INCREMENT','AVG_ROW_LENGTH','CHARSET','CHARACTER SET','COLLATE','CHECKSUM','COMMENT','COMPRESSION','CONNECTION','DATA DIRECTORY','INDEX DIRECTORY','DELAY_KEY_WRITE','ENCRYPTION','INSERT_METHOD','KEY_BLOCK_SIZE','MAX_ROWS','MIN_ROWS','PACK_KEYS','PASSWORD','ROW_FORMAT','STATS_AUTO_RECALC','STATS_PERSISTENT','STATS_SAMPLE_PAGES','TABLESPACE','UNION','ENGINE_ATTRIBUTE','SECONDARY_ENGINE_ATTRIBUTE','SECONDARY_ENGINE','AUTOEXTEND_SIZE','PAGE_CHECKSUM','PAGE_COMPRESSED','PAGE_COMPRESSION_LEVEL','TRANSACTIONAL','ENCRYPTED','ENCRYPTION_KEY_ID','IETF_QUOTES']);
 const indexOptions=new Set(['USING','KEY_BLOCK_SIZE','WITH PARSER','COMMENT','ENGINE_ATTRIBUTE','SECONDARY_ENGINE_ATTRIBUTE','ALGORITHM','LOCK']);
 let i=start;
 while(i<tokens.length){
  if(tokens[i]?.text===','){i++;continue;}
  let key=upper(tokens[i]);if(!key)throw new Error('Unsupported CREATE option. Keep ALTER actions in a separate migration.');i++;
  if(index&&['VISIBLE','INVISIBLE'].includes(key))continue;
  if(!index&&key==='DEFAULT'){key=upper(tokens[i]);i++;if(!['CHARSET','CHARACTER','COLLATE'].includes(key))throw new Error('Expected a default charset/collation option.');}
  if(key==='CHARACTER'){if(upper(tokens[i])!=='SET')throw new Error('Expected CHARACTER SET.');key+=' SET';i++;}
  if(['DATA','INDEX'].includes(key)&&upper(tokens[i])==='DIRECTORY'){key+=' DIRECTORY';i++;}
  if(index&&key==='WITH'&&upper(tokens[i])==='PARSER'){key+=' PARSER';i++;}
  if(!(index?indexOptions:tableOptions).has(key))throw new Error(`Unsupported CREATE option ${key}. Use a dedicated migration for ALTER actions, partitions or other options.`);
  if(tokens[i]?.text==='=')i++;
  if(key==='UNION'&&tokens[i]?.text==='('){const depth=tokens[i]!.depth;i++;while(i<tokens.length&&!(tokens[i]!.text===')'&&tokens[i]!.depth===depth))i++;if(!tokens[i])throw new Error('Unclosed UNION table option.');i++;}
  else{if(['+','-'].includes(tokens[i]?.text??''))i++;const value=tokens[i];if(!value||!['word','identifier','string'].includes(value.kind))throw new Error(`Missing CREATE option value for ${key}.`);i++;}
  if(key==='TABLESPACE'&&upper(tokens[i])==='STORAGE'){i++;if(!['DISK','MEMORY'].includes(upper(tokens[i])))throw new Error('Expected TABLESPACE STORAGE DISK or MEMORY.');i++;}
 }
}
function tableObject(text:string,d:TableDriver,mode?:Mode,ordinal=0):ScriptObject{
  const ts=words(text,d,mode);let i=0,name='';
  if(upper(ts[i])==='CONSTRAINT'){name=tableIdentifier(ts,i+1,d).parts[0]!;i+=2;}
  const kindWord=upper(ts[i]);let kind:ScriptObject['kind'];
  if(kindWord==='PRIMARY'){kind='primary';name||='PRIMARY';}
  else if(kindWord==='FOREIGN')kind='foreign';
  else if(kindWord==='CHECK')kind='check';
  else if(kindWord==='EXCLUDE')kind='exclusion';
  else if(kindWord==='UNIQUE')kind='unique';
  else if(['KEY','INDEX','FULLTEXT','SPATIAL'].includes(kindWord))kind='index';
  else throw new Error('Unsupported table constraint/index clause: '+text.slice(0,100));
  if(!name&&(d==='mysql'||d==='mariadb')){
    if(kindWord==='UNIQUE'||kindWord==='FULLTEXT'||kindWord==='SPATIAL')i++;
    if(['KEY','INDEX'].includes(upper(ts[i])))i++;
    if(ts[i]?.kind==='identifier'||ts[i]?.kind==='word'&&!['USING','KEY','INDEX','('].includes(upper(ts[i])))name=tableIdentifier(ts,i,d).parts[0]!;
  }
  if(!name&&d==='sqlite')name='@'+ordinal;
  if(!name&&kind!=='primary')throw new Error('Give every table constraint/index an explicit name. Use CONSTRAINT name for PostgreSQL constraints.');
  return {name,kind,definition:text};
}
/** Parse only managed CREATE TABLE plus its CREATE INDEX statements, never arbitrary migration SQL. */
export function parseTableScript(text:string,d:TableDriver,s:Pick<TableStructure,'label'|'schema'>,mode?:Mode):TableScript{
  if(Buffer.byteLength(text)>4*1024*1024)throw new Error('Table SQL exceeds the 4 MiB draft limit.');
  const sources=sqlSources(text,d,mode);if(!sources.length||sources.length>1001)throw new Error('Use one CREATE TABLE and at most 1,000 CREATE INDEX definitions.');
  const sql=sources[0]!.sql.trim().replace(/;\s*$/,''),ts=words(sql,d,mode);let at=1,unlogged=false;
  if(ts.some(t=>t.text===';'&&t.depth===0))throw new Error('Use separate semicolon-delimited CREATE definitions, without compound DELIMITER blocks.');
  if(upper(ts[0])!=='CREATE')throw new Error('The table draft must start with CREATE TABLE.');
  if(d==='postgresql'&&upper(ts[at])==='UNLOGGED'){unlogged=true;at++;}
  if(upper(ts[at])!=='TABLE')throw new Error('Use CREATE TABLE for the opened ordinary table. Temporary/virtual tables need their own workflow.');at++;
  if(ts.slice(at,at+3).map(upper).join(' ')==='IF NOT EXISTS')at+=3;
  const target=tableIdentifier(ts,at,d);if(!sameTarget(target.parts,s,d))throw new Error('The CREATE TABLE targets a different object. Keep its name/schema; use Rename Table separately.');
  if(ts[target.end]?.text!=='(')throw new Error('An explicit column list is required; CREATE TABLE AS/LIKE is not a definition draft.');
  // Inspect comments separately: the lexical stream above deliberately omits them.
  if(sqlTokens(sql,d,mode).some(t=>executable(t,d)&&!safeAttribute(t)))throw new Error('Executable comments cannot be used in managed table definitions, except known visibility/enforcement attributes.');
  const parsed=ddlSegments(sql,d,mode),columns=parsed.segments.filter(p=>p.column!==undefined).map(p=>({name:d==='postgresql'&&p.tokens[0]?.kind==='word'?p.column!.toLowerCase():p.column!,definition:p.text}));
  if(d==='mysql'||d==='mariadb')mysqlOptions(words(parsed.suffix,d,mode),1);
  if(!columns.length||columns.length>4096)throw new Error('A definition requires 1–4,096 columns.');
  if(columns.some(c=>!c.name||c.name.includes('\0'))||new Set(columns.map(c=>columnNameKey(c.name,d))).size!==columns.length)throw new Error('Column names must be nonempty and unique.');
  for(const column of columns)ddlQuote(column.name,d);
  if(parsed.segments.some(p=>p.tokens[0]?.kind==='word'&&['LIKE','PERIOD'].includes(upper(p.tokens[0]))))throw new Error('LIKE and system-versioned PERIOD clauses need a dedicated migration.');
  const objects=parsed.segments.filter(p=>p.column===undefined).map((p,i)=>tableObject(p.text,d,mode,i));
  const indexes:TableScript['indexes']=[];
  for(const source of sources.slice(1)){
    const statement=source.sql.trim().replace(/;\s*$/,''),tokens=words(statement,d,mode);let i=1;if(upper(tokens[i])==='UNIQUE')i++;
    if(tokens.some(t=>t.text===';'&&t.depth===0))throw new Error('Only one CREATE INDEX statement is allowed per SQL source.');
    if(upper(tokens[0])!=='CREATE'||upper(tokens[i])!=='INDEX')throw new Error('Only CREATE INDEX statements may follow CREATE TABLE. Triggers are retained separately.');i++;
    const index=tableIdentifier(tokens,i,d);if(index.parts.length===2&&index.parts[0]!==s.schema)throw new Error('Index schema does not match the opened table.');i=index.end;
    if(upper(tokens[i])!=='ON')throw new Error('Use a normal CREATE INDEX without CONCURRENTLY/IF NOT EXISTS.');i++;
    if(d==='postgresql'&&upper(tokens[i])==='ONLY')i++;
    const owner=tableIdentifier(tokens,i,d);if(!sameTarget(owner.parts,s,d))throw new Error('An index targets another table.');
    if(d==='mysql'||d==='mariadb'){if(tokens[owner.end]?.text!=='(')throw new Error('CREATE INDEX requires an explicit column/expression list.');const close=tokens.findIndex((t,j)=>j>owner.end&&t.text===')'&&t.depth===0);if(close<0)throw new Error('Unclosed index definition.');mysqlOptions(tokens,close+1,true);}
    if(sqlTokens(statement,d,mode).some(t=>executable(t,d)&&!safeAttribute(t)))throw new Error('Executable comments cannot be used in managed indexes.');
    const name=index.parts.at(-1)!;indexes.push({name,sql:statement});
    objects.push({name,kind:'index',definition:statement});
  }
  if(new Set(objects.map(o=>scriptObjectKey(o,d))).size!==objects.length)throw new Error('Constraint/index names must be unique within their database namespace.');
  for(const object of objects)ddlQuote(object.name,d);
  return {sql:text,createSql:sql,prefix:sql.slice(0,ts[target.end]!.end),suffix:parsed.suffix,name:s.label,schema:s.schema,columns,objects,indexes,unlogged};
}
export function renameScriptTable(sql:string,d:TableDriver,name:string,mode?:Mode){
  const ts=words(sql,d,mode),at=ts.findIndex(t=>upper(t)==='TABLE');if(at<0)throw new Error('CREATE TABLE is missing.');let start=at+1;if(ts.slice(start,start+3).map(upper).join(' ')==='IF NOT EXISTS')start+=3;const old=tableIdentifier(ts,start,d);
  return sql.slice(0,ts[start]!.start)+ddlQuote(name,d)+sql.slice(ts[old.end-1]!.end);
}
export function renameScriptIndexTable(sql:string,d:TableDriver,name:string,mode?:Mode){const ts=words(sql,d,mode),on=ts.findIndex(t=>upper(t)==='ON');let at=on+1;if(upper(ts[at])==='ONLY')at++;const old=tableIdentifier(ts,at,d);return sql.slice(0,ts[at]!.start)+ddlQuote(name,d)+sql.slice(ts[old.end-1]!.end);}
export function tableDefinitionText(s:TableStructure,d:TableDriver){let definition=s.definition;if((d==='mysql'||d==='mariadb')&&s.schema){const ts=words(definition,d,s.sqlMode),table=ts.findIndex(t=>upper(t)==='TABLE');if(table>=0){let start=table+1;if(ts.slice(start,start+3).map(upper).join(' ')==='IF NOT EXISTS')start+=3;const original=tableIdentifier(ts,start,d);definition=definition.slice(0,ts[start]!.start)+ddlQuote(s.schema,d)+'.'+ddlQuote(s.label,d)+definition.slice(ts[original.end-1]!.end);}}return definition.trim().replace(/;?\s*$/,';')+'\n'+(d==='sqlite'?s.auxiliary.filter(a=>a.type==='index').map(a=>a.sql.trim().replace(/;?\s*$/,';')).join('\n'):'');}
