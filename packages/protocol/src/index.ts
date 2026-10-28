import { z } from 'zod';
import {DdlIntentSchema,type TableStructure} from './ddl.js';
import {CompareInputSchema,CompareSourceSchema} from './comparisons.js';
import {CombinationInputSchema,CombinationSourceSchema} from './combinations.js';
import {SqlParameterValuesSchema} from './sql-parameters.js';
export * from './sql-parameters.js';
export * from './ddl.js';
export * from './comparisons.js';
export * from './combinations.js';
export * from './definitions.js';
export * from './query-plans.js';

export const PROTOCOL_VERSION = 1 as const;
export const driverNames = {sqlite:'SQLite',postgresql:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB'} as const;
export const isMysqlFamily = (driver:string):boolean => driver==='mysql'||driver==='mariadb';
export const defaultPort = (driver:string):number => isMysqlFamily(driver)?3306:5432;
export const CellSchema = z.union([
  z.null(), z.string(), z.number().finite(), z.boolean(),
  z.object({ type: z.literal('integer'), value: z.string().regex(/^-?\d+$/) }).strict(),
  z.object({ type: z.literal('binary'), base64: z.string() }).strict(),
]);
export type CellValue = z.infer<typeof CellSchema>;
export type DataRow = Record<string, CellValue>;
export type TransactionState = 'idle' | 'active' | 'unknown';
const authenticationBase={id:z.string().min(1).max(100),name:z.string().trim().min(1).max(120),user:z.string().min(1).max(1000),scope:z.enum(['global','workspace']).default('global')};
const outputPath=z.string().max(1000).regex(/^(?:[A-Za-z_][\w-]*|\d+)(?:\.(?:[A-Za-z_][\w-]*|\d+))*$/,'Use a dotted property path, such as credentials.password.');
export const AuthenticationSchema=z.discriminatedUnion('kind',[
  z.object({...authenticationBase,kind:z.literal('password')}).strict(),
  z.object({...authenticationBase,kind:z.literal('command'),executable:z.string().trim().min(1).max(4096),args:z.array(z.string().max(32768)).max(256).default([]),cwd:z.string().max(4096).optional(),output:z.enum(['password','user-password','json']).default('password'),userPath:outputPath.optional(),passwordPath:outputPath.default('password'),expiresAtPath:outputPath.optional(),cacheTtl:z.number().int().min(0).max(86400).default(0),timeout:z.number().int().min(100).max(120000).default(15000)}).strict(),
  z.object({...authenticationBase,kind:z.literal('pgpass'),path:z.string().max(4096).default('')}).strict(),
]);
const hostFingerprint=z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'Enter an OpenSSH SHA256 host key fingerprint.');
export const SshConfigSourceSchema=z.object({kind:z.literal('ssh-config'),root:z.string(),path:z.string(),line:z.number().int().min(1),alias:z.string().min(1),identityFiles:z.array(z.string()),knownHostsFiles:z.array(z.string()),fingerprints:z.array(hostFingerprint),authMethods:z.array(z.enum(['publickey','agent','password'])),issues:z.array(z.string())}).strict();
export const TunnelSchema=z.object({id:z.string().min(1).max(100),name:z.string().trim().min(1).max(120),kind:z.literal('ssh'),host:z.string().trim().min(1).max(1000),port:z.number().int().min(1).max(65535).default(22),user:z.string().min(1).max(1000),auth:z.enum(['password','key','agent']),privateKeyPath:z.string().optional(),agent:z.string().optional(),fingerprint:z.union([hostFingerprint,z.literal('')]),readyTimeout:z.number().int().min(1000).max(120000).default(15000),scope:z.enum(['global','workspace']).default('global'),source:SshConfigSourceSchema.optional()}).strict().superRefine((p,ctx)=>{if(p.auth==='key'&&!p.privateKeyPath&&!p.source)ctx.addIssue({code:'custom',path:['privateKeyPath'],message:'Select a private key file.'});if(!p.fingerprint&&!p.source)ctx.addIssue({code:'custom',path:['fingerprint'],message:'Enter an OpenSSH SHA256 host key fingerprint.'});});
export type AuthenticationProfile=z.infer<typeof AuthenticationSchema>;
export type TunnelDefinition=z.infer<typeof TunnelSchema>;
export type ConnectionResource=AuthenticationProfile|TunnelDefinition;
export type ResourceKind='authentication'|'tunnel';
export interface ResourceEditorState {revision:string;hasSecret:boolean;rememberSecret:boolean;}
export interface ResourceSummary {authentication:AuthenticationProfile[];tunnels:TunnelDefinition[];}
export const ProfileSchema = z.object({
  schemaVersion: z.literal(1).default(1), id: z.string().min(1).max(100),
  driver: z.enum(['sqlite', 'postgresql', 'mysql', 'mariadb']), name: z.string().trim().min(1).max(120),
  storage: z.enum(['file', 'memory', 'server']), path: z.string().default(''),
  authRef:z.string().min(1).max(100).optional(),tunnelRef:z.string().min(1).max(100).optional(),
  host: z.string().trim().min(1).max(1000).optional(), port: z.number().int().min(1).max(65535).optional(),
  database: z.string().min(1).max(1000).optional(), user: z.string().min(1).max(1000).optional(),
  sslMode: z.enum(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']).optional(), caPath: z.string().optional(),
  certPath: z.string().optional(), keyPath: z.string().optional(),
  connectTimeout: z.number().int().min(0).max(120000).optional(), applicationName: z.string().max(255).optional(),
  scope: z.enum(['global', 'workspace']).default('global'),
  group: z.string().max(120).default(''), color: z.string().regex(/^#[\da-f]{6}$/i).default('#2684a6'),
  readOnly: z.boolean().default(false), createIfMissing: z.boolean().default(false),
}).strict().superRefine((profile, ctx) => {
  if (profile.storage === 'file' && !profile.path.trim()) ctx.addIssue({ code: 'custom', path: ['path'], message: 'Select a database file.' });
  if (profile.driver === 'sqlite' && profile.storage === 'server') ctx.addIssue({ code: 'custom', path: ['storage'], message: 'SQLite requires file or memory storage.' });
  if(profile.driver==='sqlite'&&(profile.authRef||profile.tunnelRef))ctx.addIssue({code:'custom',path:['driver'],message:'SQLite does not use server authentication or SSH tunnels.'});
  if (profile.driver !== 'sqlite') {
    if (profile.storage !== 'server' || profile.path || profile.createIfMissing) ctx.addIssue({ code: 'custom', path: ['storage'], message: `${driverNames[profile.driver]} requires a server connection to an existing database.` });
    for (const key of ['host', 'database', 'user'] as const) if (!profile[key]&&!(key==='user'&&profile.authRef)&&!(key==='database'&&isMysqlFamily(profile.driver))) ctx.addIssue({ code: 'custom', path: [key], message: `Enter the ${driverNames[profile.driver]} ${key}.` });
    if(isMysqlFamily(profile.driver)&&['allow','prefer'].includes(profile.sslMode??''))ctx.addIssue({code:'custom',path:['sslMode'],message:`${driverNames[profile.driver]} TLS does not support plaintext fallback modes.`});
    if(isMysqlFamily(profile.driver)&&profile.host?.startsWith('/'))ctx.addIssue({code:'custom',path:['host'],message:`${driverNames[profile.driver]} requires a TCP hostname or IP address.`});
    if (Boolean(profile.certPath) !== Boolean(profile.keyPath)) ctx.addIssue({ code: 'custom', path: ['certPath'], message: 'Client certificate and key must be provided together.' });
    if (profile.sslMode === 'disable' && (profile.caPath || profile.certPath || profile.keyPath)) ctx.addIssue({ code: 'custom', path: ['sslMode'], message: 'Enable TLS before configuring certificates.' });
  }
});
export type ConnectionProfile = z.infer<typeof ProfileSchema>;
export interface ConnectionEditorState { revision: string; hasPassword: boolean; rememberPassword: boolean; }
export interface ConnectionEditResult { profile: ConnectionProfile; editor: ConnectionEditorState; }
export const IMPORT_FIELDS = ['name', 'driver', 'storage', 'path', 'connectionString', 'host', 'port', 'database', 'user', 'password', 'authRef', 'tunnelRef', 'sslMode', 'caPath', 'certPath', 'keyPath', 'connectTimeout', 'applicationName', 'readOnly', 'createIfMissing', 'group', 'color', 'scope', 'id'] as const;
export type ImportField = typeof IMPORT_FIELDS[number];
export type ImportFormat = 'json' | 'csv';
export type ImportAction = 'create' | 'copy' | 'replace' | 'skip';
export interface ImportRow { index: number; name: string; profile?: ConnectionProfile; errors: string[]; warnings: string[]; exists: boolean; action: ImportAction; hasPassword?: boolean; }
export interface ImportPreview { token: string; format: ImportFormat; headers?: string[]; mapping?: Partial<Record<ImportField, number>>; rows: ImportRow[]; }
export interface ImportReport { rows: { index: number; name: string; status: 'created' | 'replaced' | 'skipped' | 'invalid' | 'failed'; id?: string; message?: string }[]; }
export interface ColumnMeta {
  key: string; name: string; dataType: string; nullable: boolean;
  primaryKey: number; generated: boolean; defaultValue?: string | null;
  sourceColumn?: string; sourceTable?: string;
}
export interface SchemaObject {
  name: string; type: 'table' | 'view'; sql: string | null;
  schema?: string; label?: string;
  columns?: ColumnMeta[];
}
export interface TableDetails extends SchemaObject {
  columns: ColumnMeta[];
  indexes: { name: string; unique: boolean; columns: string[] }[];
  foreignKeys: { id: number; table: string; from: string; to: string; onUpdate: string; onDelete: string }[];
}
export interface QueryResult {
  columns: ColumnMeta[]; rows: DataRow[]; durationMs: number; affectedRows: number;
  truncated: boolean; sql: string; sourceTable?: string; readOnly: boolean;
}
export interface RunStatement {
  index: number; start: number; end: number; sql: string;
  status: 'succeeded' | 'failed'; result?: QueryResult; error?: string;
}
export interface QueryRun {
  id: string; sql: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  statements: RunStatement[]; durationMs: number; transaction: TransactionState; error?: string; sourceOffset?: number;
}
/** Own-property records preserve legal SQL names such as __proto__ without using object setters. */
export function safeRecord<T extends z.ZodTypeAny>(schema:T){return z.unknown().transform((input,context):Record<string,z.infer<T>>=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>10000){context.addIssue({code:'custom',message:'Expected an object with at most 10,000 fields.'});return z.NEVER;}
  const result:Record<string,z.infer<T>>=Object.create(null);for(const [key,value]of Object.entries(input)){const parsed=schema.safeParse(value);if(!parsed.success){context.addIssue({code:'custom',path:[key],message:'Invalid field value.'});return z.NEVER;}result[key]=parsed.data;}return result;
});}
export const ChangeSchema = z.object({
  kind: z.enum(['insert', 'update', 'delete']),
  original: safeRecord(CellSchema).optional(), values: safeRecord(CellSchema),
}).strict();
export type RowChange = z.infer<typeof ChangeSchema>;
export const GridEditStateSchema = z.object({
  edits: z.record(ChangeSchema),
  added: z.array(z.object({ id: z.string().regex(/^new[\w-]+$/), values: z.record(CellSchema) }).strict()).max(10000),
  keyColumns: z.array(z.string()).max(1000),
}).strict();
export type GridEditState = z.infer<typeof GridEditStateSchema>;
export interface GridEditorState {
  revision: number; edits: GridEditState; dirty: boolean; busy: boolean; canUndo: boolean; canRedo: boolean;
  result: QueryResult; request: TableRequest; message?: string; error?: string;
}
export const TableRequestSchema = z.object({
  table: z.string().min(1), where: z.string().max(100000).default(''),
  limit: z.number().int().min(1).max(100000).default(100),
  offset: z.number().int().min(0).default(0),
  order: z.array(z.object({ column: z.string(), direction: z.enum(['asc', 'desc']) })).max(20).default([]),
}).strict();
export type TableRequest = z.infer<typeof TableRequestSchema>;
export const QueryRequestSchema = z.object({
  sql: z.string().trim().min(1).max(10_000_000), limit: z.number().int().min(0).max(1_000_000).default(100000),
}).strict();
export const RunRequestSchema = z.object({ sql: z.string().min(1).max(10_000_000), limit: z.number().int().min(0).max(1_000_000).default(100000) }).strict();
export interface RuntimeInfo { sqlite: string; node: string; path: string; driver?: keyof typeof driverNames; serverVersion?: string; transaction?: TransactionState; tls?: 'disabled'|'encrypted'|'verify-ca'|'verify-full';sqliteRuntimeValidated?:boolean; }
export interface ApplyReport { affectedRows: number; }
export const ExpectedTableSchema=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),detailsSha256:z.string().regex(/^[a-f0-9]{64}$/),rowCount:z.number().int().min(0).max(100000),limit:z.number().int().min(1).max(100000)}).strict();
export type ExpectedTable=z.infer<typeof ExpectedTableSchema>;
export interface ApplyOptions {requireAutocommit?:boolean;expected?:ExpectedTable;verifyValues?:boolean;}
export interface QuerySessionState { owner: string; connected: boolean; lost: boolean; transaction: TransactionState; busy: boolean; }
export interface WorkbenchBoot {
  view: 'connection' | 'table' | 'query' | 'connections-import' | 'authentication' | 'tunnel' | 'structure' | 'data-import' | 'sqlite-backup' | 'server-backup' | 'comparison' | 'combination' | 'query-plan' | 'sql-parameters'; profile: ConnectionProfile;
  sqlParameters?:import('./sql-parameters.js').SqlParameterForm;
  queryPlan?:import('./query-plans.js').QueryPlanReport;
  combination?:{operation:'join'|'union';sources:import('./combinations.js').CombinationSource[];limit:number};
  comparison?:{source?:import('./comparisons.js').CompareSource;target?:import('./comparisons.js').CompareSource};
  nativeTools?:{dump:string;restore:string};
  structure?:TableStructure;
  structureSchema?:string;
  table?: string; result?: QueryResult; details?: TableDetails;
  editor?: GridEditorState;
  query?: QuerySessionState;
  run?: QueryRun;
  transfer?: { workspaceAvailable: boolean; workspaceDirectory?: string; };
  connectionEditor?: ConnectionEditorState;
  resources?: ResourceSummary;
  resource?: {kind:ResourceKind;value:ConnectionResource;editor:ResourceEditorState};
}
export const WebRequestSchema = z.discriminatedUnion('method', [
  z.object({method:z.literal('parameters.preview'),params:z.object({values:SqlParameterValuesSchema}).strict()}),
  z.object({method:z.literal('parameters.submit'),params:z.object({values:SqlParameterValuesSchema}).strict()}),
  z.object({method:z.literal('parameters.cancel'),params:z.object({}).strict()}),
  z.object({method:z.literal('plan.action'),params:z.object({action:z.enum(['source','copy','export'])}).strict()}),
  z.object({method:z.literal('combine.catalog'),params:z.object({}).strict()}),
  z.object({method:z.literal('combine.describe'),params:z.object({source:CombinationSourceSchema}).strict()}),
  z.object({method:z.literal('combine.run'),params:CombinationInputSchema}),
  z.object({method:z.literal('combine.page'),params:z.object({id:z.string().uuid(),offset:z.number().int().min(0),columnOffset:z.number().int().min(0)}).strict()}),
  z.object({method:z.literal('combine.lineage'),params:z.object({id:z.string().uuid()}).strict()}),
  z.object({method:z.literal('combine.export'),params:z.object({id:z.string().uuid(),format:z.enum(['csv','json'])}).strict()}),
  z.object({method:z.literal('combine.forget'),params:z.object({id:z.string().uuid()}).strict()}),
  z.object({method:z.literal('combine.cancel'),params:z.object({}).strict()}),
  z.object({method:z.literal('compare.catalog'),params:z.object({}).strict()}),
  z.object({method:z.literal('compare.clearResults'),params:z.object({}).strict()}),
  z.object({method:z.literal('compare.objects'),params:z.object({profileId:z.string().min(1).max(100)}).strict()}),
  z.object({method:z.literal('compare.suggest'),params:z.object({source:CompareSourceSchema,target:CompareSourceSchema}).strict()}),
  z.object({method:z.literal('compare.run'),params:CompareInputSchema}),
  z.object({method:z.literal('compare.page'),params:z.object({token:z.string().uuid(),offset:z.number().int().min(0),limit:z.number().int().min(1).max(200),differencesOnly:z.boolean()}).strict()}),
  z.object({method:z.literal('compare.differenceIds'),params:z.object({token:z.string().uuid()}).strict()}),
  z.object({method:z.literal('compare.previewSync'),params:z.object({token:z.string().uuid(),rows:z.array(z.string().regex(/^d\d+$/)).min(1).max(10000)}).strict()}),
  z.object({method:z.literal('compare.applySync'),params:z.object({token:z.string().uuid()}).strict()}),
  z.object({method:z.literal('compare.openScript'),params:z.object({token:z.string().uuid()}).strict()}),
  z.object({method:z.literal('compare.cancel'),params:z.object({}).strict()}),
  z.object({method:z.literal('serverBackup.create'),params:z.object({}).strict()}),
  z.object({method:z.literal('serverBackup.preview'),params:z.object({}).strict()}),
  z.object({method:z.literal('serverBackup.restore'),params:z.object({token:z.string().uuid(),database:z.string().min(1).max(1000),trusted:z.boolean()}).strict()}),
  z.object({method:z.literal('serverBackup.reviewSql'),params:z.object({token:z.string().uuid()}).strict()}),
  z.object({method:z.literal('serverBackup.cancel'),params:z.object({}).strict()}),
  z.object({method:z.literal('serverBackup.report'),params:z.object({}).strict()}),
  z.object({method:z.literal('serverBackup.settings'),params:z.object({}).strict()}),
  z.object({method:z.literal('backup.create'),params:z.object({}).strict()}),
  z.object({method:z.literal('backup.previewRestore'),params:z.object({}).strict()}),
  z.object({method:z.literal('backup.restore'),params:z.object({token:z.string().uuid()}).strict()}),
  z.object({method:z.literal('backup.cancel'),params:z.object({}).strict()}),
  z.object({method:z.literal('backup.report'),params:z.object({}).strict()}),
  z.object({method:z.literal('backup.addConnection'),params:z.object({}).strict()}),
  z.object({method:z.literal('data.pick'),params:z.object({format:z.enum(['csv','json']),delimiter:z.enum([',',';','\t']),header:z.boolean(),nullToken:z.string().min(1).max(100)}).strict()}),
  z.object({method:z.literal('data.preview'),params:z.object({source:z.string().uuid(),mapping:safeRecord(z.number().int().min(0).max(9999))}).strict()}),
  z.object({method:z.literal('data.apply'),params:z.object({token:z.string().uuid(),skipInvalid:z.boolean(),batchSize:z.number().int().min(1).max(2000)}).strict()}),
  z.object({method:z.literal('data.cancel'),params:z.object({}).strict()}),
  z.object({method:z.literal('data.report.open'),params:z.object({}).strict()}),
  z.object({method:z.literal('data.openImport'),params:z.object({}).strict()}),
  z.object({method:z.literal('data.exportAll'),params:z.object({format:z.enum(['csv','json'])}).strict()}),
  z.object({method:z.literal('ddl.load'),params:z.object({}).strict()}),
  z.object({method:z.literal('ddl.preview'),params:z.object({intent:DdlIntentSchema}).strict()}),
  z.object({method:z.literal('ddl.apply'),params:z.object({token:z.string().uuid()}).strict()}),
  z.object({method:z.literal('ddl.openSql'),params:z.object({token:z.string().uuid().optional()}).strict()}),
  z.object({ method: z.literal('initialize'), params: z.object({}).strict() }),
  z.object({ method: z.literal('file.pick'), params: z.object({ create: z.boolean() }).strict() }),
  z.object({ method: z.literal('profile.test'), params: ProfileSchema }),
  z.object({ method: z.literal('profile.save'), params: ProfileSchema }),
  z.object({ method: z.literal('profile.edit.test'), params: z.object({ profile: ProfileSchema, password: z.string().max(10000).optional() }).strict() }),
  z.object({ method: z.literal('profile.edit.save'), params: z.object({ profile: ProfileSchema, password: z.string().max(10000).optional(), rememberPassword: z.boolean().optional(), revision: z.string() }).strict() }),
  z.object({method:z.literal('resources.list'),params:z.object({}).strict()}),
  z.object({method:z.literal('tunnel.source.open'),params:z.object({id:z.string().min(1).max(100),file:z.enum(['config','known-hosts'])}).strict()}),
  z.object({method:z.literal('tunnel.credentials.save'),params:z.object({id:z.string().min(1).max(100),password:z.string().max(10000).optional(),passphrase:z.string().max(10000).optional(),remember:z.boolean(),revision:z.string()}).strict()}),
  z.object({method:z.literal('authentication.clearCache'),params:z.object({id:z.string().min(1).max(100)}).strict()}),
  z.object({method:z.literal('resource.save'),params:z.object({kind:z.enum(['authentication','tunnel']),value:z.union([AuthenticationSchema,TunnelSchema]),secret:z.string().max(10000).optional(),remember:z.boolean(),revision:z.string()}).strict()}),
  z.object({method:z.literal('tunnel.test'),params:z.object({value:TunnelSchema,secret:z.string().max(10000).optional()}).strict()}),
  z.object({method:z.literal('tunnel.fingerprint'),params:z.object({host:z.string().min(1).max(1000),port:z.number().int().min(1).max(65535),timeout:z.number().int().min(1000).max(120000)}).strict()}),
  z.object({ method: z.literal('profile.parseString'), params: z.object({ id: z.string(), text: z.string().min(1).max(100000) }).strict() }),
  z.object({ method: z.literal('connections.import.pick'), params: z.object({}).strict() }),
  z.object({ method: z.literal('connections.import.inspect'), params: z.object({ text: z.string().max(5_000_000), delimiter: z.enum([',', ';', '\t']) }).strict() }),
  z.object({ method: z.literal('connections.import.preview'), params: z.object({ text: z.string().max(5_000_000), format: z.enum(['json', 'csv']), delimiter: z.enum([',', ';', '\t']).default(','), mapping: z.record(z.number().int().min(0)).optional(), pathBase: z.enum(['workspace', 'source']).default('source') }).strict() }),
  z.object({ method: z.literal('connections.import.apply'), params: z.object({ token: z.string(), scope: z.enum(['global', 'workspace']), rememberPasswords: z.boolean().default(false), decisions: z.array(z.object({ index: z.number().int().min(0), action: z.enum(['create', 'copy', 'replace', 'skip']) }).strict()).max(10000) }).strict() }),
  z.object({ method: z.literal('table.load'), params: TableRequestSchema }),
  z.object({ method: z.literal('table.apply'), params: z.object({ table: z.string().min(1), keyColumns: z.array(z.string()), changes: z.array(ChangeSchema).min(1).max(10000) }).strict() }),
  z.object({ method: z.literal('query.execute'), params: QueryRequestSchema }),
  z.object({ method: z.literal('query.run'), params: RunRequestSchema }),
  z.object({ method: z.literal('query.result.select'), params: z.object({ index: z.number().int().min(0) }).strict() }),
  z.object({ method: z.literal('query.cancel'), params: z.object({}).strict() }),
  z.object({ method: z.literal('query.transaction'), params: z.object({ action: z.enum(['begin', 'commit', 'rollback']) }).strict() }),
  z.object({ method: z.literal('query.reset'), params: z.object({}).strict() }),
  z.object({ method: z.literal('file.export'), params: z.object({ format: z.enum(['csv', 'json']) }).strict() }),
  z.object({ method: z.literal('clipboard.write'), params: z.object({ text: z.string().max(2_000_000) }).strict() }),
  z.object({ method: z.literal('clipboard.read'), params: z.object({}).strict() }),
  z.object({ method: z.literal('confirm.discard'), params: z.object({}).strict() }),
  z.object({ method: z.literal('view.dirty'), params: z.object({ dirty: z.boolean() }).strict() }),
  z.object({ method: z.literal('editor.update'), params: z.object({ revision: z.number().int().min(0), state: GridEditStateSchema }).strict() }),
  z.object({ method: z.literal('editor.keys'), params: z.object({ keyColumns: z.array(z.string()).max(1000) }).strict() }),
  z.object({ method: z.literal('editor.save'), params: z.object({}).strict() }),
  z.object({ method: z.literal('editor.undo'), params: z.object({}).strict() }),
  z.object({ method: z.literal('editor.redo'), params: z.object({}).strict() }),
  z.object({ method: z.literal('editor.flush-complete'), params: z.object({ token: z.string(), error: z.string().optional() }).strict() }),
]);
export const WebEnvelopeSchema = z.object({ version: z.literal(PROTOCOL_VERSION), id: z.string().max(100), request: WebRequestSchema }).strict();
export const RunnerRequestSchema = z.discriminatedUnion('method', [
  z.object({method:z.literal('backup.to'),params:z.object({path:z.string().min(1),operation:z.string().uuid()}).strict()}),
  z.object({method:z.literal('backup.cancel'),params:z.object({operation:z.string().uuid()}).strict()}),
  z.object({method:z.literal('backup.inspect'),params:z.object({}).strict()}),
  z.object({method:z.literal('cursor.open'),params:z.object({sql:z.string().min(1).max(10_000_000)}).strict()}),
  z.object({method:z.literal('cursor.next'),params:z.object({id:z.string().uuid(),size:z.number().int().min(1).max(2000)}).strict()}),
  z.object({method:z.literal('cursor.close'),params:z.object({id:z.string().uuid()}).strict()}),
  z.object({ method: z.literal('open'), params: ProfileSchema }),
  z.object({ method: z.literal('schema'), params: z.object({}).strict() }),
  z.object({ method: z.literal('details'), params: z.object({ table: z.string().min(1) }).strict() }),
  z.object({ method: z.literal('table'), params: TableRequestSchema }),
  z.object({ method: z.literal('query'), params: QueryRequestSchema }),
  z.object({ method: z.literal('run'), params: RunRequestSchema.extend({ runId: z.string().min(1).max(100) }).strict() }),
  z.object({ method: z.literal('session.create'), params: z.object({ sessionId: z.string().min(1).max(100) }).strict() }),
  z.object({ method: z.literal('session.release'), params: z.object({ sessionId: z.string().min(1).max(100) }).strict() }),
  z.object({ method: z.literal('apply'), params: z.object({ table: z.string().min(1), keyColumns: z.array(z.string()), changes: z.array(ChangeSchema).min(1).max(10000), requireAutocommit: z.boolean().default(true),expected:ExpectedTableSchema.optional(),verifyValues:z.boolean().default(false) }).strict() }),
  z.object({ method: z.literal('close'), params: z.object({}).strict() }),
]);
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;
export type RunnerMethod = RunnerRequest['method'];
export const RunnerEnvelopeSchema = z.object({ version: z.literal(PROTOCOL_VERSION), id: z.string().max(100), sessionId: z.string().min(1).max(100).optional(), request: RunnerRequestSchema }).strict();
export interface RpcError { code: string; message: string; sessionLost?: boolean; }
export interface RpcResponse { version: 1; id: string; result?: unknown; error?: RpcError; session?: { transaction: TransactionState }; }
export type RunnerEvent = { version: 1; id: string; event: 'run.statement'; statement: RunStatement; session?: { transaction: TransactionState }; } | {version:1;id:string;event:'backup.progress';progress:{totalPages:number;remainingPages:number};session?:{transaction:TransactionState}};
export interface SqliteFileInfo {sqliteVersion:string;pageSize:number;pageCount:number;userVersion:number;applicationId:number;objectCount:number;objects:{type:string;name:string;table:string;sql:string|null}[];foreignKeyViolations:number;}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function displayCell(value: CellValue | undefined): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (typeof value === 'object') return value.type === 'integer' ? value.value : `[BLOB · ${Math.floor(value.base64.length * 3 / 4)} bytes]`;
  return String(value);
}
export function editableCell(value: CellValue | undefined): string {
  if (value === null) return '';
  if (typeof value === 'object') return value.type === 'integer' ? value.value : value.base64;
  return value === undefined ? '' : String(value);
}
export function parseCell(text: string, column: ColumnMeta, original?: CellValue): CellValue {
  if (typeof original === 'object' && original?.type === 'binary') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error('Binary values must be valid Base64.');
    return { type: 'binary', base64: text };
  }
  if (/INT/i.test(column.dataType) && !/^interval\b/i.test(column.dataType)) {
    if (!/^-?\d+$/.test(text)) throw new Error(`${column.name} requires an integer. Use Set NULL for a null value.`);
    const value = BigInt(text);
    if (value < (/UNSIGNED/i.test(column.dataType)?0n:-9223372036854775808n) || value > (/UNSIGNED/i.test(column.dataType)?18446744073709551615n:9223372036854775807n)) throw new Error('Integer is outside the supported 64-bit range.');
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : { type: 'integer', value: value.toString() };
  }
  if (/REAL|FLOAT|DOUBLE/i.test(column.dataType)) {
    if (!text.trim() || !Number.isFinite(Number(text))) throw new Error(`${column.name} requires a finite number.`);
    return Number(text);
  }
  return text;
}
