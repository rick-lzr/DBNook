import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readdir,rename,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {type ConnectionProfile,type QueryRun} from '../../protocol/src/index.js';
import {profileTarget} from './profile-target.js';
const idSchema=z.string().uuid();
export const HistoryEntrySchema=z.object({version:z.literal(1),id:idSchema,runId:z.string(),startedAt:z.string().datetime(),profileId:z.string(),profileName:z.string(),driver:z.enum(['sqlite','postgresql','mysql','mariadb']),database:z.string(),target:z.string().regex(/^[a-f\d]{64}$/),status:z.enum(['succeeded','failed','cancelled']),durationMs:z.number().nonnegative(),statements:z.number().int().nonnegative(),rows:z.number().int().nonnegative(),affectedRows:z.number().int().nonnegative(),truncated:z.boolean(),preview:z.string().max(400),error:z.string().max(4000).optional()}).strict();
export type HistoryEntry=z.infer<typeof HistoryEntrySchema>;
export interface HistorySettings{enabled:boolean;recordsPerDatabase:number;logFailedQueries:boolean;}
export const historyTarget=(profile:ConnectionProfile)=>createHash('sha256').update(JSON.stringify(profileTarget(profile))).digest('hex');
/** One immutable file per run avoids lost updates between VS Code windows. Header-only listing keeps SQL bodies out of memory. */
export class QueryHistory{
  private tail:Promise<unknown>=Promise.resolve();
  constructor(readonly directory:string,private settings:()=>HistorySettings,private changed:()=>void=()=>{}){}
  private path(id:string){return join(this.directory,`${idSchema.parse(id)}.query`);}
  async list(filter?:{profileId?:string;database?:string;search?:string}):Promise<HistoryEntry[]>{
    let files:string[];try{files=await readdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    const entries:HistoryEntry[]=[];
    for(const filename of files){const id=filename.replace(/\.query$/,'');if(!filename.endsWith('.query')||!idSchema.safeParse(id).success)continue;
      let file;try{file=await open(this.path(id),'r');const buffer=Buffer.alloc(65536),{bytesRead}=await file.read(buffer,0,buffer.length,0),end=buffer.subarray(0,bytesRead).indexOf(10);if(end<0)continue;const entry=HistoryEntrySchema.parse(JSON.parse(buffer.subarray(0,end).toString('utf8')));if(entry.id!==id)continue;
        if(filter?.profileId&&entry.profileId!==filter.profileId||filter?.database!==undefined&&entry.database!==filter.database)continue;
        if(filter?.search&&!`${entry.preview} ${entry.profileName} ${entry.database} ${entry.error??''}`.toLowerCase().includes(filter.search.toLowerCase()))continue;entries.push(entry);
      }catch(error){if(!(error instanceof SyntaxError)&&!(error instanceof z.ZodError)&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;/* Corrupt/incomplete entries are ignored without executing their contents. */}finally{await file?.close();}
    }
    return entries.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)||b.id.localeCompare(a.id));
  }
  async sql(id:string):Promise<{entry:HistoryEntry;sql:string}>{
    const file=await open(this.path(id),'r');try{if((await file.stat()).size>40_065_536)throw new Error('History record exceeds its size limit.');const text=await file.readFile('utf8'),end=text.indexOf('\n');const entry=HistoryEntrySchema.parse(JSON.parse(text.slice(0,end)));if(entry.id!==id)throw new Error('History record identity mismatch.');return {entry,sql:text.slice(end+1)};}finally{await file.close();}
  }
  record(profile:ConnectionProfile,run:QueryRun,startedAt:string):Promise<void>{
    const settings={...this.settings()};if(!settings.enabled||run.status==='running'||!run.sql.trim()||run.status!=='succeeded'&&!settings.logFailedQueries)return Promise.resolve();
    if(run.sql.length>10_000_000)throw new Error('History SQL exceeds ten million characters.');
    const entry=HistoryEntrySchema.parse({version:1,id:randomUUID(),runId:run.id,startedAt,profileId:profile.id,profileName:profile.name,driver:profile.driver,database:profile.database??(profile.storage==='memory'?':memory:':profile.path),target:historyTarget(profile),status:run.status,durationMs:run.durationMs,statements:run.statements.length,rows:run.statements.reduce((n,s)=>n+(s.result?.rows.length??0),0),affectedRows:run.statements.reduce((n,s)=>n+(s.result?.affectedRows??0),0),truncated:run.statements.some(s=>s.result?.truncated),preview:run.sql.replace(/\s+/g,' ').slice(0,400),error:run.error?.slice(0,4000)});
    const sql=run.sql;if(Buffer.byteLength(JSON.stringify(entry),'utf8')>=65536)throw new Error('History metadata exceeds its size limit.');
    const task=this.tail.then(async()=>{await mkdir(this.directory,{recursive:true});const target=this.path(entry.id),temp=target+'.tmp';try{await writeFile(temp,JSON.stringify(entry)+'\n'+sql,{encoding:'utf8',flag:'wx',mode:0o600});await rename(temp,target);}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      const limit=Math.max(1,Math.min(10000,Math.floor(settings.recordsPerDatabase)||1000)),same=(await this.list()).filter(e=>e.profileId===entry.profileId&&e.target===entry.target);
      for(const old of same.slice(limit))await this.remove(old.id);this.changed();});this.tail=task.catch(()=>{});return task;
  }
  async remove(id:string):Promise<void>{await unlink(this.path(id)).catch(error=>{if(error.code!=='ENOENT')throw error;});this.changed();}
  async clear():Promise<void>{await this.tail;let files:string[];try{files=await readdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}for(const filename of files){const id=filename.replace(/\.query(?:\.tmp)?$/,'');if(idSchema.safeParse(id).success&&/\.query(?:\.tmp)?$/.test(filename))await unlink(join(this.directory,filename)).catch(error=>{if(error.code!=='ENOENT')throw error;});}this.changed();}
}
