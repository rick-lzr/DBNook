import type {DefinitionSnapshot} from '../../protocol/src/definitions.js';
import type {TableStructure} from '../../protocol/src/ddl.js';
import {sqlTokens,type SqlToken} from './sql-editing.js';
import {ddlQuote} from './ddl-syntax.js';

export type DdlDialect=DefinitionSnapshot['driver'];
type Column=TableStructure['columns'][number];
export type PortableType={kind:'integer';bits:number;unsigned:boolean}|{kind:'decimal';precision?:number;scale?:number}|{kind:'float';bits:32|64}|{kind:'text';length?:number;fixed?:boolean}|{kind:'binary';length?:number;fixed?:boolean}|{kind:'boolean'}|{kind:'json'|'uuid'}|{kind:'date'|'time'|'timestamp';precision?:number;zone?:boolean};
export type PortableDefault={kind:'none'|'null'}|{kind:'number'|'string'|'binary';value:string}|{kind:'boolean';value:boolean}|{kind:'clock';value:'CURRENT_TIMESTAMP'|'CURRENT_DATE'|'CURRENT_TIME';precision?:number};
export interface PortableColumn {name:string;type:PortableType;nullable:boolean;value:PortableDefault;identity:'none'|'always'|'byDefault';warnings:string[];}
export const mysqlDialect=(d:DdlDialect)=>d==='mysql'||d==='mariadb';
const word=(t:SqlToken|undefined)=>t?.kind==='word'?t.text.toUpperCase():'';
const typeName=(v:string)=>v.trim().toLowerCase().replace(/\s+/g,' ');
export function portableType(raw:string,driver:DdlDialect):PortableType{
 const text=typeName(raw),base=text.replace(/\([^)]*\)/g,'').replace(/\b(?:unsigned|signed|zerofill)\b/g,'').replace(/\s+/g,' ').trim(),args=/\(([^)]*)\)/.exec(text)?.[1]?.split(',').map(n=>Number(n.trim()));
 if(args?.some(n=>!Number.isInteger(n)))throw new Error('The type parameters need an explicit target type.');
 if(/^(?:tinyint|int1|smallint|int2|mediumint|int|integer|int4|bigint|int8)$/.test(base)){
  const bits=driver==='sqlite'?64:/^(?:tinyint|int1)$/.test(base)?8:/^(?:smallint|int2)$/.test(base)?16:base==='mediumint'?24:/^(?:bigint|int8)$/.test(base)?64:32;
  return {kind:'integer',bits,unsigned:driver!=='sqlite'&&/\b(?:unsigned|zerofill)\b/.test(text)};
 }
 if(/^(?:numeric|decimal|dec)$/.test(base))return {kind:'decimal',precision:args?.[0],scale:args?.[1]??(args?.length?0:undefined)};
 if(/^(?:real|float|float4|float8|double|double precision)$/.test(base))return {kind:'float',bits:driver==='sqlite'||/double|float8/.test(base)||base==='float'&&driver==='postgresql'?64:32};
 if(/^(?:bool|boolean)$/.test(base))return {kind:'boolean'};
 if(/^(?:text|tinytext|mediumtext|longtext|varchar|character varying|char|character|clob)$/.test(base))return {kind:'text',length:/^(?:varchar|character varying|char|character)$/.test(base)?args?.[0]:undefined,fixed:/^(?:char|character)$/.test(base)};
 if(/^(?:bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)$/.test(base)||driver==='sqlite'&&!base)return {kind:'binary',length:/^(?:binary|varbinary)$/.test(base)?args?.[0]:undefined,fixed:base==='binary'};
 if(base==='json'||base==='jsonb')return {kind:'json'};if(base==='uuid')return {kind:'uuid'};
 if(base==='date')return {kind:'date'};
 if(/^(?:time|time without time zone|time with time zone)$/.test(base))return {kind:'time',precision:args?.[0],zone:base==='time with time zone'};
 if(/^(?:datetime|timestamp|timestamp without time zone|timestamp with time zone|timestamptz)$/.test(base))return {kind:'timestamp',precision:args?.[0],zone:base==='timestamp with time zone'||base==='timestamptz'};
 throw new Error(`Type ${raw||'(untyped)'} needs an explicit target column definition.`);
}

export function sqlStringValue(token:string,driver:DdlDialect,noBackslashEscapes=false,pgEscape=false):string{
 if(driver==='postgresql'&&token.startsWith('$')){const tag=/^\$(?:[A-Za-z_][\w]*)?\$/.exec(token)?.[0];if(!tag||!token.endsWith(tag))throw new Error('Unclosed PostgreSQL dollar string.');return token.slice(tag.length,-tag.length);}
 const quote=token[0]!;let value=token.slice(1,-1).replaceAll(quote+quote,quote);
 if(mysqlDialect(driver)&&!noBackslashEscapes)value=value.replace(/\\([\s\S])/g,(_m,c:string)=>({0:'\0',b:'\b',n:'\n',r:'\r',t:'\t',Z:'\x1a','%':'\\%','_':'\\_'}[c]??c));
 if(driver==='postgresql'&&pgEscape)value=value.replace(/\\(?:([0-7]{1,3})|x([a-f\d]{1,2})|u([a-f\d]{4})|U([a-f\d]{8})|([\s\S]))/gi,(_m,oct:string|undefined,hex:string|undefined,u:string|undefined,U:string|undefined,c:string|undefined)=>oct?String.fromCodePoint(parseInt(oct,8)):hex||u||U?String.fromCodePoint(parseInt((hex??u??U)!,16)):({b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'}[c!]??c!));
 if(value.includes('\0'))throw new Error('A NUL string needs an explicit binary/target expression.');return value;
}
export function targetString(value:string,driver:DdlDialect,mode?:TableStructure['sqlMode']){
 if(value.includes('\0'))throw new Error('A NUL string needs an explicit target expression.');
 if(mysqlDialect(driver)&&!mode?.noBackslashEscapes)value=value.replaceAll('\\','\\\\');
 return "'"+value.replaceAll("'","''")+"'";
}
/** Defaults are converted as values or known clock expressions, never arbitrary source SQL. */
export function portableDefault(input:string|undefined,s:DefinitionSnapshot):PortableDefault{
 if(input===undefined)return {kind:'none'};let text=input.trim(),ts=sqlTokens(text,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment');
 while(ts[0]?.text==='('&&ts.at(-1)?.text===')'&&!ts.slice(1,-1).some(t=>t.depth===0)){text=text.slice(ts[0].end,ts.at(-1)!.start);ts=sqlTokens(text,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment');}
 // A catalog cast of a primitive to a built-in scalar does not change that primitive value.
 const decoded=/^decode\(\s*'([a-f\d]*)'\s*(?:::text)?\s*,\s*'hex'\s*(?:::text)?\s*\)$/i.exec(text);if(decoded){if(decoded[1]!.length%2)throw new Error('Binary defaults require complete bytes.');return {kind:'binary',value:decoded[1]!.toLowerCase()};}
 const cast=ts.findIndex((t,i)=>t.depth===0&&t.text===':'&&ts[i+1]?.text===':');
 if(cast>=0){const tail=text.slice(ts[cast+1]!.end).trim();if(!/^(?:pg_catalog\.)?(?:text|character varying(?:\(\d+\))?|character(?:\(\d+\))?|varchar(?:\(\d+\))?|char(?:\(\d+\))?|smallint|integer|bigint|numeric(?:\(\d+(?:,\s*-?\d+)?\))?|real|double precision|boolean|date|time(?:stamp)?(?:\(\d+\))?(?: with(?:out)? time zone)?|uuid|bytea|jsonb?)$/i.test(tail))throw new Error('A source-specific default cast needs a target expression.');text=text.slice(0,ts[cast]!.start).trim();ts=sqlTokens(text,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment');}
 if(/^NULL$/i.test(text))return {kind:'null'};if(/^(?:TRUE|FALSE)$/i.test(text))return {kind:'boolean',value:text.toUpperCase()==='TRUE'};
 if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))return {kind:'number',value:text};
 const clock=/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW)(?:\((\d*)\))?$/i.exec(text);if(clock){const p=clock[2]?Number(clock[2]):undefined;if(p!==undefined&&(p<0||p>6))throw new Error('Clock precision needs an explicit target expression.');return {kind:'clock',value:clock[1]!.toUpperCase()==='NOW'?'CURRENT_TIMESTAMP':clock[1]!.toUpperCase() as 'CURRENT_TIMESTAMP',precision:p};}
 const binary=/^(?:x'([a-f\d]*)'|0x([a-f\d]+))$/i.exec(text);if(binary){const value=binary[1]??binary[2]!;if(value.length%2)throw new Error('Use a complete byte sequence for the binary default.');return {kind:'binary',value:value.toLowerCase()};}
 let token=ts[0],escape=false;
 if(s.driver==='postgresql'&&word(token)==='E'&&ts[1]?.kind==='string'){escape=true;token=ts[1];ts=ts.slice(1);}
 if(mysqlDialect(s.driver)&&/^_(?:utf8mb4|utf8|utf8mb3|ascii|latin1|binary)$/i.test(token?.text??'')&&ts[1]?.kind==='string'){token=ts[1];ts=ts.slice(1);}
 if(ts.length===1&&(token?.kind==='string'||s.driver==='sqlite'&&token?.kind==='identifier'&&token.text.startsWith('"'))){const value=sqlStringValue(token.text,s.driver,s.tableStructure?.sqlMode?.noBackslashEscapes,escape);if(cast>=0&&/::\s*(?:pg_catalog\.)?bytea\s*$/i.test(input)&&/^\\x[a-f\d]*$/i.test(value))return {kind:'binary',value:value.slice(2)};return {kind:'string',value};}
 throw new Error('This default expression needs an explicit target column definition.');
}
const attributeWords=new Set(['DEFAULT','NOT','NULL','PRIMARY','UNIQUE','CHECK','REFERENCES','CONSTRAINT','GENERATED','AS','AUTO_INCREMENT','AUTOINCREMENT','COLLATE','CHARACTER','CHARSET','COMMENT','ON','INVISIBLE','VISIBLE','COLUMN_FORMAT','STORAGE','SRID']);
export function hasEngineColumnAttributes(definition:string,s:DefinitionSnapshot){const ts=sqlTokens(definition,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment'),reference=ts.findIndex((t,i)=>i>0&&t.depth===0&&word(t)==='REFERENCES');return ts.some((t,i)=>i>0&&t.depth===0&&(['COLLATE','CHARSET','INVISIBLE','VISIBLE','COLUMN_FORMAT','STORAGE','SRID'].includes(word(t))||word(t)==='CHARACTER'&&word(ts[i+1])==='SET'||word(t)==='ON'&&word(ts[i+1])==='UPDATE'&&(reference<0||i<reference)));}
export function columnDefaultText(definition:string,s:DefinitionSnapshot){const ts=sqlTokens(definition,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment'),at=ts.findIndex((t,i)=>t.depth===0&&word(t)==='DEFAULT'&&word(ts[i-1])!=='BY');if(at<0)return undefined;let end=definition.length;for(let i=at+1;i<ts.length;i++)if(ts[i]!.depth===0&&ts[i]!.kind==='word'&&attributeWords.has(word(ts[i]))&&!(i===at+1&&word(ts[i])==='NULL')&&(!['CHARACTER','CHARSET'].includes(word(ts[i]))||mysqlDialect(s.driver)&&word(ts[i+1])==='SET')){end=ts[i]!.start;break;}return definition.slice(ts[at]!.end,end).trim();}
export function portableColumn(c:Column,s:DefinitionSnapshot):PortableColumn{
 const ts=sqlTokens(c.definition,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment'),words=ts.slice(1).filter(t=>t.depth===0&&t.kind==='word').map(t=>t.text.toUpperCase()),warnings:string[]=[];
 const raw=sqlTokens(s.rawSql,s.driver),withoutRowid=raw.some((t,i)=>t.depth===0&&word(t)==='WITHOUT'&&word(raw[i+1])==='ROWID'),descendingInline=words.some((w,i)=>w==='PRIMARY'&&words[i+1]==='KEY'&&words[i+2]==='DESC');
 const has=(phrase:string)=>words.some((_w,i)=>words.slice(i,i+phrase.split(' ').length).join(' ')===phrase);
 const identity=words.includes('AUTO_INCREMENT')||words.includes('AUTOINCREMENT')||s.driver==='sqlite'&&c.primaryKey>0&&s.tableStructure!.columns.filter(c=>c.primaryKey>0).length===1&&/^INTEGER$/i.test(c.dataType)&&!withoutRowid&&!descendingInline?'byDefault':has('GENERATED ALWAYS AS IDENTITY')?'always':has('GENERATED BY DEFAULT AS IDENTITY')?'byDefault':'none';
 if(c.generated&&identity==='none')throw new Error('Generated expressions need an explicit target definition.');
 if(hasEngineColumnAttributes(c.definition,s))throw new Error('Collation, charset, ON UPDATE, visibility or storage attributes need an explicit target definition.');
 if(sqlTokens(c.definition,s.driver,s.tableStructure?.sqlMode).some(t=>t.kind==='comment'&&/^\/\*(?:!|[mM]!)/.test(t.text)))throw new Error('Executable version attributes need an explicit target definition.');
 if(words.includes('COMMENT'))warnings.push('The source column comment is not copied by the portable column conversion.');
 if(/\bZEROFILL\b/i.test(c.dataType))warnings.push('ZEROFILL display padding is not portable.');
 if(s.driver==='sqlite')warnings.push('SQLite affinity and dynamic values differ from server type enforcement; source rows are not being copied.');
 if(s.driver==='sqlite'&&c.primaryKey&&c.nullable&&identity==='none')warnings.push('A server primary key rejects NULL even where a SQLite primary-key declaration permits it.');
 const type=portableType(c.dataType,s.driver);if(type.kind!=='integer'&&/\b(?:UNSIGNED|ZEROFILL)\b/i.test(c.dataType))warnings.push('Unsigned/nonnegative validation needs explicit target rules for this numeric type.');let value=identity==='none'?portableDefault(columnDefaultText(c.definition,s),s):{kind:'none'} as PortableDefault;
 if(type.kind==='boolean'&&value.kind==='string'&&['true','false'].includes(value.value.toLowerCase()))value={kind:'boolean',value:value.value.toLowerCase()==='true'};
 return {name:c.name,type,nullable:c.primaryKey?false:c.nullable,value,identity,warnings};
}

export function renderPortableColumn(column:PortableColumn,target:DefinitionSnapshot):{sql:string;warnings:string[]}{
 const d=target.driver,t=column.type,warnings=[...column.warnings],mysql=mysqlDialect(d),q=ddlQuote(column.name,d);let type:string;
 switch(t.kind){
  case 'integer':if(d==='sqlite'){type=t.unsigned&&t.bits===64?'TEXT':'INTEGER';if(type==='TEXT')warnings.push('Unsigned 64-bit integers use TEXT to preserve digits; numeric operations and ordering change.');else warnings.push('SQLite does not enforce the source integer bit range.');}
   else if(mysql)type=(t.bits<=8?'TINYINT':t.bits<=16?'SMALLINT':t.bits<=24?'MEDIUMINT':t.bits<=32?'INT':'BIGINT')+(t.unsigned?' UNSIGNED':'');
   else{type=t.unsigned&&t.bits===64?'numeric(20,0)':t.bits+(t.unsigned?1:0)<=16?'smallint':t.bits+(t.unsigned?1:0)<=32?'integer':'bigint';if(t.unsigned||t.bits===8||t.bits===24)warnings.push('The target integer type widens the source range; source range/unsigned validation needs an explicit CHECK if required.');}break;
  case 'decimal':if(d==='sqlite'){type='TEXT';warnings.push('Exact decimal values use TEXT; arithmetic, ordering and scale enforcement need explicit target rules.');}
   else{if(mysql&&(t.precision===undefined||t.scale===undefined||t.precision>65||t.scale<0||t.scale>30||t.scale>t.precision))throw new Error('MySQL/MariaDB decimal precision/scale must be explicitly chosen within target limits.');type=(mysql?'DECIMAL':'numeric')+(t.precision!==undefined?'('+t.precision+','+(t.scale??0)+')':'');}break;
  case 'float':type=d==='sqlite'?'REAL':mysql?t.bits===32?'FLOAT':'DOUBLE':t.bits===32?'real':'double precision';if(d==='sqlite'&&t.bits===32)warnings.push('SQLite REAL widens a 32-bit floating-point value to 64 bits.');break;
  case 'text':if(t.length!==undefined&&(t.length<1||mysql&&t.length>(t.fixed?255:16383)))throw new Error('Choose a target string length/type explicitly for this character width.');type=d==='sqlite'?'TEXT':mysql?t.length!==undefined?(t.fixed?'CHAR':'VARCHAR')+'('+t.length+')':'LONGTEXT':t.length!==undefined?(t.fixed?'character':'character varying')+'('+t.length+')':'text';warnings.push('Text comparison uses the target charset/collation. Source collation and padding behavior are not asserted equal.');if(d==='sqlite'&&t.length)warnings.push('SQLite TEXT does not enforce the source character length.');break;
  case 'binary':type=d==='sqlite'?'BLOB':mysql?t.length!==undefined?(t.fixed?'BINARY':'VARBINARY')+'('+t.length+')':'LONGBLOB':'bytea';warnings.push('Binary capacity and limits differ between target engines.');if(!mysql&&t.length)warnings.push('The target binary type does not enforce source length/padding.');break;
  case 'boolean':type=d==='sqlite'?'INTEGER':mysql?'BOOLEAN':'boolean';if(d!=='postgresql')warnings.push('The target Boolean storage accepts values beyond true/false unless a CHECK is explicitly added.');break;
  case 'uuid':type=d==='postgresql'?'uuid':mysql?'CHAR(36)':'TEXT';if(d!=='postgresql')warnings.push('UUID validation is not enforced by the target character type.');break;
  case 'json':if(d==='mariadb')throw new Error('Choose an explicit MariaDB JSON column definition, charset and validation policy.');type=d==='postgresql'?'jsonb':mysql?'JSON':'TEXT';warnings.push('JSON representation, duplicate-key behavior and validation differ across engines.');break;
  case 'date':type=d==='sqlite'?'TEXT':mysql?'DATE':'date';warnings.push('Date validation and accepted ranges differ between engines.');break;
  case 'time':if(t.zone&&mysql)throw new Error('MySQL/MariaDB TIME cannot preserve time-with-time-zone semantics.');type=d==='sqlite'?'TEXT':mysql?'TIME'+(t.precision!==undefined?'('+t.precision+')':''):'time'+(t.precision!==undefined?'('+t.precision+')':'')+(t.zone?' with time zone':' without time zone');warnings.push('Time ranges, timezone and text representation require review.');break;
  case 'timestamp':if(t.zone&&mysql)throw new Error('Choose a target timestamp/timezone storage policy explicitly.');type=d==='sqlite'?'TEXT':mysql?'DATETIME'+(t.precision!==undefined?'('+t.precision+')':''):'timestamp'+(t.precision!==undefined?'('+t.precision+')':'')+(t.zone?' with time zone':' without time zone');warnings.push('Timestamp validation, timezone and precision require review.');break;
 }
 let generation='';if(column.identity!=='none'){
  if(t.kind!=='integer'||t.unsigned&&t.bits===64)throw new Error('The identity column needs an explicit target signed integer definition.');
  if(d==='sqlite'){type='INTEGER';generation=' PRIMARY KEY AUTOINCREMENT';}
  else if(mysql)generation=' AUTO_INCREMENT';else generation=' GENERATED '+(column.identity==='always'?'ALWAYS':'BY DEFAULT')+' AS IDENTITY';
  warnings.push('Identity uses target-owned state, not the source sequence/counter. Explicit-value policy and allocation behavior may differ.');
 }
 let value='';const v=column.value;
 if(v.kind==='null')value='NULL';else if(v.kind==='number')value=d==='sqlite'&&type==='TEXT'?targetString(v.value,d):v.value;
 else if(v.kind==='string')value=targetString(v.value,d,target.tableStructure?.sqlMode);else if(v.kind==='boolean')value=d==='postgresql'?String(v.value).toUpperCase():v.value?'1':'0';
 else if(v.kind==='binary')value=d==='postgresql'?"decode('"+v.value+"','hex')":"X'"+v.value+"'";
 else if(v.kind==='clock'){value=v.value+(v.precision!==undefined&&d!=='sqlite'?'('+v.precision+')':'');warnings.push('Clock defaults use target session timezone and engine precision.');}
 if(value&&mysql&&(/^(?:LONGTEXT|LONGBLOB|JSON)$/.test(type)||v.kind==='clock'&&v.value!=='CURRENT_TIMESTAMP'))value='('+value+')';
 return {sql:q+' '+type+generation+(column.nullable?'':' NOT NULL')+(value?' DEFAULT '+value:''),warnings:[...new Set(warnings)]};
}
