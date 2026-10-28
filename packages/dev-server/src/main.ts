import {QueryPlans} from '../../core/src/query-plans.js';
import {sqlParameters,renderSqlParameters} from '../../core/src/sql-parameters.js';
// Loopback-only development host backed by the same real SQLite runner used by
// the extension. This is a verification harness, not a second product backend.
import { createServer } from 'node:http';
import {SchemaChanges} from '../../core/src/schema-changes.js';
import {DataTransfers} from '../../core/src/data-transfers.js';
import {SqliteBackups,type BackupReport} from '../../core/src/sqlite-backups.js';
import {Comparisons} from '../../core/src/comparisons.js';
import {Combinations} from '../../core/src/combinations.js';
import {readTableStructure} from '../../core/src/table-structure.js';
import { mkdir, readFile, writeFile,appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ConnectionManager, type ProfileStore } from '../../core/src/connections.js';
import { exportResult } from '../../core/src/export.js';
import { GridDocumentModel, type GridEditTransition } from '../../core/src/grid-document.js';
import { SqlDocuments } from '../../core/src/sql-documents.js';
import { ConnectionTransfers, mapConnectionHeaders, parseConnectionCsv } from '../../core/src/connection-transfer.js';
import { parseConnectionString } from '../../core/src/connection-strings.js';
import { errorMessage, WebRequestSchema,AuthenticationSchema,TunnelSchema, driverNames, isMysqlFamily, type ConnectionProfile, type QueryResult, type WorkbenchBoot,type ResourceSummary,type ConnectionResource } from '../../protocol/src/index.js';
import {ConnectionResources,type ResourceStore} from '../../core/src/resources.js';
import {SshTunnels} from '../../core/src/tunnels.js';
import {discoverSshConfigs} from '../../core/src/ssh-config.js';

const postgres = process.env.DBW_PREVIEW_DRIVER === 'postgresql', familyDriver=process.env.DBW_PREVIEW_DRIVER==='mariadb'?'mariadb':'mysql', mysql = isMysqlFamily(process.env.DBW_PREVIEW_DRIVER??'');
const dailyAcceptance=process.env.DBW_DAILY_ACCEPTANCE==='1';
const directory = resolve(dailyAcceptance?`.cache/daily-preview-${process.env.DBW_PREVIEW_DRIVER??'sqlite'}-${Date.now()}`:mysql ? `.cache/preview-${familyDriver}` : postgres ? '.cache/preview-postgresql' : '.cache/preview'); await mkdir(directory, { recursive: true });
const profile: ConnectionProfile = mysql ? {schemaVersion:1,id:`preview-${familyDriver}`,driver:familyDriver,name:`${driverNames[familyDriver]} development`,storage:'server',path:'',host:'localhost',port:Number(process.env.DBW_MYSQL_PORT),database:'dbworkbench',user:'dbw',sslMode:'verify-full',caPath:process.env.DBW_MYSQL_CA,scope:'global',group:'',color:'#2684a6',readOnly:false,createIfMissing:false} : postgres
  ? { schemaVersion:1,id:'preview-postgres',driver:'postgresql',name:'PostgreSQL development',storage:'server',path:'',host:'127.0.0.1',port:Number(process.env.DBW_PG_PORT),database:'dbworkbench',user:'dbw',sslMode:'verify-full',caPath:process.env.DBW_PG_CA,scope:'global',group:'',color:'#2684a6',readOnly:false,createIfMissing:false }
  : { schemaVersion: 1, id: 'preview-local', driver: 'sqlite', name: 'Local development', storage: 'file', path: join(directory, 'workspace.db'), scope: 'global', group: '', color: '#2684a6', readOnly: false, createIfMissing: true };
const profiles = [profile];
const resourceData:ResourceSummary={authentication:[],tunnels:[]},resourceSecrets=new Map<string,string>();
const resourceStore:ResourceStore={list:()=>resourceData,save:async(kind,value)=>{const rows=kind==='authentication'?resourceData.authentication:resourceData.tunnels,index=rows.findIndex(v=>v.id===value.id);if(index<0)(rows as ConnectionResource[]).push(value);else (rows as ConnectionResource[])[index]=value;await writeFile(join(directory,'resources.json'),JSON.stringify(resourceData,null,2));},remove:async(kind,id)=>{if(kind==='authentication')resourceData.authentication=resourceData.authentication.filter(v=>v.id!==id);else resourceData.tunnels=resourceData.tunnels.filter(v=>v.id!==id);}};
const resources=new ConnectionResources(resourceStore,{get:async id=>resourceSecrets.get(id),store:async(id,value)=>{resourceSecrets.set(id,value);},delete:async id=>{resourceSecrets.delete(id);}},()=>profiles),tunnels=new SshTunnels(resources);
let sshPreview:Awaited<ReturnType<typeof import('../../../tests/fixtures/ssh-server.js')['sshFixture']>>|undefined;
if(postgres&&process.env.DBW_PREVIEW_SSH==='1'){
  const {sshFixture}=await import('../../../tests/fixtures/ssh-server.js');sshPreview=await sshFixture({allowedPort:profile.port,mapHost:()=> '127.0.0.1'});
  await resources.save('authentication',AuthenticationSchema.parse({id:'preview-auth',name:'Shared PostgreSQL credentials',kind:'password',user:'dbw'}),{secret:process.env.DBW_PG_PASSWORD,remember:false,revision:resources.revision('authentication','preview-auth')});
  await resources.save('tunnel',TunnelSchema.parse({id:'preview-ssh',name:'SSH development tunnel',kind:'ssh',host:'127.0.0.1',port:sshPreview.port,user:'ssh-user',auth:'password',fingerprint:sshPreview.fingerprint}),{secret:'ssh-test-password',remember:false,revision:resources.revision('tunnel','preview-ssh')});Object.assign(profile,{host:'localhost',authRef:'preview-auth',tunnelRef:'preview-ssh',user:undefined});
  if(process.env.DBW_PREVIEW_SSH_CONFIG==='1'){
    const config=join(directory,'ssh_config'),known=join(directory,'known_hosts');await writeFile(known,`[127.0.0.1]:${sshPreview.port} ${sshPreview.publicHostKey}\n`);await writeFile(config,`Host development-config\n HostName 127.0.0.1\n Port ${sshPreview.port}\n User ssh-user\n PubkeyAuthentication no\n UserKnownHostsFile "${known}"\n GlobalKnownHostsFile none\n`);
    resources.setDiscoveredTunnels((await discoverSshConfigs([config])).tunnels);const discovered=resources.list().tunnels.find(v=>v.source)!;await resources.saveTunnelCredentials(discovered.id,{password:'ssh-test-password',remember:false,revision:resources.revision('tunnel',discovered.id)});profile.tunnelRef=discovered.id;
  }
}
const store: ProfileStore = { list: () => profiles, save: async value => { const index = profiles.findIndex(p => p.id === value.id); if (index >= 0) profiles[index] = value; else profiles.push(value); await writeFile(join(directory, 'profiles.json'), JSON.stringify(profiles, null, 2)); }, remove: async id => { const index = profiles.findIndex(p => p.id === id); if (index >= 0) profiles.splice(index, 1); } };
// Preview credentials are disposable, in-memory only. Native SecretStorage is tested in VS Code separately.
const connectionSecrets=new Map<string,string>();
const manager = new ConnectionManager(store, { runnerPath: resolve('dist/sqlite-runner.cjs'),resources,tunnels,
  credentials:{get:async id=>connectionSecrets.get(id),store:async(id,value)=>{connectionSecrets.set(id,value);},delete:async id=>{connectionSecrets.delete(id);}} });
if ((postgres||mysql)&&!profile.authRef) await manager.setPassword(profile.id,(mysql?process.env.DBW_MYSQL_PASSWORD:process.env.DBW_PG_PASSWORD)!,'session');
resources.beforeChange=async(kind,id)=>{await Promise.all(profiles.filter(p=>(kind==='authentication'?p.authRef:p.tunnelRef)===id).map(p=>manager.disconnect(p.id)));if(kind==='tunnel')await tunnels.disconnect(id);return true;};
const transfers = new ConnectionTransfers(manager);
const sqlDocuments = new SqlDocuments(manager); const queryOwner = 'preview-sql'; await sqlDocuments.bind(queryOwner, profile.id);
const parameterSql="SELECT :{minimum||9223372036854775807||number} AS minimum,\n       :{label||O'Reilly 你好||string} AS label,\n       :{day||now||date} AS day, :{code||0001||||opaque} AS code,\n       :nullable AS optional, :minimum AS repeated;";
const parameterScan=sqlParameters(parameterSql,profile.driver),parameterForm={sql:parameterSql,parameters:parameterScan.parameters,values:parameterScan.parameters.map(p=>({key:p.key,type:p.type==='auto'?'string' as const:p.type,value:p.key===':nullable'?null:p.defaultValue??''}))};
const session = await manager.connect(profile.id);
if (!(await session.schema()).some(table => table.name === (mysql ? '`dbworkbench`.`teams`' : postgres ? 'public.teams' : 'teams'))) {
  await session.query(`CREATE TABLE teams(workspace_id INTEGER NOT NULL DEFAULT 1,name VARCHAR(100) NOT NULL,status VARCHAR(40) NOT NULL DEFAULT '启用',description TEXT,id ${mysql?'INTEGER PRIMARY KEY AUTO_INCREMENT':postgres ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY'},created_at ${mysql?'DATETIME(6)':postgres ? 'TIMESTAMP' : 'TEXT'} DEFAULT CURRENT_TIMESTAMP${mysql?'(6)':''})`);
  await session.query("INSERT INTO teams(name,description) VALUES ('核心平台组','核心系统与平台能力建设'),('业务交付组','业务需求交付与产品协同'),('质量保障组','测试、质量和发布保障'),('数据治理组','数据治理与指标体系建设'),('研发一组','人员初始化样本'),('研发二组','数据库工作台集成验证')");
}
const tableName=dailyAcceptance?'daily_items':'teams';
const table = mysql ? '`dbworkbench`.`'+tableName+'`' : postgres ? 'public.'+tableName : tableName; const results = new Map<string, QueryResult>();
if(dailyAcceptance){
  await session.query('CREATE TABLE daily_items(id INTEGER PRIMARY KEY,name VARCHAR(100) NOT NULL,status VARCHAR(40),description TEXT)');
  await session.apply(table,[],Array.from({length:305},(_,i)=>({kind:'insert' as const,values:{id:i+1,name:'Daily '+String(i+1).padStart(3,'0'),status:i%2?'Even':'Odd',description:i===0?"中文 O'Reilly\nline 2":'Fixture '+(i+1)}})));
  await writeFile(join(directory,'daily-environment.json'),JSON.stringify({profile,table,expectedRows:305,runtime:session.info,password:mysql?process.env.DBW_MYSQL_PASSWORD:postgres?process.env.DBW_PG_PASSWORD:undefined},null,2));
  console.log('Isolated daily acceptance fixture: '+directory);
}
const tableRequest = { table, where: '', order: [], limit: 100, offset: 0 };
const document = new GridDocumentModel(profile, await session.details(table), await session.table(tableRequest), tableRequest,manager.resourceBinding(profile));
const undo: GridEditTransition[] = [], redo: GridEditTransition[] = [];
const schemaChanges=new SchemaChanges(manager);
const dataTransfers=new DataTransfers(manager,join(directory,'transfer-cache'));let lastDataReport:import('../../core/src/data-transfers.js').ImportReport|undefined;
const sqliteBackups=new SqliteBackups(manager,join(directory,'sqlite-backups'));let lastBackupReport:BackupReport|undefined,backupSource:string|undefined;
const comparisons=new Comparisons(manager);let comparisonToken:string|undefined,comparisonAbort:AbortController|undefined;
const combinations=new Combinations(comparisons);let combinationAbort:AbortController|undefined;
if(!postgres&&!mysql&&!(await session.schema()).some(t=>t.name==='combination_members')){await session.query('CREATE TABLE combination_members(team_id INTEGER,member TEXT)');await session.query("INSERT INTO combination_members VALUES(1,'Alice'),(1,'Bob'),(2,'Chen'),(NULL,'Unassigned'),(999,'No matching team')");}
if(!postgres&&!mysql)comparisons.registerResult(profile.id,await session.query('SELECT id AS shared,workspace_id AS shared FROM teams'),'Duplicate labels (preview)');
if(!postgres&&!mysql&&!(await session.schema()).some(t=>t.name==='comparison_target')){await session.query('CREATE TABLE comparison_target AS SELECT * FROM teams');await session.query("UPDATE comparison_target SET name='Target version' WHERE id=1");await session.query('DELETE FROM comparison_target WHERE id=2');await session.query('UPDATE comparison_target SET id=100 WHERE id=3');}
const structureTable=new Map<string,string|undefined>();
const queryPlans=new QueryPlans(manager,sqlDocuments);
const port = Number(process.env.DBW_PREVIEW_PORT ?? 4318);
const html = '<!doctype html><html class="browser-preview"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>DBNook · Development</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const server = createServer(async (req, res) => {
  let queryView = false;
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) throw new Error('Unexpected development origin.');
      let body = ''; for await (const chunk of req) { body += String(chunk); if (body.length > 6_000_000) throw new Error('Request too large.'); }
      const request = WebRequestSchema.parse(JSON.parse(body)); let result: unknown;
      const view:WorkbenchBoot['view'] = url.searchParams.get('view')==='sql-parameters'?'sql-parameters':url.searchParams.get('view')==='query-plan'?'query-plan':url.searchParams.get('view')==='combination'?'combination':url.searchParams.get('view')==='comparison'?'comparison':url.searchParams.get('view')==='server-backup'?'server-backup':url.searchParams.get('view')==='sqlite-backup'?'sqlite-backup':url.searchParams.get('view')==='data-import'?'data-import':url.searchParams.get('view')==='structure'?'structure':url.searchParams.get('view') === 'authentication' ? 'authentication':url.searchParams.get('view') === 'tunnel'?'tunnel':url.searchParams.get('view') === 'import' ? 'connections-import' : url.searchParams.get('view') === 'connection' ? 'connection' : url.searchParams.get('view') === 'query' ? 'query' : 'table';
      const structureKey=url.searchParams.get('table')??table,structureName=structureTable.has(structureKey)?structureTable.get(structureKey):(url.searchParams.get('create')==='1'?undefined:structureKey);
      const structureBoot=async():Promise<WorkbenchBoot>=>({view:'structure',profile,table:structureName,structure:structureName?await schemaChanges.structure(profile.id,structureName):undefined});
      queryView = view === 'query';
      switch (request.method) {
        case 'parameters.preview': {if(view!=='sql-parameters')throw new Error('Use the SQL parameter preview.');const sql=renderSqlParameters(parameterSql,parameterScan,request.params.values,profile.driver,session.sqlMode);result={sql:sql.slice(0,250000),truncated:sql.length>250000};break;}
        case 'parameters.submit': {if(view!=='sql-parameters')throw new Error('Use the SQL parameter preview.');result=await sqlDocuments.run(queryOwner,renderSqlParameters(parameterSql,parameterScan,request.params.values,profile.driver,session.sqlMode));break;}
        case 'parameters.cancel': result=null;break;
        case 'initialize': {
          if(view==='sql-parameters'){result={view,profile,sqlParameters:parameterForm} satisfies WorkbenchBoot;break;}
          if(view==='query-plan'){const sql=!mysql&&!postgres?'SELECT t.name,m.member FROM teams t LEFT JOIN combination_members m ON t.id=m.team_id WHERE t.id>1 ORDER BY t.name':`SELECT * FROM ${table} WHERE id>1`;result={view,profile,queryPlan:await queryPlans.run((await queryPlans.prepare(queryOwner,sql,'explain')).token)} satisfies WorkbenchBoot;break;}
          if(view==='combination'){result={view,profile,combination:{operation:'join',sources:[{kind:'table',profileId:profile.id,table},{kind:'table',profileId:profile.id,table:!mysql&&!postgres?'combination_members':table}],limit:10000}} satisfies WorkbenchBoot;break;}
          if(view==='comparison'){result={view,profile,comparison:{source:{kind:'table',profileId:profile.id,table},target:!mysql&&!postgres?{kind:'table',profileId:profile.id,table:'comparison_target'}:undefined}} satisfies WorkbenchBoot;break;}
          if(view==='sqlite-backup'){result={view,profile} satisfies WorkbenchBoot;break;}
          if(view==='server-backup'){result={view,profile,nativeTools:{dump:'',restore:''}} satisfies WorkbenchBoot;break;}
          if(view==='data-import'){result={view,profile,table,structure:await readTableStructure(session,table)} satisfies WorkbenchBoot;break;}
          if(view==='structure'){result=await structureBoot();break;}
          if(view==='authentication'||view==='tunnel'){
            const id=view==='authentication'?'preview-auth':process.env.DBW_PREVIEW_SSH_CONFIG==='1'?profile.tunnelRef!:'preview-ssh',existing=(view==='authentication'?resources.list().authentication:resources.list().tunnels).find(v=>v.id===id);
            const value:ConnectionResource=existing??(view==='authentication'?{id,name:'',kind:'password',user:'',scope:'global'}:{id,name:'',kind:'ssh',host:'',port:22,user:'',auth:'password',fingerprint:'',readyTimeout:15000,scope:'global'});
            result={view,profile,resource:{kind:view,value,editor:await resources.editor(view,id)},resources:resources.list(),transfer:{workspaceAvailable:true}} satisfies WorkbenchBoot;break;
          }
          const connection = await manager.connect(profile.id);
          const data = view === 'table' ? document.state().result : undefined;
          if (data) results.set(view, data);
          const formId=url.searchParams.get('profileId')??(url.searchParams.get('edit')==='1'?profile.id:'preview-new');
          const connectionProfile=view==='connection'?(profiles.find(p=>p.id===formId)??(formId==='preview-new'?{...profile,id:formId,name:'',path:''}:profile)):profile;
          result = { view, profile:connectionProfile,connectionEditor:view==='connection'?await manager.editorState(connectionProfile.id):undefined,resources:resources.list(), table, result: view === 'query' ? results.get(view) : data, details: view === 'table' ? document.details : undefined, editor: view === 'table' ? document.state() : undefined, query: view === 'query' ? sqlDocuments.state(queryOwner) : undefined, run: view === 'query' ? sqlDocuments.lastRun(queryOwner) : undefined, transfer: view === 'connections-import' ? { workspaceAvailable: true, workspaceDirectory: directory } : undefined } satisfies WorkbenchBoot; break;
        }
        case 'plan.action':throw new Error('Source editor, clipboard and save dialog actions are provided by the native VS Code extension. This browser harness only previews the captured plan.');
        case 'profile.test': result = await manager.test(request.params); break;
        case 'resources.list':result=resources.list();break;
        case 'authentication.clearCache':resources.clearCredentials(request.params.id);result=null;break;
        case 'resource.save':{const input=request.params;const value=await resources.save(input.kind,input.value,input);result={value,editor:await resources.editor(input.kind,value.id)};break;}
        case 'tunnel.credentials.save':{const value=await resources.saveTunnelCredentials(request.params.id,request.params);result={value,editor:await resources.editor('tunnel',value.id)};break;}
        case 'tunnel.source.open':throw new Error('Source files open in the native VS Code extension. This browser harness only previews the editor.');
        case 'tunnel.test':{const current=resources.list().tunnels.find(v=>v.id===request.params.value.id);result=await tunnels.test(current?.source?current:request.params.value,current?.source?undefined:request.params.secret);break;}
        case 'tunnel.fingerprint':result={fingerprint:await SshTunnels.fingerprint(request.params.host,request.params.port,request.params.timeout)};break;
        case 'backup.create':{const path=join(directory,'backup-'+Date.now()+'.db');result=lastBackupReport=await sqliteBackups.backup(profile.id,path);if(lastBackupReport.published)backupSource=path;break;}
        case 'backup.previewRestore':if(!backupSource)throw new Error('Create a backup first in this browser harness.');result=await sqliteBackups.previewRestore(backupSource,join(directory,'restored-'+Date.now()+'.db'));break;
        case 'backup.restore':result=lastBackupReport=await sqliteBackups.restore(request.params.token);break;
        case 'backup.report':if(!lastBackupReport?.reportPath)throw new Error('No report.');result={text:await readFile(lastBackupReport.reportPath,'utf8')};break;
        case 'backup.addConnection':if(lastBackupReport?.kind!=='restore'||!lastBackupReport.published)throw new Error('Restore first.');result=await manager.save({...profile,id:'restored-'+Date.now(),name:'Restored preview',storage:'file',path:lastBackupReport.destination,createIfMissing:false});break;
        case 'backup.cancel':throw new Error('Cancellation is tested in the native host and core tests.');
        case 'compare.catalog':result=comparisons.catalog();break;
        case 'compare.objects':result=await comparisons.objects(request.params.profileId);break;
        case 'compare.suggest':{const [source,target]=await Promise.all([comparisons.describe(request.params.source),comparisons.describe(request.params.target)]);result={source,target,pairs:comparisons.suggestedPairs(source.columns,target.columns)};break;}
        case 'compare.run':if(comparisonAbort)throw new Error('Comparison already running.');if(comparisonToken)comparisons.forget(comparisonToken);comparisonAbort=new AbortController();try{const summary=await comparisons.compare(request.params,comparisonAbort.signal);comparisonToken=summary.token;result=summary;}finally{comparisonAbort=undefined;}break;
        case 'compare.page':result=comparisons.page(request.params.token,request.params.offset,request.params.limit,request.params.differencesOnly);break;
        case 'compare.differenceIds':result=comparisons.differenceIds(request.params.token);break;
        case 'compare.previewSync':result=comparisons.previewSync(request.params.token,request.params.rows);break;
        case 'compare.applySync':if(comparisonAbort)throw new Error('Comparison already running.');comparisonAbort=new AbortController();try{result=await comparisons.apply(request.params.token,comparisonAbort.signal);}finally{comparisonAbort=undefined;}break;
        case 'compare.cancel':comparisonAbort?.abort();result=null;break;
        case 'compare.openScript':throw new Error('The full SQL inspection document opens in the VS Code extension. Review the displayed SQL excerpt in this browser harness.');
        case 'compare.clearResults':if(comparisonToken)comparisons.forget(comparisonToken);comparisons.clearResults();result=view==='combination'?combinations.catalog():comparisons.catalog();break;
        case 'serverBackup.create':case 'serverBackup.preview':case 'serverBackup.restore':case 'serverBackup.reviewSql':case 'serverBackup.report':case 'serverBackup.cancel':case 'serverBackup.settings':throw new Error('Native tool configuration and file dialogs are available in the VS Code extension. This browser harness previews the page layout only.');
        case 'data.pick':if(view!=='data-import')throw new Error('Open the data import editor.');result=await dataTransfers.inspect(process.env.DBW_IMPORT_FIXTURE??join(directory,'data-import.csv'),request.params);break;
        case 'data.preview':if(view!=='data-import')throw new Error('Open the data import editor.');result=await dataTransfers.preview(request.params.source,profile.id,table,request.params.mapping);break;
        case 'data.apply':if(view!=='data-import')throw new Error('Open the data import editor.');result=lastDataReport=await dataTransfers.apply(profile.id,request.params.token,{...request.params,reportPath:join(directory,'import-report-'+Date.now()+'.jsonl')});break;
        case 'data.report.open':if(!lastDataReport?.reportPath)throw new Error('No report available.');result={text:await readFile(lastDataReport.reportPath,'utf8')};break;
        case 'data.cancel':throw new Error('Cancellation is verified through native VS Code and core tests; this browser harness does not host background jobs.');
        case 'data.exportAll':result=await dataTransfers.exportFile(profile.id,{table},join(directory,'full-table.'+request.params.format),{format:request.params.format,overwrite:true});break;
        case 'data.openImport':throw new Error('Open ?view=data-import in this development harness.');
        case 'ddl.load':result=await structureBoot();break;
        case 'ddl.preview':if(view!=='structure')throw new Error('Open the structure editor.');result=await schemaChanges.preview(profile.id,structureName,request.params.intent);break;
        case 'ddl.apply':{if(view!=='structure')throw new Error('Open the structure editor.');const report=await schemaChanges.apply(profile.id,request.params.token);if(report.status==='succeeded'){structureTable.set(structureKey,report.removed?undefined:report.table);result={report,boot:{view:'structure',profile,table:report.removed?undefined:report.table,structure:report.removed?undefined:await schemaChanges.structure(profile.id,report.table)}};}else result={report,boot:await structureBoot()};break;}
        case 'ddl.openSql':throw new Error('Open SQL is available in native VS Code. The generated SQL is displayed in this preview.');
        case 'profile.edit.test': result=await manager.test(request.params.profile,request.params.password);break;
        case 'profile.edit.save': { const input=request.params;const saved=await manager.save(input.profile,{password:input.password,rememberPassword:input.rememberPassword,revision:input.revision});result={profile:saved,editor:await manager.editorState(saved.id)};break; }
        case 'profile.save': result = await manager.save(request.params); break;
        case 'profile.parseString': result = parseConnectionString(request.params.text, { baseDirectory: directory }); break;
        case 'connections.import.pick': throw new Error('File dialogs are available in VS Code. Paste JSON or CSV to test the import preview.');
        case 'connections.import.inspect': { const headers = parseConnectionCsv(request.params.text, request.params.delimiter)[0]!; result = { headers, mapping: mapConnectionHeaders(headers) }; break; }
        case 'connections.import.preview': result = transfers.preview(request.params.text, request.params.format, { baseDirectory: directory, mapping: request.params.mapping, delimiter: request.params.delimiter }); break;
        case 'connections.import.apply': result = await transfers.apply(request.params.token, request.params.decisions, request.params.scope,request.params.rememberPasswords); break;
        case 'table.load': result = await document.load(await manager.connect(profile.id), request.params); undo.length = redo.length = 0; results.set(view, result as QueryResult); break;
        case 'editor.update': { const transition = document.update(request.params.revision, request.params.state); if (transition) { undo.push(transition); redo.length = 0; } result = document.state(); break; }
        case 'editor.keys': document.keys(request.params.keyColumns); result = null; break;
        case 'editor.save': await document.save(await manager.connect(profile.id)); undo.length = redo.length = 0; result = document.state(); break;
        case 'editor.undo': { const transition = undo.pop(); transition?.undo(); if (transition) redo.push(transition); result = document.state(); break; }
        case 'editor.redo': { const transition = redo.pop(); transition?.redo(); if (transition) undo.push(transition); result = document.state(); break; }
        case 'editor.flush-complete': result = null; break;
        case 'table.apply': result = await (await manager.connect(profile.id)).apply(request.params.table, request.params.keyColumns, request.params.changes); break;
        case 'query.execute': result = await sqlDocuments.execute(queryOwner, request.params.sql, request.params.limit); results.set(view, result as QueryResult); break;
        case 'query.run': {
          const run = await sqlDocuments.run(queryOwner, request.params.sql, request.params.limit); const latest = [...run.statements].reverse().find(statement => statement.result)?.result;
          if (latest) results.set(view, latest); else results.delete(view); result = run; break;
        }
        case 'query.result.select': {
          const item = sqlDocuments.lastRun(queryOwner)?.statements[request.params.index]; if (!item) throw new Error('No such statement result.');
          if (item.result) results.set(view, item.result); else results.delete(view); result = null; break;
        }
        case 'query.cancel': result = view === 'query' ? await sqlDocuments.cancel(queryOwner) : await manager.cancel(profile.id); break;
        case 'combine.catalog':result=combinations.catalog();break;
        case 'combine.describe':result=await combinations.describe(request.params.source);break;
        case 'combine.run':if(combinationAbort)throw new Error('A combination is already running.');combinationAbort=new AbortController();try{result=await combinations.run(request.params,combinationAbort.signal);}finally{combinationAbort=undefined;}break;
        case 'combine.page':result=combinations.page(request.params.id,request.params.offset,request.params.columnOffset);break;
        case 'combine.lineage':result=combinations.lineage(request.params.id);break;
        case 'combine.forget':combinations.forget(request.params.id);result=null;break;
        case 'combine.export':{const path=join(directory,`combined-${request.params.id}.${request.params.format}`);await writeFile(path,combinations.export(request.params.id,request.params.format));result=path;break;}
        case 'combine.cancel':combinationAbort?.abort();result=null;break;
        case 'query.transaction': result = await sqlDocuments.transaction(queryOwner, request.params.action); break;
        case 'query.reset': await sqlDocuments.reset(queryOwner); result = true; break;
        case 'view.dirty': result = null; break;
        case 'confirm.discard': document.revert(); undo.length = redo.length = 0; result = true; break;
        case 'file.pick': throw new Error('File dialogs are available in the VS Code extension. Enter a path to test this development view.');
        case 'file.export': { const data = view === 'table' ? document.state().result : results.get(view); if (!data) throw new Error('No query results.'); const target = join(directory, `export.${request.params.format}`); await writeFile(target, exportResult(data, request.params.format)); result = target; break; }
      }
      if(dailyAcceptance){
        const state=document.state(),entry={at:new Date().toISOString(),method:request.method,
          ...(request.method==='table.load'?{request:request.params,ids:state.result.rows.map(row=>row.id),sql:state.result.sql}:{}),
          ...(['editor.update','editor.save','editor.undo','editor.redo','confirm.discard'].includes(request.method)?{dirty:document.dirty,request:state.request,ids:state.result.rows.map(row=>row.id)}:{}),
          ...(request.method==='profile.edit.save'||request.method==='profile.edit.test'?{profileId:request.params.profile.id,driver:request.params.profile.driver}:{}),
        };
        await appendFile(join(directory,'daily-trace.jsonl'),JSON.stringify(entry)+'\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: 1, id: 'dev', result, editorState: view === 'table' && ['table.load', 'confirm.discard'].includes(request.method) ? document.state() : undefined, queryState: view === 'query' ? sqlDocuments.state(queryOwner) : undefined })); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ready: true, database: profile.path })); return; }
    if (url.pathname === '/app.js' || url.pathname === '/app.css') { const asset = await readFile(resolve('dist/webview', url.pathname.slice(1))); res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' }); res.end(asset); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: 1, id: 'dev', error: { code: 'DEV_ERROR', message: errorMessage(error) }, queryState: queryView ? sqlDocuments.state(queryOwner) : undefined })); }
});
server.listen(port, '127.0.0.1', () => console.log(`DBNook real-database preview: http://127.0.0.1:${port}`));
async function shutdown() { server.close();await combinations.dispose();await comparisons.dispose();await sqliteBackups.dispose();await dataTransfers.dispose();resources.close(); await manager.close();await tunnels.close();await sshPreview?.close(); process.exit(0); }
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
if(dailyAcceptance&&process.stdin.isTTY){
 console.log('Press Enter in this test session to close the isolated preview.');
 process.stdin.once('data',()=>{void shutdown();});process.stdin.resume();
}
