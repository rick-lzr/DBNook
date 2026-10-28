import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from './connections.js';
import {DdlIntentSchema,type DdlIntent,type DdlPreview,type DdlReport,type TableStructure} from '../../protocol/src/ddl.js';
import {errorMessage} from '../../protocol/src/index.js';
import {readTableStructure} from './table-structure.js';
import {renderDdl} from './ddl-renderer.js';
import {ddlQuote} from './ddl-syntax.js';
import {structureFingerprint} from './structure-fingerprint.js';
import {tableMigration} from './table-migrations.js';
import {sqlTokens} from './sql-editing.js';
export {structureFingerprint} from './structure-fingerprint.js';
interface Pending{preview:DdlPreview;profileId:string;table?:string;revision:string;fingerprint?:string;expires:number;mode:string;}
export class SchemaChanges{
  private plans=new Map<string,Pending>();private busy=new Set<string>();
  constructor(private manager:ConnectionManager,private changed:(id:string)=>void=()=>{},private beforeApply:(id:string,table?:string)=>Promise<void>=async()=>{},private settled:(id:string)=>Promise<void>=async()=>{}){}
  async structure(profileId:string,table:string){return readTableStructure(await this.manager.connect(profileId),table);}
  async preview(profileId:string,table:string|undefined,input:DdlIntent,expectedFingerprint?:string):Promise<DdlPreview>{
    const intent=DdlIntentSchema.parse(input),profile=this.manager.profile(profileId);if(profile.readOnly)throw new Error('This connection is read-only. Definition viewing remains available.');
    if(this.busy.has(profileId))throw new Error('A structure change is already running for this connection.');
    const revision=this.manager.editorRevision(profileId),owner='ddl-preview:'+randomUUID(),session=await this.manager.lease(profileId,owner);
    try{
      const structure=intent.action==='createTable'?undefined:table?await readTableStructure(session,table):undefined;
      if(intent.action!=='createTable'&&!structure)throw new Error('Select an existing table.');
      if(expectedFingerprint&&(!structure||structureFingerprint(structure,profile.driver)!==expectedFingerprint))throw new Error('Server table changed while preparing the definition. Compare and preview again.');
      const rendered=intent.action==='editDefinition'?await tableMigration(this.manager,session,structure!,intent):renderDdl(profile.driver,intent,structure,session.sqlMode),token=randomUUID(),expires=Date.now()+15*60*1000;
      if(this.manager.editorRevision(profileId)!==revision)throw new Error('Connection changed during preview. Reload and preview again.');
      const preview:DdlPreview={token,profileId,intent,...rendered,expiresAt:new Date(expires).toISOString()};
      for(const [key,p] of this.plans)if(p.expires<Date.now())this.plans.delete(key);
      while(this.plans.size>=20||this.plans.size>0&&[...this.plans.values()].reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0)+Buffer.byteLength(JSON.stringify(preview))>64*1024*1024)this.plans.delete(this.plans.keys().next().value!);
      this.plans.set(token,{preview,profileId,table:structure?.name,revision,fingerprint:structure?structureFingerprint(structure,profile.driver):undefined,expires,mode:JSON.stringify(session.sqlMode??null)});return structuredClone(preview);
    }finally{await this.manager.releaseLease(owner);}
  }
  forget(token:string){this.plans.delete(token);}
  async apply(profileId:string,token:string,signal?:AbortSignal):Promise<DdlReport>{
    const plan=this.plans.get(token);if(!plan||plan.profileId!==profileId||plan.expires<Date.now())throw new Error('SQL preview expired or belongs to a different connection. Preview again.');
    if(this.busy.has(profileId))throw new Error('A structure change is already running.');
    if(this.manager.editorRevision(profileId)!==plan.revision)throw new Error('Connection settings changed after preview. Preview again.');
    if(this.manager.profile(profileId).readOnly)throw new Error('This connection is read-only.');
    this.busy.add(profileId);let session:Awaited<ReturnType<ConnectionManager['lease']>>|undefined,transaction=false,completed=0,sent=false,committing=false,committed=false;
    const warnings:string[]=[],check=()=>{if(signal?.aborted)throw new Error('Schema migration cancelled.');if(this.manager.editorRevision(profileId)!==plan.revision)throw new Error('Connection changed while applying SQL.');};
    const notify=()=>{try{this.changed(profileId);}catch(e){warnings.push((committed?'Applied, but ':'')+'metadata notification failed: '+errorMessage(e));}};
    const owner='ddl-apply:'+token,driver=this.manager.profile(profileId).driver,sqlite=driver==='sqlite';
    try{
      check();await this.beforeApply(profileId,plan.table);check();
      if(this.manager.documentSessions(profileId).some(l=>l.session?.transactionState==='active')||(await this.manager.connect(profileId)).transactionState==='active')throw new Error('Commit or roll back open SQL transactions before changing table structure.');
      session=await this.manager.lease(profileId,owner);if(JSON.stringify(session.sqlMode??null)!==plan.mode)throw new Error('SQL mode changed after preview. Preview again.');
      if(plan.preview.policy==='sqlite-rebuild'){await session.query('PRAGMA foreign_keys=OFF');await session.query('PRAGMA legacy_alter_table=ON');}
      if(plan.preview.policy!=='implicit-commit'){await session.query(sqlite?'BEGIN IMMEDIATE':'BEGIN');transaction=true;}
      if(plan.table){
        if(driver==='postgresql')await session.query(`LOCK TABLE ${plan.table} IN ACCESS EXCLUSIVE MODE`);
        const current=await readTableStructure(session,plan.table);if(structureFingerprint(current,driver)!==plan.fingerprint)throw new Error('Server table structure changed after preview. Reload the table and preview again; no changes were applied.');
      }
      // Consume once immediately before execution. A failed preview check may be corrected and retried.
      this.plans.delete(token);
      for(const step of plan.preview.steps){
        check();sent=true;const result=await session.query(step.sql,step.expect?1:0);
        if(step.expect==='empty'&&result.rows.length)throw new Error('Foreign-key validation failed; the structure change was rolled back.');
        if(step.expect==='one'&&Number(result.rows[0]?.c0)!==1)throw new Error('Row-count validation failed.');
        if(step.expect==='integrity'&&result.rows[0]?.c0!=='ok')throw new Error('SQLite integrity validation failed.');completed++;
        const first=sqlTokens(step.sql,driver,session.sqlMode).find(t=>t.kind!=='comment');if(plan.preview.policy==='implicit-commit'&&['CREATE','ALTER','DROP','RENAME','TRUNCATE'].includes(first?.text.toUpperCase()??''))committed=true;
      }
      if(plan.preview.policy==='implicit-commit'&&committed&&signal?.aborted){if(this.manager.editorRevision(profileId)!==plan.revision)throw new Error('Connection changed after DDL completed.');warnings.push('The DDL completed before cancellation took effect.');}else check();
      if(transaction){committing=true;await session.query('COMMIT');transaction=false;committing=false;}committed=true;
      notify();return {status:'succeeded',completed,committed:true,rolledBack:false,warnings,table:plan.preview.table,removed:plan.preview.intent.action==='dropTable'};
    }catch(error){
      let rolledBack=false;if(transaction&&session?.connected&&!committing){try{await session.query('ROLLBACK');rolledBack=true;}catch{}}
      const unknown=committing||sent&&!session?.connected&&!rolledBack;
      notify();return {status:unknown?'unknown':signal?.aborted?'cancelled':'failed',completed,committed,rolledBack,warnings,error:errorMessage(error),table:plan.preview.table};
    }finally{
      // Closing the isolated session also discards migration-only pragmas and any failed transaction.
      try{await this.manager.releaseLease(owner);}catch(e){warnings.push((committed?'Applied, but ':'')+'session cleanup failed: '+errorMessage(e));}finally{try{await this.settled(profileId);}catch(e){warnings.push((committed?'Applied, but ':'')+'editor refresh failed: '+errorMessage(e));}finally{this.busy.delete(profileId);}}
    }
  }
}
