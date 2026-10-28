import type {ConnectionProfile,QueryResult} from '../../protocol/src/index.js';
import {sqlSources,sqlTokens} from './sql-editing.js';
export type StreamConsumer=(batch:QueryResult)=>Promise<void>;
export function exportStatement(sql:string,driver:ConnectionProfile['driver'],mode?:{noBackslashEscapes:boolean;ansiQuotes:boolean;mariaDb?:boolean}):string{
  const sources=sqlSources(sql,driver,mode);if(sources.length!==1)throw new Error('Export one SELECT/WITH/VALUES statement. Select the statement to export.');
  const source=sources[0]!.sql.replace(/;\s*$/,''),all=sqlTokens(source,driver,mode),tokens=all.filter(t=>t.kind!=='comment');
  if(!['SELECT','WITH','VALUES'].includes(tokens[0]?.text.toUpperCase()??'')||tokens.some((t,i)=>t.kind==='word'&&(t.text.toUpperCase()==='INTO'||['INSERT','UPDATE','DELETE','MERGE','REPLACE'].includes(t.text.toUpperCase())&&tokens[i+1]?.text!=='('))||all.some(t=>t.kind==='comment'&&/^\/\*(?:!|[mM]!)/.test(t.text)))throw new Error('Export requires a read query without INTO, data modification or executable comments.');return source;
}
export function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw new Error('Data transfer cancelled.');}
