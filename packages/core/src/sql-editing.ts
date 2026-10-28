import type { ConnectionProfile } from '../../protocol/src/index.js';
import { postgresStatements } from '../../drivers/postgresql/sql.js';
import { nextMysqlStatement, type MysqlSqlMode } from '../../drivers/mysql/sql.js';

export interface SqlSource {start:number;end:number;sql:string;}
export interface SqlToken {text:string;start:number;end:number;kind:'word'|'identifier'|'string'|'comment'|'symbol';depth:number;}
/** Lexical context only. Never claims to validate SQL or execute it to find boundaries. */
export function sqlTokens(text:string,driver:ConnectionProfile['driver'],mode?:MysqlSqlMode):SqlToken[]{
  const tokens:SqlToken[]=[];let i=0,depth=0;
  const mysql=driver==='mysql'||driver==='mariadb';
  while(i<text.length){
    const start=i,c=text[i]!,n=text[i+1];if(/\s/.test(c)){i++;continue;}
    let kind:SqlToken['kind']='symbol';
    if(c==='-'&&n==='-'&&(!mysql||/\s/.test(text[i+2]??' '))||mysql&&c==='#'){kind='comment';while(i<text.length&&!/[\r\n]/.test(text[i]!))i++;}
    else if(c==='/'&&n==='*'){kind='comment';i+=2;let level=1;while(i<text.length&&level){if(driver==='postgresql'&&text.startsWith('/*',i)){level++;i+=2;}else if(text.startsWith('*/',i)){level--;i+=2;}else i++;}}
    else if(driver==='postgresql'&&c==='$'&&/^\$(?:[A-Za-z_][\w]*)?\$/.test(text.slice(i))){kind='string';const tag=/^\$(?:[A-Za-z_][\w]*)?\$/.exec(text.slice(i))![0],end=text.indexOf(tag,i+tag.length);i=end<0?text.length:end+tag.length;}
    else if(c==="'"||c==='"'||c==='`'||driver==='sqlite'&&c==='['){
      const close=c==='['?']':c;kind=c==="'"||mysql&&c==='"'&&!mode?.ansiQuotes?'string':'identifier';i++;
      const escapes=mysql&&!mode?.noBackslashEscapes&&c!=='`'||driver==='postgresql'&&c==="'"&&/\b[eE]$/.test(text.slice(Math.max(0,start-2),start));
      while(i<text.length){if(escapes&&text[i]==='\\'){i+=2;continue;}if(text[i]===close){if(text[i+1]===close){i+=2;continue;}i++;break;}i++;}
    }else if(/[\p{L}\p{N}_$]/u.test(c)){kind='word';i++;while(i<text.length&&/[\p{L}\p{N}_$]/u.test(text[i]!))i++;}
    else{i++;if(c===')')depth=Math.max(0,depth-1);}
    tokens.push({text:text.slice(start,i),start,end:i,kind,depth});if(c==='('&&kind==='symbol')depth++;
  }
  return tokens;
}
export function sqlSources(text:string,driver:ConnectionProfile['driver'],mode?:MysqlSqlMode):SqlSource[]{
  if(text.length>10_000_000)throw new Error('SQL documents are limited to 10 million characters.');
  if(driver==='postgresql')return postgresStatements(text);
  if(driver==='mysql'||driver==='mariadb'){
    const result:SqlSource[]=[];let offset=0,delimiter=';';while(offset<text.length){const source=nextMysqlStatement(text,offset,delimiter,{noBackslashEscapes:false,ansiQuotes:false,...mode,mariaDb:driver==='mariadb'});if(!source)break;result.push(source);offset=source.next;delimiter=source.delimiter;}return result;
  }
  const tokens=sqlTokens(text,driver),result:SqlSource[]=[];let first:number|undefined,trigger=false,begins=0,cases=0,head:string[]=[];
  const add=(end:number)=>{if(first!==undefined)result.push({start:first,end,sql:text.slice(first,end)});first=undefined;trigger=false;begins=0;cases=0;head=[];};
  for(const t of tokens){if(t.kind==='comment')continue;if(t.text!==';')first??=t.start;if(t.kind==='string'||t.kind==='identifier')continue;const word=t.text.toUpperCase();
    if(t.kind==='word'){
      if(head.length<4)head.push(word);
      if(head[0]==='CREATE'&&head.includes('TRIGGER'))trigger=true;
      if(trigger){if(word==='BEGIN')begins++;else if(word==='CASE')cases++;else if(word==='END'){if(cases)cases--;else begins=Math.max(0,begins-1);}}
    }
    if(t.text===';'&&!begins)add(t.end);
  }
  add(text.length);return result;
}
export function currentSql(text:string,offset:number,driver:ConnectionProfile['driver'],mode?:MysqlSqlMode):SqlSource|undefined{
  if(!Number.isInteger(offset)||offset<0||offset>text.length)throw new Error('Invalid SQL cursor offset.');
  const sources=sqlSources(text,driver,mode);return sources.find(s=>offset>=s.start&&offset<s.end)??sources.find(s=>offset<s.start)??(offset===text.length?sources.at(-1):undefined);
}
export const sqlIdentifier=(value:string)=>value.startsWith('[')?value.slice(1,-1).replaceAll(']]',']'):value.startsWith('"')||value.startsWith('`')?value.slice(1,-1).replaceAll(value[0]!+value[0]!,value[0]!):value;
