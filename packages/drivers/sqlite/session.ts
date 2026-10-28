import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { DriverSession } from '../../driver-sdk/src/index.js';
import {checkAbort,type StreamConsumer} from '../../core/src/data-stream.js';
import { PROTOCOL_VERSION, type ApplyReport, type ConnectionProfile, type QueryResult, type QueryRun, type RunStatement, type RowChange, type RpcResponse, type RunnerEvent, type RunnerRequest, type RuntimeInfo, type SchemaObject, type TableDetails, type TableRequest, type TransactionState } from '../../protocol/src/index.js';

export class SessionLostError extends Error { readonly sessionLost = true; }
export class SqliteSession implements DriverSession {
  readonly id = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; owner?: string; state(value: TransactionState): void; progress?: (statement: RunStatement) => void;backupProgress?:(value:{totalPages:number;remainingPages:number})=>void }>();
  private stderr = '';
  private opening = false;
  private runtimeInfo?: RuntimeInfo;
  private currentTransaction: TransactionState = 'unknown';
  private closed = false;
  constructor(readonly profile: ConnectionProfile, private options: { runnerPath: string; nodePath?: string; log?: (message: string) => void }, private binding?: { parent: SqliteSession; sessionId: string }) {}
  get connected(): boolean { return Boolean(this.runtimeInfo && !this.closed && (this.binding ? this.binding.parent.connected : this.child)); }
  get info(): RuntimeInfo | undefined { return this.connected ? this.runtimeInfo : undefined; }
  get transactionState(): TransactionState { return this.connected ? this.currentTransaction : 'unknown'; }
  sibling(): SqliteSession {
    if (!this.connected) throw new SessionLostError('The shared in-memory database process is closed. Reconnect explicitly before opening another document.');
    return new SqliteSession(this.profile, this.options, { parent: this, sessionId: randomUUID() });
  }
  async createSibling(): Promise<SqliteSession> {
    const session = this.sibling(); await session.open(); return session;
  }
  async open(): Promise<RuntimeInfo> {
    if (this.connected) return this.runtimeInfo!;
    if (this.closed) throw new SessionLostError('This document session was released. Open a new session explicitly.');
    if (this.opening) throw new Error('Connection is already opening.');
    this.opening = true;
    try {
      if (this.binding) {
        const info = await this.binding.parent.dispatch<RuntimeInfo>({ method: 'session.create', params: { sessionId: this.binding.sessionId } }, undefined, value => { this.currentTransaction = value; });
        if (this.closed) throw new SessionLostError('This document session was closed while opening.');
        this.runtimeInfo = info; return info;
      }
      const child = spawn(this.options.nodePath || process.execPath, [this.options.runnerPath], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      this.child = child;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        try {
          const response = JSON.parse(line) as RpcResponse | RunnerEvent;
          if (response.version !== PROTOCOL_VERSION || typeof response.id !== 'string') throw new Error('Runner protocol mismatch.');
          const request = this.pending.get(response.id);
          if (!request) return;
          if (response.session) request.state(response.session.transaction);
          if ('event' in response) { if(response.event==='backup.progress')request.backupProgress?.(response.progress);else request.progress?.(response.statement); return; }
          this.pending.delete(response.id);
          response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
        } catch { this.fail(new SessionLostError('Invalid response from database runner.')); child.kill(); }
      });
      child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8000); this.options.log?.(chunk.toString()); });
      child.on('error', error => { if (this.child === child) { this.child = undefined; this.runtimeInfo = undefined; this.fail(error); } });
      child.on('exit', (code, signal) => {
        lines.close();
        if (this.child === child) {
          this.child = undefined; this.runtimeInfo = undefined;
          this.fail(new SessionLostError(`Database runner exited (${signal || code}). ${this.stderr.includes('node:sqlite') ? 'Use Node.js 22.16+ in DBNook: Node Path. ' : ''}${this.stderr.trim()}`));
        }
      });
      const timer = setTimeout(() => { this.fail(new Error('Database runner startup timed out.')); child.kill(); }, 15000);
      try { this.runtimeInfo = await this.call<RuntimeInfo>({ method: 'open', params: this.profile }); }
      catch (error) { child.kill(); throw error; }
      finally { clearTimeout(timer); }
      return this.runtimeInfo;
    } finally { this.opening = false; }
  }
  private fail(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  private call<T>(request: RunnerRequest, progress?: (statement: RunStatement) => void,backupProgress?:(value:{totalPages:number;remainingPages:number})=>void): Promise<T> {
    if (this.binding) {
      if (!this.connected) return Promise.reject(new SessionLostError('The document session was lost. Reset its session explicitly; an interrupted transaction will not be replayed.'));
      return this.binding.parent.dispatch(request, this.binding.sessionId, value => { this.currentTransaction = value; }, progress,backupProgress);
    }
    return this.dispatch(request, undefined, value => { this.currentTransaction = value; }, progress,backupProgress);
  }
  private dispatch<T>(request: RunnerRequest, sessionId: string | undefined, state: (value: TransactionState) => void, progress?: (statement: RunStatement) => void,backupProgress?:(value:{totalPages:number;remainingPages:number})=>void): Promise<T> {
    if (!this.child || this.child.killed) return Promise.reject(new SessionLostError('Connection is closed. Reconnect before running another operation.'));
    const child = this.child;
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const owner = sessionId ?? (request.method === 'session.create' || request.method === 'session.release' ? request.params.sessionId : undefined);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, owner, state, progress,backupProgress });
      child.stdin.write(JSON.stringify({ version: PROTOCOL_VERSION, id, sessionId, request }) + '\n', error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }
  schema(): Promise<SchemaObject[]> { return this.call({ method: 'schema', params: {} }); }
  inspectFile():Promise<import('../../protocol/src/index.js').SqliteFileInfo>{return this.call({method:'backup.inspect',params:{}});}
  async backupFile(path:string,progress?:(value:{totalPages:number;remainingPages:number})=>void,signal?:AbortSignal):Promise<number>{
    checkAbort(signal);let callbackError:unknown,cancellation:Promise<unknown>|undefined;const operation=randomUUID(),abort=()=>{cancellation??=this.call({method:'backup.cancel',params:{operation}}).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{const pages=await this.call<number>({method:'backup.to',params:{path,operation}},undefined,p=>{if(callbackError)return;try{progress?.(p);}catch(e){callbackError=e;abort();}});if(callbackError)throw callbackError;checkAbort(signal);return pages;}catch(e){throw callbackError??e;}finally{signal?.removeEventListener('abort',abort);await cancellation;}
  }
  details(table: string): Promise<TableDetails> { return this.call({ method: 'details', params: { table } }); }
  table(request: TableRequest): Promise<QueryResult> { return this.call({ method: 'table', params: request }); }
  query(sql: string, limit = 100000): Promise<QueryResult> { return this.call({ method: 'query', params: { sql, limit } }); }
  async stream(sql:string,batchSize:number,consume:StreamConsumer,signal?:AbortSignal):Promise<void>{
    checkAbort(signal);if(this.transactionState==='active')throw new Error('Commit or roll back before read-only export.');let cursor:string|undefined;
    // Shared in-memory cancellation must not kill sibling sessions or destroy their data.
    const abort=()=>{if(this.profile.storage!=='memory')void this.cancel();};signal?.addEventListener('abort',abort,{once:true});
    try{cursor=(await this.call<{id:string}>({method:'cursor.open',params:{sql}})).id;checkAbort(signal);
      for(;;){checkAbort(signal);const result=await this.call<{batch:QueryResult;done:boolean}>({method:'cursor.next',params:{id:cursor,size:batchSize}});checkAbort(signal);await consume(result.batch);if(result.done)break;}
    }finally{signal?.removeEventListener('abort',abort);if(cursor&&this.connected)await this.call({method:'cursor.close',params:{id:cursor}});}
  }
  run(sql: string, limit: number, runId: string, progress?: (statement: RunStatement) => void): Promise<QueryRun> { return this.call({ method: 'run', params: { sql, limit, runId } }, progress); }
  apply(table: string, keyColumns: string[], changes: RowChange[], options?: import('../../protocol/src/index.js').ApplyOptions): Promise<ApplyReport> { return this.call({ method: 'apply', params: { table, keyColumns, changes, requireAutocommit: options?.requireAutocommit ?? true,expected:options?.expected,verifyValues:options?.verifyValues??false } }); }
  async cancel(): Promise<boolean> {
    if (this.binding) {
      if (![...this.binding.parent.pending.values()].some(request => request.owner === this.binding!.sessionId)) return false;
      return this.binding.parent.cancel();
    }
    if (!this.child || !this.pending.size) return false;
    const child = this.child; this.child = undefined; this.runtimeInfo = undefined;
    const consequence = this.profile.storage === 'memory' ? 'All sessions sharing this in-memory connection were terminated and its database contents are lost.' : 'Uncommitted work in this session was rolled back; completed autocommit statements may have persisted.';
    this.fail(new SessionLostError(`Query cancelled. ${consequence} Reset the document session to continue.`));
    child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
    return true;
  }
  async close(): Promise<void> {
    if (this.binding) {
      if (this.closed) return; this.closed = true; this.runtimeInfo = undefined;
      const { parent, sessionId } = this.binding;
      if ([...parent.pending.values()].some(request => request.owner === sessionId)) await parent.cancel();
      else if (parent.connected) await parent.dispatch({ method: 'session.release', params: { sessionId } }, undefined, () => {});
      return;
    }
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    // Wait for the actual process exit, not only an RPC response, so file locks
    // are released before disconnect resolves.
    this.child = undefined; this.runtimeInfo = undefined;
    this.fail(new SessionLostError('Connection disconnected. Pending operations were stopped.'));
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await exited;
  }
}
