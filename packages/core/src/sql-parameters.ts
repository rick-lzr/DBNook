import type {ConnectionProfile} from '../../protocol/src/index.js';
import {SqlParameterValuesSchema,type SqlParameter,type SqlParameterValue} from '../../protocol/src/sql-parameters.js';
import type {MysqlSqlMode} from '../../drivers/mysql/sql.js';
import {currentSql,type SqlSource} from './sql-editing.js';

export interface ParameterOccurrence {start:number;end:number;key:string;mode?:MysqlSqlMode;}
export interface ParameterScan {parameters:SqlParameter[];occurrences:ParameterOccurrence[];deferredAt?:number;}
const number=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** Lexical substitution, never global replacement. Parameter defaults are consumed before SQL quotes. */
export function sqlParameters(sql:string,driver:ConnectionProfile['driver'],mode?:MysqlSqlMode,editing=false):ParameterScan{
 if(sql.length>10_000_000)throw new Error('SQL documents are limited to 10 million characters.');
 const definitions=new Map<string,SqlParameter>(),occurrences:ParameterOccurrence[]=[];let i=0;
 const mysql=driver==='mysql'||driver==='mariadb';
 while(i<sql.length){
  const c=sql[i]!,n=sql[i+1],start=i;
  if(c==='-'&&n==='-'&&(!mysql||/\s/.test(sql[i+2]??' '))||mysql&&c==='#'){while(i<sql.length&&!/[\r\n]/.test(sql[i]!))i++;continue;}
  if(c==='/'&&n==='*'){i+=2;let depth=1;while(i<sql.length&&depth){if(driver==='postgresql'&&sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++;}continue;}
  if(driver==='postgresql'&&c==='$'){
   const tag=/^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i));if(tag){const end=sql.indexOf(tag[0],i+tag[0].length);i=end<0?sql.length:end+tag[0].length;continue;}
  }
  if(c==="'"||c==='"'||c==='`'||driver==='sqlite'&&c==='['){
   const close=c==='['?']':c,escape=mysql&&!mode?.noBackslashEscapes&&c!=='`'||driver==='postgresql'&&c==="'"&&/\b[eE]$/.test(sql.slice(Math.max(0,i-2),i));i++;
   while(i<sql.length){if(escape&&sql[i]==='\\'){i+=2;continue;}if(sql[i]===close){if(sql[i+1]===close){i+=2;continue;}i++;break;}i++;}continue;
  }
  if('&$:%'.includes(c)&&!/[\p{L}\p{N}_$:.\-@&'"`]/u.test(sql[i-1]??' ')){
   const opener=n==='{'||n==='('?n:undefined;
   let body:string|undefined,end=i;
   if(opener){const close=opener==='{'?'}':')',found=sql.indexOf(close,i+2);if(found>=0){body=sql.slice(i+2,found);end=found+1;}else if(/^[A-Za-z_]/.test(sql[i+2]??'')){if(!editing)throw new Error('Unclosed SQL parameter at character '+start+'.');body=sql.slice(i+2);end=sql.length;}}
   else if(c!=='%'){
    const match=/^(?:[A-Za-z_]\w*|\d+)(?:\|\|[^|,\s;)'"`]+)*/.exec(sql.slice(i+1));if(match){body=match[0];end=i+1+body.length;}
   }
   if(body!==undefined){
    const fields=body.split('||'),name=fields[0]!.trim(),positional=c==='$'&&/^[1-9]\d*$/.test(name);
    const boundary=end===sql.length||/[\s,);=+*/<>!\-|]/.test(sql[end]!)||driver==='postgresql'&&sql.startsWith('::',end)||editing&&Boolean(opener);
    if((positional||/^[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*$/.test(name))&&boundary){
     if((fields.length>4||name.length>250)&&!editing)throw new Error('Invalid SQL parameter definition at character '+start+'.');
     let declared=fields[2]?.toLowerCase()||'auto';if(fields[2]&&!['string','number','date','identifier'].includes(declared)){if(!editing)throw new Error('Invalid parameter type for '+c+name+'. Use string, number, date or identifier.');declared='auto';}
     const key=c+name,definition:SqlParameter={key,name,type:declared as SqlParameter['type'],defaultValue:fields[1],options:fields[3],occurrences:1},prior=definitions.get(key);
     if(prior){
      if(fields.length>1){if(prior.defaultValue!==undefined&&(prior.defaultValue!==definition.defaultValue||prior.type!==definition.type||prior.options!==definition.options)&&!editing)throw new Error('Conflicting definitions for SQL parameter '+key+'.');Object.assign(prior,{defaultValue:definition.defaultValue,type:definition.type,options:definition.options});}prior.occurrences++;
     }else definitions.set(key,definition);
     occurrences.push({start,end,key});if(definitions.size>(editing?10000:256)||occurrences.length>10000)throw new Error('SQL parameter limit exceeded.');i=end;continue;
    }
   }
  }
  i++;
 }
 return {parameters:[...definitions.values()],occurrences};
}
export function maskSqlParameters(sql:string,scan:ParameterScan):string{let result='',offset=0;for(const o of scan.occurrences){result+=sql.slice(offset,o.start)+'0'+sql.slice(o.start+1,o.end).replace(/[^\r\n]/g,' ');offset=o.end;}return result+sql.slice(offset);}
export function currentParameterizedSql(sql:string,offset:number,driver:ConnectionProfile['driver'],mode?:MysqlSqlMode):SqlSource|undefined{const scan=sqlParameters(sql,driver,mode),source=currentSql(maskSqlParameters(sql,scan),offset,driver,mode);return source?{...source,sql:sql.slice(source.start,source.end)}:undefined;}
function literal(value:string,driver:ConnectionProfile['driver'],mode?:MysqlSqlMode):string{
 if(value.includes('\0'))throw new Error('SQL parameter values cannot contain NUL.');
 if(driver==='postgresql')return "E'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
 return "'"+(driver!=='sqlite'&&!mode?.noBackslashEscapes?value.replaceAll('\\','\\\\'):value).replaceAll("'","''")+"'";
}
function identifier(value:string,driver:ConnectionProfile['driver']):string{
 if(!value.trim()||value.includes('\0'))throw new Error('Enter a non-empty identifier without NUL.');
 const parts:string[]=[];let i=0;
 while(i<value.length){while(/\s/.test(value[i]??''))i++;let name='',quoted=false;
  if(value[i]==='"'||value[i]==='`'){quoted=true;const q=value[i++]!;let closed=false;while(i<value.length){if(value[i]===q){if(value[i+1]===q){name+=q;i+=2;}else{i++;closed=true;break;}}else name+=value[i++];}if(!closed)throw new Error('Unclosed quoted identifier.');}
  else{const start=i;while(i<value.length&&value[i]!=='.')i++;name=value.slice(start,i).trim();}
  if(!name)throw new Error('Identifier parts cannot be empty.');while(/\s/.test(value[i]??''))i++;
  if(!quoted&&name==='*'){if(i!==value.length)throw new Error('An identifier wildcard must be the last part.');parts.push('*');}
  else{const q=driver==='mysql'||driver==='mariadb'?'`':'"';parts.push(q+name.replaceAll(q,q+q)+q);}
  if(i===value.length)break;if(value[i++]!=='.'||i===value.length)throw new Error('Use an identifier or dot-separated identifier parts.');
  if(parts.length>=8)throw new Error('Identifier has too many parts.');
 }
 return parts.join('.');
}
export function renderSqlParameters(sql:string,scan:ParameterScan,values:SqlParameterValue[],driver:ConnectionProfile['driver'],mode?:MysqlSqlMode):string{
 const parsed=SqlParameterValuesSchema.parse(values),map=new Map(parsed.map(v=>[v.key,v]));if(map.size!==parsed.length||parsed.reduce((n,v)=>n+(v.value?.length??0),0)>2_000_000)throw new Error('Duplicate or oversized SQL parameter values.');
 const rendered=new Map<string,string>();
 const keys=new Set(scan.parameters.map(p=>p.key));if(parsed.some(v=>!keys.has(v.key)))throw new Error('Unexpected SQL parameter value.');
 const renderValue=(key:string,lexicalMode?:MysqlSqlMode)=>{const v=map.get(key);if(!v)throw new Error('Missing SQL parameter '+key+'.');
  let result:string;if(v.value===null){if(v.type==='identifier')throw new Error('Identifiers cannot be NULL.');result='NULL';}
  else if(v.type==='number'||v.type==='auto'&&number.test(v.value)){if(!number.test(v.value))throw new Error('Parameter '+key+' requires a finite SQL number.');result=v.value;}
  else if(v.type==='identifier')result=identifier(v.value,driver);
  else result=literal(v.value,driver,lexicalMode);
  return result;
 };
 for(const p of scan.parameters)renderValue(p.key,mode);
 let result='',offset=0;for(const o of scan.occurrences){const lexicalMode=o.mode??mode,cacheKey=o.key+'|'+(lexicalMode?.noBackslashEscapes?'1':'0');if(!rendered.has(cacheKey))rendered.set(cacheKey,renderValue(o.key,lexicalMode));result+=sql.slice(offset,o.start)+rendered.get(cacheKey);offset=o.end;}result+=sql.slice(offset);if(result.length>10_000_000)throw new Error('Expanded SQL exceeds 10 million characters.');return result;
}
