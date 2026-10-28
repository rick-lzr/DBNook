import type {ConnectionProfile,SqlParameter} from '../../protocol/src/index.js';
import {nextMysqlStatement,type MysqlSqlMode} from '../../drivers/mysql/sql.js';
import {sqlTokens} from './sql-editing.js';
import {mysqlModeAfter,UnresolvedSqlModeError} from './mysql-lexical-mode.js';
import {sqlParameters,maskSqlParameters,type ParameterScan} from './sql-parameters.js';

/** Discover known lexical contexts without executing SET or guessing dynamic session values. */
export function scriptSqlParameters(sql:string,driver:ConnectionProfile['driver'],initial?:MysqlSqlMode,editing=false,initialDelimiter=';'):ParameterScan{
 if(driver!=='mysql'&&driver!=='mariadb'||initialDelimiter===';'&&!/\bsql_mode\b|\bDELIMITER\b/i.test(sql))return sqlParameters(sql,driver,initial,editing);
 const result:ParameterScan={parameters:[],occurrences:[]},definitions=new Map<string,SqlParameter>();let mode:MysqlSqlMode={noBackslashEscapes:false,ansiQuotes:false,...initial,mariaDb:driver==='mariadb'},offset=0,mask='',modeKey='',delimiter=initialDelimiter;
 while(offset<sql.length){
  if(!mask||modeKey!==JSON.stringify(mode)){const remaining=sql.slice(offset);mask=mask.slice(0,offset)+maskSqlParameters(remaining,sqlParameters(remaining,driver,mode,true));modeKey=JSON.stringify(mode);}
  const source=nextMysqlStatement(mask,offset,delimiter,mode);if(!source)break;
  const statement=sql.slice(source.start,source.end),scan=sqlParameters(statement,driver,mode,editing);
  for(const parameter of scan.parameters){
   const prior=definitions.get(parameter.key);if(prior){if(parameter.defaultValue!==undefined){if(prior.defaultValue!==undefined&&(prior.defaultValue!==parameter.defaultValue||prior.type!==parameter.type||prior.options!==parameter.options)&&!editing)throw new Error('Conflicting definitions for SQL parameter '+parameter.key+'.');Object.assign(prior,{defaultValue:parameter.defaultValue,type:parameter.type,options:parameter.options});}prior.occurrences+=parameter.occurrences;}
   else{definitions.set(parameter.key,parameter);result.parameters.push(parameter);}
  }
  for(const o of scan.occurrences)result.occurrences.push({...o,start:source.start+o.start,end:source.start+o.end,mode:{...mode}});
  if(result.parameters.length>(editing?10000:256)||result.occurrences.length>10000)throw new Error('SQL parameter limit exceeded.');
  offset=source.next;delimiter=source.delimiter;
  if(/\bsql_mode\b/i.test(statement)&&sqlTokens(mask.slice(offset),driver,mode).some(t=>t.kind!=='comment'&&t.text!==';'))try{mode=mysqlModeAfter(statement,driver,mode);}catch(error){if(!(error instanceof UnresolvedSqlModeError))throw error;result.deferredAt=offset;break;}
 }
 return result;
}
