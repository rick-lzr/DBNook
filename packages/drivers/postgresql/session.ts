import { Client, Query, types, type QueryArrayConfig, type FieldDef, type QueryResult as PgResult } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DriverSession } from '../../driver-sdk/src/index.js';
import {checkAbort,exportStatement,type StreamConsumer} from '../../core/src/data-stream.js';
import {cancelServerRequest} from '../../core/src/server-cancellation.js';
import {verifyTableSnapshot,verifyWrittenValues} from '../../core/src/table-snapshot.js';
import { SessionLostError } from '../sqlite/session.js';
import { errorMessage, type ApplyReport, type CellValue, type ColumnMeta, type ConnectionProfile, type DataRow, type QueryResult, type QueryRun, type RowChange, type RunStatement, type RuntimeInfo, type SchemaObject, type TableDetails, type TableRequest, type TransactionState } from '../../protocol/src/index.js';
import { postgresStatements, quotePg } from './sql.js';
import type {EndpointLease} from '../../core/src/tunnels.js';

const plainTypes = { getTypeParser: () => (value: string) => value };
const valueOf = (value: string | null, oid: number): CellValue => {
  if (value === null) return null;
  if (oid === 16) return value === 't';
  if (oid === 20 || oid === 21 || oid === 23 || oid === 26) { const number = BigInt(value); return number <= BigInt(Number.MAX_SAFE_INTEGER) && number >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(number) : { type: 'integer', value }; }
  if (oid === 700 || oid === 701) return Number.isFinite(Number(value)) ? Number(value) : value;
  if (oid === 17) return { type: 'binary', base64: (types.getTypeParser(17)(value) as Buffer).toString('base64') };
  return value; // Numeric, JSON, arrays and timestamps retain their exact server text.
};
const parameter = (value: CellValue): unknown => typeof value === 'object' && value ? value.type === 'integer' ? value.value : Buffer.from(value.base64, 'base64') : value;
export class PostgresSession implements DriverSession {
  readonly id = randomUUID();
  private client?: Client;
  private ready = false;
  private closed = false;
  private opening = false;
  private busy = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private runtimeInfo?: RuntimeInfo;
  private typeNames = new Map<number, string>();
  private endpoint?:EndpointLease;private abort=new AbortController();
  private authenticated?:{user:string;password?:string};private backendId?:number;private activeRequest?:string;private cancelling=false;private cancellation?:Promise<boolean>;private encrypted=false;
  private get marker(){return `/* DBW:${this.id} */ `;}
  constructor(readonly profile: ConnectionProfile, private password: () => Promise<string | undefined> = async () => undefined,private options:{credentials?:()=>Promise<{user:string;password?:string}>;endpoint?:(signal:AbortSignal)=>Promise<EndpointLease>}={}) {}
  get connected(): boolean { return this.ready && !this.closed && !this.cancelling && (!this.endpoint||this.endpoint.active()); }
  get info(): RuntimeInfo | undefined { return this.connected ? this.runtimeInfo : undefined; }
  get transactionState(): TransactionState { const state = this.client?.getTransactionStatus(); return !this.connected ? 'unknown' : state === 'I' ? 'idle' : state === 'T' || state === 'E' ? 'active' : 'unknown'; }
  async open(): Promise<RuntimeInfo> {
    if (this.connected) return this.runtimeInfo!;
    if (this.closed || this.client || this.opening) throw new SessionLostError('This PostgreSQL session is closed or already opening. Reset it explicitly.');
    this.opening=true;
    try { return await this.openClient(); } catch(error){this.closed=true;await this.endClient();await this.releaseEndpoint();throw error;}finally { this.opening=false; }
  }
  private async openClient(): Promise<RuntimeInfo> {
    const p = this.profile;
    const credentials=this.options.credentials?await this.options.credentials():{user:p.user!,password:await this.password()};
    if(this.closed)throw new SessionLostError('Connection closed before authentication.');
    if(this.options.endpoint)this.endpoint=await this.options.endpoint(this.abort.signal);
    const mode=p.host?.startsWith('/')?'disable':p.sslMode??'disable';
    const verifiesCA=mode==='verify-full'||mode==='verify-ca'||mode==='require'&&Boolean(p.caPath);
    const ssl = mode !== 'disable' ? {
      rejectUnauthorized: verifiesCA,
      ...(this.endpoint?{host:p.host,...(p.host?.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(p.host??'')?{}:{servername:p.host})}:{}),
      ...(verifiesCA&&mode!=='verify-full'?{checkServerIdentity:()=>undefined}:{}),
      ...(p.caPath ? { ca: await readFile(p.caPath, 'utf8') } : {}),
      ...(p.certPath ? { cert: await readFile(p.certPath, 'utf8'), key: await readFile(p.keyPath!, 'utf8') } : {}),
    } : false;
    const password = credentials.password;
    if (this.closed) throw new SessionLostError('Connection closed before authentication.');
    const attempts=mode==='prefer'?[true,false]:mode==='allow'?[false,true]:[mode!=='disable'];
    const timeout=p.connectTimeout??15000,deadline=timeout?Date.now()+timeout:Infinity;let encrypted=false;
    try {
      for(let index=0;index<attempts.length;index++) {
        if(this.closed)throw new SessionLostError('Connection closed before authentication.');
        const remaining=deadline-Date.now();if(remaining<=0)throw new Error('PostgreSQL connection timed out.');
        const client = new Client({ host:this.endpoint?.host??p.host!,port:this.endpoint?.port??p.port??5432,database:p.database!,user:credentials.user,password:()=>password??'',ssl:attempts[index]?ssl:false,
          connectionTimeoutMillis:timeout?remaining:0,application_name:p.applicationName||'DBNook',options:'-c standard_conforming_strings=on'+(p.readOnly?' -c default_transaction_read_only=on':''),
        });this.client=client;
        client.on('error',()=>{if(this.client===client)this.ready=false;});client.on('end',()=>{if(this.client===client){this.ready=false;if(!this.opening)void this.releaseEndpoint();}});
        try {await client.connect();encrypted=Boolean(attempts[index]);break;}
        catch(error) {await client.end().catch(()=>{});if(this.closed||index+1===attempts.length)throw error;}
      }
      if (this.closed) throw new SessionLostError('Connection closed while authenticating.');
      this.encrypted=encrypted;this.authenticated={...credentials};this.backendId=Number((await this.raw('SELECT pg_backend_pid()')).rows[0]![0]);
      const version = await this.raw('SHOW server_version');
      const names = await this.raw('SELECT oid, format_type(oid,NULL) AS name FROM pg_catalog.pg_type');
      for (const row of names.rows) this.typeNames.set(Number(row[0]), row[1]!);
      this.ready = true;
      this.runtimeInfo = { sqlite: '', driver: 'postgresql', serverVersion: version.rows[0]![0], node: process.versions.node, path: `${p.host}:${p.port ?? 5432}/${p.database}`,tls:!encrypted?'disabled':verifiesCA?mode==='verify-full'?'verify-full':'verify-ca':'encrypted' };
      return this.runtimeInfo;
    } catch (error) { await this.client?.end().catch(() => {}); this.closed = true; throw error; }
  }
  private operation<T>(action: () => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => { if (!this.connected) throw new SessionLostError('PostgreSQL session lost. Reset explicitly; interrupted statements will not be replayed.'); this.busy++; try { return await action(); } finally { this.busy--; } });
    this.tail = task.catch(() => {}); return task;
  }
  private async raw(sql: string, values: unknown[] = [], maxRows = 0,maxBytes=0): Promise<PgResult<string[]>> {
    if(this.closed||this.cancelling)throw new SessionLostError('PostgreSQL session disconnected or cancelled. Reset explicitly.');
    const config: QueryArrayConfig & { queryMode: 'extended' } = { text: this.marker+sql, values, rowMode: 'array', types: plainTypes, queryMode: 'extended' };
    return new Promise((resolve,reject) => {
      const request=randomUUID();this.activeRequest=request;const done=()=>{if(this.activeRequest===request)this.activeRequest=undefined;};
      const query = new Query(config), rows: string[][] = [];let bytes=0,overflow=false;
      query.on('row', row => {if(overflow)return;if(maxBytes){bytes+=row.reduce((n:number,v:string|null)=>n+(v===null?0:Buffer.byteLength(v)),0);if(bytes>maxBytes){overflow=true;reject(new Error('PostgreSQL export batch exceeds 32 MB. Use a smaller batch or native large-object export.'));void this.close();return;}}if (!maxRows || rows.length < maxRows) rows.push(row); });
      query.on('error',error=>{const e=error as Error&{position?:string;code?:string};if(e.code&&/^[0-9A-Z]{5}$/.test(e.code))done();if(e.position&&/^\d+$/.test(e.position))e.position=String(Math.max(1,Number(e.position)-this.marker.length));reject(this.cancelling?new SessionLostError('PostgreSQL session closed during cancellation. Inspect the server before repeating the statement. '+errorMessage(e),{cause:e}):e);}); query.on('end',result =>{done();resolve({...result,rows});}); this.client!.query(query);
    });
  }
  private columns(fields: FieldDef[]): ColumnMeta[] { return fields.map((field, i) => ({ key: `c${i}`, name: field.name, dataType: this.typeNames.get(field.dataTypeID) ?? `oid:${field.dataTypeID}`, nullable: true, primaryKey: 0, generated: false })); }
  private async execute(sql: string, limit = 100000, values: unknown[] = [],maxBytes=0): Promise<QueryResult> {
    if (/^\s*COPY\b[\s\S]*\b(?:STDIN|STDOUT)\b/i.test(sql)) throw new Error('COPY streaming requires a dedicated import/export workflow, which is not implemented yet.');
    if (this.profile.readOnly) {
      if (/\b(?:READ\s+WRITE|SET\s+(?:(?:LOCAL|SESSION)\s+)?(?:TRANSACTION|default_transaction_read_only|transaction_read_only)|RESET\s+(?:ALL|default_transaction_read_only))\b/i.test(sql)) throw new Error('This connection is read-only.');
      if (this.transactionState === 'idle') await this.raw('SET default_transaction_read_only = on');
    }
    const started = performance.now(), result = await this.raw(sql, values, limit ? limit+1 : 0,maxBytes);
    const rows = (limit ? result.rows.slice(0, limit) : result.rows).map(row => Object.fromEntries(row.map((v, i) => [`c${i}`, valueOf(v, result.fields[i]!.dataTypeID)])));
    return { columns: this.columns(result.fields), rows, affectedRows: /^(INSERT|UPDATE|DELETE|MERGE|COPY)$/.test(result.command) ? result.rowCount ?? 0 : 0, truncated: Boolean(limit && result.rows.length > limit), durationMs: Math.round((performance.now() - started) * 100) / 100, sql, readOnly: true };
  }
  query(sql: string, limit = 100000): Promise<QueryResult> { return this.operation(() => this.execute(sql, limit)); }
  stream(sql:string,batchSize:number,consume:StreamConsumer,signal?:AbortSignal):Promise<void>{return this.operation(async()=>{
    checkAbort(signal);batchSize=Math.max(1,Math.min(2000,Math.floor(batchSize)));if(this.transactionState!=='idle')throw new Error('Export needs a dedicated idle session.');sql=exportStatement(sql,'postgresql');const name='dbw_export_'+randomUUID().replaceAll('-','');
    const abort=()=>{void this.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{await this.raw('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.raw(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`);
      for(;;){checkAbort(signal);const batch=await this.execute(`FETCH FORWARD ${batchSize} FROM ${name}`,0,[],32_000_000);batch.sql=sql;await consume(batch);if(batch.rows.length<batchSize)break;}
    }finally{signal?.removeEventListener('abort',abort);if(this.connected)await this.raw('ROLLBACK').catch(()=>{});}
  });}
  run(sql: string, limit: number, id: string, progress?: (statement: RunStatement) => void): Promise<QueryRun> {
    return this.operation(async () => {
      const started = performance.now(), run: QueryRun = { id, sql, status: 'running', statements: [], durationMs: 0, transaction: this.transactionState };
      for (const source of postgresStatements(sql)) {
        let item: RunStatement;
        try { item = { ...source, index: run.statements.length, status: 'succeeded', result: await this.execute(source.sql, limit) }; }
        catch (error) { item = { ...source, index: run.statements.length, status: 'failed', error: errorMessage(error) }; run.error = item.error; run.status = this.closed||this.cancelling ? 'cancelled' : 'failed'; }
        run.statements.push(item); progress?.(item); if (run.status !== 'running') break;
      }
      if (run.status === 'running') run.status = 'succeeded'; run.transaction = this.transactionState; run.durationMs = Math.round((performance.now() - started) * 100) / 100; return run;
    });
  }
  private async objects(): Promise<SchemaObject[]> {
    const result = await this.raw(`SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname), c.relkind, CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END,n.nspname,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND has_schema_privilege(n.oid,'USAGE') ORDER BY n.nspname,c.relname`);
    return result.rows.map(row => ({ name: row[0]!, type: ['v', 'm'].includes(row[1]!) ? 'view' : 'table', sql: row[2] ?? null, schema: row[3], label: row[4] }));
  }
  schema(): Promise<SchemaObject[]> { return this.operation(() => this.objects()); }
  private async relation(name: string): Promise<{ oid: string; sql: string; type: 'table' | 'view' }> {
    const result = await this.raw(`SELECT c.oid::text, quote_ident(n.nspname)||'.'||quote_ident(c.relname), c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1) AND c.relkind IN ('r','p','v','m')`, [name]);
    if (!result.rows.length) throw new Error('The table or view no longer exists.');
    const row = result.rows[0]!; return { oid: row[0]!, sql: row[1]!, type: ['v','m'].includes(row[2]!) ? 'view' : 'table' };
  }
  private async describe(name: string): Promise<TableDetails> {
    const relation = await this.relation(name);
    const result = await this.raw(`SELECT a.attname,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,COALESCE((SELECT k.n FROM unnest(i.indkey) WITH ORDINALITY k(attnum,n) WHERE k.attnum=a.attnum AND k.n<=i.indnkeyatts),0),a.attgenerated <> '' OR a.attidentity='a',pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=a.attrelid AND i.indisprimary WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation.oid]);
    const columns: ColumnMeta[] = result.rows.map(row => ({ key: row[0]!, name: row[0]!, dataType: row[1]!, nullable: row[2] === 't', primaryKey: Number(row[3]), generated: row[4] === 't', defaultValue: row[5] }));
    const indexes = await this.raw(`SELECT ci.relname,i.indisunique,COALESCE((SELECT json_agg(pg_get_indexdef(i.indexrelid,k.n,true) ORDER BY k.n)::text FROM generate_series(1,i.indnkeyatts) k(n)),'[]') FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=$1 ORDER BY ci.relname`, [relation.oid]);
    const fks = await this.raw(`SELECT k.oid::text,k.confrelid::regclass::text,a.attname,b.attname,k.confupdtype,k.confdeltype FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey,k.confkey) WITH ORDINALITY AS x(akey,bkey,n) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.akey JOIN pg_attribute b ON b.attrelid=k.confrelid AND b.attnum=x.bkey WHERE k.conrelid=$1 AND k.contype='f' ORDER BY k.oid,x.n`, [relation.oid]);
    const actions: Record<string,string> = { a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT' };
    const definition = relation.type === 'view' ? (await this.raw('SELECT pg_get_viewdef($1::oid,true)', [relation.oid])).rows[0]![0] : null;
    return { name: relation.sql, type: relation.type, sql: definition ?? null, columns, indexes: indexes.rows.map(row => ({ name:row[0]!,unique:row[1]==='t',columns:JSON.parse(row[2]!) as string[] })), foreignKeys:fks.rows.map(row=>({id:Number(row[0]),table:row[1]!,from:row[2]!,to:row[3]!,onUpdate:actions[row[4]!]!,onDelete:actions[row[5]!]!})) };
  }
  details(table: string): Promise<TableDetails> { return this.operation(() => this.describe(table)); }
  table(request: TableRequest): Promise<QueryResult> {
    return this.operation(async () => {
      const details = await this.describe(request.table);
      if (request.order.some(order => !details.columns.some(column => column.name === order.column))) throw new Error('Unknown sort column.');
      const order = [...request.order];
      for (const column of details.columns.filter(column=>column.primaryKey).sort((a,b)=>a.primaryKey-b.primaryKey)) if (!order.some(item=>item.column===column.name)) order.push({column:column.name,direction:'asc'});
      const sql = `SELECT * FROM ${details.name}${request.where.trim() ? ` WHERE ${request.where}` : ''}${order.length ? ` ORDER BY ${order.map(order=>`${quotePg(order.column)} ${order.direction === 'desc' ? 'DESC' : 'ASC'}`).join(',')}` : ''} LIMIT $1 OFFSET $2`;
      const result = await this.execute(sql, request.limit, [request.limit+1, request.offset]);
      result.rows = result.rows.map(row => Object.fromEntries(details.columns.map((column,i)=>[column.name,row[`c${i}`]!])));
      result.columns = details.columns; result.sourceTable = details.name; result.readOnly = this.profile.readOnly || details.type !== 'table'; return result;
    });
  }
  apply(table: string, keys: string[], changes: RowChange[], options?: import('../../protocol/src/index.js').ApplyOptions): Promise<ApplyReport> {
    return this.operation(async () => {
      if (this.profile.readOnly) throw new Error('This connection is read-only.');
      if (this.transactionState !== 'idle') throw new Error('Commit or roll back the open SQL transaction before saving grid edits.');
      const details = await this.describe(table);
      if (details.type !== 'table') throw new Error('Views cannot be edited.');
      if (new Set(keys).size!==keys.length || keys.some(key=>!details.columns.some(c=>c.name===key)) || (!keys.length && changes.some(c=>c.kind!=='insert'))) throw new Error('Select valid unique key columns.');
      const writable = new Set(details.columns.filter(c=>!c.generated).map(c=>c.name));
      const verify=async(change:RowChange)=>{if(!options?.verifyValues)return;const keyValues=keys.map(k=>Object.hasOwn(change.values,k)?change.values[k]!:change.original?.[k]);if(!keys.length||keyValues.some(v=>v===undefined))throw new Error('Written-value verification requires explicit key values.');const result=await this.raw(`SELECT * FROM ${details.name} WHERE ${keys.map((k,i)=>quotePg(k)+' IS NOT DISTINCT FROM $'+(i+1)).join(' AND ')} LIMIT 2 FOR UPDATE`,keyValues.map(v=>parameter(v!)));verifyWrittenValues(details,result.rows.map(row=>Object.fromEntries(result.fields.map((f,i)=>[f.name,valueOf(row[i]!,f.dataTypeID)]))),change.values,change.kind==='delete');};
      await this.raw('BEGIN'); let affectedRows=0;
      try {
        await this.raw("SET LOCAL lock_timeout = '10s'");
        await this.raw(`LOCK TABLE ${details.name} IN SHARE ROW EXCLUSIVE MODE`);
        if(options?.expected){const locked=await this.describe(table),current=await this.raw(`SELECT ${locked.columns.map(c=>quotePg(c.name)).join(',')} FROM ${locked.name} LIMIT ${options.expected.limit+1}`);verifyTableSnapshot(locked,current.rows.map(row=>Object.fromEntries(current.fields.map((f,i)=>[f.name,valueOf(row[i]!,f.dataTypeID)]))),options.expected);}
        for (const change of changes) {
          const entries = Object.entries(change.values);
          if (entries.some(([name])=>!writable.has(name))) throw new Error('A changed column is generated or no longer exists.');
          if (change.kind === 'insert') {
            const sql = entries.length ? `INSERT INTO ${details.name} (${entries.map(([c])=>quotePg(c)).join(',')}) VALUES (${entries.map((_,i)=>`$${i+1}`).join(',')})` : `INSERT INTO ${details.name} DEFAULT VALUES`;
            affectedRows += (await this.raw(sql,entries.map(([,v])=>parameter(v)))).rowCount ?? 0; continue;
          }
          if (!change.original || keys.some(key=>!(key in change.original!))) throw new Error('Original key values are missing.');
          const values = keys.map(key=>parameter(change.original![key]!));
          const where = keys.map((key,i)=>`${quotePg(key)} IS NOT DISTINCT FROM $${i+1}`).join(' AND ');
          const current = await this.raw(`SELECT * FROM ${details.name} WHERE ${where} FOR UPDATE`,values);
          if (current.rows.length!==1) throw new Error(`Key matched ${current.rows.length} rows instead of 1. No changes were applied.`);
          current.fields.forEach((field,i)=> { if (field.name in change.original! && JSON.stringify(valueOf(current.rows[0]![i]!,field.dataTypeID))!==JSON.stringify(change.original![field.name])) throw new Error('This row changed since it was loaded. Refresh and retry.'); });
          if (change.kind==='update' && !entries.length) continue;
          const sql = change.kind==='delete' ? `DELETE FROM ${details.name} WHERE ${where}` : `UPDATE ${details.name} SET ${entries.map(([c],i)=>`${quotePg(c)}=$${keys.length+i+1}`).join(',')} WHERE ${where}`;
          const count = (await this.raw(sql,[...values,...(change.kind==='delete'?[]:entries.map(([,v])=>parameter(v)))])).rowCount;
          if (count!==1) throw new Error('The row was not written exactly once. All grid changes were rolled back.'); affectedRows++;
        }
        for(const change of changes)await verify(change);
        await this.raw('COMMIT'); return {affectedRows};
      } catch(error) { await this.raw('ROLLBACK').catch(()=>{}); throw error; }
    });
  }
  cancel():Promise<boolean>{
    if(this.cancellation)return this.cancellation;if(!this.busy&&!this.opening)return Promise.resolve(false);
    const credentials=this.authenticated?{...this.authenticated}:undefined,id=this.backendId,encrypted=this.encrypted;this.cancelling=true;
    return this.cancellation=(async()=>{try{if(this.activeRequest&&credentials&&id){const profile={...this.profile,readOnly:false,connectTimeout:Math.min(this.profile.connectTimeout||5000,5000),...(encrypted&&['allow','prefer'].includes(this.profile.sslMode??'')?{sslMode:'require' as const}:{})},control=new PostgresSession(profile,async()=>credentials.password,{credentials:async()=>credentials,endpoint:this.options.endpoint});await cancelServerRequest(control,id,this.marker,()=>Boolean(this.activeRequest));}return true;}finally{await this.close();}})();
  }
  private async releaseEndpoint():Promise<void>{const endpoint=this.endpoint;this.endpoint=undefined;await endpoint?.release();}
  private async endClient():Promise<void>{await this.client?.end().catch(()=>{});}
  async close(): Promise<void> { this.authenticated=undefined;this.abort.abort();if(this.closed){await this.releaseEndpoint();return;}this.closed=true;this.ready=false;try{await this.client?.end();}finally{await this.releaseEndpoint();} }
}
