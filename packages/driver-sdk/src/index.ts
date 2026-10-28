import type { ApplyReport, ConnectionProfile, QueryResult, QueryRun, RunStatement, RowChange, RuntimeInfo, SchemaObject, TableDetails, TableRequest, TransactionState } from '../../protocol/src/index.js';
export type Capability = 'supported' | 'partial' | 'unsupported' | 'unknown';
export interface DriverDescriptor {
  id: string; name: string; language: string;
  capabilities: Record<'browse' | 'query' | 'edit' | 'transactions' | 'ddl' | 'cancel' | 'backup' | 'monitor', Capability>;
}
export interface DriverSession {
  readonly id: string;
  readonly profile: ConnectionProfile;
  readonly connected: boolean;
  readonly transactionState: TransactionState;
  readonly info: RuntimeInfo | undefined;
  readonly sqlMode?: {noBackslashEscapes:boolean;ansiQuotes:boolean;mariaDb?:boolean};
  open(): Promise<RuntimeInfo>;
  schema(): Promise<SchemaObject[]>;
  databases?(): Promise<string[]>;
  details(table: string): Promise<TableDetails>;
  table(request: TableRequest): Promise<QueryResult>;
  query(sql: string, limit?: number): Promise<QueryResult>;
  stream(sql:string,batchSize:number,consume:(batch:QueryResult)=>Promise<void>,signal?:AbortSignal):Promise<void>;
  backupFile?(path:string,progress?:(value:{totalPages:number;remainingPages:number})=>void,signal?:AbortSignal):Promise<number>;
  inspectFile?():Promise<import('../../protocol/src/index.js').SqliteFileInfo>;
  run(sql: string, limit: number, runId: string, progress?: (statement: RunStatement) => void, options?:{singleStatement?:boolean}): Promise<QueryRun>;
  apply(table: string, keyColumns: string[], changes: RowChange[], options?: import('../../protocol/src/index.js').ApplyOptions): Promise<ApplyReport>;
  cancel(): Promise<boolean>;
  close(): Promise<void>;
}
export const sqliteDescriptor: DriverDescriptor = {
  id: 'sqlite', name: 'SQLite', language: 'sql',
  capabilities: { browse: 'supported', query: 'partial', edit: 'partial', transactions: 'partial', ddl: 'partial', cancel: 'partial', backup: 'partial', monitor: 'unsupported' },
};
export const postgresDescriptor: DriverDescriptor = {
  id: 'postgresql', name: 'PostgreSQL', language: 'sql',
  capabilities: { browse: 'partial', query: 'partial', edit: 'partial', transactions: 'partial', ddl: 'partial', cancel: 'partial', backup: 'partial', monitor: 'unsupported' },
};
export const mysqlDescriptor: DriverDescriptor = {
  id:'mysql',name:'MySQL',language:'sql',
  capabilities:{browse:'partial',query:'partial',edit:'partial',transactions:'partial',ddl:'partial',cancel:'partial',backup:'partial',monitor:'unsupported'},
};
export const mariadbDescriptor:DriverDescriptor={...mysqlDescriptor,id:'mariadb',name:'MariaDB',capabilities:{...mysqlDescriptor.capabilities}};
