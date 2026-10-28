import type {DriverSession} from '../../driver-sdk/src/index.js';
import {errorMessage,type QueryRun,type RunStatement} from '../../protocol/src/index.js';
import type {SqlParameterForm,SqlParameterValue} from '../../protocol/src/sql-parameters.js';
import {nextMysqlStatement} from '../../drivers/mysql/sql.js';
import {sqlSources} from './sql-editing.js';
import {sqlParameters,maskSqlParameters,renderSqlParameters,type ParameterScan} from './sql-parameters.js';
import {scriptSqlParameters} from './sql-script-parameters.js';

export type ParameterResolver=(form:SqlParameterForm,session:DriverSession,signal:AbortSignal)=>Promise<SqlParameterValue[]>;
export async function resolveSqlParameters(sql:string,session:DriverSession,signal:AbortSignal,resolve:ParameterResolver,guard:()=>void=()=>{},known?:Map<string,SqlParameterValue>,definitions?:Map<string,ParameterScan['parameters'][number]>,delimiter=';'):Promise<{scan:ParameterScan;values:SqlParameterValue[]}>{
 guard();if(signal.aborted)throw new Error('SQL parameter input cancelled.');const scan=scriptSqlParameters(sql,session.profile.driver,session.sqlMode,false,delimiter);let changed=false;
 for(const p of scan.parameters){const declared=definitions?.get(p.key);if(declared&&p.defaultValue===undefined)Object.assign(p,{type:declared.type,defaultValue:declared.defaultValue,options:declared.options});else if(declared&&p.defaultValue!==undefined){if(declared.defaultValue!==undefined&&(p.type!==declared.type||p.defaultValue!==declared.defaultValue||p.options!==declared.options))throw new Error('Conflicting SQL parameter definitions for '+p.key+'.');if(declared.defaultValue===undefined)changed=true;}definitions?.set(p.key,p);}
 let values=scan.parameters.map(p=>known?.get(p.key)??{key:p.key,type:p.type==='auto'?'string' as const:p.type,value:p.defaultValue??''});
 if(changed||scan.parameters.some(p=>!known?.has(p.key))){values=await resolve({sql,parameters:scan.parameters,values,deferred:scan.deferredAt!==undefined,delimiter},session,signal);guard();if(signal.aborted)throw new Error('SQL parameter input cancelled.');renderSqlParameters(sql,scan,values,session.profile.driver,session.sqlMode);for(const v of values)known?.set(v.key,v);}
 return {scan,values};
}
/** Render each statement using the current physical session's SQL mode, including changes within scripts. */
export async function runParameterizedSql(session:DriverSession,sql:string,limit:number,id:string,signal:AbortSignal,resolve:ParameterResolver,progress:(statement:RunStatement)=>void,singleStatement=false,guard:()=>void=()=>{}):Promise<QueryRun>{
 const started=performance.now(),known=new Map<string,SqlParameterValue>(),definitions=new Map<string,ParameterScan['parameters'][number]>(),statements:RunStatement[]=[];
 const report=(status:QueryRun['status'],error?:string):QueryRun=>({id,sql,status,error,statements,durationMs:performance.now()-started,transaction:session.transactionState});
 const initial=await resolveSqlParameters(sql,session,signal,resolve,guard,known,definitions),driver=session.profile.driver,mysql=driver==='mysql'||driver==='mariadb';
 let masked=maskSqlParameters(sql,initial.scan),offset=0,delimiter=';',mode=JSON.stringify(session.sqlMode),sourceIndex=0,deferredAt=initial.scan.deferredAt;
 const sources=mysql||singleStatement?[]:sqlSources(masked,driver,session.sqlMode);
 while(offset<sql.length){
  guard();if(signal.aborted)return report('cancelled','SQL execution cancelled. Earlier statements may have taken effect.');
  if(mysql&&(mode!==JSON.stringify(session.sqlMode)||deferredAt!==undefined&&offset>=deferredAt)){const remaining=sql.slice(offset),resolved=await resolveSqlParameters(remaining,session,signal,resolve,guard,known,definitions,delimiter);masked=masked.slice(0,offset)+maskSqlParameters(remaining,resolved.scan);mode=JSON.stringify(session.sqlMode);deferredAt=resolved.scan.deferredAt===undefined?undefined:offset+resolved.scan.deferredAt;}
  const source=singleStatement?{start:0,end:sql.length,sql:masked,next:sql.length,delimiter}:mysql?nextMysqlStatement(masked,offset,delimiter,{noBackslashEscapes:false,ansiQuotes:false,...session.sqlMode,mariaDb:driver==='mariadb'}):sources[sourceIndex++];
  if(!source)break;const {start,end}=source,template=sql.slice(start,end),scan=sqlParameters(template,driver,session.sqlMode),keys=new Set(scan.parameters.map(p=>p.key)),actual=renderSqlParameters(template,scan,[...known.values()].filter(v=>keys.has(v.key)),driver,session.sqlMode);
  let cancellation:Promise<boolean>|undefined;const cancel=()=>{cancellation??=session.cancel();void cancellation.catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
   guard();if(signal.aborted)return report('cancelled','SQL execution cancelled before the statement started.');
   const run=await session.run(actual,limit,id,s=>{const mapped={...s,index:statements.length,start,end,sql:template};statements.push(mapped);progress(mapped);},{singleStatement:true});
   if(run.status!=='succeeded')return report(run.status,run.error);
  }catch(error){return report(signal.aborted?'cancelled':'failed',errorMessage(error));}
  finally{signal.removeEventListener('abort',cancel);if(cancellation)await cancellation;}
  if(mysql){const next=source as typeof source&{next:number;delimiter:string};offset=next.next;delimiter=next.delimiter;}else offset=end;
  if(singleStatement)break;
 }
 return signal.aborted?report('cancelled','Cancellation was requested; completed statements may have taken effect. Inspect the session before retrying.'):report('succeeded');
}
