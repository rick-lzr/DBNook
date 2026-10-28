import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from './connections.js';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import {CellSchema,errorMessage,type ColumnMeta,type DataRow,type QueryResult,type RowChange,type TableDetails} from '../../protocol/src/index.js';
import {CompareInputSchema,CompareSourceSchema,type CompareInput,type CompareSource,type ComparePair,type CompareDatasetInfo,type CompareSummary,type ComparePage,type CompareRow,type SyncPreview,type SyncReport} from '../../protocol/src/comparisons.js';
import {compareRows,defaultPairs,synchronizeCell} from './compare-values.js';
import {tableSnapshot} from './table-snapshot.js';
import {ddlLiteral,ddlQuote} from './ddl-syntax.js';
import {checkAbort} from './data-stream.js';
import {profileTarget} from './profile-target.js';

export interface CapturedDataset {info:CompareDatasetInfo;rows:DataRow[];revision:string;sql:string;target:ReturnType<typeof profileTarget>;details?:TableDetails;}
type Captured=CapturedDataset;
interface Comparison {summary:CompareSummary;source:Captured;target:Captured;rows:CompareRow[];expires:number;}
interface SyncPlan {preview:SyncPreview;comparison:Comparison;changes:RowChange[];keys:string[];sql:string;expires:number;}
class EnoughRows extends Error{}
const MAX_BYTES=64*1024*1024;
const abbreviate=(row:DataRow|undefined)=>row&&Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='string'&&v.length>1000?v.slice(0,1000)+'… [abbreviated]':v&&typeof v==='object'&&v.type==='binary'?`<binary ${Buffer.from(v.base64,'base64').length} bytes: ${v.base64.slice(0,100)}${v.base64.length>100?'…':''}>`:v]));
const identity=(s:CompareSource)=>JSON.stringify(s);

export class Comparisons {
  private results=new Map<string,{capture:Captured;expires:number}>();private comparisons=new Map<string,Comparison>();private plans=new Map<string,SyncPlan>();private running=new Map<AbortController,Promise<unknown>>();private busyTargets=new Set<string>();private closed=false;private reservedBytes=0;
  constructor(private manager:ConnectionManager,private beforeWrite:(id:string)=>Promise<void>=async()=>{},private settled:(id:string)=>Promise<void>=async()=>{},private limits={datasetBytes:MAX_BYTES,residentBytes:4*MAX_BYTES}){}
  private residentBytes(){let bytes=0;const seen=new Set<DataRow[]>(),count=(c:Captured)=>{if(!seen.has(c.rows)){seen.add(c.rows);bytes+=c.info.bytes;}};for(const r of this.results.values())count(r.capture);for(const c of this.comparisons.values()){count(c.source);count(c.target);}for(const p of this.plans.values())bytes+=Buffer.byteLength(p.sql);return bytes;}
  private budget(additional:number){if(this.residentBytes()+this.reservedBytes+additional>this.limits.residentBytes)throw new Error('Comparison memory budget reached. Close older comparison editors or clear captured SQL results.');}
  catalog(){this.expire();return {profiles:this.manager.profiles().map(p=>({id:p.id,name:p.name,driver:p.driver})),results:[...this.results].map(([id,v])=>({id,label:v.capture.info.label,rows:v.capture.info.rows,truncated:v.capture.info.truncated}))};}
  async objects(profileId:string){const owner='compare-catalog:'+randomUUID();try{const session=await this.manager.lease(profileId,owner);return (await session.schema()).map(o=>({name:o.name,label:o.label??o.name,type:o.type}));}finally{await this.manager.releaseLease(owner);}}
  registerResult(profileId:string,result:QueryResult,label:string):CompareSource{
    if(this.closed)throw new Error('Comparison service is closed.');this.expire();if(this.results.size>=20)throw new Error('Close an older captured result before capturing another.');
    if(new Set(result.columns.map(c=>c.key)).size!==result.columns.length)throw new Error('Captured query result has duplicate column identities.');
    let bytes=0;for(const row of result.rows){bytes+=Buffer.byteLength(JSON.stringify(row));if(bytes>this.limits.datasetBytes)throw new Error('This result exceeds the comparison byte budget. Run a narrower query.');for(const c of result.columns){if(!Object.hasOwn(row,c.key))throw new Error('Captured query result is missing a column value.');CellSchema.parse(row[c.key]);}}this.budget(bytes);
    const id=randomUUID(),source:CompareSource={kind:'result',id};const info:CompareDatasetInfo={label,source,profileId,columns:structuredClone(result.columns),rows:result.rows.length,truncated:result.truncated,bytes,capturedAt:new Date().toISOString(),writable:false};
    this.results.set(id,{capture:{info,rows:structuredClone(result.rows),revision:this.manager.editorRevision(profileId),sql:result.sql,target:profileTarget(this.manager.profile(profileId))},expires:Date.now()+30*60*1000});return source;
  }
  forgetResult(id:string){this.results.delete(id);}
  clearResults(){this.results.clear();}
  private expire(){const now=Date.now();for(const [id,v]of this.results)if(v.expires<now)this.results.delete(id);for(const [id,v]of this.comparisons)if(v.expires<now)this.comparisons.delete(id);for(const [id,v]of this.plans)if(v.expires<now)this.plans.delete(id);}
  private operation<T>(signal:AbortSignal|undefined,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Comparison service is closed.'));const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const promise=Promise.resolve().then(()=>{checkAbort(controller.signal);this.expire();return action(controller.signal);}).finally(()=>{this.running.delete(controller);signal?.removeEventListener('abort',abort);});this.running.set(controller,promise);return promise;
  }
  private async capture(source:CompareSource,limit:number,signal:AbortSignal):Promise<Captured>{
    if(source.kind==='result'){const r=this.results.get(source.id);if(!r)throw new Error('Captured result expired. Capture the SQL result again.');const rows=r.capture.rows.slice(0,limit);return {...r.capture,rows,info:{...r.capture.info,bytes:rows.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0),rows:rows.length,truncated:r.capture.info.truncated||rows.length<r.capture.rows.length}};}
    const p=this.manager.profile(source.profileId),revision=this.manager.editorRevision(p.id),owner='compare-read:'+randomUUID();
    try{
      const session=await this.manager.lease(p.id,owner),details=await session.details(source.table),canonicalTable=p.driver==='sqlite'?ddlQuote(details.name,'sqlite'):details.name,columns=details.columns,rows:DataRow[]=[];let bytes=0,truncated=false;
      const writable=details.type==='table'&&!p.readOnly&&!(await session.table({table:details.name,limit:1,offset:0,where:'',order:[]})).readOnly;
      const sql=`SELECT ${columns.map(c=>ddlQuote(c.name,p.driver)).join(',')} FROM ${canonicalTable}`;
      try{await session.stream(sql,250,async batch=>{checkAbort(signal);if(this.manager.editorRevision(p.id)!==revision)throw new Error('Connection changed while capturing comparison data.');for(const row of batch.rows){if(rows.length>=limit){truncated=true;throw new EnoughRows();}const named=Object.fromEntries(columns.map((c,i)=>{const key=batch.columns[i]?.key;if(!key||!Object.hasOwn(row,key))throw new Error('Database comparison stream does not match its column metadata.');return [c.name,row[key]!];})),size=Buffer.byteLength(JSON.stringify(named));if(bytes+size>this.limits.datasetBytes){truncated=true;throw new EnoughRows();}bytes+=size;rows.push(named);}},signal);}catch(e){if(!(e instanceof EnoughRows))throw e;}
      checkAbort(signal);if(this.manager.editorRevision(p.id)!==revision)throw new Error('Connection changed while capturing comparison data.');
      return {info:{label:`${p.name} · ${details.name}`,source,profileId:p.id,columns,rows:rows.length,truncated,bytes,capturedAt:new Date().toISOString(),writable},rows,revision,details,sql,target:profileTarget(p)};
    }finally{await this.manager.releaseLease(owner);}
  }
  describe(source:CompareSource,signal?:AbortSignal):Promise<CompareDatasetInfo>{return this.operation(signal,async signal=>{const s=CompareSourceSchema.parse(source);if(s.kind==='result'){const r=this.results.get(s.id);if(!r)throw new Error('Captured result expired.');return structuredClone(r.capture.info);}const p=this.manager.profile(s.profileId),owner='compare-columns:'+randomUUID();try{const session=await this.manager.lease(p.id,owner),d=await session.details(s.table);checkAbort(signal);return {label:`${p.name} · ${d.name}`,source:s,profileId:p.id,columns:d.columns,rows:0,truncated:false,bytes:0,capturedAt:new Date().toISOString(),writable:d.type==='table'&&!p.readOnly};}finally{await this.manager.releaseLease(owner);}});}
  suggestedPairs(source:ColumnMeta[],target:ColumnMeta[]){return defaultPairs(source,target);}
  /** Retain capture reservations until the consumer finishes; never expose rows to Webview. */
  withDatasets<T>(sources:CompareSource[],limit:number,consume:(values:CapturedDataset[],signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{return this.operation(signal,async signal=>{
    if(sources.length>20||!Number.isInteger(limit)||limit<1||limit>100000)throw new Error('Unsupported dataset capture limits.');
    const values:CapturedDataset[]=[];let held=0;
    try{for(const source of sources){this.budget(this.limits.datasetBytes);this.reservedBytes+=this.limits.datasetBytes;held+=this.limits.datasetBytes;const value=await this.capture(CompareSourceSchema.parse(source),limit,signal);this.reservedBytes-=this.limits.datasetBytes-value.info.bytes;held-=this.limits.datasetBytes-value.info.bytes;values.push(value);}checkAbort(signal);return await consume(values,signal);}finally{this.reservedBytes-=held;}
  });}
  compare(value:CompareInput,signal?:AbortSignal):Promise<CompareSummary>{return this.operation(signal,async signal=>{
    const input=CompareInputSchema.parse(value);if(identity(input.source)===identity(input.target))throw new Error('Choose two distinct tables or result snapshots.');if(this.comparisons.size>=10)throw new Error('Close an older comparison before starting another.');
    const reservation=2*this.limits.datasetBytes;this.budget(reservation);this.reservedBytes+=reservation;try{
    // Sequential capture keeps both memory use and shared-memory SQLite locking bounded.
    const source=await this.capture(input.source,input.limit,signal),target=await this.capture(input.target,input.limit,signal);
    if(new Set(input.pairs.map(p=>p.source)).size!==input.pairs.length||new Set(input.pairs.map(p=>p.target)).size!==input.pairs.length)throw new Error('Map each source and target column at most once.');
    if(input.pairs.some(p=>!source.info.columns.some(c=>c.key===p.source)||!target.info.columns.some(c=>c.key===p.target)))throw new Error('Mapped columns changed. Reload the columns.');
    const rows=compareRows(source.rows,target.rows,input.pairs),counts:CompareSummary['counts']={'source-only':0,'target-only':0,changed:0,equal:0};for(const row of rows)counts[row.kind]++;
    const truncated=source.info.truncated||target.info.truncated,syncReason=truncated?'This comparison is incomplete (row or byte limit). Synchronization is disabled; increase the limit or compare a smaller dataset.':!target.info.writable||!target.details?'The target is a view, query snapshot, read-only profile or unsupported table engine.':undefined;
    const token=randomUUID(),expires=Date.now()+15*60*1000,summary:CompareSummary={token,input,source:source.info,target:target.info,counts,expiresAt:new Date(expires).toISOString(),canSync:!syncReason,syncReason,warnings:[`Each side fetches at most ${input.limit.toLocaleString()} rows and 64 MB. Captures are sequential snapshots, not a distributed transaction.`,`Only ${input.pairs.length} mapped columns are compared. NULL keys match NULL keys; duplicate composite keys stop comparison.`,...(truncated?['Incomplete sample: rows outside either capture may produce false additions/deletions. No full-table equality claim or synchronization is available.']:[]),'Long values in the comparison page are abbreviated; synchronization uses the original exact values.']};
    this.comparisons.set(token,{summary,source,target,rows,expires});return structuredClone(summary);
    }finally{this.reservedBytes-=reservation;}
  });}
  page(token:string,offset=0,limit=100,differencesOnly=true):ComparePage{this.expire();const c=this.comparisons.get(token);if(!c)throw new Error('Comparison expired. Compare again.');const rows=differencesOnly?c.rows.filter(r=>r.kind!=='equal'):c.rows;return {offset,total:rows.length,rows:rows.slice(offset,offset+Math.min(200,limit)).map(r=>({...r,source:abbreviate(r.source),target:abbreviate(r.target)}))};}
  differenceIds(token:string){this.expire();const c=this.comparisons.get(token);if(!c)throw new Error('Comparison expired.');const rows=c.rows.filter(r=>r.kind!=='equal');if(rows.length>10000)throw new Error('Select at most 10,000 differences per atomic synchronization.');return rows.map(r=>r.id);}
  private current(c:Comparison){for(const s of [c.source,c.target])if(this.manager.editorRevision(s.info.profileId)!==s.revision)throw new Error('A source or target connection changed after comparison. Compare again.');}
  previewSync(comparison:string,ids:string[]):SyncPreview{
    this.expire();const c=this.comparisons.get(comparison);if(!c)throw new Error('Comparison expired. Compare again.');if(!c.summary.canSync)throw new Error(c.summary.syncReason);this.current(c);
    if(!ids.length||ids.length>10000||new Set(ids).size!==ids.length)throw new Error('Select between 1 and 10,000 distinct difference rows.');if(this.plans.size>=20)throw new Error('Close an older synchronization preview first.');
    const rows=ids.map(id=>{const row=c.rows.find(r=>r.id===id);if(!row||row.kind==='equal')throw new Error('Select valid difference rows from this comparison.');return row;}),details=c.target.details!,driver=this.manager.profile(c.target.info.profileId).driver;
    const pairs=c.summary.input.pairs,keys=pairs.filter(p=>p.key).map(p=>p.target),changes:RowChange[]=[];let inserted=0,updated=0,deleted=0;
    if(keys.some(key=>details.columns.some(c=>c.key===key&&c.generated)))throw new Error('Generated target key columns require a dedicated synchronization policy. Select writable unique keys.');
    for(const row of rows.filter(r=>r.kind==='target-only')){changes.push({kind:'delete',original:row.target,values:{}});deleted++;}
    for(const row of rows.filter(r=>r.kind==='changed'||r.kind==='source-only')){
      const values:DataRow=Object.create(null);for(const pair of pairs){const target=details.columns.find(col=>col.key===pair.target)!,source=c.source.info.columns.find(col=>col.key===pair.source)!;if(target.generated){if(row.changed.includes(pair.target))throw new Error(`${target.name}: generated columns cannot be synchronized.`);continue;}if(row.kind==='changed'&&!row.changed.includes(pair.target))continue;values[target.name]=synchronizeCell(row.source![pair.source]!,source,target,driver);}
      if(row.kind==='source-only'){changes.push({kind:'insert',values});inserted++;}else{if(!Object.keys(values).length)throw new Error('This row has no writable differences.');changes.push({kind:'update',original:row.target,values});updated++;}
    }
    const table=driver==='sqlite'?ddlQuote(details.name,driver):details.name,literal=(v:import('../../protocol/src/index.js').CellValue):string=>{
      if(v===null)return 'NULL';if(typeof v==='boolean')return driver==='postgresql'?v?'TRUE':'FALSE':v?'1':'0';if(typeof v==='number')return String(v);if(typeof v==='object')return v.type==='integer'?v.value:driver==='postgresql'?`decode('${Buffer.from(v.base64,'base64').toString('hex')}','hex')`:`X'${Buffer.from(v.base64,'base64').toString('hex')}'`;return driver==='sqlite'&&v.includes('\0')?`CAST(X'${Buffer.from(v).toString('hex')}' AS TEXT)`:ddlLiteral(v,driver);
    };
    const sql='-- Direction: '+c.source.info.label.replace(/[\r\n]/g,' ')+' -> '+c.target.info.label.replace(/[\r\n]/g,' ')+'\n-- Review of DML. Apply in DBNook additionally locks and validates the entire captured target.\n'+changes.map(change=>{const entries=Object.entries(change.values),where=change.kind==='insert'?'':keys.map(k=>`${ddlQuote(k,driver)} ${driver==='mysql'||driver==='mariadb'?'<=>':driver==='postgresql'?'IS NOT DISTINCT FROM':'IS'} ${literal(change.original![k]!)}`).join(' AND ');return change.kind==='insert'?`INSERT INTO ${table} (${entries.map(([k])=>ddlQuote(k,driver)).join(',')}) VALUES (${entries.map(([,v])=>literal(v)).join(',')});`:change.kind==='delete'?`DELETE FROM ${table} WHERE ${where};`:`UPDATE ${table} SET ${entries.map(([k,v])=>ddlQuote(k,driver)+' = '+literal(v)).join(',')} WHERE ${where};`;}).join('\n');
    if(Buffer.byteLength(sql)>16*1024*1024)throw new Error('Synchronization exceeds the 16 MB atomic preview budget. Select fewer differences.');
    this.budget(Buffer.byteLength(sql));
    const token=randomUUID(),expires=c.expires,preview:SyncPreview={token,comparison,target:c.target.info.label,inserted,updated,deleted,steps:changes.length,sql:sql.slice(0,100000),scriptTruncated:sql.length>100000,expiresAt:new Date(expires).toISOString()};this.plans.set(token,{preview,comparison:c,changes,keys,sql,expires});return structuredClone(preview);
  }
  script(token:string){this.expire();const plan=this.plans.get(token);if(!plan)throw new Error('Synchronization preview expired.');this.current(plan.comparison);return plan.sql;}
  scriptProfile(token:string){this.script(token);return this.plans.get(token)!.comparison.target.info.profileId;}
  apply(token:string,signal?:AbortSignal):Promise<SyncReport>{return this.operation(signal,async signal=>{
    const plan=this.plans.get(token);if(!plan)throw new Error('Synchronization preview expired. Preview again.');const c=plan.comparison,target=c.target,p=this.manager.profile(target.info.profileId),owner='compare-sync:'+randomUUID(),report:SyncReport={status:'failed',affectedRows:0,committed:false,warnings:[]};let session:DriverSession|undefined,writing=false,prepared=false,cancellation:Promise<unknown>|undefined;
    const abort=()=>{if(writing&&!(p.driver==='sqlite'&&p.storage==='memory'))cancellation??=session?.cancel().catch(()=>{});};
    if(this.busyTargets.has(p.id))throw new Error('A synchronization is already running on this connection.');this.busyTargets.add(p.id);
    try{
      this.current(c);if(p.readOnly)throw new Error('Target connection is read-only.');await this.beforeWrite(p.id);prepared=true;checkAbort(signal);
      if(this.manager.documentSessions(p.id).some(l=>l.session?.transactionState==='active')||(await this.manager.connect(p.id)).transactionState==='active')throw new Error('Commit or roll back target SQL transactions before synchronization.');
      session=await this.manager.lease(p.id,owner);this.current(c);checkAbort(signal);signal.addEventListener('abort',abort,{once:true});
      this.plans.delete(token);writing=true;
      const result=await session.apply(target.details!.name,plan.keys,plan.changes,{requireAutocommit:true,expected:tableSnapshot(target.details!,target.rows,c.summary.input.limit),verifyValues:true});
      report.committed=true;report.status='succeeded';report.affectedRows=result.affectedRows;if(signal.aborted)report.warnings.push('The atomic write completed before cancellation could stop it.');
      this.forget(c.summary.token);
    }catch(e){report.status=writing&&!session?.connected?'unknown':signal.aborted?'cancelled':'failed';report.error=errorMessage(e);}
    finally{signal.removeEventListener('abort',abort);await cancellation;try{await this.manager.releaseLease(owner);}catch(e){report.warnings.push('Session cleanup: '+errorMessage(e));}if(prepared)try{await this.settled(p.id);}catch(e){report.warnings.push('View refresh: '+errorMessage(e));}this.busyTargets.delete(p.id);}
    return report;
  });}
  forget(token:string){this.comparisons.delete(token);for(const [id,p]of this.plans)if(p.preview.comparison===token)this.plans.delete(id);}
  forgetPlan(token:string){this.plans.delete(token);}
  async dispose(){this.closed=true;for(const c of this.running.keys())c.abort();await Promise.allSettled([...this.running.values()]);this.comparisons.clear();this.plans.clear();this.results.clear();}
}
