import mysql, { type Connection, type FieldPacket, type ResultSetHeader } from 'mysql2';
import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DriverSession } from '../../driver-sdk/src/index.js';
import {checkAbort,exportStatement,type StreamConsumer} from '../../core/src/data-stream.js';
import {cancelServerRequest} from '../../core/src/server-cancellation.js';
import {verifyTableSnapshot,verifyWrittenValues} from '../../core/src/table-snapshot.js';
import type { EndpointLease } from '../../core/src/tunnels.js';
import { SessionLostError } from '../sqlite/session.js';
import { driverNames, isMysqlFamily, errorMessage, type ApplyReport, type CellValue, type ColumnMeta, type ConnectionProfile, type QueryResult, type QueryRun, type RowChange, type RunStatement, type RuntimeInfo, type SchemaObject, type TableDetails, type TableRequest, type TransactionState } from '../../protocol/src/index.js';
import { mysqlRelation, nextMysqlStatement, quoteMysql, type MysqlSqlMode } from './sql.js';

interface RawSet { fields: FieldPacket[]; rows: CellValue[][]; affectedRows: number; truncated: boolean; warnings?:number; }
const checkedWrite=(result:RawSet)=>{if(result.warnings)throw new Error('The database reported a write warning (possible truncation or conversion). The write was rejected.');return result;};
const parameter = (v: CellValue): unknown => v && typeof v === 'object' ? v.type === 'integer' ? v.value : Buffer.from(v.base64, 'base64') : v;
const types: Record<number, string> = { 0:'DECIMAL',1:'TINYINT',2:'SMALLINT',3:'INT',4:'FLOAT',5:'DOUBLE',7:'TIMESTAMP',8:'BIGINT',9:'MEDIUMINT',10:'DATE',11:'TIME',12:'DATETIME',13:'YEAR',16:'BIT',245:'JSON',246:'DECIMAL',249:'TINYBLOB',250:'MEDIUMBLOB',251:'LONGBLOB',252:'BLOB',253:'VARCHAR',254:'CHAR',255:'GEOMETRY' };
const initialMode: MysqlSqlMode = { noBackslashEscapes: false, ansiQuotes: false };
export class MysqlSession implements DriverSession {
  readonly id = randomUUID();
  private get label():string{return driverNames[this.profile.driver];}
  private client?: Connection;
  private socket?: Socket;
  private ready = false;
  private closed = false;
  private opening = false;
  private busy = 0;
  private state: TransactionState = 'unknown';
  private autocommit = true;
  private tail: Promise<unknown> = Promise.resolve();
  private runtimeInfo?: RuntimeInfo;
  private endpoint?: EndpointLease;
  private abort = new AbortController();
  private mode: MysqlSqlMode = { ...initialMode };
  private authenticated?:{user:string;password?:string};private activeRequest?:string;private cancelling=false;private cancellation?:Promise<boolean>;
  private get marker(){return `/* DBW:${this.id} */ `;}
  constructor(readonly profile: ConnectionProfile, private password: () => Promise<string | undefined> = async () => undefined, private options: { credentials?: () => Promise<{user:string;password?:string}>; endpoint?: (signal:AbortSignal) => Promise<EndpointLease> } = {}) {}
  get connected(): boolean { return this.ready && !this.closed && !this.cancelling && (!this.endpoint || this.endpoint.active()); }
  get info(): RuntimeInfo | undefined { return this.connected ? this.runtimeInfo : undefined; }
  get transactionState(): TransactionState { return this.connected ? this.state : 'unknown'; }
  get sqlMode():MysqlSqlMode{return {...this.mode};}
  async open(): Promise<RuntimeInfo> {
    if (this.connected) return this.runtimeInfo!;
    if (this.closed || this.opening || this.client) throw new SessionLostError(`This ${this.label} session is closed or already opening. Reset it explicitly.`);
    this.opening = true;
    try {
      if(!isMysqlFamily(this.profile.driver))throw new Error('Select a MySQL or MariaDB connection profile.');
      const p = this.profile, credentials = this.options.credentials ? await this.options.credentials() : { user:p.user!, password:await this.password() };
      if (this.closed) throw new SessionLostError('Connection closed before authentication.');
      if (this.options.endpoint) this.endpoint = await this.options.endpoint(this.abort.signal);
      const mode = p.sslMode ?? 'disable', verifies = mode === 'verify-full' || mode === 'verify-ca' || mode === 'require' && Boolean(p.caPath);
      if(mode==='verify-full'&&isIP(p.host!))throw new Error(`${this.label} hostname verification currently requires a DNS hostname matching the certificate. Use that hostname, or choose certificate-authority verification for an IP endpoint.`);
      const ssl = mode === 'disable' ? undefined : { rejectUnauthorized: verifies, verifyIdentity: mode === 'verify-full', ...(p.caPath ? {ca:await readFile(p.caPath,'utf8')} : {}), ...(p.certPath ? {cert:await readFile(p.certPath,'utf8'),key:await readFile(p.keyPath!,'utf8')} : {}) };
      if (this.closed) throw new SessionLostError('Connection closed before authentication.');
      const client = mysql.createConnection({ host:p.host, port:p.port??3306, stream:()=>{this.socket=tcpConnect({host:this.endpoint?.host??p.host!,port:this.endpoint?.port??p.port??3306});return this.socket;}, database:p.database||undefined, user:credentials.user, password:credentials.password??'', ssl,
        connectTimeout:p.connectTimeout??15000, connectAttributes:{program_name:p.applicationName||'DBNook'}, charset:'utf8mb4', multipleStatements:false, supportBigNumbers:true, bigNumberStrings:true, dateStrings:true, jsonStrings:true, rowsAsArray:true,
        typeCast(field, next) {
          if (['GEOMETRY','BIT'].includes(field.type)) { const b=field.buffer();return b===null?null:{type:'binary',base64:b.toString('base64')}; }
          const value=next();return Buffer.isBuffer(value)?{type:'binary',base64:value.toString('base64')}:value;
        },
      }); this.client=client;
      client.on('error',()=>{this.ready=false;}); client.on('end',()=>{this.ready=false;void this.releaseEndpoint();});
      await new Promise<void>((resolve,reject)=>{const stop=()=>reject(new SessionLostError(`${this.label} connection cancelled. Reset explicitly.`));this.abort.signal.addEventListener('abort',stop,{once:true});client.connect(error=>{this.abort.signal.removeEventListener('abort',stop);error?reject(error):resolve();});});
      if (this.closed) throw new SessionLostError('Connection closed while authenticating.');
      this.authenticated={...credentials};
      const version=(await this.raw('SELECT VERSION()')).rows[0]![0] as string;
      const actual=/MariaDB/i.test(version)?'mariadb':'mysql';
      if(actual!==p.driver)throw new Error(`This is a ${driverNames[actual]} server. Select ${driverNames[actual]} in the connection editor.`);
      if (p.readOnly) await this.raw('SET SESSION TRANSACTION READ ONLY');
      await this.sync(); this.ready=true;
      this.runtimeInfo={sqlite:'',driver:p.driver,serverVersion:version,node:process.versions.node,path:`${p.host}:${p.port??3306}/${p.database??''}`,tls:!ssl?'disabled':verifies?mode==='verify-full'?'verify-full':'verify-ca':'encrypted'};
      return this.runtimeInfo;
    } catch(error) { await this.close();throw error; } finally { this.opening=false; }
  }
  private operation<T>(action:()=>Promise<T>):Promise<T> {
    const task=this.tail.then(async()=>{if(!this.connected)throw new SessionLostError(`${this.label} session lost. Reset explicitly; interrupted statements will not be replayed.`);this.busy++;try{return await action();}finally{this.busy--;}});this.tail=task.catch(()=>{});return task;
  }
  private sets(sql:string, values:unknown[]=[], limit=0):Promise<RawSet[]> {
    return new Promise((resolve,reject)=>{
      if(this.abort.signal.aborted||this.cancelling){reject(new SessionLostError(`${this.label} session disconnected or cancelled. Reset explicitly.`));return;}
      const request=randomUUID();this.activeRequest=request;const done=()=>{if(this.activeRequest===request)this.activeRequest=undefined;};
      const stop=()=>reject(new SessionLostError(`${this.label} session disconnected or cancelled. Reset explicitly.`));
      this.abort.signal.addEventListener('abort',stop,{once:true});
      const sets:RawSet[]=[];let activeIndex=0;
      const query=values.length?this.client!.execute({sql:this.marker+sql,values,rowsAsArray:true}):this.client!.query({sql:this.marker+sql,rowsAsArray:true});
      query.on('fields',(fields:FieldPacket[]|undefined,index:number)=>{activeIndex=index??sets.length;sets[activeIndex]={fields:fields??[],rows:[],affectedRows:0,truncated:false};});
      query.on('result',(row:CellValue[]|ResultSetHeader,index:number)=>{
        const set=sets[index??activeIndex]??(sets[index??activeIndex]={fields:[],rows:[],affectedRows:0,truncated:false});
        if (Array.isArray(row)) { if(!limit||set.rows.length<limit)set.rows.push(row.map((value,i)=>{if(value!==null&&[1,2,3,8,9,13].includes(set.fields[i]?.columnType??-1)){const n=BigInt(String(value));return n<=BigInt(Number.MAX_SAFE_INTEGER)&&n>=BigInt(Number.MIN_SAFE_INTEGER)?Number(n):{type:'integer',value:n.toString()};}return value;}));else set.truncated=true; }
        else {set.affectedRows=row.affectedRows;set.warnings=row.warningStatus??0;this.autocommit=Boolean(row.serverStatus&2);this.state=row.serverStatus&1||!this.autocommit?'active':'idle';}
      });
      query.on('error',error=>{if((error as {errno?:number}).errno!==undefined)done();this.abort.signal.removeEventListener('abort',stop);reject(error);});query.on('end',()=>{done();this.abort.signal.removeEventListener('abort',stop);resolve(sets);});
    });
  }
  private async raw(sql:string,values:unknown[]=[]):Promise<RawSet> { const sets=await this.sets(sql,values);if(sets.length!==1)throw new Error('Expected one result set.');return sets[0]!; }
  private async sync():Promise<void> {
    // mysql2 exposes OK status publicly, but SELECT EOF status is not a public API.
    // DO does not access transactional tables; it obtains authoritative status without starting a transaction.
    const value=String((await this.raw('SELECT @@SESSION.sql_mode')).rows[0]![0]);
    const names=value.split(',');this.mode={noBackslashEscapes:names.includes('NO_BACKSLASH_ESCAPES'),ansiQuotes:names.includes('ANSI_QUOTES'),mariaDb:this.profile.driver==='mariadb'};
    await this.raw('DO 0');
  }
  private columns(fields:FieldPacket[]):ColumnMeta[] { return fields.map((f,i)=>({key:`c${i}`,name:f.name,dataType:(types[f.columnType??-1]??`type:${f.columnType}`)+(Number(f.flags)&32?' UNSIGNED':''),nullable:!(Number(f.flags)&1),primaryKey:0,generated:false})); }
  private async execute(sql:string,limit=100000,values:unknown[]=[]):Promise<QueryResult[]> {
    if(this.profile.readOnly) {
      const text=sql.replace(/\/\*[\s\S]*?\*\/|#[^\r\n]*|--(?=\s)[^\r\n]*/g,' ').trim();
      if(!/^(?:SELECT\b|SHOW\b|DESC(?:RIBE)?\b|EXPLAIN\s+(?:FORMAT\s*=\s*(?:JSON|TRADITIONAL)\s+)?(?:SELECT|WITH|TABLE|INSERT|UPDATE|DELETE|REPLACE)\b|EXPLAIN\s+ANALYZE\s+(?:FORMAT\s*=\s*TREE\s+)?(?:SELECT|WITH|TABLE)\b|ANALYZE\s+FORMAT\s*=\s*JSON\s+(?:SELECT|WITH)\b|BEGIN\s*$|START\s+TRANSACTION\s+READ\s+ONLY\s*$|COMMIT\b|ROLLBACK\b)/i.test(text)||/\/\*(?:!|[mM]!)|\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(sql))throw new Error('This connection is read-only.');
      if(this.state==='idle')await this.raw('SET SESSION TRANSACTION READ ONLY');
    }
    const started=performance.now();let sets:RawSet[];
    try{sets=await this.sets(sql,values,limit);}catch(error){try{await this.sync();}catch{this.ready=false;}throw error;}
    await this.sync();
    return sets.map(set=>({columns:this.columns(set.fields),rows:set.rows.map(row=>Object.fromEntries(row.map((v,i)=>[`c${i}`,v]))),affectedRows:set.affectedRows,truncated:set.truncated,durationMs:Math.round((performance.now()-started)*100)/100,sql,readOnly:true}));
  }
  query(sql:string,limit=100000):Promise<QueryResult> {return this.operation(async()=>{const results=await this.execute(sql,limit);if(results.length!==1)throw new Error('This statement returned multiple results. Use Execute SQL to see every result.');return results[0]!;});}
  stream(sql:string,batchSize:number,consume:StreamConsumer,signal?:AbortSignal):Promise<void>{return this.operation(async()=>{
    checkAbort(signal);await this.sync();if(this.state!=='idle')throw new Error('Export needs an idle session.');sql=exportStatement(sql,this.profile.driver,this.mode);
    await this.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await this.raw('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const abort=()=>{void this.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{await new Promise<void>((resolve,reject)=>{
      let fields:FieldPacket[]=[],rows:QueryResult['rows']=[],bytes=0,chain=Promise.resolve(),failed=false;
      const disconnected=()=>fail(new SessionLostError('Export cancelled or disconnected.'));
      const fail=(error:unknown)=>{if(failed)return;failed=true;this.abort.signal.removeEventListener('abort',disconnected);this.client?.resume();if(!this.cancelling)void this.cancel().catch(()=>this.close());reject(error);};
      this.abort.signal.addEventListener('abort',disconnected,{once:true});
      const flush=()=>{const batch:QueryResult={columns:this.columns(fields),rows,sql,readOnly:true,durationMs:0,truncated:false,affectedRows:0};rows=[];bytes=0;this.client!.pause();chain=chain.then(async()=>{checkAbort(signal);await consume(batch);}).then(()=>{if(!failed)this.client?.resume();});chain.catch(fail);};
      const request=randomUUID();this.activeRequest=request;const done=()=>{if(this.activeRequest===request)this.activeRequest=undefined;};
      const query=this.client!.query({sql:this.marker+sql,rowsAsArray:true});
      query.on('fields',(value:FieldPacket[])=>{fields=value;});
      query.on('result',(record:CellValue[])=>{try{if(!Array.isArray(record))throw new Error('Export expected a single read result.');const row=Object.fromEntries(record.map((v,i)=>{if(v!==null&&[1,2,3,8,9,13].includes(fields[i]?.columnType??-1)){const n=BigInt(String(v));v=n<=BigInt(Number.MAX_SAFE_INTEGER)&&n>=BigInt(Number.MIN_SAFE_INTEGER)?Number(n):{type:'integer',value:n.toString()};}return [`c${i}`,v];})),length=Buffer.byteLength(JSON.stringify(row));if(length>16_000_000)throw new Error('An export row exceeds 16 MB.');rows.push(row);bytes+=length;if(rows.length>=batchSize||bytes>=4_000_000)flush();}catch(error){fail(error);}});
      query.on('error',error=>{if((error as {errno?:number}).errno!==undefined)done();fail(error);});query.on('end',()=>{done();if(failed)return;flush();chain.then(()=>{this.abort.signal.removeEventListener('abort',disconnected);if(!failed)resolve();},fail);});
    });}finally{signal?.removeEventListener('abort',abort);if(this.connected)await this.raw('ROLLBACK').catch(()=>{});}
  });}
  run(sql:string,limit:number,id:string,progress?:(statement:RunStatement)=>void,options?:{singleStatement?:boolean}):Promise<QueryRun> {
    return this.operation(async()=>{
      const started=performance.now(),run:QueryRun={id,sql,status:'running',statements:[],durationMs:0,transaction:this.transactionState};let offset=0,delimiter=';';
      while(offset<sql.length) {
        let source;
        try{source=options?.singleStatement?{start:0,end:sql.length,sql,next:sql.length,delimiter:';'}:nextMysqlStatement(sql,offset,delimiter,this.mode);if(!source)break;const results=await this.execute(source.sql,limit);for(const result of results){const item:RunStatement={start:source.start,end:source.end,sql:source.sql,index:run.statements.length,status:'succeeded',result};run.statements.push(item);progress?.(item);}offset=source.next;delimiter=source.delimiter;}
        catch(error){const item:RunStatement={start:source?.start??offset,end:source?.end??sql.length,sql:source?.sql??sql.slice(offset),index:run.statements.length,status:'failed',error:errorMessage(error)};run.statements.push(item);progress?.(item);run.error=item.error;run.status=this.closed||this.cancelling?'cancelled':'failed';break;}
      }
      if(run.status==='running')run.status='succeeded';run.transaction=this.transactionState;run.durationMs=Math.round((performance.now()-started)*100)/100;return run;
    });
  }
  databases():Promise<string[]>{return this.operation(async()=>this.profile.database?[this.profile.database]:(await this.raw('SHOW DATABASES')).rows.map(row=>String(row[0])).filter(name=>!['information_schema','performance_schema','mysql','sys'].includes(name)));}
  schema():Promise<SchemaObject[]> {return this.operation(async()=>{const r=await this.raw(`SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE ${this.profile.database?'TABLE_SCHEMA=?':"TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')"} AND TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_SCHEMA,TABLE_NAME`,this.profile.database?[this.profile.database]:[]);return r.rows.map(row=>({name:`${quoteMysql(String(row[0]))}.${quoteMysql(String(row[1]))}`,schema:String(row[0]),label:String(row[1]),type:row[2]==='VIEW'?'view':'table',sql:null}));});}
  private async describe(table:string):Promise<TableDetails & {engine:string}> {
    const [database,name]=mysqlRelation(table,this.profile.database),qualified=`${quoteMysql(database)}.${quoteMysql(name)}`;
    const r=await this.raw('SELECT TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[database,name]);if(r.rows.length!==1)throw new Error('The table or view no longer exists.');
    if(!['BASE TABLE','VIEW'].includes(String(r.rows[0]![0])))throw new Error('This database object type is not supported by the table editor yet.');
    const cols=await this.raw(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,[database,name]);
    const indexes=await this.raw('SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',[database,name]);
    const idx=new Map<string,TableDetails['indexes'][number]>();const primary=new Map<string,number>();
    for(const row of indexes.rows){const key=String(row[0]);const value=idx.get(key)??{name:key,unique:Number(row[1])===0,columns:[]};value.columns.push(row[2]===null?'(expression)':String(row[2]));idx.set(key,value);if(key==='PRIMARY')primary.set(String(row[2]),Number(row[3]));}
    const columns:ColumnMeta[]=cols.rows.map(row=>({key:String(row[0]),name:String(row[0]),dataType:String(row[1]),nullable:row[2]==='YES',primaryKey:primary.get(String(row[0]))??0,generated:Boolean(row[5]),defaultValue:row[3]===null?null:String(row[3])}));
    const fks=await this.raw(`SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON k.CONSTRAINT_SCHEMA=r.CONSTRAINT_SCHEMA AND k.TABLE_NAME=r.TABLE_NAME AND k.CONSTRAINT_NAME=r.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION`,[database,name]);
    const names=[...new Set(fks.rows.map(row=>String(row[0])))];
    return {name:qualified,type:r.rows[0]![0]==='VIEW'?'view':'table',sql:null,engine:String(r.rows[0]![1]),columns,indexes:[...idx.values()],foreignKeys:fks.rows.map(row=>({id:names.indexOf(String(row[0])),from:String(row[1]),table:`${quoteMysql(String(row[2]))}.${quoteMysql(String(row[3]))}`,to:String(row[4]),onUpdate:String(row[5]),onDelete:String(row[6])}))};
  }
  details(table:string):Promise<TableDetails>{return this.operation(async()=>{const {engine,...details}=await this.describe(table);return details;});}
  table(request:TableRequest):Promise<QueryResult>{return this.operation(async()=>{
    const details=await this.describe(request.table),order=[...request.order];if(order.some(o=>!details.columns.some(c=>c.name===o.column)))throw new Error('Unknown sort column.');
    for(const c of details.columns.filter(c=>c.primaryKey).sort((a,b)=>a.primaryKey-b.primaryKey))if(!order.some(o=>o.column===c.name))order.push({column:c.name,direction:'asc'});
    // Select named columns explicitly: MySQL SELECT * omits INVISIBLE columns.
    const sql=`SELECT ${details.columns.map(c=>quoteMysql(c.name)).join(',')} FROM ${details.name}${request.where.trim()?` WHERE ${request.where}`:''}${order.length?` ORDER BY ${order.map(o=>`${quoteMysql(o.column)} ${o.direction==='desc'?'DESC':'ASC'}`).join(',')}`:''} LIMIT ? OFFSET ?`;
    const result=(await this.execute(sql,request.limit,[request.limit+1,request.offset]))[0]!;result.rows=result.rows.map(row=>Object.fromEntries(details.columns.map((c,i)=>[c.name,row[`c${i}`]!])));result.columns=details.columns;result.sourceTable=details.name;result.readOnly=this.profile.readOnly||details.type!=='table'||details.engine!=='InnoDB';return result;
  });}
  apply(table:string,keys:string[],changes:RowChange[],options?:import('../../protocol/src/index.js').ApplyOptions):Promise<ApplyReport>{return this.operation(async()=>{
    if(this.profile.readOnly)throw new Error('This connection is read-only.');await this.sync();if(this.state!=='idle'||!this.autocommit)throw new Error('Commit or roll back the open SQL transaction and enable autocommit before saving grid edits.');
    const details=await this.describe(table);if(details.type!=='table'||details.engine!=='InnoDB')throw new Error('Grid editing requires an InnoDB table. Views and nontransactional engines are read-only.');
    if(new Set(keys).size!==keys.length||keys.some(k=>!details.columns.some(c=>c.name===k))||!keys.length&&changes.some(c=>c.kind!=='insert'))throw new Error('Select valid unique key columns.');
    const writable=new Set(details.columns.filter(c=>!c.generated).map(c=>c.name));
    const verify=async(change:RowChange)=>{if(!options?.verifyValues)return;const keyValues=keys.map(k=>Object.hasOwn(change.values,k)?change.values[k]!:change.original?.[k]);if(!keys.length||keyValues.some(v=>v===undefined))throw new Error('Written-value verification requires explicit key values.');const result=await this.raw(`SELECT ${details.columns.map(c=>quoteMysql(c.name)).join(',')} FROM ${details.name} WHERE ${keys.map(k=>quoteMysql(k)+' <=> ?').join(' AND ')} LIMIT 2 FOR UPDATE`,keyValues.map(v=>parameter(v!)));verifyWrittenValues(details,result.rows.map(row=>Object.fromEntries(details.columns.map((c,i)=>[c.name,row[i]!]))),change.values,change.kind==='delete');};
    await this.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');await this.raw('START TRANSACTION');let affectedRows=0;
    try{
      // Take a metadata lock before trusting the pre-transaction description.
      await this.raw(`SELECT ${details.columns.map(c=>quoteMysql(c.name)).join(',')} FROM ${details.name} LIMIT 0 FOR UPDATE`);
      const locked=await this.describe(table);if(JSON.stringify(locked)!==JSON.stringify(details))throw new Error('Table structure changed. Refresh before saving.');
      if(options?.expected){const current=await this.raw(`SELECT ${locked.columns.map(c=>quoteMysql(c.name)).join(',')} FROM ${locked.name} LIMIT ${options.expected.limit+1} FOR UPDATE`);verifyTableSnapshot(locked,current.rows.map(row=>Object.fromEntries(locked.columns.map((c,i)=>[c.name,row[i]!]))),options.expected);}
      for(const change of changes){
        const entries=Object.entries(change.values);if(entries.some(([key])=>!writable.has(key)))throw new Error('A changed column is generated or no longer exists.');
        if(change.kind==='insert'){const sql=entries.length?`INSERT INTO ${details.name} (${entries.map(([k])=>quoteMysql(k)).join(',')}) VALUES (${entries.map(()=>'?').join(',')})`:`INSERT INTO ${details.name} () VALUES ()`;affectedRows+=checkedWrite(await this.raw(sql,entries.map(([,v])=>parameter(v)))).affectedRows;continue;}
        if(!change.original||keys.some(k=>!(k in change.original!)))throw new Error('Original key values are missing.');
        const values=keys.map(k=>parameter(change.original![k]!)),where=keys.map(k=>`${quoteMysql(k)} <=> ?`).join(' AND ');
        const current=await this.raw(`SELECT ${details.columns.map(c=>quoteMysql(c.name)).join(',')} FROM ${details.name} WHERE ${where} FOR UPDATE`,values);
        if(current.rows.length!==1)throw new Error(`Key matched ${current.rows.length} rows instead of 1. No changes were applied.`);
        details.columns.forEach((c,i)=>{if(!(c.name in change.original!)||JSON.stringify(current.rows[0]![i])!==JSON.stringify(change.original![c.name]))throw new Error('This row changed since it was loaded. Refresh and retry.');});
        if(change.kind==='update'&&!entries.length)continue;
        const sql=change.kind==='delete'?`DELETE FROM ${details.name} WHERE ${where}`:`UPDATE ${details.name} SET ${entries.map(([k])=>`${quoteMysql(k)}=?`).join(',')} WHERE ${where}`;
        const count=checkedWrite(await this.raw(sql,change.kind==='delete'?values:[...entries.map(([,v])=>parameter(v)),...values])).affectedRows;
        if(count!==1)throw new Error('The row was not written exactly once. All grid changes were rolled back.');affectedRows++;
      }
      for(const change of changes)await verify(change);
      await this.raw('COMMIT');return {affectedRows};
    }catch(error){await this.raw('ROLLBACK').catch(()=>{});throw error;}
  });}
  cancel():Promise<boolean>{
    if(this.cancellation)return this.cancellation;if(!this.busy&&!this.opening)return Promise.resolve(false);
    const credentials=this.authenticated?{...this.authenticated}:undefined,id=this.client?.threadId;this.cancelling=true;
    return this.cancellation=(async()=>{try{if(this.activeRequest&&credentials&&id){const control=new MysqlSession({...this.profile,readOnly:false,connectTimeout:Math.min(this.profile.connectTimeout||5000,5000)},async()=>credentials.password,{credentials:async()=>credentials,endpoint:this.options.endpoint});await cancelServerRequest(control,id,this.marker,()=>Boolean(this.activeRequest));}return true;}finally{await this.close();}})();
  }
  private async releaseEndpoint():Promise<void>{const endpoint=this.endpoint;this.endpoint=undefined;await endpoint?.release();}
  async close():Promise<void>{this.authenticated=undefined;this.closed=true;this.ready=false;this.abort.abort();this.client?.destroy();this.socket?.destroy();await this.releaseEndpoint();}
}
