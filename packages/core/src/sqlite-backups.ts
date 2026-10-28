import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,link,unlink,lstat,readdir,stat,realpath} from 'node:fs/promises';
import {basename,dirname,join,isAbsolute,resolve} from 'node:path';
import type {ConnectionManager} from './connections.js';
import {checkAbort} from './data-stream.js';
import {errorMessage,type SqliteFileInfo} from '../../protocol/src/index.js';

export interface BackupProgress {phase:string;totalPages?:number;remainingPages?:number;}
export interface RestorePreview {token:string;source:string;destination:string;bytes:number;sha256:string;info:SqliteFileInfo;expiresAt:string;}
export interface BackupReport {jobId:string;kind:'backup'|'restore';status:'succeeded'|'failed'|'cancelled';destination:string;published:boolean;bytes:number;sha256?:string;info?:SqliteFileInfo;startedAt:string;finishedAt:string;reportPath?:string;error?:string;warnings:string[];}
type Plan={preview:RestorePreview;path:string;expires:number};
const remove=async(path:string)=>{try{await unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
const hash=async(path:string,signal?:AbortSignal)=>{const digest=createHash('sha256');let bytes=0;for await(const data of createReadStream(path)){checkAbort(signal);digest.update(data);bytes+=data.length;}checkAbort(signal);return {sha256:digest.digest('hex'),bytes};};
const exists=async(path:string)=>{try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
const canonical=async(path:string)=>{if(!isAbsolute(path))throw new Error('Choose an absolute destination path.');const value=join(await realpath(dirname(path)),basename(path));return process.platform==='win32'?value.toLowerCase():value;};

/** SQLite's online backup API, with verified snapshots and publication to a fresh file. */
export class SqliteBackups {
  private plans=new Map<string,Plan>();private running=new Map<AbortController,Promise<unknown>>();private targets=new Set<string>();private closed=false;private prepared?:Promise<void>;
  constructor(private manager:ConnectionManager,readonly directory:string){}
  private prepare(){return this.prepared??=(async()=>{await mkdir(this.directory,{recursive:true});for(const file of await readdir(this.directory)){if(!/^[a-f\d-]{36}\.snapshot$/.test(file))continue;const path=join(this.directory,file);try{if(Date.now()-(await stat(path)).mtimeMs>15*60*1000)await remove(path);}catch(e){if(!['ENOENT','EPERM'].includes((e as NodeJS.ErrnoException).code??''))throw e;}}})();}
  private operation<T>(signal:AbortSignal|undefined,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Backup service is closed.'));
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const promise=Promise.resolve().then(()=>{checkAbort(controller.signal);return action(controller.signal);}).finally(()=>{this.running.delete(controller);signal?.removeEventListener('abort',abort);});this.running.set(controller,promise);return promise;
  }
  private async target(path:string):Promise<string>{
    const key=await canonical(path);if(await exists(path))throw new Error('Destination already exists. Choose a new file; existing databases are not overwritten.');
    for(const suffix of ['-wal','-shm','-journal'])if(await exists(path+suffix))throw new Error('Destination has SQLite sidecar files. Choose a different unused path.');
    for(const p of this.manager.profiles())if(p.driver==='sqlite'&&p.storage==='file'){
      let candidate:string;try{candidate=await canonical(p.path);}catch{candidate=resolve(p.path);if(process.platform==='win32')candidate=candidate.toLowerCase();}
      if(candidate===key)throw new Error('Destination is already configured as a database connection. Choose a new file.');
    }return key;
  }
  private async temporary(path:string){const file=await open(path,'wx',0o600);await file.close();}
  private async inspect(path:string,signal:AbortSignal){checkAbort(signal);const result=await this.manager.withSqliteFile(path,session=>session.inspectFile!());checkAbort(signal);return result;}
  backup(profileId:string,destination:string,progress:(p:BackupProgress)=>void=()=>{},signal?:AbortSignal):Promise<BackupReport>{
    return this.operation(signal,signal=>this.execute('backup',destination,progress,signal,async path=>{
      const revision=this.manager.editorRevision(profileId),profile=this.manager.profile(profileId);if(profile.driver!=='sqlite')throw new Error('Select a SQLite connection for online backup.');
      const owner='sqlite-backup:'+randomUUID();try{const session=await this.manager.lease(profileId,owner);if(this.manager.editorRevision(profileId)!==revision)throw new Error('Connection changed before backup.');await session.backupFile!(path,p=>progress({phase:'Copying pages',...p}),signal);if(this.manager.editorRevision(profileId)!==revision)throw new Error('Connection changed during backup.');}finally{await this.manager.releaseLease(owner);}
    }));
  }
  previewRestore(source:string,destination:string,progress:(p:BackupProgress)=>void=()=>{},signal?:AbortSignal):Promise<RestorePreview>{
    return this.operation(signal,async signal=>{
      await this.prepare();await this.target(destination);if(await canonical(source)===await canonical(destination))throw new Error('Source and destination must differ.');
      for(const [token,p]of this.plans)if(p.expires<Date.now())await this.forget(token);if(this.plans.size>=10)await this.forget(this.plans.keys().next().value!);
      const token=randomUUID(),path=join(this.directory,token+'.snapshot');await this.temporary(path);let retained=false;
      try{
        progress({phase:'Capturing reviewed snapshot'});await this.manager.withSqliteFile(source,session=>session.backupFile!(path,p=>progress({phase:'Capturing reviewed snapshot',...p}),signal));
        progress({phase:'Checking integrity'});const info=await this.inspect(path,signal),digest=await hash(path,signal),expires=Date.now()+15*60*1000;
        checkAbort(signal);if(this.closed)throw new Error('Backup service is closed.');const preview:RestorePreview={token,source,destination,...digest,info,expiresAt:new Date(expires).toISOString()};this.plans.set(token,{preview,path,expires});retained=true;return structuredClone(preview);
      }finally{if(!retained)await this.cleanup(path);}
    });
  }
  restore(token:string,progress:(p:BackupProgress)=>void=()=>{},signal?:AbortSignal):Promise<BackupReport>{
    return this.operation(signal,async signal=>{
      const plan=this.plans.get(token);if(!plan||plan.expires<Date.now())throw new Error('Restore preview expired. Select the source and preview again.');
      this.plans.delete(token);
      // A reviewed snapshot is immutable even if the original source later changes.
      let report:BackupReport|undefined;
      try{const digest=await hash(plan.path,signal);if(digest.sha256!==plan.preview.sha256)throw new Error('Reviewed snapshot changed. Preview again.');
        report=await this.execute('restore',plan.preview.destination,progress,signal,async path=>{await this.manager.withSqliteFile(plan.path,session=>session.backupFile!(path,p=>progress({phase:'Restoring pages',...p}),signal));});return report;
      }finally{try{await this.cleanup(plan.path);}catch(e){if(report)report.warnings.push('Reviewed snapshot cleanup: '+errorMessage(e));else throw e;}}
    });
  }
  private async execute(kind:BackupReport['kind'],destination:string,progress:(p:BackupProgress)=>void,signal:AbortSignal,copy:(path:string)=>Promise<void>):Promise<BackupReport>{
    await this.prepare();const jobId=randomUUID(),report:BackupReport={jobId,kind,status:'failed',destination,published:false,bytes:0,startedAt:new Date().toISOString(),finishedAt:'',warnings:[]};
    let key:string|undefined,temp:string|undefined,acquired=false;
    try{
      key=await this.target(destination);if(this.targets.has(key))throw new Error('A backup or restore is already writing this target.');this.targets.add(key);acquired=true;
      temp=join(dirname(destination),'.'+basename(destination)+'.dbw-'+jobId+'.tmp');await this.temporary(temp);checkAbort(signal);progress({phase:kind==='backup'?'Starting online backup':'Restoring reviewed snapshot'});await copy(temp);
      progress({phase:'Checking integrity'});report.info=await this.inspect(temp,signal);const digest=await hash(temp,signal);Object.assign(report,digest);const file=await open(temp,'r+');try{await file.sync();}finally{await file.close();}
      await this.target(destination);progress({phase:'Publishing verified database'});checkAbort(signal);await link(temp,destination);report.published=true;report.status='succeeded';
      // No callback, cleanup or report failure can turn a published database into a failed write.
    }catch(error){report.status=signal.aborted?'cancelled':'failed';report.error=errorMessage(error);}
    finally{
      if(key&&acquired)this.targets.delete(key);if(temp)try{await this.cleanup(temp);}catch(e){report.warnings.push('Temporary file cleanup: '+errorMessage(e));}
      report.finishedAt=new Date().toISOString();const path=join(this.directory,jobId+'.report.json');let file:Awaited<ReturnType<typeof open>>|undefined;
      try{file=await open(path,'wx',0o600);await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.sync();report.reportPath=path;}catch(e){report.warnings.push('Job report: '+errorMessage(e));}finally{if(file)await file.close().catch(e=>report.warnings.push('Report close: '+errorMessage(e)));}
    }return report;
  }
  private async cleanup(path:string){for(const suffix of ['','-wal','-shm','-journal'])await remove(path+suffix);}
  async forget(token:string){const plan=this.plans.get(token);this.plans.delete(token);if(plan)await this.cleanup(plan.path);}
  async dispose(){this.closed=true;for(const controller of this.running.keys())controller.abort();await Promise.allSettled([...this.running.values()]);for(const token of this.plans.keys())await this.forget(token);}
}
