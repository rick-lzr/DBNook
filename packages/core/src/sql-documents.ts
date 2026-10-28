import type { ConnectionManager } from './connections.js';
import type { DriverSession } from '../../driver-sdk/src/index.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { errorMessage, type ConnectionProfile, type QueryResult, type QueryRun, type QuerySessionState } from '../../protocol/src/index.js';
import {resolveSqlParameters,runParameterizedSql,type ParameterResolver} from './sql-parameter-run.js';
import {renderSqlParameters} from './sql-parameters.js';
import type {SqlParameterValue} from '../../protocol/src/sql-parameters.js';

/** SQL text, results and transaction controls share this document identity. */
export class SqlDocuments {
  private bindings = new Map<string, string>();
  private running = new Set<string>();
  private generations = new Map<string, number>();
  private operationVersions=new Map<string,number>();
  private runs = new Map<string, QueryRun>();
  private scopes=new Map<string,{abort:AbortController;done:Promise<void>;finish():void}>();
  private parameterResolver?:ParameterResolver;
  private parameterEnabled=()=>true;
  private parameterCache=new Map<string,{session:string;revision:string;values:Map<string,{signature:string;value:SqlParameterValue}>}>();
  private parameterInputs=new Set<string>();
  constructor(private manager: ConnectionManager, private changed: () => void = () => {}, private observer?: { finished(profile:ConnectionProfile,run:QueryRun,startedAt:string):Promise<void>|void; error(error:unknown):void }) {}
  configureParameters(resolve:ParameterResolver,enabled=()=>true){this.parameterResolver=resolve;this.parameterEnabled=enabled;}
  get parametersEnabled(){return Boolean(this.parameterResolver&&this.parameterEnabled());}
  clearParameters(owner:string){this.parameterCache.delete(owner);}
  private resolver(owner:string,guard:()=>void):ParameterResolver{return async(form,session,signal)=>{
    const revision=this.manager.editorRevision(session.profile.id),saved=this.parameterCache.get(owner),cache=saved?.session===session.id&&saved.revision===revision?saved.values:new Map<string,{signature:string;value:SqlParameterValue}>();
    const signature=(key:string)=>{const p=form.parameters.find(p=>p.key===key);return JSON.stringify([p?.key,p?.type,p?.defaultValue,p?.options]);};
    const values=form.values.map(v=>{const entry=cache.get(v.key);return entry?.signature===signature(v.key)?entry.value:v;});
    this.parameterInputs.add(owner);const accepted=await this.parameterResolver!({...form,values},session,signal);guard();
    if(signal.aborted)throw new Error('SQL parameter input cancelled.');if(this.connection(owner)!==session.profile.id||this.manager.editorRevision(session.profile.id)!==revision)throw new Error('Connection settings changed during parameter input. Run again.');
    renderSqlParameters(form.sql,{parameters:form.parameters,occurrences:[]},accepted,session.profile.driver,session.sqlMode);
    for(const value of accepted)cache.set(value.key,{signature:signature(value.key),value:{...value}});this.parameterCache.set(owner,{session:session.id,revision,values:cache});return accepted;
  };}
  async prepareParameters(owner:string,sql:string,session:DriverSession,signal:AbortSignal,guard:()=>void=()=>{}):Promise<string>{
    if(!this.parametersEnabled)return sql;const {scan,values}=await resolveSqlParameters(sql,session,signal,this.resolver(owner,guard),guard);if(scan.deferredAt!==undefined)throw new Error('Use script execution to resolve SQL parameters after a dynamic session mode change.');return renderSqlParameters(sql,scan,values,session.profile.driver,session.sqlMode);
  }
  private async finished(profile:ConnectionProfile,run:QueryRun,startedAt:string){try{await this.observer?.finished(profile,run,startedAt);}catch(error){this.observer?.error(error);}}
  connection(owner: string): string | undefined { return this.bindings.get(owner); }
  operationVersion(owner:string):number{return this.operationVersions.get(owner)??0;}
  useSession<T>(owner:string,action:(session:DriverSession,signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(this.running.has(owner))return Promise.reject(new Error('This SQL document already has a running operation.'));
    let finish!:()=>void;const scope={abort:new AbortController(),done:new Promise<void>(resolve=>{finish=resolve;}),finish:()=>finish()};this.scopes.set(owner,scope);
    return this.operate(owner,session=>action(session,scope.abort.signal)).finally(()=>{this.scopes.delete(owner);scope.finish();});
  }
  state(owner: string): QuerySessionState {
    const session = this.manager.documentSession(owner);
    return { owner, connected: session?.connected ?? false, lost: Boolean(session && !session.connected), transaction: session?.transactionState ?? 'unknown', busy: this.running.has(owner) };
  }
  async bind(owner: string, profileId: string): Promise<void> {
    if (!owner) throw new Error('A SQL document requires an identity.');
    this.manager.profile(profileId);
    if (this.running.has(owner)) throw new Error('Cancel the current query before switching this document connection.');
    if (this.bindings.get(owner) === profileId) return;
    const generation = this.generations.get(owner) ?? 0; this.running.add(owner); this.changed();
    try {
      await this.manager.releaseLease(owner);
      if ((this.generations.get(owner) ?? 0) !== generation) throw new Error('The SQL document closed while switching connections.');
      this.bindings.set(owner, profileId);
      this.clearParameters(owner);
      this.runs.delete(owner);
    } finally { this.running.delete(owner); this.changed(); }
  }
  private async operate<T>(owner: string, action: (session: DriverSession) => Promise<T>): Promise<T> {
    const profileId = this.bindings.get(owner); if (!profileId) throw new Error('The source SQL document is closed or has no selected connection.');
    if (this.running.has(owner)) throw new Error('This SQL document already has a running operation.');
    this.running.add(owner); this.changed();
    this.operationVersions.set(owner,this.operationVersion(owner)+1);
    try {
      const session = await this.manager.lease(profileId, owner);
      if (this.bindings.get(owner) !== profileId) throw new Error('The source SQL document closed while connecting.');
      return await action(session);
    }
    finally { this.running.delete(owner); this.changed(); }
  }
  execute(owner: string, sql: string, limit = 100000): Promise<QueryResult> { return this.useSession(owner, async (session,signal) => {
    this.parameterInputs.delete(owner);
    const profile={...session.profile},startedAt=new Date().toISOString(),started=performance.now();
    const run:QueryRun={id:randomUUID(),sql,status:'succeeded',statements:[],durationMs:0,transaction:session.transactionState};
    let cancellation:Promise<boolean>|undefined;const cancel=()=>{cancellation??=session.cancel();void cancellation.catch(()=>{});};
    try{const actual=await this.prepareParameters(owner,sql,session,signal);if(signal.aborted)throw new Error('SQL execution cancelled.');signal.addEventListener('abort',cancel,{once:true});const result=await session.query(actual,limit);run.statements=[{index:0,start:0,end:sql.length,sql,status:'succeeded',result}];return result;}
    catch(error){run.status='failed';run.error=errorMessage(error);throw error;}
    finally{signal.removeEventListener('abort',cancel);if(cancellation)await cancellation;run.durationMs=performance.now()-started;run.transaction=session.transactionState;await this.finished(profile,this.historyRun(owner,run),startedAt);}
  }); }
  private historyRun(owner:string,run:QueryRun):QueryRun{return this.parameterInputs.has(owner)?{...run,error:run.error?'SQL execution failed. Detailed errors are available in the current result view.':undefined,statements:run.statements.map(s=>({...s,error:s.error?'SQL execution failed.':undefined}))}:run;}
  lastRun(owner: string): QueryRun | undefined { return this.runs.get(owner); }
  run(owner: string, sql: string, limit = 100000, sourceOffset = 0,singleStatement=false,guard:()=>void=()=>{}): Promise<QueryRun> {
    return this.useSession(owner, async (session,signal) => {
      this.parameterInputs.delete(owner);
      const started = performance.now();
      const startedAt=new Date().toISOString(),profile={...session.profile};
      let run: QueryRun = { id: randomUUID(), sql, sourceOffset, status: 'running', statements: [], durationMs: 0, transaction: session.transactionState };
      this.runs.set(owner, run); this.changed();
      try {
        const progress=(statement:import('../../protocol/src/index.js').RunStatement) => {
          run.statements.push(statement); run.durationMs = Math.round((performance.now() - started) * 100) / 100; run.transaction = session.transactionState;
          if (this.bindings.has(owner)) this.changed();
        };
        let report:QueryRun;
        if(this.parametersEnabled)report=await runParameterizedSql(session,sql,limit,run.id,signal,this.resolver(owner,guard),progress,singleStatement,guard);
        else{let cancellation:Promise<boolean>|undefined;const cancel=()=>{cancellation??=session.cancel();void cancellation.catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});try{guard();if(signal.aborted)throw new Error('SQL execution cancelled.');report=await session.run(sql,limit,run.id,progress,{singleStatement});}finally{signal.removeEventListener('abort',cancel);if(cancellation)await cancellation;}}
        run = { ...report, sourceOffset };
      } catch (error) {
        run = { ...run, status: signal.aborted||(error as Error).name==='AbortError'||(error as { sessionLost?: boolean }).sessionLost && /cancelled|disconnected/i.test(errorMessage(error)) ? 'cancelled' : 'failed', error: errorMessage(error), transaction: session.transactionState, durationMs: Math.round((performance.now() - started) * 100) / 100 };
      }
      if (this.bindings.has(owner)) { this.runs.set(owner, run); this.changed(); }
      await this.finished(profile,this.historyRun(owner,run),startedAt);
      return run;
    });
  }
  transaction(owner: string, action: 'begin' | 'commit' | 'rollback'): Promise<QueryResult> {
    return this.operate(owner, async session => {
      if (action === 'begin' && session.transactionState === 'active') throw new Error('This document already has an active transaction.');
      if (action !== 'begin' && session.transactionState !== 'active') throw new Error('This document has no active transaction.');
      return session.query(action === 'begin' ? 'BEGIN' : action.toUpperCase());
    });
  }
  async cancel(owner: string): Promise<boolean> {const scope=this.scopes.get(owner);if(scope){scope.abort.abort();this.changed();return true;}const cancelled = await this.manager.cancelLease(owner); this.changed(); return cancelled; }
  async reset(owner: string): Promise<void> {
    if (this.running.has(owner)) throw new Error('Cancel the current query before resetting this document session.');
    const profileId = this.bindings.get(owner); if (!profileId) throw new Error('Select a connection for this SQL document first.');
    const generation = this.generations.get(owner) ?? 0; this.running.add(owner); this.changed();
    try {
      this.clearParameters(owner);
      await this.manager.releaseLease(owner);
      if (this.bindings.get(owner) !== profileId || (this.generations.get(owner) ?? 0) !== generation) throw new Error('The SQL document closed while resetting its session.');
      await this.manager.lease(profileId, owner);
    } finally { this.running.delete(owner); this.changed(); }
  }
  async close(owner: string): Promise<boolean> {
    const scope=this.scopes.get(owner);if(scope){scope.abort.abort();await scope.done;}
    const hadTransaction = this.state(owner).transaction === 'active'; this.bindings.delete(owner); this.runs.delete(owner);this.operationVersions.delete(owner); this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
    this.clearParameters(owner);
    this.parameterInputs.delete(owner);
    await this.manager.releaseLease(owner); this.changed(); return hadTransaction;
  }
  activeTransactions(profileId: string): string[] { return this.manager.documentSessions(profileId).filter(lease => lease.session?.transactionState === 'active').map(lease => lease.owner); }
}
