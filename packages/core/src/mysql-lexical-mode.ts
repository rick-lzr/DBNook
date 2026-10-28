import type {ConnectionProfile} from '../../protocol/src/index.js';
import type {MysqlSqlMode} from '../../drivers/mysql/sql.js';
import {sqlTokens} from './sql-editing.js';

export class UnresolvedSqlModeError extends Error {}

export function mysqlModeAfter(sql:string,driver:ConnectionProfile['driver'],mode:MysqlSqlMode):MysqlSqlMode{
  const all=sqlTokens(sql,driver,mode);
  if(all.some(t=>t.kind==='comment'&&/^\/\*(?:!|M!)/i.test(t.text)&&/\bsql_mode\b/i.test(t.text)))throw new UnresolvedSqlModeError('Conditional SQL mode changes require formatting the following SQL as a selection with its actual session mode.');
  const tokens=all.filter(t=>t.kind!=='comment'&&t.text!==';');if(tokens[0]?.text.toUpperCase()!=='SET')return mode;
  let scope='SESSION',start=1;if(['SESSION','LOCAL','GLOBAL','PERSIST','PERSIST_ONLY'].includes(tokens[start]?.text.toUpperCase()??''))scope=tokens[start++]!.text.toUpperCase();
  const groups:typeof tokens[]=[];let group:typeof tokens=[];for(const t of tokens.slice(start)){if(t.text===','&&t.depth===0){groups.push(group);group=[];}else group.push(t);}groups.push(group);let next={...mode};
  for(const assignment of groups){
    const equals=assignment.findIndex(t=>t.text==='='),target=assignment.slice(0,equals).map(t=>t.text).join('').toUpperCase();
    if(equals<0||!['SQL_MODE','@@SQL_MODE','@@SESSION.SQL_MODE','@@LOCAL.SQL_MODE'].includes(target)||['GLOBAL','PERSIST','PERSIST_ONLY'].includes(scope)&&!target.startsWith('@@SESSION.')&&!target.startsWith('@@LOCAL.'))continue;
    const values=assignment.slice(equals+1),value=values[0];if(values.length!==1||value?.kind!=='string'||!['\'', '"'].includes(value.text[0]!))throw new UnresolvedSqlModeError('A dynamic SQL mode change cannot be inferred while formatting. Format the following SQL as a selection in its actual session mode.');
    const q=value.text[0]!,body=value.text.slice(1,-1);let decoded='';
    for(let i=0;i<body.length;i++){const c=body[i]!;if(c===q&&body[i+1]===q){decoded+=q;i++;}else if(c==='\\'&&!mode.noBackslashEscapes&&i+1<body.length){const escaped=body[++i]!;decoded+=({n:'\n',r:'\r',t:'\t','0':'\0',b:'\b',Z:'\x1a'} as Record<string,string>)[escaped]??escaped;}else decoded+=c;}
    const names=decoded.toUpperCase().split(',').map(n=>n.trim());
    if(names.some(n=>['ORACLE','MSSQL','DB2','MAXDB','POSTGRESQL'].includes(n)))throw new UnresolvedSqlModeError('Database emulation modes need their own SQL grammar. Format this script in the corresponding mode-aware editor.');
    next={...next,noBackslashEscapes:names.includes('NO_BACKSLASH_ESCAPES'),ansiQuotes:names.includes('ANSI_QUOTES')||names.includes('ANSI')};
  }
  return next;
}

