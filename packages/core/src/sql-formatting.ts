import { z } from 'zod';
import { format } from 'sql-formatter';
import type { ConnectionProfile } from '../../protocol/src/index.js';
import {nextMysqlStatement,type MysqlSqlMode} from '../../drivers/mysql/sql.js';
import {sqlParameters,maskSqlParameters} from './sql-parameters.js';
import {sqlTokens} from './sql-editing.js';
import {mysqlModeAfter} from './mysql-lexical-mode.js';
import {scriptSqlParameters} from './sql-script-parameters.js';
export const SqlFormatSchema=z.object({keywordCase:z.enum(['upper','lower','preserve']).default('upper'),functionCase:z.enum(['upper','lower','preserve']).default('preserve'),dataTypeCase:z.enum(['upper','lower','preserve']).default('preserve'),identifierCase:z.literal('preserve').default('preserve'),tabWidth:z.number().int().min(1).max(16).default(2),useTabs:z.boolean().default(false),indentStyle:z.enum(['standard','tabularLeft','tabularRight']).default('standard'),logicalOperatorNewline:z.enum(['before','after']).default('before'),expressionWidth:z.number().int().min(10).max(500).default(80),linesBetweenQueries:z.number().int().min(1).max(5).default(2),denseOperators:z.boolean().default(false),newlineBeforeSemicolon:z.boolean().default(false)}).strict();
interface FormatContext {parameters?:boolean;mode?:MysqlSqlMode;selection?:{text:string;start:number;end:number};}
function formatStatement(text:string,driver:ConnectionProfile['driver'],options:unknown,eol:string,context:FormatContext):string{
  if(text.length>1_000_000)throw new Error('Formatting is limited to one million characters per request.');
  if(eol!=='\n'&&eol!=='\r\n')throw new Error('Choose LF or CRLF SQL line endings.');
  // DELIMITER is a client directive; reject whole-file formatting without modifying the document.
  const settings=SqlFormatSchema.parse(options),scan=context.parameters===false?{parameters:[],occurrences:[]}:sqlParameters(text,driver,context.mode),masked=maskSqlParameters(text,scan);
  const spans:{start:number;end:number;comment?:boolean;line?:boolean}[]=[...scan.occurrences],tokens=sqlTokens(masked,driver,context.mode);
  for(const [index,token]of tokens.entries()){
    if(token.kind==='comment'){spans.push({start:token.start,end:token.end,comment:true,line:!token.text.startsWith('/*')});continue;}
    if(token.kind!=='string'&&token.kind!=='identifier')continue;
    let start=token.start;const previous=tokens[index-1];
    if(previous?.end===start&&previous.kind==='word'&&/^(?:[ENXB]|_[a-z0-9_]+)$/i.test(previous.text))start=previous.start;
    else if(/\bU&$/i.test(masked.slice(Math.max(0,start-3),start)))start-=2;
    if(driver==='mysql'||driver==='mariadb')while(start>0&&masked[start-1]==='@'&&token.start-start<2)start--;
    spans.push({start,end:token.end});
  }
  spans.sort((a,b)=>a.start-b.start);
  // Markers are absent from the entire source, including strings/comments, and are restored once.
  const reserved=new Set([...text.matchAll(/__dbw[0-9a-z]+/gi)].map(m=>m[0].toLowerCase())),raw=new Map<string,string>(),q=driver==='mysql'||driver==='mariadb'?'`':'"';let sequence=0,protectedSql='',offset=0;
  for(const span of spans){
    if(span.start<offset)throw new Error('SQL protected regions overlap. Formatting did not change the document.');
    let name:string;do{name='__dbw'+(sequence++).toString(36);}while(reserved.has(name));reserved.add(name);
    const marker=span.comment?span.line?'-- '+name:'/*'+name+'*/':q+name+q;
    raw.set(marker,text.slice(span.start,span.end));protectedSql+=text.slice(offset,span.start)+marker;offset=span.end;
  }
  protectedSql+=text.slice(offset);
  if((driver==='mysql'||driver==='mariadb')&&/^\s*DELIMITER\b/im.test(protectedSql))throw new Error('Format the SQL inside DELIMITER directives as a selection; client directives are preserved.');
  const formatted=format(protectedSql,{...settings,language:driver});let normalized='',last=0;
  // Normalize only whitespace between tokens. Literal/comment newlines are user data.
  for(const token of sqlTokens(formatted,driver,context.mode)){normalized+=formatted.slice(last,token.start).replace(/\r?\n/g,eol)+token.text;last=token.end;}
  normalized+=formatted.slice(last).replace(/\r?\n/g,eol);
  const counts=new Map<string,number>(),result=normalized.replace(/"__dbw[0-9a-z]+"|`__dbw[0-9a-z]+`|\/\*__dbw[0-9a-z]+\*\/|-- __dbw[0-9a-z]+/g,marker=>{const value=raw.get(marker);if(value===undefined)return marker;counts.set(marker,(counts.get(marker)??0)+1);return value;});
  if([...raw.keys()].some(marker=>counts.get(marker)!==1))throw new Error('The formatter changed a protected SQL token. The document was kept unchanged.');
  return result;
}

export function formatSql(text:string,driver:ConnectionProfile['driver'],options:unknown={},eol='\n',context:FormatContext={}):string{
  if(text.length>1_000_000)throw new Error('Formatting is limited to one million characters per request.');
  if(eol!=='\n'&&eol!=='\r\n')throw new Error('Choose LF or CRLF SQL line endings.');
  const settings=SqlFormatSchema.parse(options),selection=context.selection;
  if(selection&&context.parameters!==false){
    if(!Number.isInteger(selection.start)||!Number.isInteger(selection.end)||selection.start<0||selection.end<selection.start||selection.end>selection.text.length||selection.text.slice(selection.start,selection.end)!==text)throw new Error('SQL formatting selection changed. Try again.');
    const scan=scriptSqlParameters(selection.text,driver,context.mode,true),occurrences=[...scan.occurrences];if(scan.deferredAt!==undefined)for(const o of sqlParameters(selection.text.slice(scan.deferredAt),driver,context.mode,true).occurrences)occurrences.push({...o,start:o.start+scan.deferredAt,end:o.end+scan.deferredAt});
    if(occurrences.some(o=>selection.start>o.start&&selection.start<o.end||selection.end>o.start&&selection.end<o.end))throw new Error('Select the complete SQL parameter before formatting. Its default value was kept unchanged.');
  }
  if(driver!=='mysql'&&driver!=='mariadb'||!/\bsql_mode\b/i.test(text))return formatStatement(text,driver,settings,eol,context);
  let mode:MysqlSqlMode={noBackslashEscapes:false,ansiQuotes:false,...context.mode,mariaDb:driver==='mariadb'},offset=0,mask='',modeKey='';const result:string[]=[];
  while(offset<text.length){
    if(!mask||modeKey!==JSON.stringify(mode)){const rest=text.slice(offset),scan=context.parameters===false?{parameters:[],occurrences:[]}:sqlParameters(rest,driver,mode,true);mask=mask.slice(0,offset)+maskSqlParameters(rest,scan);modeKey=JSON.stringify(mode);}
    const source=nextMysqlStatement(mask,offset,';',mode),gap=source?mask.slice(offset,source.start):mask.slice(offset);
    if(source&&source.delimiter!==';'||sqlTokens(gap,driver,mode).some(t=>t.kind==='word'&&t.text.toUpperCase()==='DELIMITER'))throw new Error('Format the SQL inside DELIMITER directives as a selection; client directives are preserved.');
    if(!source){const tail=text.slice(offset);if(tail.trim())result.push(formatStatement(tail,driver,settings,eol,{...context,mode}));break;}
    const statement=text.slice(source.start,source.next);result.push(formatStatement(statement,driver,settings,eol,{...context,mode}));offset=source.next;
    if(/\bsql_mode\b/i.test(statement)&&sqlTokens(mask.slice(offset),driver,mode).some(t=>t.kind!=='comment'&&t.text!==';'))mode=mysqlModeAfter(statement,driver,mode);
  }
  return result.join(eol.repeat(settings.linesBetweenQueries));
}

