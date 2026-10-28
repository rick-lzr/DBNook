import { DatabaseSync, backup, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {exportStatement} from '../../core/src/data-stream.js';
import {assertSqliteFeatures} from './runtime.js';
import {verifyTableSnapshot,verifyWrittenValues} from '../../core/src/table-snapshot.js';
import type { ApplyReport, CellValue, ColumnMeta, ConnectionProfile, DataRow, QueryResult, QueryRun, RunStatement, RowChange, RuntimeInfo, SchemaObject, TableDetails, TableRequest } from '../../protocol/src/index.js';

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export function encodeValue(value: unknown): CellValue {
  if (value === null) return null;
  if (typeof value === 'bigint') return value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER) ? { type: 'integer', value: value.toString() } : Number(value);
  if (value instanceof Uint8Array) return { type: 'binary', base64: Buffer.from(value).toString('base64') };
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new Error(`Unsupported SQLite value: ${typeof value}`);
}
export function decodeValue(value: CellValue): SQLInputValue {
  if (typeof value === 'object' && value !== null) return value.type === 'integer' ? BigInt(value.value) : Buffer.from(value.base64, 'base64');
  return typeof value === 'boolean' ? Number(value) : value;
}
export class SqliteEngine {
  private db: DatabaseSync;
  private backupOperation?:{id:string;cancelled:boolean};
  get backupBusy(){return Boolean(this.backupOperation);}
  cancelBackup(id:string){if(this.backupOperation?.id===id)this.backupOperation.cancelled=true;}
  async backupFile(path:string,id:string,progress:(v:{totalPages:number;remainingPages:number})=>void):Promise<number>{
    if(this.backupBusy||this.cursors.size||this.db.isTransaction)throw new Error('Finish the current transaction or cursor before backing up this session.');
    const operation={id,cancelled:false};this.backupOperation=operation;
    try{return await backup(this.db,path,{rate:64,progress:v=>{if(operation.cancelled)throw new Error('Backup cancelled.');progress(v);}});}finally{this.backupOperation=undefined;}
  }
  inspectFile():import('../../protocol/src/index.js').SqliteFileInfo{
    this.db.exec('PRAGMA trusted_schema=OFF');
    const integrity=this.db.prepare('PRAGMA integrity_check(100)').all();if(integrity.length!==1||Object.values(integrity[0]!)[0]!=='ok')throw new Error('SQLite integrity check failed: '+integrity.map(r=>Object.values(r)[0]).join('; ').slice(0,2000));
    const scalar=(pragma:string)=>Number(Object.values(this.db.prepare('PRAGMA '+pragma).get()!)[0]);
    const fk=this.db.prepare('PRAGMA foreign_key_check').iterate();let foreignKeyViolations=0;try{for(const _ of fk){if(++foreignKeyViolations>=100)break;}}finally{fk.return?.();}
    const objects=this.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 1000").all().map(r=>({type:String(r.type),name:String(r.name),table:String(r.tbl_name),sql:r.sql===null?null:String(r.sql)}));
    return {sqliteVersion:String(this.db.prepare('SELECT sqlite_version() v').get()!.v),pageSize:scalar('page_size'),pageCount:scalar('page_count'),userVersion:scalar('user_version'),applicationId:scalar('application_id'),objectCount:Number(this.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!.n),objects,foreignKeyViolations};
  }
  private cursors=new Map<string,{sql:string;columns:ColumnMeta[];iterator:Iterator<unknown>;queryOnly:boolean;}>();
  constructor(readonly profile: ConnectionProfile, options?: { memoryName: string }) {
    // Validate before opening/creating the user's file. sqlite_version() alone also works on incomplete APIs.
    const probe=new DatabaseSync(':memory:');try{
      const statement=probe.prepare('SELECT ? AS probe, ? AS probe');assertSqliteFeatures(probe,statement,backup);
      statement.setReadBigInts(true);statement.setReturnArrays(true);const row=statement.get(9223372036854775807n,1n) as unknown as bigint[];
      if(statement.columns().length!==2||row[0]!==9223372036854775807n||row[1]!==1n)throw new Error('SQLite runtime failed the exact integer / duplicate column read probe.');
      probe.exec('BEGIN');if(!probe.isTransaction)throw new Error('SQLite runtime failed the transaction-state probe.');probe.exec('ROLLBACK');
    }finally{probe.close();}
    if (profile.storage === 'file' && !profile.createIfMissing && !existsSync(profile.path)) throw new Error(`Database file not found: ${profile.path}`);
    const memory = options ? `file:db-workbench-${encodeURIComponent(options.memoryName)}?mode=memory&cache=shared` : ':memory:';
    this.db = new DatabaseSync(profile.storage === 'memory' ? memory : profile.path, { readOnly: profile.readOnly, enableForeignKeyConstraints: true, timeout: 5000 });
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (profile.readOnly) this.db.exec('PRAGMA query_only = ON');
  }
  info(): RuntimeInfo {
    const row = this.db.prepare('SELECT sqlite_version() AS version').get()!;
    return { sqlite: String(row.version), node: process.versions.node, path: this.profile.storage === 'memory' ? ':memory:' : this.profile.path, transaction: this.transactionState,sqliteRuntimeValidated:true };
  }
  get transactionState(): 'active' | 'idle' { return this.db.isTransaction ? 'active' : 'idle'; }
  close(): void { for(const id of this.cursors.keys())this.closeCursor(id);this.db.close(); }
  openCursor(sql:string):{id:string}{
    if(this.cursors.size)throw new Error('This session already has an export cursor.');
    sql=exportStatement(sql,'sqlite');const queryOnly=Boolean(this.db.prepare('PRAGMA query_only').get()!.query_only);this.db.exec('PRAGMA query_only=ON');
    try{
    const statement=this.db.prepare(sql);statement.setReadBigInts(true);statement.setReturnArrays(true);
    const columns=statement.columns().map((c,i)=>({key:`c${i}`,name:c.name,dataType:c.type??'',nullable:true,primaryKey:0,generated:false,sourceColumn:c.column??undefined,sourceTable:c.table??undefined}));
    if(!columns.length)throw new Error('The query has no result columns.');const id=randomUUID();this.cursors.set(id,{sql,columns,iterator:statement.iterate(),queryOnly});return {id};
    }catch(error){if(!queryOnly)this.db.exec('PRAGMA query_only=OFF');throw error;}
  }
  nextCursor(id:string,size:number):{batch:QueryResult;done:boolean}{
    const cursor=this.cursors.get(id);if(!cursor)throw new Error('The export cursor is closed.');const rows:DataRow[]=[];let done=false,bytes=0;
    for(let n=0;n<size;n++){const item=cursor.iterator.next();if(item.done){done=true;break;}const row=Object.fromEntries((item.value as unknown[]).map((v,i)=>{if(typeof v==='number'&&!Number.isFinite(v))throw new Error('Non-finite SQLite REAL values cannot be exported by this serializer. Use a native backup.');return [`c${i}`,encodeValue(v)];})),length=Buffer.byteLength(JSON.stringify(row));if(length>16_000_000)throw new Error('An export row exceeds 16 MB. Use a native database backup for larger values.');rows.push(row);bytes+=length;if(bytes>=4_000_000)break;}
    if(done)this.closeCursor(id);return {batch:{sql:cursor.sql,columns:cursor.columns,rows,affectedRows:0,truncated:false,durationMs:0,readOnly:true},done};
  }
  closeCursor(id:string){const cursor=this.cursors.get(id);cursor?.iterator.return?.();this.cursors.delete(id);if(cursor&&!cursor.queryOnly)this.db.exec('PRAGMA query_only=OFF');}
  schema(): SchemaObject[] {
    return this.db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type,name COLLATE NOCASE").all().map(row => ({ name: String(row.name), type: row.type as 'table' | 'view', sql: row.sql as string | null }));
  }
  details(table: string): TableDetails {
    const item = this.schema().find(item => item.name === table);
    if (!item) throw new Error(`Table or view no longer exists: ${table}`);
    const columns = this.db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table).filter(row => Number(row.hidden) !== 1).map((row): ColumnMeta => ({
      key: String(row.name), name: String(row.name), dataType: String(row.type || ''), nullable: !row.notnull && !row.pk,
      primaryKey: Number(row.pk), generated: Number(row.hidden) > 1, defaultValue: row.dflt_value as string | null,
      sourceColumn: String(row.name), sourceTable: table,
    }));
    const indexes = this.db.prepare('SELECT * FROM pragma_index_list(?)').all(table).map(row => ({
      name: String(row.name), unique: Boolean(row.unique),
      columns: this.db.prepare('SELECT * FROM pragma_index_info(?)').all(String(row.name)).map(col => String(col.name)),
    }));
    const foreignKeys = this.db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table).map(row => ({ id: Number(row.id), table: String(row.table), from: String(row.from), to: String(row.to), onUpdate: String(row.on_update), onDelete: String(row.on_delete) }));
    return { ...item, columns, indexes, foreignKeys };
  }
  table(request: TableRequest): QueryResult {
    const details = this.details(request.table);
    for (const order of request.order) if (!details.columns.some(c => c.name === order.column)) throw new Error(`Unknown sort column: ${order.column}`);
    // Parenthesized expression plus a prepared statement prevents WHERE from
    // appending a second statement. SQL documents use the explicit query path.
    const sql = `SELECT * FROM ${quoteIdentifier(request.table)}${request.where.trim() ? ` WHERE (${request.where})` : ''}${request.order.length ? ` ORDER BY ${request.order.map(o => `${quoteIdentifier(o.column)} ${o.direction.toUpperCase()}`).join(', ')}` : ''} LIMIT ? OFFSET ?`;
    const result = this.execute(sql, request.limit, [request.limit + 1, request.offset]);
    result.sourceTable = request.table;
    result.readOnly = this.profile.readOnly || details.type !== 'table';
    result.columns = details.columns.map(c => ({ ...c, key: c.name }));
    // Query columns are positional to preserve duplicate result names. Table
    // browsing uses stable schema names for editing and composite key matching.
    result.rows = result.rows.map(row => Object.fromEntries(details.columns.map((c, i) => [c.name, row[`c${i}`] ?? null])));
    return result;
  }
  query(sql: string, limit: number): QueryResult {
    this.assertAllowed(sql); return this.execute(sql, limit);
  }
  private assertAllowed(sql: string): void {
    if (this.profile.readOnly) {
      const first = sql.replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '').match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
      // In addition to SQLite's read-only file handle and query_only pragma,
      // prevent a user query from disabling query_only or attaching a writable
      // second database. Metadata pragmas run through the controlled API.
      if (!first || !['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(first)) throw new Error('This connection is read-only. Only read queries and transaction controls are allowed.');
    }
  }
  run(sql: string, limit: number, runId: string, progress?: (statement: RunStatement) => void): QueryRun {
    const started = performance.now();
    const run: QueryRun = { id: runId, sql, status: 'running', statements: [], durationMs: 0, transaction: this.transactionState };
    let offset = 0;
    while (offset < sql.length) {
      // Only skip SQLite trivia here. SQLite's own parser identifies statement
      // boundaries, including trigger bodies, quoted identifiers and literals.
      while (offset < sql.length) {
        if (/[\s;]/.test(sql[offset]!)) { offset++; continue; }
        if (sql.startsWith('--', offset)) { const end = sql.indexOf('\n', offset + 2); offset = end < 0 ? sql.length : end + 1; continue; }
        if (sql.startsWith('/*', offset)) { const end = sql.indexOf('*/', offset + 2); offset = end < 0 ? sql.length : end + 2; continue; }
        break;
      }
      if (offset >= sql.length) break;
      const start = offset;
      let end = sql.length;
      try {
        const statement = this.db.prepare(sql.slice(start));
        if (!statement.sourceSQL.length) throw new Error('SQLite did not consume a SQL statement.');
        end = start + statement.sourceSQL.length;
        const source = sql.slice(start, end); this.assertAllowed(source);
        const result = this.executePrepared(source, statement, limit);
        const item: RunStatement = { index: run.statements.length, start, end, sql: source, status: 'succeeded', result };
        run.statements.push(item); progress?.(item); offset = end;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const item: RunStatement = { index: run.statements.length, start, end, sql: sql.slice(start, end), status: 'failed', error: message };
        run.statements.push(item); progress?.(item); run.error = message; run.status = 'failed'; break;
      }
    }
    if (run.status === 'running') run.status = 'succeeded';
    run.durationMs = Math.round((performance.now() - started) * 100) / 100; run.transaction = this.transactionState; return run;
  }
  private execute(sql: string, limit: number, parameters: SQLInputValue[] = []): QueryResult {
    const statement = this.db.prepare(sql);
    const tail = sql.slice(statement.sourceSQL.length).replace(/--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\//g, '').trim();
    if (tail && tail !== ';') throw new Error('Execute one SQL statement at a time. Select the statement you want to run.');
    return this.executePrepared(sql, statement, limit, parameters);
  }
  private executePrepared(sql: string, statement: StatementSync, limit: number, parameters: SQLInputValue[] = []): QueryResult {
    const started = performance.now(), before = this.db.prepare('SELECT total_changes() AS n').get()!.n;
    statement.setReadBigInts(true);
    const metadata = statement.columns();
    const columns: ColumnMeta[] = metadata.map((c, i) => ({ key: `c${i}`, name: c.name, dataType: c.type ?? '', nullable: true, primaryKey: 0, generated: false, sourceColumn: c.column ?? undefined, sourceTable: c.table ?? undefined }));
    const rows: DataRow[] = [];
    let affectedRows = 0, truncated = false;
    if (metadata.length) {
      statement.setReturnArrays(true);
      const iterator = statement.iterate(...parameters);
      try {
        for (const record of iterator) {
          if (limit && rows.length >= limit) { truncated = true; break; }
          rows.push(Object.fromEntries((record as unknown as unknown[]).map((value, i) => [`c${i}`, encodeValue(value)])));
        }
      } finally { iterator.return?.(); }
    } else {
      statement.run(...parameters);
    }
    if (this.db.prepare('SELECT total_changes() AS n').get()!.n !== before) affectedRows = Number(this.db.prepare('SELECT changes() AS n').get()!.n);
    return { columns, rows, affectedRows, durationMs: Math.round((performance.now() - started) * 100) / 100, truncated, sql, readOnly: true };
  }
  apply(table: string, keyColumns: string[], changes: RowChange[], requireAutocommit = false,expected?:import('../../protocol/src/index.js').ExpectedTable,verifyValues=false): ApplyReport {
    if (this.profile.readOnly) throw new Error('This connection is read-only.');
    if (requireAutocommit && this.db.isTransaction) throw new Error('This connection has an open SQL transaction. Commit or roll it back before saving grid edits. Your staged changes have been kept.');
    const details = this.details(table);
    if (details.type !== 'table') throw new Error('Views cannot be edited.');
    if ((!keyColumns.length && changes.some(change => change.kind !== 'insert')) || new Set(keyColumns).size !== keyColumns.length || keyColumns.some(k => !details.columns.some(c => c.name === k))) throw new Error('Select valid unique key columns.');
    const writable = new Set(details.columns.filter(c => !c.generated).map(c => c.name));
    let affectedRows = 0;
    const tableSql = quoteIdentifier(table);
    const verify=(change:RowChange)=>{if(!verifyValues)return;const keyValues=keyColumns.map(k=>Object.hasOwn(change.values,k)?change.values[k]!:change.original?.[k]);if(!keyColumns.length||keyValues.some(v=>v===undefined))throw new Error('Written-value verification requires explicit key values.');const statement=this.db.prepare(`SELECT * FROM ${tableSql} WHERE ${keyColumns.map(k=>quoteIdentifier(k)+' IS ?').join(' AND ')} LIMIT 2`);statement.setReadBigInts(true);verifyWrittenValues(details,statement.all(...keyValues.map(v=>decodeValue(v!))).map(row=>Object.fromEntries(details.columns.map(c=>[c.name,encodeValue(row[c.name])]))),change.values,change.kind==='delete');};
    // Savepoints nest inside a user's SQL transaction. Every row is checked and
    // written on this connection under the same write lock; a failure rolls the
    // whole grid batch back, including prior rows in this batch.
    this.db.exec('SAVEPOINT dbw_grid_changes');
    try {
      // Acquire the SQLite write lock before validation (zero affected rows).
      this.db.prepare(`UPDATE ${tableSql} SET ${quoteIdentifier(details.columns.find(c => !c.generated)!.name)} = ${quoteIdentifier(details.columns.find(c => !c.generated)!.name)} WHERE 0`).run();
      if(expected){const current=this.db.prepare(`SELECT ${details.columns.map(c=>quoteIdentifier(c.name)).join(',')} FROM ${tableSql} LIMIT ?`);current.setReadBigInts(true);verifyTableSnapshot(this.details(table),current.all(expected.limit+1).map(row=>Object.fromEntries(details.columns.map(c=>[c.name,encodeValue(row[c.name])]))),expected);}
      for (const change of changes) {
        const entries = Object.entries(change.values);
        if (entries.some(([column]) => !writable.has(column))) throw new Error('A changed column is generated or no longer exists.');
        if (change.kind === 'insert') {
          const sql = entries.length ? `INSERT INTO ${tableSql} (${entries.map(([c]) => quoteIdentifier(c)).join(',')}) VALUES (${entries.map(() => '?').join(',')})` : `INSERT INTO ${tableSql} DEFAULT VALUES`;
          affectedRows += Number(this.db.prepare(sql).run(...entries.map(([, v]) => decodeValue(v))).changes);
          continue;
        }
        const original = change.original;
        if (!original || keyColumns.some(k => !(k in original))) throw new Error('Original key values are missing.');
        const where = keyColumns.map(k => `${quoteIdentifier(k)} IS ?`).join(' AND ');
        const keys = keyColumns.map(k => decodeValue(original[k]!));
        const matches = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${tableSql} WHERE ${where}`).get(...keys)!.n);
        if (matches !== 1) throw new Error(`Key matched ${matches} rows instead of 1. No changes were applied.`);
        const current = this.db.prepare(`SELECT * FROM ${tableSql} WHERE ${where}`); current.setReadBigInts(true);
        const row = current.get(...keys)!;
        for (const column of details.columns) {
          if (column.name in original && JSON.stringify(encodeValue(row[column.name])) !== JSON.stringify(original[column.name])) throw new Error('This row changed since it was loaded. Refresh and retry.');
        }
        if (change.kind === 'delete') affectedRows += Number(this.db.prepare(`DELETE FROM ${tableSql} WHERE ${where}`).run(...keys).changes);
        else if (entries.length) affectedRows += Number(this.db.prepare(`UPDATE ${tableSql} SET ${entries.map(([c]) => `${quoteIdentifier(c)} = ?`).join(', ')} WHERE ${where}`).run(...entries.map(([, v]) => decodeValue(v)), ...keys).changes);
      }
      // Verify after the whole batch: a later trigger can modify an earlier row.
      for(const change of changes)verify(change);
      this.db.exec('RELEASE dbw_grid_changes');
      return { affectedRows };
    } catch (error) {
      this.db.exec('ROLLBACK TO dbw_grid_changes; RELEASE dbw_grid_changes');
      throw error;
    }
  }
}
