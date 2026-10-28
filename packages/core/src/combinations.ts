import {randomUUID} from 'node:crypto';
import {CombinationInputSchema,CombinationSourceSchema,type CombinationSource,type CombinationInput,type CombinationSummary,type CombinationPage,type CombinationNode,type QueryResult} from '../../protocol/src/index.js';
import type {Comparisons,CapturedDataset} from './comparisons.js';
import {combineRows,type CombinationDataset} from './combine-rows.js';
import {checkAbort} from './data-stream.js';
import {exportResult} from './export.js';
interface Stored {summary:CombinationSummary;dataset:CombinationDataset;nodes:CombinationNode[];expires:number;memoryBytes:number;}
export class Combinations {
  private values=new Map<string,Stored>();private pinned=new Map<Stored,number>();private reserved=0;private running=new Map<AbortController,Promise<unknown>>();private closed=false;
  constructor(private datasets:Comparisons,private limits={datasetBytes:64*1024*1024,residentBytes:256*1024*1024,lineageBytes:4*1024*1024}){}
  private expire(){const now=Date.now();for(const [id,v]of this.values)if(v.expires<now)this.values.delete(id);}
  private budget(add:number){let bytes=this.reserved;for(const v of new Set([...this.values.values(),...this.pinned.keys()]))bytes+=v.memoryBytes;if(bytes+add>this.limits.residentBytes)throw new Error('Combined-result memory budget reached. Forget older results or use narrower sources.');}
  private stored(id:string){this.expire();const value=this.values.get(id);if(!value)throw new Error('Combined result expired or was forgotten. Run the operation again.');return value;}
  catalog(){this.expire();return {...this.datasets.catalog(),derived:[...this.values.values()].map(v=>({id:v.summary.id,label:v.summary.label,rows:v.summary.rows,truncated:v.summary.truncated}))};}
  async describe(value:CombinationSource,signal?:AbortSignal){const source=CombinationSourceSchema.parse(value);if(source.kind==='derived'){const v=this.stored(source.id);return {label:v.summary.label,columns:structuredClone(v.summary.columns)};}const d=await this.datasets.describe(source,signal);return {label:d.label,columns:d.columns};}
  private snapshot(c:CapturedDataset):{dataset:CombinationDataset;node:CombinationNode}{const id=randomUUID();return {dataset:{id,label:c.info.label,rows:c.rows,columns:c.info.columns.map(col=>({...col,origins:[{node:id,column:col.key}]}))},node:{id,label:c.info.label,kind:c.info.source.kind,parents:[],capturedAt:c.info.capturedAt,rows:c.rows.length,truncated:c.info.truncated,profileId:c.info.profileId,target:c.target,targetRevision:c.revision,sql:c.sql}};}
  run(value:CombinationInput,signal?:AbortSignal):Promise<CombinationSummary>{
    if(this.closed)return Promise.reject(new Error('Data combination service is closed.'));const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const task=(async()=>{checkAbort(controller.signal);this.expire();const input=CombinationInputSchema.parse(value);if(this.values.size>=20)throw new Error('Forget an older combined result before creating another.');this.budget(this.limits.datasetBytes+this.limits.lineageBytes);this.reserved+=this.limits.datasetBytes+this.limits.lineageBytes;const pins:Stored[]=[];
      try{
        const derived=new Map<number,Stored>();input.sources.forEach((s,i)=>{if(s.kind==='derived'){const v=this.stored(s.id);derived.set(i,v);pins.push(v);this.pinned.set(v,(this.pinned.get(v)??0)+1);}});
        const originals=input.sources.filter((s):s is Exclude<CombinationSource,{kind:'derived'}>=>s.kind!=='derived');
        return await this.datasets.withDatasets(originals,input.limit,async(captures,signal)=>{
          const sources:CombinationDataset[]=[],nodes=new Map<string,CombinationNode>(),infos:CombinationSummary['sources']=[];let cursor=0;
          for(let i=0;i<input.sources.length;i++){const d=derived.get(i);if(d){const rows=d.dataset.rows.slice(0,input.limit),truncated=d.summary.truncated||rows.length<d.dataset.rows.length;sources.push({...d.dataset,rows});for(const n of d.nodes)nodes.set(n.id,n);infos.push({label:d.summary.label,rows:rows.length,truncated,capturedAt:d.nodes.find(n=>n.id===d.summary.id)!.capturedAt});}
            else {const c=captures[cursor++]!,v=this.snapshot(c);sources.push(v.dataset);nodes.set(v.node.id,v.node);infos.push({label:c.info.label,rows:c.info.rows,truncated:c.info.truncated,capturedAt:c.info.capturedAt});}}
          if(nodes.size>=128)throw new Error('This combination lineage exceeds 128 nodes. Export a snapshot or start a fresh source query.');
          const id=randomUUID(),label=(input.operation==='union'?'Union':'Join '+input.type)+' · '+sources.map(s=>s.label).join(' + ').slice(0,220),output=await combineRows(sources,input,this.limits.datasetBytes,signal),inputTruncated=infos.some(i=>i.truncated),truncated=inputTruncated||output.truncated,now=new Date().toISOString();
          nodes.set(id,{id,label,kind:input.operation,parents:sources.map(s=>s.id),capturedAt:now,rows:output.rows.length,truncated,recipe:structuredClone(input)});const lineage=[...nodes.values()];if(Buffer.byteLength(JSON.stringify(lineage))>this.limits.lineageBytes)throw new Error('The retained source SQL and operation lineage exceed 4 MiB. Use shorter source queries.');
          const expires=Date.now()+30*60*1000,summary:CombinationSummary={id,label,operation:input.operation,columns:output.columns,rows:output.rows.length,bytes:output.bytes,inputTruncated,outputTruncated:output.truncated,truncated,sources:infos,expiresAt:new Date(expires).toISOString(),warnings:['Read-only captured data. Sources are sequential snapshots, not a distributed transaction.',...(input.operation==='union'?['Union aligns exact column names (including duplicate-name occurrence), fills missing columns with NULL and preserves duplicate rows.']:['Join NULL keys do not match. Repeated keys produce every matching row combination.']),...(inputTruncated?['A source is truncated. Missing source rows can change matches and outer-join unmatched rows; this is a sample result.']:[]),...(output.truncated?['Output reached the row or byte limit. Displayed rows are a prefix, not the complete operation.']:[])]};
          const memoryBytes=output.bytes+Buffer.byteLength(JSON.stringify(summary))+Buffer.byteLength(JSON.stringify(lineage));this.budget(Math.max(0,memoryBytes-this.limits.datasetBytes-this.limits.lineageBytes));
          this.values.set(id,{summary,dataset:{id,label,columns:output.columns,rows:output.rows},nodes:lineage,expires,memoryBytes});return structuredClone(summary);
        },controller.signal);
      }finally{this.reserved-=this.limits.datasetBytes+this.limits.lineageBytes;for(const p of pins){const n=this.pinned.get(p)!-1;if(n)this.pinned.set(p,n);else this.pinned.delete(p);}}
    })().finally(()=>{this.running.delete(controller);signal?.removeEventListener('abort',abort);});this.running.set(controller,task);return task;
  }
  page(id:string,offset=0,columnOffset=0):CombinationPage{const v=this.stored(id),columns=v.summary.columns.slice(columnOffset,columnOffset+8);let abbreviated=false;return {columns:structuredClone(columns),columnOffset,columnCount:v.summary.columns.length,offset,total:v.summary.rows,rows:v.dataset.rows.slice(offset,offset+25).map(row=>Object.fromEntries(columns.map(c=>{let value=row[c.key]!;if(typeof value==='string'&&value.length>1000){value=value.slice(0,1000)+'… [abbreviated]';abbreviated=true;}if(value&&typeof value==='object'&&value.type==='binary'){value=`<binary ${Buffer.from(value.base64,'base64').length} bytes>`;abbreviated=true;}return [c.key,structuredClone(value)];}))),get abbreviated(){return abbreviated;}};}
  lineage(id:string){return structuredClone(this.stored(id).nodes);}
  export(id:string,format:'csv'|'json'){const v=this.stored(id),result:QueryResult={columns:v.summary.columns,rows:v.dataset.rows,truncated:v.summary.truncated,sql:'',durationMs:0,affectedRows:0,readOnly:true};return exportResult(result,format);}
  forget(id:string){this.values.delete(id);}
  async dispose(){this.closed=true;for(const c of this.running.keys())c.abort();await Promise.allSettled([...this.running.values()]);this.values.clear();}
}
