import {randomUUID,createHash} from 'node:crypto';
import {open,mkdir,rename,link,unlink,stat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname,join,basename} from 'node:path';
import type {ConnectionManager} from './connections.js';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import {CellSchema,errorMessage,type CellValue,type ColumnMeta,type QueryResult} from '../../protocol/src/index.js';
import type {TableStructure} from '../../protocol/src/ddl.js';
import {readTableStructure} from './table-structure.js';
import {structureFingerprint} from './schema-changes.js';
import {ddlQuote} from './ddl-syntax.js';
import {checkAbort,exportStatement} from './data-stream.js';
import {emptyMetadata,exactJson,ExactNumber,fileRows,type DataFileOptions,type FileMetadata,type SourceCell,type SourceRow} from './data-files.js';
export interface TransferProgress{phase:string;rows:number;bytes:number;total?:number;}
export interface ExportReport{rows:number;bytes:number;sha256:string;path:string;durationMs:number;}
export interface FileSource{token:string;headers:string[];rows:number;bytes:number;sample:{index:number;cells:string[]}[];truncated:boolean;}
export interface ImportPreview{token:string;profileId:string;table:string;total:number;valid:number;invalid:number;mapping:Record<string,number>;columns:TableStructure['columns'];sample:{index:number;values:Record<string,CellValue>;errors:string[]}[];errors:{index:number;line?:number;message:string}[];expiresAt:string;}
export interface ImportReport{status:'succeeded'|'failed'|'cancelled'|'unknown';processed:number;affectedRows:number;invalid:number;remaining:number;reportPath:string;error?:string;}
interface Source{path:string;options:DataFileOptions;metadata:FileMetadata;expires:number;}
interface Plan{profileId:string;table:string;path:string;preview:ImportPreview;revision:string;fingerprint:string;expires:number;}
async function remove(path:string){await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});}
async function write(file:Awaited<ReturnType<typeof open>>,text:string){const data=Buffer.from(text);for(let offset=0;offset<data.length;){const r=await file.write(data,offset,data.length-offset,null);if(!r.bytesWritten)throw new Error('The output file stopped accepting data.');offset+=r.bytesWritten;}return data.length;}
function rawCells(row:SourceRow,headers:string[]):unknown[]{if(row.cells)return row.cells;if(Array.isArray(row.value))return row.value;if(row.value&&typeof row.value==='object'&&!(row.value instanceof ExactNumber))return headers.map(h=>Object.hasOwn(row.value!,h)?(row.value as Record<string,unknown>)[h]:undefined);throw new Error('JSON rows must be objects or arrays.');}
function text(value:unknown):string{if(value===undefined)return '(missing)';if(value&&typeof value==='object'&&'quoted'in value&&'text'in value)return String(value.text);return typeof value==='string'?value:exactJson(value);}
function cellValue(value:unknown,column:TableStructure['columns'][number],source:Source):CellValue|undefined{
  if(value===undefined)return undefined;
  const csv=value&&typeof value==='object'&&'quoted'in value&&'text'in value?value as SourceCell:undefined;
  if(csv)value=!csv.quoted&&csv.text===source.options.nullToken?null:csv.text;
  if(value===null){if(!column.nullable)throw new Error(`${column.name}: NULL is not allowed.`);return null;}
  const type=column.dataType.toUpperCase(),binary=/BLOB|BYTEA|BINARY|\bBIT\b/.test(type),json=/\bJSONB?\b/.test(type);
  if(source.metadata.typed&&value&&typeof value==='object'&&!(value instanceof ExactNumber)&&('type'in value||'$binary'in value)){
    const tagged='$binary'in value?{type:'binary',base64:(value as any).$binary}:value,parsed=CellSchema.parse(tagged);
    if(parsed&&typeof parsed==='object'){if(parsed.type==='binary'){if(!binary&&type)throw new Error(`${column.name}: binary data needs a binary target column.`);if(Buffer.from(parsed.base64,'base64').toString('base64')!==parsed.base64)throw new Error('Invalid base64 binary value.');return parsed;}value=parsed.value;}
  }
  if(json){const data=typeof value==='string'?value:exactJson(value);parseJsonCheck(data);return data;}
  if(binary){if(typeof value!=='string'||!value.startsWith('base64:'))throw new Error(`${column.name}: use base64: followed by the binary value.`);const data=value.slice(7);if(Buffer.from(data,'base64').toString('base64')!==data)throw new Error(`${column.name}: invalid base64.`);return {type:'binary',base64:data};}
  const scalar=value instanceof ExactNumber?value.text:typeof value==='string'?value:typeof value==='boolean'?String(value):exactJson(value);
  if(/\bBOOL(?:EAN)?\b/.test(type)){if(/^(?:true|1)$/i.test(scalar))return true;if(/^(?:false|0)$/i.test(scalar))return false;throw new Error(`${column.name}: enter true/false or 1/0.`);}
  if(/\b(?:TINYINT|SMALLINT|MEDIUMINT|INTEGER|BIGINT|INT\d?|SERIAL|BIGSERIAL)\b/.test(type)){if(!/^[+-]?\d+$/.test(scalar))throw new Error(`${column.name}: expected an integer.`);const n=BigInt(scalar);return n<=BigInt(Number.MAX_SAFE_INTEGER)&&n>=BigInt(Number.MIN_SAFE_INTEGER)?Number(n):{type:'integer',value:n.toString()};}
  if(/\b(?:DECIMAL|NUMERIC|NUMBER)\b/.test(type)){if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(scalar))throw new Error(`${column.name}: expected a decimal.`);return scalar;}
  if(/\b(?:REAL|FLOAT\d?|DOUBLE)\b/.test(type)){const n=Number(scalar);if(!scalar.trim()||!Number.isFinite(n))throw new Error(`${column.name}: expected a finite number.`);return n;}
  if(!type&&source.metadata.typed&&value instanceof ExactNumber){const n=Number(value.text);if(!Number.isFinite(n))throw new Error('Number is not finite.');if(/^-?\d+$/.test(value.text)&&!Number.isSafeInteger(n))return {type:'integer',value:value.text};return n;}
  return scalar;
}
import {parseExactJSON as parseJsonCheck} from './data-files.js';
export class DataTransfers{
  private sources=new Map<string,Source>();private plans=new Map<string,Plan>();private busy=new Set<string>();
  private prepared?:Promise<void>;private closed=false;
  private prepare(){return this.prepared??=(async()=>{await mkdir(this.directory,{recursive:true});for(const file of await readdir(this.directory)){if(!/^[a-f\d-]{36}\.preview$/.test(file))continue;const path=join(this.directory,file);try{if(Date.now()-(await stat(path)).mtimeMs>15*60*1000)await remove(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&(error as NodeJS.ErrnoException).code!=='EPERM')throw error;}}})();}
  constructor(private manager:ConnectionManager,readonly directory:string,private beforeWrite:(id:string)=>Promise<void>=async()=>{},private settled:(id:string)=>Promise<void>=async()=>{}){}
  async exportFile(profileId:string,source:{table:string;where?:string}|{sql:string},path:string,options:{format:'csv'|'json';delimiter?:','|';'|'\t';nullToken?:string;overwrite?:boolean;batchSize?:number},progress:(p:TransferProgress)=>void=()=>{},signal?:AbortSignal,sessionOverride?:DriverSession):Promise<ExportReport>{
    const started=Date.now(),revision=this.manager.editorRevision(profileId),owner='export:'+randomUUID(),session=sessionOverride??await this.manager.lease(profileId,owner),temp=join(dirname(path),'.'+basename(path)+'.dbw-'+randomUUID()+'.tmp');let file:Awaited<ReturnType<typeof open>>|undefined,rows=0,bytes=0,first=true;
    const hash=createHash('sha256'),delimiter=options.delimiter??',',nullToken=options.nullToken??'\\N';
    const append=async(text:string)=>{checkAbort(signal);hash.update(text);bytes+=await write(file!,text);};
    const quote=(v:string,force=false)=>force||v===nullToken||v===''||v.includes(delimiter)||/["\r\n]/.test(v)?'"'+v.replaceAll('"','""')+'"':v;
    try{
      checkAbort(signal);if(session.profile.id!==profileId)throw new Error('SQL document connection changed before export.');if(![',',';','\t'].includes(delimiter)||!nullToken||/["\r\n]/.test(nullToken)||nullToken.includes(delimiter))throw new Error('Choose a nonempty NULL marker without delimiter, quotes or newlines.');
      let sql:string;if('table'in source){const d=await session.details(source.table);sql=`SELECT * FROM ${session.profile.driver==='sqlite'?ddlQuote(d.name,'sqlite'):d.name}${source.where?.trim()?' WHERE ('+source.where+')':''}`;}else sql=source.sql;
      sql=exportStatement(sql,session.profile.driver,session.sqlMode);file=await open(temp,'wx',0o600);
      await session.stream(sql,Math.max(1,Math.min(2000,Math.floor(options.batchSize??500))),async batch=>{
        checkAbort(signal);if(this.manager.editorRevision(profileId)!==revision)throw new Error('Connection settings changed during export.');
        if(first){if(options.format==='json')await append('{"format":"db-workbench.rows","version":1,"columns":'+JSON.stringify(batch.columns)+',"rows":[');else await append('\uFEFF'+batch.columns.map(c=>quote(c.name)).join(delimiter)+'\r\n');first=false;}
        const output:string[]=[];for(const row of batch.rows){if(options.format==='json')output.push((rows?',':'')+'\n'+JSON.stringify(batch.columns.map(c=>row[c.key]??null)));else output.push(batch.columns.map(c=>{const value=row[c.key];return value===null||value===undefined?nullToken:quote(typeof value==='object'?value.type==='integer'?value.value:'base64:'+value.base64:String(value));}).join(delimiter)+'\r\n');rows++;}await append(output.join(''));
        progress({phase:'Exporting',rows,bytes});
      },signal);
      if(options.format==='json')await append('],"truncated":false}\n');checkAbort(signal);await file.sync();await file.close();file=undefined;
      checkAbort(signal);if(options.overwrite)await rename(temp,path);else{await link(temp,path);await remove(temp);}return {rows,bytes,sha256:hash.digest('hex'),path,durationMs:Date.now()-started};
    }finally{await file?.close();await remove(temp);if(!sessionOverride)await this.manager.releaseLease(owner);}
  }
  async inspect(path:string,options:DataFileOptions,signal?:AbortSignal):Promise<FileSource>{
    if(options.format==='csv'&&(!options.nullToken||options.nullToken.length>100||/["\r\n]/.test(options.nullToken)||options.nullToken.includes(options.delimiter)))throw new Error('Choose a nonempty NULL marker without delimiter, quotes or newlines.');
    const metadata=emptyMetadata(),samples:SourceRow[]=[],headers=new Set<string>();
    for await(const row of fileRows(path,options,metadata,signal)){
      if(samples.length<20)samples.push(row.cells?{...row,cells:row.cells.map(c=>({...c,text:c.text.slice(0,1000)}))}:Array.isArray(row.value)?{...row,value:row.value.map(v=>text(v).slice(0,1000))}:row.value&&typeof row.value==='object'?{...row,value:Object.fromEntries(Object.entries(row.value).map(([k,v])=>[k,text(v).slice(0,1000)]))}:row);if(options.format==='json'&&!Array.isArray(row.value)&&row.value&&typeof row.value==='object')for(const key of Object.keys(row.value))headers.add(key);
      if(!options.header&&options.format==='csv'&&!metadata.headers.length)metadata.headers=row.cells!.map((_,i)=>`Column ${i+1}`);
      if(options.format==='json'&&Array.isArray(row.value))for(let i=0;i<row.value.length;i++)headers.add(`Column ${i+1}`);if(headers.size>10000)throw new Error('Source has more than 10,000 columns.');
    }
    checkAbort(signal);if(!metadata.headers.length)metadata.headers=[...headers];if(!metadata.headers.length)throw new Error('The file contains no columns.');if(metadata.headers.some(h=>h.length>1000))throw new Error('A source header exceeds 1,000 characters. Check whether the file has a header row.');for(const [key,s]of this.sources)if(s.expires<Date.now())this.sources.delete(key);if(this.sources.size>=50)this.sources.delete(this.sources.keys().next().value!);const token=randomUUID();this.sources.set(token,{path,options:{...options},metadata,expires:Date.now()+30*60*1000});
    return {token,headers:metadata.headers,rows:metadata.rows,bytes:metadata.bytes,truncated:metadata.truncated,sample:samples.map(r=>({index:r.index,cells:rawCells(r,metadata.headers).map(text)}))};
  }
  async preview(sourceToken:string,profileId:string,table:string,mapping:Record<string,number>,signal?:AbortSignal):Promise<ImportPreview>{
    if(this.closed)throw new Error('Data transfer service is closed.');
    const source=this.sources.get(sourceToken);if(!source||source.expires<Date.now())throw new Error('Source file selection expired. Select it again.');if(this.manager.profile(profileId).readOnly)throw new Error('This connection is read-only.');
    const session=await this.manager.connect(profileId),structure=await readTableStructure(session,table);if(!structure.editable||structure.type!=='table')throw new Error('Choose an editable ordinary table.');
    const mapped=Object.entries(mapping);if(!mapped.length)throw new Error('Map at least one source column.');for(const [name,index]of mapped){const c=structure.columns.find(c=>c.name===name);if(!c||c.generated||!Number.isInteger(index)||index<0||index>=source.metadata.headers.length)throw new Error('Invalid or generated target column mapping.');}
    await this.prepare();const token=randomUUID(),path=join(this.directory,token+'.preview'),file=await open(path,'wx',0o600),metadata=emptyMetadata(),expires=Date.now()+15*60*1000,revision=this.manager.editorRevision(profileId);
    const result:ImportPreview={token,profileId,table:structure.name,total:0,valid:0,invalid:0,mapping:{...mapping},columns:structure.columns,sample:[],errors:[],expiresAt:new Date(expires).toISOString()};
    let spool='';try{
      for await(const row of fileRows(source.path,source.options,metadata,signal)){
        checkAbort(signal);const errors:string[]=[],values:Record<string,CellValue>=Object.create(null);let cells:unknown[]=[];try{cells=rawCells(row,source.metadata.headers);if(Array.isArray(row.value)||row.cells)if(cells.length!==source.metadata.headers.length)throw new Error('Row field count differs from source headers.');for(const [name,index]of mapped){const v=cellValue(cells[index],structure.columns.find(c=>c.name===name)!,source);if(v!==undefined)values[name]=v;}
          for(const c of structure.columns)if(!Object.hasOwn(values,c.name)&&!c.nullable&&!c.generated&&c.defaultSql===null&&!/\bAUTO_INCREMENT\b/i.test(c.definition)&&!(session.profile.driver==='sqlite'&&c.primaryKey&&c.dataType.toUpperCase()==='INTEGER'&&!/WITHOUT\s+ROWID/i.test(structure.definition)))throw new Error(`${c.name}: required target column is missing.`);
        }catch(error){errors.push(errorMessage(error));}
        result.total++;if(errors.length){result.invalid++;if(result.errors.length<500)result.errors.push({index:row.index,line:row.line,message:errors.join('; ')});}else{result.valid++;spool+=JSON.stringify({index:row.index,line:row.line,values})+'\n';if(spool.length>=1_000_000){await write(file,spool);spool='';}}
        if(result.sample.length<50)result.sample.push({index:row.index,values:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,typeof v==='string'?v.slice(0,1000):v&&typeof v==='object'&&v.type==='binary'?`<binary: ${Buffer.from(v.base64,'base64').length} bytes>`:v])),errors});
      }
      checkAbort(signal);if(metadata.sha256!==source.metadata.sha256)throw new Error('Source file changed after inspection. Select it again.');if(this.manager.editorRevision(profileId)!==revision)throw new Error('Connection changed during preview.');if(this.closed)throw new Error('The import editor closed during preview.');if(spool)await write(file,spool);await file.close();
      if(this.plans.size>=30){const oldest=this.plans.keys().next().value!;await this.forget(oldest);}this.plans.set(token,{profileId,table:structure.name,path,preview:result,revision,fingerprint:structureFingerprint(structure,session.profile.driver),expires});return structuredClone(result);
    }catch(error){await file.close().catch(()=>{});await remove(path);throw error;}
  }
  async apply(profileId:string,token:string,options:{skipInvalid?:boolean;batchSize?:number;reportPath:string},progress:(p:TransferProgress)=>void=()=>{},signal?:AbortSignal):Promise<ImportReport>{
    const p=this.plans.get(token);if(!p||p.profileId!==profileId||p.expires<Date.now())throw new Error('Import preview expired. Preview again.');if(p.preview.invalid&&!options.skipInvalid)throw new Error('Fix invalid rows, or explicitly choose to skip them.');if(this.busy.has(profileId))throw new Error('Another import is running on this connection.');
    this.busy.add(profileId);const owner='import:'+token,report:ImportReport={status:'succeeded',processed:0,affectedRows:0,invalid:p.preview.invalid,remaining:p.preview.valid,reportPath:''};let session:Awaited<ReturnType<ConnectionManager['lease']>>|undefined,file:Awaited<ReturnType<typeof open>>|undefined;
    try{
      await this.beforeWrite(profileId);checkAbort(signal);if(this.manager.editorRevision(profileId)!==p.revision)throw new Error('Connection changed after preview.');
      if(this.manager.documentSessions(profileId).some(s=>s.session?.transactionState==='active')||(await this.manager.connect(profileId)).transactionState==='active')throw new Error('Commit or roll back SQL transactions before importing.');
      session=await this.manager.lease(profileId,owner);file=await open(options.reportPath,'wx',0o600);report.reportPath=options.reportPath;await write(file,JSON.stringify({kind:'summary',format:'db-workbench.import-report',version:1,profileId,table:p.table,total:p.preview.total,invalid:p.preview.invalid,errors:p.preview.errors})+'\n');
      if(structureFingerprint(await readTableStructure(session,p.table),session.profile.driver)!==p.fingerprint)throw new Error('Target structure changed after preview. Preview again.');
      this.plans.delete(token);const batchSize=Math.max(1,Math.min(2000,options.batchSize??500));let batch:{index:number;line?:number;values:Record<string,CellValue>}[]=[];
      const flush=async()=>{if(!batch.length)return;checkAbort(signal);if(this.manager.editorRevision(profileId)!==p.revision)throw new Error('Connection changed during import.');
        if(structureFingerprint(await readTableStructure(session!,p.table),session!.profile.driver)!==p.fingerprint)throw new Error('Target structure changed between import batches. Completed batches remain committed.');
        const start=batch[0]!.index,end=batch.at(-1)!.index;
        let affectedRows:number;try{affectedRows=(await session!.apply(p.table,[],batch.map(v=>({kind:'insert' as const,values:v.values})))).affectedRows;}
        catch(error){report.status=session!.connected?'failed':'unknown';await write(file!,JSON.stringify({kind:'batch',start,end,status:report.status,error:errorMessage(error)})+'\n');throw error;}
        report.processed+=batch.length;report.affectedRows+=affectedRows;report.remaining-=batch.length;batch=[];await write(file!,JSON.stringify({kind:'batch',start,end,status:'committed',affectedRows})+'\n');progress({phase:'Importing',rows:report.processed,bytes:0,total:p.preview.valid});
      };
      const input=createReadStream(p.path),lines=createInterface({input,crlfDelay:Infinity});try{for await(const line of lines){checkAbort(signal);batch.push(JSON.parse(line));if(batch.length>=batchSize)await flush();}await flush();}finally{lines.close();input.destroy();}
    }catch(error){report.status=report.status==='unknown'?'unknown':signal?.aborted?'cancelled':'failed';report.error=errorMessage(error);}
    finally{
      const warnings:string[]=[];
      try{await this.manager.releaseLease(owner);}catch(e){warnings.push('Session cleanup: '+errorMessage(e));}
      try{await this.settled(profileId);}catch(e){warnings.push('View refresh: '+errorMessage(e));}finally{this.busy.delete(profileId);}
      if(!this.plans.has(token))try{await remove(p.path);}catch(e){warnings.push('Preview cleanup: '+errorMessage(e));}
      if(warnings.length)report.error=[report.error,`${report.processed} source rows were already committed. ${warnings.join('; ')}`].filter(Boolean).join(' ');
      if(file){try{await write(file,JSON.stringify({kind:'result',...report})+'\n');await file.sync();}catch(e){report.error=[report.error,`Report write failed after ${report.processed} committed rows: ${errorMessage(e)}`].filter(Boolean).join(' ');}finally{await file.close().catch(e=>{report.error=[report.error,'Report close: '+errorMessage(e)].filter(Boolean).join(' ');});}}
    }return report;
  }
  async forget(token:string){const p=this.plans.get(token);this.plans.delete(token);if(p)await remove(p.path);}
  async dispose(){this.closed=true;for(const token of this.plans.keys())await this.forget(token);this.sources.clear();}
}
