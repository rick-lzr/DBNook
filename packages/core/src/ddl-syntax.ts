import {sqlIdentifier,sqlTokens,type SqlToken} from './sql-editing.js';
import type {ConnectionProfile} from '../../protocol/src/index.js';
export type DdlDriver=ConnectionProfile['driver'];
type Mode={noBackslashEscapes:boolean;ansiQuotes:boolean;mariaDb?:boolean};
export const ddlQuote=(s:string,d:DdlDriver)=>{if(s.includes('\0')||!s.length)throw new Error('An SQL name cannot be empty or contain NUL.');if(d==='postgresql'&&Buffer.byteLength(s)>63||(d==='mysql'||d==='mariadb')&&[...s].length>64)throw new Error('The identifier exceeds this database name limit.');return d==='mysql'||d==='mariadb'?'`'+s.replaceAll('`','``')+'`':'"'+s.replaceAll('"','""')+'"';};
export const ddlLiteral=(s:string,d:DdlDriver)=>d==='mysql'||d==='mariadb'?`CONVERT(0x${Buffer.from(s).toString('hex')} USING utf8mb4)`:d==='postgresql'?(()=>{let tag='$dbw$';while(s.includes(tag))tag='$'+tag.slice(1,-1)+'x$';return tag+s+tag;})():"'"+s.replaceAll("'","''")+"'";
export function ddlFragment(text:string,driver:DdlDriver,mode?:Mode){
  const tokens=sqlTokens(text,driver,{ansiQuotes:true,noBackslashEscapes:false,...mode});
  if(!tokens.length||tokens.some(t=>t.kind==='comment'||t.text===';'||t.text===','&&t.depth===0)||tokens.filter(t=>t.text==='(').length!==tokens.filter(t=>t.text===')').length)throw new Error('Enter one SQL type or expression without statement separators, comments or top-level commas.');
  return text.trim();
}
/** Split a server-produced CREATE TABLE without reserializing unrelated clauses. */
export function ddlSegments(sql:string,driver:DdlDriver,mode?:Mode){
  const tokens=sqlTokens(sql,driver,{ansiQuotes:true,noBackslashEscapes:false,...mode}),open=tokens.find(t=>t.text==='('),close=tokens.find(t=>t.text===')'&&t.depth===0&&t.start>(open?.start??Infinity));
  if(!open||!close)throw new Error('This CREATE TABLE definition cannot be edited by the structure designer.');
  const cuts=tokens.filter(t=>t.text===','&&t.depth===1&&t.start>open.start&&t.start<close.start);let start=open.end;
  const segments=[...cuts,close].map(t=>{const text=sql.slice(start,t.start).trim();start=t.end;const ts=sqlTokens(text,driver,{ansiQuotes:true,noBackslashEscapes:false,...mode}).filter(t=>t.kind!=='comment');const first=ts[0];const column=first&&(first.kind==='identifier'||!['CONSTRAINT','PRIMARY','UNIQUE','FOREIGN','CHECK','EXCLUDE','KEY','INDEX','FULLTEXT','SPATIAL'].includes(first.text.toUpperCase()))?sqlIdentifier(first.text):undefined;return {text,column,tokens:ts};});
  return {prefix:sql.slice(0,open.end),suffix:sql.slice(close.start),segments};
}
export function alterColumnDefinition(source:string,driver:DdlDriver,change:'type'|'default'|'nullable',value:string|boolean|null,mode?:Mode):string{
  const ts=sqlTokens(source,driver,{ansiQuotes:true,noBackslashEscapes:false,...mode}).filter(t=>t.kind!=='comment');if(!ts[0])throw new Error('Column definition is missing.');
  const word=(t:SqlToken|undefined,w:string)=>t?.kind==='word'&&t.text.toUpperCase()===w;
  const constraint=new Set(['CONSTRAINT','PRIMARY','NOT','UNIQUE','CHECK','DEFAULT','COLLATE','REFERENCES','GENERATED','AS','AUTO_INCREMENT','COMMENT','CHARACTER','INVISIBLE','VISIBLE','ON','SRID','COLUMN_FORMAT','STORAGE']);
  if(change==='type'){
    if(typeof value!=='string')throw new Error('Enter a SQL data type.');ddlFragment(value,driver,mode);
    const end=ts.slice(1).find(t=>t.depth===0&&t.kind==='word'&&constraint.has(t.text.toUpperCase()))?.start??source.length;
    return source.slice(0,ts[0].end)+' '+value.trim()+' '+source.slice(end);
  }
  if(change==='nullable'){
    if(typeof value!=='boolean')throw new Error('Nullable must be true or false.');
    const i=ts.findIndex((t,i)=>t.depth===0&&word(t,'NOT')&&word(ts[i+1],'NULL'));
    if(i<0)return value?source:source+' NOT NULL';if(!value)return source;
    let start=ts[i]!.start,end=ts[i+1]!.end;
    if(word(ts[i-2],'CONSTRAINT'))start=ts[i-2]!.start;
    if(word(ts[i+2],'ON')&&word(ts[i+3],'CONFLICT'))end=ts[i+4]?.end??end;
    return source.slice(0,start)+source.slice(end);
  }
  if(value!==null&&typeof value!=='string')throw new Error('Enter a default SQL expression or choose Drop default.');if(typeof value==='string')ddlFragment(value,driver,mode);
  const i=ts.findIndex((t,i)=>t.depth===0&&word(t,'DEFAULT')&&!word(ts[i-1],'SET'));
  if(i<0)return source+(value===null?'':' DEFAULT '+value);
  let j=i+1;if(['+','-'].includes(ts[j]?.text??''))j++;
  if(!ts[j])throw new Error('Invalid server default definition.');
  const consumeParen=()=>{j++;while(j<ts.length&&!(ts[j]!.text===')'&&ts[j]!.depth===0))j++;if(!ts[j])throw new Error('Unclosed default expression.');j++;};
  if(ts[j]!.text==='(')consumeParen();else{j++;if(ts[j]?.text==='(')consumeParen();else if(ts[j]?.kind==='string'&&/^[bBxXnN]$/.test(ts[j-1]!.text))j++;}
  let start=ts[i]!.start;const end=ts[j-1]!.end;if(value===null&&word(ts[i-2],'CONSTRAINT'))start=ts[i-2]!.start;
  return source.slice(0,start)+(value===null?'':'DEFAULT '+value)+source.slice(end);
}
