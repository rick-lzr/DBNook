import {randomUUID} from 'node:crypto';
import type {DefinitionSnapshot,ConnectionProfile} from '../../protocol/src/index.js';
import {sqlSources,sqlTokens,sqlIdentifier,type SqlToken} from './sql-editing.js';
const words=(sql:string,driver:ConnectionProfile['driver'],mode?:DefinitionSnapshot['modeRaw'])=>sqlTokens(sql,driver,{noBackslashEscapes:!!mode?.split(',').includes('NO_BACKSLASH_ESCAPES'),ansiQuotes:!!mode?.split(',').includes('ANSI_QUOTES'),mariaDb:driver==='mariadb'});
export function definitionDocument(sql:string,driver:string,kind:string){
  if((driver==='mysql'||driver==='mariadb')&&['procedure','function','trigger'].includes(kind)){let delimiter='//';while(sql.includes(delimiter))delimiter='//'+randomUUID().replaceAll('-','').slice(0,12);return `DELIMITER ${delimiter}\n${sql.replace(/;\s*$/,'')}\n${delimiter}\nDELIMITER ;\n`;}
  return sql.trim().replace(/;?\s*$/,';')+'\n';
}
function atomicSources(sql:string):string[]{
  const ts=sqlTokens(sql,'postgresql').filter(t=>t.kind!=='comment'),begin=ts.findIndex((t,i)=>t.kind==='word'&&t.text.toUpperCase()==='BEGIN'&&ts[i+1]?.text.toUpperCase()==='ATOMIC');
  if(begin<0)return sqlSources(sql,'postgresql').map(s=>s.sql);
  let blocks=0,cases=0,end=-1;for(let i=begin;i<ts.length;i++){const t=ts[i]!;if(t.kind!=='word'&&t.text!==';')continue;const w=t.text.toUpperCase();if(w==='BEGIN'&&ts[i+1]?.text.toUpperCase()==='ATOMIC')blocks++;else if(w==='CASE')cases++;else if(w==='END'){if(cases)cases--;else if(--blocks===0){end=i;break;}}}
  if(end<0)throw new Error('Unclosed BEGIN ATOMIC definition.');const tail=ts.slice(end+1);if(tail.some(t=>t.text!==';')||tail.length>1)throw new Error('Only one CREATE definition is allowed.');return [sql];
}
function identifier(ts:SqlToken[],at:number,driver:ConnectionProfile['driver']){const parts:string[]=[];let i=at;while(ts[i]&&(ts[i]!.kind==='word'||ts[i]!.kind==='identifier')){const token=ts[i]!;parts.push(driver==='postgresql'&&token.kind==='word'?token.text.toLowerCase():sqlIdentifier(token.text));i++;if(ts[i]?.text!=='.')break;i++;}return {parts,end:i};}
function argumentSignature(ts:SqlToken[],at:number){if(ts[at]?.text!=='(')throw new Error('Routine argument declaration is missing.');const depth=ts[at]!.depth+1,result:string[]=[];let skip=false;for(let i=at+1;i<ts.length;i++){const t=ts[i]!;if(t.text===')'&&t.depth<depth)return result;if(t.depth===depth&&t.text===','){skip=false;result.push(',');continue;}if(t.depth===depth&&(t.text.toUpperCase()==='DEFAULT'||t.text==='=')){skip=true;continue;}if(!skip)result.push(t.kind==='word'?t.text.toLowerCase():t.text);}throw new Error('Unclosed routine argument declaration.');}
/** Top-level target guard only. Definition bodies remain user-authored database code. */
export function validateDefinition(snapshot:DefinitionSnapshot,text:string):string{
  if(Buffer.byteLength(text)>4*1024*1024)throw new Error('Definition exceeds the 4 MiB editor limit.');const driver=snapshot.driver,mode={noBackslashEscapes:snapshot.modeRaw?.split(',').includes('NO_BACKSLASH_ESCAPES')??false,ansiQuotes:snapshot.modeRaw?.split(',').includes('ANSI_QUOTES')??false,mariaDb:driver==='mariadb'};
  const sources=driver==='postgresql'?atomicSources(text):sqlSources(text,driver,mode).map(s=>s.sql);if(sources.length!==1)throw new Error('Only one CREATE definition is allowed. Keep the supplied DELIMITER wrapper for MySQL/MariaDB routines and triggers.');const sql=sources[0]!.trim().replace(/;\s*$/,'');
  const ts=words(sql,driver,snapshot.modeRaw);if(ts.some(t=>t.kind==='comment'&&/^\/\*(?:!|[mM]!)/.test(t.text)))throw new Error('Executable version comments are not allowed in managed definitions.');const tokens=ts.filter(t=>t.kind!=='comment');if(tokens[0]?.text.toUpperCase()!=='CREATE')throw new Error('A managed definition must start with CREATE.');
  const kind=snapshot.ref.kind.toUpperCase(),at=tokens.findIndex(t=>t.kind==='word'&&t.depth===0&&['VIEW','TRIGGER','FUNCTION','PROCEDURE','TABLE','INDEX','DATABASE','SCHEMA','SEQUENCE','TEMP','TEMPORARY','MATERIALIZED'].includes(t.text.toUpperCase()));if(at<1||at>20||tokens[at]!.text.toUpperCase()!==kind)throw new Error(`Expected CREATE ${kind} for the opened object.`);
  let nameAt=at+1;if(tokens.slice(nameAt,nameAt+3).map(t=>t.text.toUpperCase()).join(' ')==='IF NOT EXISTS')nameAt+=3;
  const target=identifier(tokens,nameAt,driver),expected=snapshot.ref.schema?[snapshot.ref.schema,snapshot.ref.name]:[snapshot.ref.name];const actual=target.parts.length===1&&(driver!=='postgresql'||snapshot.ref.kind==='trigger')&&snapshot.ref.schema?[snapshot.ref.schema,...target.parts]:target.parts;
  const canonical=(s:string)=>driver==='sqlite'?s.toLowerCase():s;if(JSON.stringify(actual.map(canonical))!==JSON.stringify(expected.map(canonical)))throw new Error('The edited CREATE targets a different object. Keep the opened object name and schema.');
  if(snapshot.ref.kind==='trigger'){
    const on=tokens.findIndex((t,i)=>i>=target.end&&t.kind==='word'&&t.depth===0&&t.text.toUpperCase()==='ON');if(on<0)throw new Error('Trigger owner table is missing.');const owner=identifier(tokens,on+1,driver).parts;const baseline=words(snapshot.rawSql,driver,snapshot.modeRaw).filter(t=>t.kind!=='comment'),oldOn=baseline.findIndex(t=>t.kind==='word'&&t.depth===0&&t.text.toUpperCase()==='ON'),oldOwner=identifier(baseline,oldOn+1,driver).parts;if(JSON.stringify(owner.map(canonical))!==JSON.stringify(oldOwner.map(canonical)))throw new Error('The trigger owner table changed. Open/create that trigger separately.');
  }
  if(driver==='postgresql'&&['function','procedure'].includes(snapshot.ref.kind)){
    const old=words(snapshot.rawSql,driver).filter(t=>t.kind!=='comment'),k=old.findIndex(t=>t.kind==='word'&&t.text.toUpperCase()===kind),name=identifier(old,k+1,driver);
    if(JSON.stringify(argumentSignature(tokens,target.end))!==JSON.stringify(argumentSignature(old,name.end)))throw new Error('Changing argument names/types could address a different PostgreSQL overload. Keep the argument signature; defaults and the body can be edited.');
  }
  // SHOW CREATE routines often omit the database. Never let an object selected
  // from a different database execute against the connection's default database.
  const qualified=(driver==='mysql'||driver==='mariadb')&&snapshot.ref.schema?[snapshot.ref.schema,snapshot.ref.name].map(s=>'`'+s.replaceAll('`','``')+'`').join('.'):undefined;
  const suffix=qualified?qualified+sql.slice(tokens[target.end-1]!.end):sql.slice(tokens[nameAt]!.start);
  return sql.slice(0,tokens[at]!.end)+' '+suffix;
}
export function replaceCreate(sql:string,driver:DefinitionSnapshot['driver'],modeRaw?:string){const t=words(sql,driver,modeRaw).find(t=>t.kind!=='comment');if(!t||t.text.toUpperCase()!=='CREATE')throw new Error('Expected CREATE.');const tail=sql.slice(t.end);return /^\s+OR\s+REPLACE\b/i.test(tail)?sql:sql.slice(0,t.end)+' OR REPLACE'+tail;}
export function orderedTrigger(sql:string,neighbor:{before?:string;after?:string},quote:(s:string)=>string,driver:'mysql'|'mariadb',modeRaw:string){const ts=words(sql,driver,modeRaw).filter(t=>t.kind!=='comment'),row=ts.findIndex((t,i)=>t.text.toUpperCase()==='FOR'&&ts[i+1]?.text.toUpperCase()==='EACH'&&ts[i+2]?.text.toUpperCase()==='ROW');if(row<0||['FOLLOWS','PRECEDES'].includes(ts[row+3]?.text.toUpperCase()??''))return sql;const addition=neighbor.before?' PRECEDES '+quote(neighbor.before):neighbor.after?' FOLLOWS '+quote(neighbor.after):'';return sql.slice(0,ts[row+2]!.end)+addition+sql.slice(ts[row+2]!.end);}
