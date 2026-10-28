import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {ConnectionProfile,QueryResult} from '../../protocol/src/index.js';
import {errorMessage} from '../../protocol/src/index.js';
import type {PlanMode,PlanNode,PlanProposal,QueryPlanReport} from '../../protocol/src/query-plans.js';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import type {ConnectionManager} from './connections.js';
import type {SqlDocuments} from './sql-documents.js';
import {sqlSources,sqlTokens} from './sql-editing.js';
import {ExactNumber,parseExactJSON} from './data-files.js';
import {exportStatement} from './data-stream.js';

const RAW_LIMIT=8_000_000;
const scalar=(v:unknown):string=>v instanceof ExactNumber?v.text:typeof v==='string'?v:v===null?'null':JSON.stringify(v);
async function planContext(session:DriverSession,signal:AbortSignal):Promise<PlanProposal['context']>{
 if(signal.aborted)throw new Error('Plan cancelled before context capture.');let cancellation:Promise<boolean>|undefined;const cancel=()=>{cancellation??=session.cancel();void cancellation.catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{const p=session.profile,result=await session.query(p.driver==='sqlite'?'PRAGMA database_list':p.driver==='postgresql'?"SELECT pg_catalog.current_database() AS database,pg_catalog.current_schema() AS schema,current_user AS username,pg_catalog.current_setting('search_path') AS search_path":'SELECT DATABASE() AS current_database,CURRENT_USER() AS username',256);
  if(signal.aborted)throw new Error('Plan context capture cancelled.');
  const context=[{name:'Endpoint',value:p.driver==='sqlite'?p.path||':memory:':`${p.host}:${p.port??(p.driver==='postgresql'?5432:3306)}`}];
  if(p.driver==='sqlite'){const name=result.columns.find(c=>c.name==='name')?.key,file=result.columns.find(c=>c.name==='file')?.key;if(!name||!file)throw new Error('SQLite database context columns are unavailable.');for(const r of result.rows)context.push({name:'Database '+scalar(r[name]),value:scalar(r[file])||':memory:'});}
  else for(const c of result.columns)context.push({name:c.name,value:scalar(result.rows[0]?.[c.key])});return context;
 }catch(error){let failure:unknown;if(cancellation)await cancellation.catch(e=>{failure=e;});if(failure)throw new Error(`${errorMessage(error)} ${errorMessage(failure)}`,{cause:error});throw error;}finally{signal.removeEventListener('abort',cancel);if(cancellation)await cancellation.catch(()=>{});}
}
/** Server syntax is chosen explicitly; it never falls back to executing the source query. */
export function planStatement(sql:string,driver:ConnectionProfile['driver'],mode:PlanMode,serverVersion:string,sqlMode?:DriverSession['sqlMode']):Pick<PlanProposal,'sql'|'executedSql'|'format'>{
 if(!sql.trim()||sql.length>250000)throw new Error('Choose one SQL statement of at most 250,000 characters.');
 const sources=sqlSources(sql,driver,sqlMode);if(sources.length!==1)throw new Error('Explain one statement. Select it or place the cursor inside it.');
 const source=sources[0]!.sql,tokens=sqlTokens(source,driver,sqlMode),head=tokens.find(t=>t.kind!=='comment');
 const significant=tokens.filter(t=>t.kind!=='comment');if(significant.some((t,i)=>t.text===';'&&i!==significant.length-1))throw new Error('Plan inputs cannot contain multiple commands, including custom-delimiter batches.');
 if(tokens.some(t=>t.kind==='comment'&&/^\/\*(?:!|[mM]!)/.test(t.text)))throw new Error('Executable SQL comments require an explicit SQL execution workflow.');
 if(head?.kind!=='word'||!['SELECT','WITH','VALUES','TABLE','INSERT','UPDATE','DELETE','REPLACE','MERGE','EXECUTE'].includes(head.text.toUpperCase()))throw new Error('Choose an explainable query or data modification statement. DDL and transaction commands are not plan inputs.');
 const version=/^(\d+)\.(\d+)(?:\.(\d+))?/.exec(driver==='mariadb'?serverVersion.replace(/^5\.5\.5-/, ''):serverVersion),atLeast=(major:number,minor:number,patch=0)=>version&&Number(version[1])*1_000_000+Number(version[2])*1000+Number(version[3]??0)>=major*1_000_000+minor*1000+patch;
 let prefix:string,format:PlanProposal['format']='json';
 if(driver==='sqlite'){if(mode==='analyze')throw new Error('SQLite does not provide this execution analysis mode. ANALYZE updates statistics and is not a substitute.');prefix='EXPLAIN QUERY PLAN';format='sqlite';}
 else if(driver==='postgresql')prefix=mode==='analyze'?'EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, VERBOSE TRUE, FORMAT JSON)':'EXPLAIN (VERBOSE TRUE, FORMAT JSON)';
 else if(driver==='mariadb'){if(!atLeast(10,1))throw new Error('This plan workflow requires MariaDB 10.1+ syntax; this server version is unknown or older.');prefix=mode==='analyze'?'ANALYZE FORMAT=JSON':'EXPLAIN FORMAT=JSON';}
 else{if(mode==='analyze'){if(!atLeast(8,0,18))throw new Error('Execution analysis requires MySQL 8.0.18+ syntax.');prefix=atLeast(8,0,21)?'EXPLAIN ANALYZE FORMAT=TREE':'EXPLAIN ANALYZE';format='text';}else{if(!atLeast(5,6))throw new Error('JSON explain requires MySQL 5.6+ syntax.');prefix='EXPLAIN FORMAT=JSON';}}
 return {sql:source,executedSql:prefix+'\n'+source,format};
}

export function planTree(raw:string,format:PlanProposal['format'],result?:QueryResult):{nodes:PlanNode[];warnings:string[]}{
 const warnings:string[]=[],nodes:PlanNode[]=[];let count=0;
 const node=(label:string):PlanNode=>{if(++count>10000)throw new Error('Plan display exceeds 10,000 nodes.');return {id:String(count),label,attributes:[],children:[]};};
 try{
  if(format==='sqlite'){
   if(!result)throw new Error('SQLite plan metadata is missing.');const key=(name:string)=>result.columns.find(c=>c.name.toLowerCase()===name)?.key,id=key('id'),parent=key('parent'),detail=key('detail');
   if(!id||!parent||!detail)throw new Error('Unrecognized SQLite plan columns; inspect the raw output.');
   const rows=new Map<string,{node:PlanNode;parent:string}>();for(const r of result.rows){const name=scalar(r[id]);if(rows.has(name))throw new Error('Duplicate SQLite plan node IDs.');const item=node(scalar(r[detail]));item.attributes=result.columns.map(c=>({name:c.name,value:scalar(r[c.key])}));rows.set(name,{node:item,parent:scalar(r[parent])});}
   for(const [id,v]of rows){let p=v.parent,depth=0;while(rows.has(p)){if(p===id||++depth>64)throw new Error('SQLite plan graph is cyclic or too deep.');p=rows.get(p)!.parent;}const owner=rows.get(v.parent);if(owner)owner.node.children.push(v.node);else nodes.push(v.node);}
  }else if(format==='text'){
   const stack:{indent:number;node:PlanNode}[]=[];for(const line of raw.split(/\r?\n/)){if(!line.trim())continue;const match=/^(\s*)->\s*(.*)$/.exec(line);if(!match){const n=node(line);nodes.push(n);stack.length=0;continue;}const indent=match[1]!.length,n=node(match[2]!);while(stack.length&&stack.at(-1)!.indent>=indent)stack.pop();if(stack.length>=64)throw new Error('Text plan display exceeds 64 levels.');if(stack.length)stack.at(-1)!.node.children.push(n);else nodes.push(n);stack.push({indent,node:n});}
  }else{
   const parsed=parseExactJSON(raw);
   const visit=(value:unknown,label:string,depth:number):PlanNode=>{if(depth>64)throw new Error('Plan display exceeds 64 levels.');const n=node(label);
    if(Array.isArray(value)){value.forEach((v,i)=>n.children.push(visit(v,String(i+1),depth+1)));}
    else if(value&&typeof value==='object'&&!(value instanceof ExactNumber)){const object=value as Record<string,unknown>;n.label=typeof object['Node Type']==='string'?object['Node Type']:typeof object.table_name==='string'?label+' · '+object.table_name:label;for(const [k,v]of Object.entries(object)){if(v!==null&&typeof v==='object'&&!(v instanceof ExactNumber))n.children.push(visit(v,k,depth+1));else n.attributes.push({name:k,value:scalar(v)});}}
    else n.attributes.push({name:'value',value:scalar(value)});return n;};nodes.push(visit(parsed,'Plan',0));
  }
 }catch(error){nodes.length=0;warnings.push(error instanceof Error?error.message:String(error));}
 return {nodes,warnings};
}

export class QueryPlans{
 private proposals=new Map<string,{proposal:PlanProposal;sessionId:string;revision:string;sqlMode:string;operationVersion:number;expires:number}>();
 constructor(private manager:ConnectionManager,private documents:SqlDocuments){}
 async prepare(owner:string,sql:string,mode:PlanMode):Promise<PlanProposal>{
  for(const [id,v]of this.proposals)if(v.expires<Date.now())this.proposals.delete(id);if(this.proposals.size>=64)throw new Error('Close or complete pending plan reviews before opening more.');
  return this.documents.useSession(owner,async(session,signal)=>{
   if(signal.aborted)throw new Error('Plan preparation cancelled.');
   sql=await this.documents.prepareParameters(owner,sql,session,signal);
   const context=await planContext(session,signal),p=session.profile,serverVersion=session.info?.serverVersion??session.info?.sqlite??'',statement=planStatement(sql,p.driver,mode,serverVersion,session.sqlMode),expires=Date.now()+300000;
   if(mode==='analyze'&&p.readOnly)try{exportStatement(sql,p.driver,session.sqlMode);}catch{throw new Error('Read-only execution analysis requires a read query without data modification or INTO.');}
   const proposal:PlanProposal={token:randomUUID(),owner,profileId:p.id,connection:p.name,driver:p.driver,serverVersion,mode,...statement,transaction:session.transactionState,context,expiresAt:new Date(expires).toISOString()};
   this.proposals.set(proposal.token,{proposal,sessionId:session.id,revision:this.manager.editorRevision(p.id),sqlMode:JSON.stringify(session.sqlMode),operationVersion:this.documents.operationVersion(owner),expires});return structuredClone(proposal);
  });
 }
 forget(token:string){this.proposals.delete(token);}
 run(token:string,executionConfirmed=false):Promise<QueryPlanReport>{
  const entry=this.proposals.get(token);if(!entry||entry.expires<Date.now()){this.proposals.delete(token);return Promise.reject(new Error('Plan review expired. Prepare it again.'));}
  const p=entry.proposal;if(p.mode==='analyze'&&!executionConfirmed)return Promise.reject(new Error('Analyze executes SQL. Explicit execution confirmation is required.'));
  this.proposals.delete(token);
  return this.documents.useSession(p.owner,async(session,signal)=>{
   if(signal.aborted)throw new Error('Plan cancelled before execution.');
   if(this.documents.operationVersion(p.owner)!==entry.operationVersion+1)throw new Error('Another SQL document operation ran since plan review. Prepare the plan again.');
   if(session.id!==entry.sessionId||this.documents.connection(p.owner)!==p.profileId||this.manager.editorRevision(p.profileId)!==entry.revision)throw new Error('Connection or document session changed since plan review. Prepare it again.');
   const context=await planContext(session,signal);
   if(JSON.stringify(context)!==JSON.stringify(p.context)||JSON.stringify(session.sqlMode)!==entry.sqlMode||session.transactionState!==p.transaction)throw new Error('Database, user, search path, SQL mode or transaction changed since plan review. Prepare it again.');
   let cancellation:Promise<boolean>|undefined;const cancel=()=>{cancellation??=session.cancel();void cancellation.catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});const started=performance.now(),warnings:string[]=[];
   try{
    const result=await session.query(p.executedSql,10000);let raw=p.format==='sqlite'?JSON.stringify({columns:result.columns.map(c=>({key:c.key,name:c.name})),rows:result.rows},null,2):typeof result.rows[0]?.[result.columns[0]?.key??'c0']==='string'?result.rows[0]![result.columns[0]!.key] as string:JSON.stringify(result.rows,null,2),truncated=result.truncated;
    if(raw.length>RAW_LIMIT){raw=raw.slice(0,RAW_LIMIT);truncated=true;}if(truncated)warnings.push('Plan output was truncated; the displayed plan is incomplete.');if(signal.aborted)warnings.push('Cancellation was requested while the server completed. Inspect the transaction and database before repeating execution.');
    const tree=truncated?{nodes:[],warnings:[]}:planTree(raw,p.format,result);warnings.push(...tree.warnings);
    if(p.mode==='analyze')warnings.push('Analyze executed the statement in this SQL document session. No automatic commit or rollback was added; effects outside transactions may remain.');
    return {...p,id:randomUUID(),capturedAt:new Date().toISOString(),durationMs:performance.now()-started,transactionAfter:session.transactionState,raw,nodes:tree.nodes,warnings,truncated};
   }catch(error){let failure:unknown;if(cancellation)await cancellation.catch(e=>{failure=e;});const message=errorMessage(error)+(failure?' '+errorMessage(failure):'');if(p.mode==='analyze')throw new Error(`Analyze did not return a complete plan. The statement may have executed; inspect the database and document transaction before retrying. ${message}`,{cause:error});if(failure)throw new Error(message,{cause:error});throw error;}finally{signal.removeEventListener('abort',cancel);if(cancellation)await cancellation.catch(e=>{warnings.push(errorMessage(e));});}
  });
 }
}
