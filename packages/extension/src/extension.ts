import {defaultPort} from '../../protocol/src/index.js';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ConnectionManager } from '../../core/src/connections.js';
import { SqlDocuments } from '../../core/src/sql-documents.js';
import { connectionString } from '../../core/src/connection-strings.js';
import { ConnectionOrganization, matchesObject } from '../../core/src/connection-organization.js';
import { errorMessage, type ConnectionProfile } from '../../protocol/src/index.js';
import { VscodeProfileStore } from './store.js';
import { ConnectionsTree, DbNode } from './tree.js';
import { PanelManager } from './panels.js';
import {ConnectionResources} from '../../core/src/resources.js';
import {SshTunnels} from '../../core/src/tunnels.js';
import {VscodeResourceStore,ResourceTree,ResourcePanels,openSshConfigSource,type ResourceNode} from './resources.js';
import {SshConfigDiscovery} from './ssh-config.js';
import {SqlLanguage} from './sql-language.js';
import {QueryHistory} from '../../core/src/query-history.js';
import {HistoryTree,registerHistory} from './history.js';
import {SchemaChanges} from '../../core/src/schema-changes.js';
import {StructurePanels} from './structure-panels.js';
import {DataTransfers} from '../../core/src/data-transfers.js';
import {DataPanels} from './data-panels.js';
import {SqliteBackups} from '../../core/src/sqlite-backups.js';
import {BackupPanels} from './backup-panels.js';
import {Diagnostics} from './diagnostics.js';
import {configureWebview} from './webview.js';
import {sqliteRuntimePath} from '../../core/src/sqlite-runtime-path.js';
import {ServerBackups,type ServerTools} from '../../core/src/server-backups.js';
import {ServerBackupPanels} from './server-backup-panels.js';
import {Comparisons} from '../../core/src/comparisons.js';
import {ComparisonPanels} from './comparison-panels.js';
import {Combinations} from '../../core/src/combinations.js';
import {CombinationPanels} from './combination-panels.js';
import {profileTarget} from '../../core/src/profile-target.js';
import {DatabaseDefinitions} from '../../core/src/database-definitions.js';
import {DefinitionDocuments} from './definition-documents.js';
import {StructureComparisons} from '../../core/src/structure-comparisons.js';
import {StructureComparisonDocuments} from './structure-comparison-documents.js';
import {QueryPlans} from '../../core/src/query-plans.js';
import {QueryPlanPanels} from './query-plan-panels.js';
import {SqlParameterPanels} from './sql-parameter-panels.js';

let manager: ConnectionManager | undefined;
let resourceManager:ConnectionResources|undefined;
export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('DBNook'); context.subscriptions.push(output);
  const diagnosticService=new Diagnostics(context,output);context.subscriptions.push(diagnosticService);
  const log = (error: unknown) => {if(typeof error==='string')diagnosticService.journal.record('info','runtime',error);else diagnosticService.error('extension',error);};
  context.subscriptions.push(vscode.commands.registerCommand('dbWorkbench.showOutput',()=>diagnosticService.show()),vscode.commands.registerCommand('dbWorkbench.collectDiagnostics',()=>diagnosticService.openReport()));
  const config = () => vscode.workspace.getConfiguration('dbWorkbench');
  let tree: ConnectionsTree;
  let treeView: vscode.TreeView<DbNode> | undefined;
  let authTree:ResourceTree|undefined,tunnelTree:ResourceTree|undefined;
  const profileStore = new VscodeProfileStore(log);
  const credentials = { get: async (id: string) => context.secrets.get(`connection:${id}`), store: async (id: string, password: string) => context.secrets.store(`connection:${id}`, password), delete: async (id: string) => context.secrets.delete(`connection:${id}`) };
  const refresh = () => { tree?.refresh();authTree?.refresh();tunnelTree?.refresh(); if (treeView) { const problems = profileStore.diagnostics().filter(issue => issue.code !== 'shadowed').length; treeView.message = [organization.filter ? `Connections filter: ${organization.filter}` : '', problems ? `${problems} configuration problem(s). Use Diagnose Connection Settings.` : ''].filter(Boolean).join('\n') || undefined; } };
  const resourceSecrets={get:async(id:string)=>context.secrets.get(`resource:${id}`),store:async(id:string,secret:string)=>context.secrets.store(`resource:${id}`,secret),delete:async(id:string)=>context.secrets.delete(`resource:${id}`)};
  const resources=new ConnectionResources(new VscodeResourceStore(log),resourceSecrets,()=>profileStore.allProfiles(),refresh);
  resourceManager=resources;
  const tunnels=new SshTunnels(resources,refresh);context.subscriptions.push({dispose:()=>resources.close()});
  manager = new ConnectionManager(profileStore, {
    runnerPath: vscode.Uri.joinPath(context.extensionUri, 'dist', 'sqlite-runner.cjs').fsPath,
    nodePath: sqliteRuntimePath(context.extensionUri.fsPath,config().get<string>('nodePath')).path, log,
    credentials,resources,tunnels,
  }, refresh);
  const organization = new ConnectionOrganization(manager, {
    favorites: () => { const values = context.globalState.get<unknown>('connectionFavorites', []); return Array.isArray(values) ? values : []; },
    saveFavorites: values => context.globalState.update('connectionFavorites', values),
    groupOrder: () => { const values = config().get<unknown>('connectionGroupOrder', []); return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []; },
    saveGroupOrder: values => config().update('connectionGroupOrder', values, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global),
  }, refresh);
  tree = new ConnectionsTree(manager, log, organization, () => config().get<string>('defaultConnection', ''));
  treeView = vscode.window.createTreeView('dbWorkbench.connections', { treeDataProvider: tree, canSelectMany: true });
  const historySettings=()=>({enabled:config().get('history.enabled',false),recordsPerDatabase:config().get('history.recordsPerDatabase',1000),logFailedQueries:config().get('history.logFailedQueries',true)});
  const history=new QueryHistory(vscode.Uri.joinPath(context.globalStorageUri,'history').fsPath,historySettings,()=>historyTree.refresh());
  const historyTree=new HistoryTree(history,()=>historySettings().enabled);
  const sqlDocuments = new SqlDocuments(manager, () => { updateStatus(); panels.refreshQueryStates(); },{finished:async(profile,run,startedAt)=>{language.invalidate(profile.id);await history.record(profile,run,startedAt);},error:log});
  const parameterPanels=new SqlParameterPanels(context,log);context.subscriptions.push(parameterPanels);
  sqlDocuments.configureParameters((form,session,signal)=>parameterPanels.request(form,session,signal),()=>config().get('sqlParameters.enabled',true));
  const language=new SqlLanguage(context,manager,sqlDocuments,log);
  const queryPlans=new QueryPlans(manager,sqlDocuments),queryPlanPanels=new QueryPlanPanels(context,manager,queryPlans,log);context.subscriptions.push(queryPlanPanels);
  context.subscriptions.push(language,historyTree,vscode.window.createTreeView('dbWorkbench.history',{treeDataProvider:historyTree}));
  const panels = new PanelManager(context, manager, () => tree.refresh(), log, sqlDocuments,resources,tunnels);
  const schemaChanges=new SchemaChanges(manager,id=>{tree.refresh();language.invalidate(id);},id=>panels.tableEditors.beginStructureChange(id),async id=>{try{await panels.tableEditors.finishStructureChange(id);}catch(error){log(error);}});
  const structurePanels=new StructurePanels(context,manager,schemaChanges,sqlDocuments,log);context.subscriptions.push(structurePanels);
  const databaseDefinitions=new DatabaseDefinitions(manager,id=>panels.tableEditors.beginStructureChange(id,'definition'),async id=>{try{await panels.tableEditors.finishStructureChange(id,'definition');}finally{tree.refresh();language.invalidate(id);}},schemaChanges);
  const definitionDocuments=new DefinitionDocuments(context,manager,databaseDefinitions,sqlDocuments);context.subscriptions.push(definitionDocuments);
  const structureComparisons=new StructureComparisons(manager,databaseDefinitions),structureComparisonDocuments=new StructureComparisonDocuments(manager,structureComparisons,definitionDocuments);context.subscriptions.push(structureComparisonDocuments);
  const dataTransfers=new DataTransfers(manager,vscode.Uri.joinPath(context.globalStorageUri,'transfer-cache').fsPath,id=>panels.tableEditors.beginStructureChange(id,'data-import'),async id=>{try{await panels.tableEditors.finishStructureChange(id,'data-import');}catch(e){log(e);}tree.refresh();});
  const dataPanels=new DataPanels(context,manager,dataTransfers,log);context.subscriptions.push(dataPanels);
  const sqliteBackups=new SqliteBackups(manager,vscode.Uri.joinPath(context.globalStorageUri,'sqlite-backups').fsPath),backupPanels=new BackupPanels(context,manager,sqliteBackups,log);context.subscriptions.push(backupPanels);
  const nativeTools=(driver:ConnectionProfile['driver']):ServerTools=>{const values=config().get<Record<string,ServerTools>>('nativeTools',{});return {dump:values[driver]?.dump??'',restore:values[driver]?.restore??''};};
  const serverBackups=new ServerBackups(manager,vscode.Uri.joinPath(context.globalStorageUri,'server-backups').fsPath,nativeTools,undefined,id=>panels.tableEditors.beginStructureChange(id,'server-restore'),async id=>{try{await panels.tableEditors.finishStructureChange(id,'server-restore');}finally{tree.refresh();language.invalidate(id);}});
  const serverBackupPanels=new ServerBackupPanels(context,manager,serverBackups,nativeTools,log);context.subscriptions.push(serverBackupPanels);
  const comparisons=new Comparisons(manager,id=>panels.tableEditors.beginStructureChange(id,'comparison-sync'),async id=>{try{await panels.tableEditors.finishStructureChange(id,'comparison-sync');}finally{tree.refresh();language.invalidate(id);}});
  const comparisonPanels=new ComparisonPanels(context,manager,comparisons,sqlDocuments,log);context.subscriptions.push(comparisonPanels);
  const combinations=new Combinations(comparisons),combinationPanels=new CombinationPanels(context,manager,comparisons,combinations,log);context.subscriptions.push(combinationPanels);
  const resourcePanels=new ResourcePanels(context,resources,tunnels,log,()=>sshConfigs.refresh());
  authTree=new ResourceTree(resources,tunnels,'authentication');tunnelTree=new ResourceTree(resources,tunnels,'tunnel');
  context.subscriptions.push(authTree,tunnelTree,resourcePanels,vscode.window.createTreeView('dbWorkbench.authenticationProfiles',{treeDataProvider:authTree}),vscode.window.createTreeView('dbWorkbench.tunnels',{treeDataProvider:tunnelTree}),{dispose:()=>{void tunnels.close();}});
  resources.beforeChange=async(kind,id)=>{const affected=manager!.profiles().filter(p=>(kind==='authentication'?p.authRef:p.tunnelRef)===id);for(const profile of affected)if(!await panels.prepareSave(profile,true))return false;await Promise.all(affected.map(p=>manager!.disconnect(p.id)));if(kind==='tunnel')await tunnels.disconnect(id);return true;};
  const sshConfigs=new SshConfigDiscovery(resources,log);context.subscriptions.push(sshConfigs,vscode.workspace.onDidGrantWorkspaceTrust(()=>{void sshConfigs.refresh();}));
  const diagnostics = vscode.languages.createDiagnosticCollection('db-workbench-sql'); context.subscriptions.push(diagnostics);
  context.subscriptions.push(tree, treeView, panels);
  refresh();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dbWorkbench.sessionActions'; context.subscriptions.push(status);
  const updateStatus = () => {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId !== 'sql') { status.hide(); void vscode.commands.executeCommand('setContext', 'dbWorkbench.sqlTransactionActive', false); return; }
    const owner = active.uri.toString(), id = sqlDocuments.connection(owner) || config().get<string>('defaultConnection');
    const state = sqlDocuments.state(owner);
    status.text = `$(database) ${manager?.profiles().find(p => p.id === id)?.name ?? 'Select Connection'}${state.busy ? ' · Running' : state.transaction === 'active' ? ' · TX ACTIVE' : ''}`;
    status.tooltip = state.transaction === 'active' ? 'This SQL document has an uncommitted transaction. Click for Commit or Roll Back.' : 'Select connection or manage this SQL document session';
    void vscode.commands.executeCommand('setContext', 'dbWorkbench.sqlTransactionActive', state.transaction === 'active'); status.show();
  };
  const requireTrusted = () => { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to a database.'); };
  const pick = async (node?: DbNode): Promise<ConnectionProfile | undefined> => {
    requireTrusted();
    if (node?.profileId) return manager!.profile(node.profileId);
    const editor = vscode.window.activeTextEditor;
    const id = editor ? sqlDocuments.connection(editor.document.uri.toString()) : undefined;
    const preferred = id || config().get<string>('defaultConnection');
    if (preferred && manager!.profiles().some(p => p.id === preferred)) return manager!.profile(preferred);
    const choices = manager!.profiles().map(profile => ({ label: profile.name, description: profile.driver !== 'sqlite' ? `${profile.host}:${profile.port ?? defaultPort(profile.driver)}/${profile.database??''}` : profile.storage === 'memory' ? 'In memory' : profile.path, profile }));
    if (!choices.length) { await panels.connection(); return; }
    return (await vscode.window.showQuickPick(choices, { title: 'Select Connection' }))?.profile;
  };
  const command = (name: string, callback: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`dbWorkbench.${name}`, async (...args: unknown[]) => {
    try { requireTrusted(); return await callback(...args); }
    catch (error) { diagnosticService.error('command.'+name,error); await vscode.window.showErrorMessage(`DBNook: ${errorMessage(error)}`); }
  }));
  const activeSql = async () => {
    const editor = vscode.window.activeTextEditor; if (editor?.document.languageId !== 'sql') throw new Error('Activate a SQL document first.');
    if(editor.document.uri.scheme==='dbw-plan')throw new Error('Use Execute Reviewed Analysis for this read-only plan review.');
    const profile = await pick(); if (!profile) return;
    const owner = editor.document.uri.toString(); await sqlDocuments.bind(owner, profile.id); return { editor, profile, owner };
  };
  registerHistory(context,history,historyTree,manager,sqlDocuments,command);
  const definitionUri=(uri?:vscode.Uri)=>{const source=uri??vscode.window.activeTextEditor?.document.uri;if(!source)throw new Error('Open an object definition first.');return source;};
  command('openDefinition',async(node?:DbNode)=>{
    const profile=await pick(node);if(!profile)return;const schema=node?.object?.schema??(node?.section?.startsWith('schema:')?node.section.slice(7):node?.kind==='database'?node.section:undefined);
    const refs=await databaseDefinitions.list(profile.id,schema),seed=node?.object&&refs.find(r=>r.name===(node.object!.label??node.object!.name)&&(!node.object!.schema||r.schema===node.object!.schema)&&['table','view','materialized-view'].includes(r.kind));
    const ref=seed||(await vscode.window.showQuickPick(refs.map(ref=>({label:ref.label??ref.name,description:`${ref.kind}${ref.schema?' · '+ref.schema:''}${ref.table?' · '+ref.table:''}`,ref})),{title:`Open Object Definition · ${profile.name}`,matchOnDescription:true}))?.ref;
    if(ref)return definitionDocuments.open(profile.id,ref);
  });
  command('compareDefinition',(uri?:vscode.Uri)=>definitionDocuments.compare(definitionUri(uri)));
  command('mapDefinitionColumns',(uri?:vscode.Uri)=>definitionDocuments.mapColumns(definitionUri(uri)));
  command('previewDefinition',async(uri?:vscode.Uri)=>{
    const source=definitionUri(uri),result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Preparing SQL preview'},()=>definitionDocuments.preview(source));
    if(result.kind==='conflict'){
      if(!result.current){await vscode.window.showWarningMessage('This object was removed from the server. The draft is preserved; reopen or recreate it using a separate migration.');return;}
      const choice=await vscode.window.showWarningMessage('The server definition changed since this draft opened. Review Opened ↔ Server before using the current server as the new conflict baseline. Your SQL draft is kept.',{modal:true},'Use Current Server Baseline');
      if(choice==='Use Current Server Baseline')return definitionDocuments.acceptServer(source,result.current.fingerprint);
    }return result;
  });
  command('reloadDefinition',async(uri?:vscode.Uri)=>{const source=definitionUri(uri);if(await vscode.window.showWarningMessage('Replace this definition draft with the current server SQL? Local edits can be recovered with native Undo.',{modal:true},'Reload Definition')==='Reload Definition')await definitionDocuments.reload(source);});
  command('applyDefinition',async(uri?:vscode.Uri)=>{
    const source=definitionUri(uri),preview=await definitionDocuments.pending(source);if(!preview){await vscode.commands.executeCommand('dbWorkbench.previewDefinition',source);void vscode.window.showInformationMessage('Review the generated SQL, then run Apply Definition Changes.');return;}
    const profile=manager!.profile(preview.profileId),detail=`Target: ${profile.name} · ${preview.target}\nPolicy: ${preview.policy}\n${preview.warnings.join('\n')}`;
    if(await vscode.window.showWarningMessage('Apply the reviewed object definition?',{modal:true,detail},'Apply Definition')!=='Apply Definition')return;
    const report=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Applying definition · ${preview.target}`,cancellable:true},async(_progress,cancellation)=>{const abort=new AbortController(),subscription=cancellation.onCancellationRequested(()=>abort.abort());try{if(cancellation.isCancellationRequested)abort.abort();return await definitionDocuments.apply(source,abort.signal);}finally{subscription.dispose();}});
    diagnosticService.info('definition.apply.finished',{status:report.status,completed:report.completed,committed:report.committed,rolledBack:report.rolledBack});
    if(report.status==='succeeded')void vscode.window.showInformationMessage(`Definition applied: ${preview.target}${report.warnings.some(w=>w.startsWith('Applied, but'))?' · refresh needs attention':''}`);
    else{log(new Error(`Definition ${report.status}: ${report.error}; completed steps=${report.completed}; rolled back=${report.rolledBack}`));await vscode.window.showErrorMessage(`Definition ${report.status}: ${report.error}${report.rolledBack?' · rolled back':report.completed?' · some steps completed; inspect the server before retrying':''}`);}
    return report;
  });
  command('refreshSqlMetadata',()=>{language.invalidate();void vscode.window.showInformationMessage('SQL metadata cache cleared. Completion will reload tables and columns.');});
  command('sqliteBackup',async(node?:DbNode)=>{const profile=await pick(node);if(profile)await backupPanels.open(profile.id);});
  command('serverBackup',async(node?:DbNode)=>{const profile=await pick(node);if(profile)await serverBackupPanels.open(profile.id);});
  command('compareTables',async(node?:DbNode,nodes?:DbNode[])=>{const selected=nodes?.length?nodes:node?[node]:[],objects=selected.filter(n=>n.object).slice(0,2).map(n=>({kind:'table' as const,profileId:n.profileId,table:n.object!.name}));await comparisonPanels.open(objects[0],objects[1]);});
  command('compareStructures',async(node?:DbNode,nodes?:DbNode[])=>{const selected=nodes?.length?nodes:node?[node]:[],objects=selected.filter(n=>n.object).slice(0,2).map(n=>({profileId:n.profileId,table:n.object!.name})),source=objects[0]??await structureComparisonDocuments.pick('Source');if(!source)return;const target=objects[1]??await structureComparisonDocuments.pick('Target');if(target)return structureComparisonDocuments.open(source,target);});
  command('prepareStructureSync',()=>structureComparisonDocuments.choose());
  command('configureStructureConversions',()=>structureComparisonDocuments.configure());
  command('swapStructureComparison',()=>structureComparisonDocuments.swap());
  command('refreshStructureComparison',()=>structureComparisonDocuments.refresh());
  command('openStructureTarget',()=>structureComparisonDocuments.openTarget());
  const combineTables=async(operation:'join'|'union',node?:DbNode,nodes?:DbNode[])=>{const selected=nodes?.length?nodes:node?[node]:[],objects=selected.filter(n=>n.object).slice(0,operation==='join'?2:20).map(n=>({kind:'table' as const,profileId:n.profileId,table:n.object!.name}));await combinationPanels.open(operation,objects);};
  command('joinTables',(node?:DbNode,nodes?:DbNode[])=>combineTables('join',node,nodes));
  command('unionTables',(node?:DbNode,nodes?:DbNode[])=>combineTables('union',node,nodes));
  command('combineQueryResults',async()=>{
    const editor=vscode.window.activeTextEditor;if(editor?.document.languageId!=='sql')throw new Error('Activate an executed SQL document first.');const owner=editor.document.uri.toString(),id=sqlDocuments.connection(owner),run=sqlDocuments.lastRun(owner),session=manager!.documentSession(owner);
    if(!id||!run||!session?.connected||JSON.stringify(profileTarget(session.profile))!==JSON.stringify(profileTarget(manager!.profile(id))))throw new Error('Execute this SQL document with its current connection before capturing results.');await manager!.lease(id,owner);
    const choices=run.statements.filter(s=>s.result).map(s=>({label:`Statement ${s.index+1}`,description:`${s.result!.rows.length} rows${s.result!.truncated?' · truncated':''}`,statement:s}));
    const selected=choices.length===1?choices:await vscode.window.showQuickPick(choices,{title:'Capture executed results for Join / Union',canPickMany:true});if(!selected?.length)return;if(selected.length>20)throw new Error('Select at most 20 result sets.');
    const captured=selected.map(s=>comparisons.registerResult(id,s.statement.result!,`${manager!.profile(id).name} · ${s.label} · ${run.id.slice(0,8)}`));await combinationPanels.open('union',captured);
  });
  command('compareQueryResult',async()=>{const editor=vscode.window.activeTextEditor;if(editor?.document.languageId!=='sql')throw new Error('Activate an executed SQL document first.');const owner=editor.document.uri.toString(),id=sqlDocuments.connection(owner),run=sqlDocuments.lastRun(owner),session=manager!.documentSession(owner);if(!id||!run||!session?.connected||JSON.stringify(profileTarget(session.profile))!==JSON.stringify(profileTarget(manager!.profile(id))))throw new Error('Execute this SQL document with its current connection before capturing a result.');await manager!.lease(id,owner);const choices=run.statements.filter(s=>s.result).map(s=>({label:`Statement ${s.index+1}`,description:`${s.result!.rows.length} rows${s.result!.truncated?' · truncated':''}`,statement:s}));const selected=choices.length===1?choices[0]:await vscode.window.showQuickPick(choices,{title:'Capture a result for comparison'});if(!selected) return;const source=comparisons.registerResult(id,selected.statement.result!,`${manager!.profile(id).name} · ${selected.label} · ${run.id.slice(0,8)}`);await comparisonPanels.open(source);});
  command('tableStructure',async(node?:DbNode)=>{const profile=await pick(node);if(!profile)return;if(!node?.object)throw new Error('Choose a table or view in Connections.');await structurePanels.open(profile.id,node.object.name);});
  command('createTable',async(node?:DbNode)=>{const profile=await pick(node);if(profile)await structurePanels.open(profile.id,undefined,node?.section?.startsWith('schema:')?node.section.slice(7):node?.kind==='database'?node.section:undefined);});
  command('importTableData',async(node?:DbNode)=>{const profile=await pick(node);if(!profile)return;if(!node?.object)throw new Error('Choose a target table in Connections.');await dataPanels.open(profile.id,node.object.name);});
  command('exportTableData',async(node?:DbNode,format?:'csv'|'json')=>{const profile=await pick(node);if(!profile)return;if(!node?.object)throw new Error('Choose a table or view.');return dataPanels.export(profile.id,{table:node.object.name},format);});
  command('exportQueryData',async()=>{const source=await activeSql();if(!source)return;if(sqlDocuments.state(source.owner).transaction==='active')throw new Error('Commit or roll back this document transaction before read-only export.');const statement=await language.current(source.editor.document,source.editor.document.offsetAt(source.editor.selection.active));if(!statement)throw new Error('Place the cursor in a SELECT statement.');return sqlDocuments.useSession(source.owner,(session,signal)=>dataPanels.export(source.profile.id,{sql:statement.sql},undefined,session,signal));});
  const confirmTransactions = async (id: string): Promise<boolean> => {
    const count = sqlDocuments.activeTransactions(id).length;
    return !count || await vscode.window.showWarningMessage(`Disconnecting rolls back ${count} open SQL transaction${count === 1 ? '' : 's'}. Continue?`, { modal: true }, 'Roll Back and Disconnect') === 'Roll Back and Disconnect';
  };
  command('addConnection', () => panels.connection());
  command('auth.add',()=>resourcePanels.open('authentication'));
  command('auth.edit',(node:ResourceNode)=>{if(node?.kind!=='authentication')throw new Error('Select an Authentication Profile.');return resourcePanels.open('authentication',resources.get('authentication',node.value.id));});
  command('auth.delete',async(node:ResourceNode)=>{if(node?.kind!=='authentication')throw new Error('Select an Authentication Profile.');if(await vscode.window.showWarningMessage(`Delete Authentication Profile ${node.value.name}?`,{modal:true},'Delete')==='Delete')await resources.remove('authentication',node.value.id);});
  command('auth.refresh',()=>authTree?.refresh());
  command('auth.clearCache',(node:ResourceNode)=>{if(node?.kind!=='authentication')throw new Error('Select an Authentication Profile.');resources.clearCredentials(node.value.id);void vscode.window.showInformationMessage('Credential cache cleared. New sessions will resolve fresh credentials. Existing sessions remain connected.');});
  command('tunnel.add',()=>resourcePanels.open('tunnel'));
  command('tunnel.edit',(node:ResourceNode)=>{if(node?.kind!=='tunnel')throw new Error('Select an SSH tunnel.');return resourcePanels.open('tunnel',resources.get('tunnel',node.value.id));});
  command('tunnel.delete',async(node:ResourceNode)=>{if(node?.kind!=='tunnel')throw new Error('Select an SSH tunnel.');const current=resources.get('tunnel',node.value.id);if(current.kind==='ssh'&&current.source){await openSshConfigSource(resources,current.id);void vscode.window.showInformationMessage('Remove this Host entry in SSH Config to stop discovering the tunnel.');return;}if(await vscode.window.showWarningMessage(`Delete SSH tunnel ${node.value.name}?`,{modal:true},'Delete')==='Delete'){await resources.remove('tunnel',node.value.id);await tunnels.disconnect(node.value.id);}});
  command('tunnel.source',(node:ResourceNode)=>{if(node?.kind!=='tunnel')throw new Error('Select an SSH Config tunnel.');return openSshConfigSource(resources,node.value.id);});
  command('tunnel.disconnect',async(node:ResourceNode)=>{if(node?.kind!=='tunnel')throw new Error('Select an SSH tunnel.');if(!await resources.beforeChange('tunnel',node.value.id))return;await tunnels.disconnect(node.value.id);});
  command('tunnel.logs',async(node:ResourceNode)=>{if(node?.kind!=='tunnel')throw new Error('Select an SSH tunnel.');const document=await vscode.workspace.openTextDocument({content:tunnels.logs(node.value.id).join('\n')||'No tunnel activity in this session.',language:'log'});await vscode.window.showTextDocument(document,{preview:true});});
  command('tunnel.refresh',async()=>{await sshConfigs.refresh();tunnelTree?.refresh();});
  command('importConnections', () => panels.importConnections());
  command('exportConnections', (node?: DbNode, nodes?: DbNode[]) => panels.exportConnections(nodes?.length ? nodes.filter(item => item.profileId).map(item => item.profileId) : node?.profileId ? [node.profileId] : undefined));
  command('copyConnectionString', async (node?: DbNode) => { const profile = await pick(node); if (profile) await vscode.env.clipboard.writeText(connectionString(profile.authRef?{...profile,user:resources.get('authentication',profile.authRef).user}:profile)); });
  command('filterConnections', async () => { const value = await vscode.window.showInputBox({ title: 'Filter Connections', prompt: 'Match all words against connection name, group, file path and driver.', value: organization.filter }); if (value !== undefined) organization.setFilter(value); });
  command('clearConnectionFilter', () => organization.setFilter(''));
  command('filterObjects', async (node?: DbNode) => {
    const profile = await pick(node); if (!profile) return;
    const value = await vscode.window.showInputBox({ title: `Filter Tables and Views · ${profile.name}`, prompt: 'LIKE pattern: % matches any text, _ matches one character. Prefix NOT LIKE to exclude.', placeHolder: '%name%', value: organization.objectFilter(profile.id), validateInput: value => { try { matchesObject('', value); return undefined; } catch (error) { return errorMessage(error); } } });
    if (value !== undefined) organization.setObjectFilter(profile.id, value);
  });
  command('clearObjectFilter', async (node?: DbNode) => { const profile = await pick(node); if (profile) organization.setObjectFilter(profile.id, ''); });
  const chosenConnections = async (node?: DbNode, nodes?: DbNode[]) => {
    const ids = [...new Set((nodes?.length ? nodes : node ? [node] : []).filter(item => item.profileId).map(item => item.profileId))];
    if (ids.length) return ids;
    const values = await vscode.window.showQuickPick(manager!.profiles().map(profile => ({ label: profile.name, description: profile.group || undefined, profile })), { canPickMany: true, title: 'Choose Connections' }); return values?.map(value => value.profile.id) ?? [];
  };
  command('groupConnections', async (node?: DbNode, nodes?: DbNode[]) => {
    const ids = await chosenConnections(node, nodes); if (!ids.length) return;
    const choice = await vscode.window.showQuickPick([{ label: 'New group…', value: undefined }, ...organization.groups().map(value => ({ label: value, value }))], { title: `Group ${ids.length} connection(s)` }); if (!choice) return;
    const group = choice.value ?? await vscode.window.showInputBox({ title: 'New Connection Group', validateInput: value => !value.trim() ? 'Enter a group name.' : value.trim().length > 120 ? 'Use at most 120 characters.' : undefined });
    if (group !== undefined) await organization.group(ids, group);
  });
  command('ungroupConnections', async (node?: DbNode, nodes?: DbNode[]) => { const ids = await chosenConnections(node, nodes); if (ids.length) await organization.group(ids, ''); });
  const groupName = (node: DbNode) => { if (node?.kind !== 'group' || !node.section) throw new Error('Select a connection group first.'); return node.section; };
  command('renameGroup', async (node: DbNode) => {
    const before = groupName(node), after = await vscode.window.showInputBox({ title: 'Rename Connection Group', value: before, validateInput: value => !value.trim() ? 'Enter a group name.' : value.trim().length > 120 ? 'Use at most 120 characters.' : organization.groups().includes(value.trim()) && value.trim() !== before ? 'A group already uses this name. Move connections into it to merge groups.' : undefined });
    if (after !== undefined && after !== before) await organization.renameGroup(before, after);
  });
  command('removeGroup', (node: DbNode) => organization.removeGroup(groupName(node)));
  command('moveGroupUp', (node: DbNode) => organization.moveGroup(groupName(node), -1));
  command('moveGroupDown', (node: DbNode) => organization.moveGroup(groupName(node), 1));
  for (const [name, enabled] of [['addFavorite', true], ['removeFavorite', false]] as const) command(name, async (node: DbNode) => { if (!node?.object) throw new Error('Select a table or view first.'); await organization.favorite(node.profileId, node.object, enabled); });
  command('copyLabel', async (node: DbNode) => { if (!node) throw new Error('Select an item in Connections.'); await vscode.env.clipboard.writeText(typeof node.label === 'string' ? node.label : node.label?.label ?? ''); });
  command('copyQualifiedName', async (node: DbNode) => { if (!node?.object) throw new Error('Select a database object first.'); await vscode.env.clipboard.writeText(manager!.profile(node.profileId).driver !== 'sqlite' ? node.object.name : `"main"."${node.object.name.replaceAll('"', '""')}"`); });
  command('quickOpenObject', async (node?: DbNode) => {
    const profile = await pick(node); if (!profile) return; const session = await manager!.connect(profile.id);
    const object = await vscode.window.showQuickPick((await session.schema()).map(object => ({ label: object.name, description: `${profile.name} · ${object.type}`, object })), { title: `Quick Open Object · ${profile.name}`, matchOnDescription: true });
    if (object) await panels.table(profile, object.object.name);
  });
  command('diagnoseConnections', async () => {
    const issues = profileStore.diagnostics(); if (!issues.length) { await vscode.window.showInformationMessage('Connection settings have no configuration problems.'); return; }
    const issue = await vscode.window.showQuickPick(issues.map(issue => ({ label: `${issue.scope} · ${issue.index < 0 ? 'connections' : `row ${issue.index + 1}`}`, detail: issue.message, scope: issue.scope })), { title: 'Connection Settings Diagnostics', matchOnDetail: true });
    if (issue) await vscode.commands.executeCommand(issue.scope === 'workspace' ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson');
  });
  command('editConnection', async (node: DbNode) => { const profile = await pick(node); if (profile) await panels.connection(profile); });
  command('duplicateConnection', async (node: DbNode) => { const profile = await pick(node); if (profile) await manager!.duplicate(profile.id); });
  command('refresh', () => tree.refresh());
  command('openTable', async (node: DbNode) => { if (node.object) await panels.table(manager!.profile(node.profileId), node.object.name); });
  command('disconnect', async (node?: DbNode) => {
    const profile = await pick(node); if (!profile || !await confirmTransactions(profile.id) || !await panels.confirmDisconnect(profile.id)) return;
    await manager!.disconnect(profile.id); panels.closeForConnection(profile.id); tree.refresh();
    updateStatus();
  });
  command('deleteConnection', async (node?: DbNode) => {
    const profile = await pick(node); if (!profile) return;
    if (await vscode.window.showWarningMessage(`Delete connection "${profile.name}"? The database file will be kept.`, { modal: true }, 'Delete Connection') !== 'Delete Connection') return;
    if (!await confirmTransactions(profile.id) || !await panels.confirmDisconnect(profile.id)) return;
    await manager!.remove(profile.id); await organization.forget(profile.id); panels.closeForConnection(profile.id);
    const defaults = config().inspect<string>('defaultConnection');
    if (defaults?.globalValue === profile.id) await config().update('defaultConnection', undefined, vscode.ConfigurationTarget.Global);
    if (defaults?.workspaceValue === profile.id) await config().update('defaultConnection', undefined, vscode.ConfigurationTarget.Workspace);
  });
  command('defaultConnection', async (node?: DbNode) => {
    const profile = await pick(node); if (profile) { await config().update('defaultConnection', profile.id, vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global); updateStatus(); }
  });
  command('newQuery', async (node?: DbNode) => {
    const profile = await pick(node); if (!profile) return;
    const directory = vscode.Uri.joinPath(context.globalStorageUri, 'scratch'); await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, `query-${randomUUID()}.sql`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`-- Ctrl+Enter executes the selection or SQL document.\n${profile.driver !== 'sqlite' ? 'SELECT version();' : 'SELECT sqlite_version();'}\n`));
    const document = await vscode.workspace.openTextDocument(uri);
    await sqlDocuments.bind(document.uri.toString(), profile.id); await vscode.window.showTextDocument(document, { preview: false }); updateStatus();
  });
  const executeSql=async(current=false) => {
    const editor = vscode.window.activeTextEditor; if (!editor || editor.document.languageId !== 'sql') return;
    if(editor.document.uri.scheme==='dbw-plan')throw new Error('Use Execute Reviewed Analysis for this read-only plan review.');
    const profile = await pick(); if (!profile) return; const owner = editor.document.uri.toString(); await sqlDocuments.bind(owner, profile.id); updateStatus();
    const sourceVersion=editor.document.version;
    const statement=current?await language.current(editor.document,editor.document.offsetAt(editor.selection.active)):undefined;
    if(editor.document.version!==sourceVersion)throw new Error('SQL changed while locating the current statement. Run again.');
    if(current&&!statement)throw new Error('No SQL statement at the cursor.');
    const sql = current?statement!.sql:editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    const base = current?statement!.start:editor.selection.isEmpty ? 0 : editor.document.offsetAt(editor.selection.start);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Querying ${profile.name}`, cancellable: true }, async (_progress, token) => {
      const subscription = token.onCancellationRequested(() => { void sqlDocuments.cancel(owner).catch(log); });
      try {
        diagnostics.delete(editor.document.uri); await panels.query(profile, undefined, owner);
        const run = await sqlDocuments.run(owner, sql, config().get('queryRowLimit', 100000), base,current,()=>{if(editor.document.isClosed||editor.document.version!==sourceVersion)throw new Error('SQL changed during parameter input or execution. Run the current text again.');});
        const failed = run.statements.find(statement => statement.status === 'failed');
        if (failed && editor.document.version === sourceVersion) diagnostics.set(editor.document.uri, [new vscode.Diagnostic(new vscode.Range(editor.document.positionAt(base + failed.start), editor.document.positionAt(base + failed.end)), `Statement ${failed.index + 1}: ${failed.error}`, vscode.DiagnosticSeverity.Error)]);
        tree.refresh();
      }
      finally { subscription.dispose(); }
    });
  };
  command('execute',()=>executeSql());
  command('executeCurrent',()=>executeSql(true));
  command('clearSqlParameters',async()=>{const owner=vscode.window.activeTextEditor?.document.uri.toString();if(owner){sqlDocuments.clearParameters(owner);void vscode.window.showInformationMessage('SQL parameter values cleared for this document.');}});
  const runPlan=async(proposal:import('../../protocol/src/index.js').PlanProposal,confirmed=false)=>vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`${proposal.mode==='analyze'?'Analyzing':'Explaining'} ${proposal.connection}`,cancellable:true},async(_progress,token)=>{
    const subscription=token.onCancellationRequested(()=>{void sqlDocuments.cancel(proposal.owner).catch(log);});
    try{const report=await queryPlans.run(proposal.token,confirmed);queryPlanPanels.open(report);return report;}finally{subscription.dispose();tree.refresh();language.invalidate(proposal.profileId);}
  });
  for(const [name,mode]of [['executeExplain','explain'],['executeAnalyze','analyze']] as const)command(name,async()=>{
    const editor=vscode.window.activeTextEditor;if(!editor||editor.document.languageId!=='sql'||editor.document.uri.scheme==='dbw-plan')throw new Error('Activate the source SQL document first.');
    const document=editor.document,version=document.version,profile=await pick();if(!profile)return;const owner=document.uri.toString();await sqlDocuments.bind(owner,profile.id);
    const selected=editor.selection.isEmpty?await language.current(document,document.offsetAt(editor.selection.active)):{sql:document.getText(editor.selection)};
    if(document.isClosed||document.version!==version)throw new Error('Source SQL changed while locating the statement. Prepare the plan again.');if(!selected)throw new Error('No statement at the cursor.');
    const proposal=await queryPlans.prepare(owner,selected.sql,mode);if(document.isClosed||document.version!==version){queryPlans.forget(proposal.token);throw new Error('Source SQL changed during plan preparation.');}
    if(mode==='analyze')return queryPlanPanels.review(proposal,version);return runPlan(proposal);
  });
  command('executeReviewedAnalyze',async()=>{
    const review=queryPlanPanels.currentReview();if(!review)throw new Error('Open a prepared Analyze review first.');
    const current=()=>vscode.workspace.textDocuments.find(d=>d.uri.toString()===review.proposal.owner&&!d.isClosed&&d.version===review.sourceVersion);
    if(!current())throw new Error('The source SQL was changed or closed. Prepare Analyze again.');
    if(await vscode.window.showWarningMessage(`Execute the reviewed analysis on ${review.proposal.connection}?`,{modal:true,detail:'Analyze actually executes SQL and may modify data or invoke functions. It uses the source document session. No automatic commit or rollback is added; nontransactional effects may remain.'},'Execute reviewed analysis')!=='Execute reviewed analysis')return;
    if(!current())throw new Error('Source SQL changed during confirmation. Prepare Analyze again.');return runPlan(review.proposal,true);
  });
  command('cancel', async (node?: DbNode) => {
    const owner = vscode.window.activeTextEditor?.document.uri.toString(); if (!node && owner && sqlDocuments.connection(owner)) { await sqlDocuments.cancel(owner); return; }
    const profile = await pick(node); if (profile) await manager!.cancel(profile.id);
  });
  command('selectConnection', async () => {
    const editor = vscode.window.activeTextEditor; if (editor?.document.languageId !== 'sql') throw new Error('Activate a SQL document first.');
    if(editor.document.uri.scheme==='dbw-plan')throw new Error('The plan review retains its original source connection. Prepare a new review from the source SQL document.');
    const owner = editor.document.uri.toString();
    const choice = await vscode.window.showQuickPick(manager!.profiles().map(profile => ({ label: profile.name, description: profile.path || ':memory:', profile })), { title: 'Select Connection for This SQL Document' });
    if (!choice || choice.profile.id === sqlDocuments.connection(owner)) return;
    if (sqlDocuments.state(owner).transaction === 'active' && await vscode.window.showWarningMessage('Switching connections rolls back this document transaction. Continue?', { modal: true }, 'Roll Back and Switch') !== 'Roll Back and Switch') return;
    panels.closeQuery(owner); await sqlDocuments.bind(owner, choice.profile.id);
  });
  for (const [name, action] of [['beginTransaction', 'begin'], ['commitTransaction', 'commit'], ['rollbackTransaction', 'rollback']] as const) command(name, async () => {
    const source = await activeSql(); if (!source) return; await sqlDocuments.transaction(source.owner, action); tree.refresh();
  });
  command('resetSession', async () => {
    const source = await activeSql(); if (!source) return;
    if (sqlDocuments.state(source.owner).transaction === 'active' && await vscode.window.showWarningMessage('Resetting this SQL session rolls back its open transaction. Continue?', { modal: true }, 'Roll Back and Reset') !== 'Roll Back and Reset') return;
    await sqlDocuments.reset(source.owner);
  });
  command('sessionActions', async () => {
    const editor = vscode.window.activeTextEditor; if (editor?.document.languageId !== 'sql') return;
    const active = sqlDocuments.state(editor.document.uri.toString()).transaction === 'active';
    const choice = await vscode.window.showQuickPick([{ label: 'Select Connection', command: 'selectConnection' }, ...(active ? [{ label: 'Commit Transaction', command: 'commitTransaction' }, { label: 'Roll Back Transaction', command: 'rollbackTransaction' }] : [{ label: 'Begin Transaction', command: 'beginTransaction' }]), { label: 'Reset Document Session', command: 'resetSession' }], { title: 'SQL Document Session' });
    if (choice) await vscode.commands.executeCommand(`dbWorkbench.${choice.command}`);
  });
  command('sample', async () => {
    const directory = context.globalStorageUri; await vscode.workspace.fs.createDirectory(directory);
    const path = vscode.Uri.joinPath(directory, `sample-${randomUUID()}.db`).fsPath;
    const profile: ConnectionProfile = { schemaVersion: 1, id: randomUUID(), name: 'Sample · SQLite', driver: 'sqlite', storage: 'file', path, scope: 'global', group: '', color: '#2684a6', readOnly: false, createIfMissing: true };
    await manager!.save(profile); const session = await manager!.connect(profile.id);
    await session.query('CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'Active\', description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    await session.query("INSERT INTO teams(name,status,description) VALUES ('核心平台组','启用','核心系统与平台能力建设'),('业务交付组','启用','业务需求交付与产品协同'),('质量保障组','启用','测试、质量和发布保障'),('数据治理组','启用','数据治理与指标体系建设')");
    await panels.table(profile, 'teams'); tree.refresh();
  });
  const closeSql = (owner: string) => {
    if (!sqlDocuments.connection(owner)) return;
    diagnostics.delete(vscode.Uri.parse(owner));
    panels.closeQuery(owner); void sqlDocuments.close(owner).then(rolledBack => { if (rolledBack) void vscode.window.showInformationMessage('Closed SQL document: its uncommitted transaction was rolled back.'); }, log);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatus), vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) diagnostics.delete(event.document.uri); }), vscode.workspace.onDidCloseTextDocument(doc => closeSql(doc.uri.toString())), vscode.window.tabGroups.onDidChangeTabs(event => {
    for (const tab of event.closed) if (tab.input instanceof vscode.TabInputText) {
      const owner = tab.input.uri.toString();
      const stillOpen = vscode.window.tabGroups.all.some(group => group.tabs.some(other => other.input instanceof vscode.TabInputText && other.input.uri.toString() === owner));
      if (!stillOpen) closeSql(owner);
    }
  }), vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dbWorkbench')) { refresh(); updateStatus();historyTree.refresh();language.invalidate();void vscode.commands.executeCommand('setContext','dbWorkbench.historyEnabled',historySettings().enabled); }if(event.affectsConfiguration('dbWorkbench.sshConfigPaths'))void sshConfigs.refresh(); }));
  await vscode.commands.executeCommand('setContext','dbWorkbench.historyEnabled',historySettings().enabled);
  await sshConfigs.refresh();
  diagnosticService.info('activation.ready');
  if (context.extensionMode === vscode.ExtensionMode.Test) return { manager, parameterPanels,queryPlans,queryPlanPanels,credentials, resources,tunnels,sshConfigs,authTree,tunnelTree,tree, organization, transfers: panels.transfers, profileStore, sqlDocuments,history,language,schemaChanges,structurePanels,databaseDefinitions,definitionDocuments,structureComparisons,structureComparisonDocuments,dataTransfers,dataPanels,sqliteBackups,backupPanels,serverBackups,serverBackupPanels,comparisons,comparisonPanels,combinations,combinationPanels,diagnosticService,extensionContext:context,configureTestWebview:(panel:vscode.WebviewPanel)=>configureWebview(context,panel), tableEditors: panels.tableEditors, initializedViews: () => parameterPanels.initializedViews()+queryPlanPanels.initializedViews()+panels.initializedViews()+resourcePanels.initializedViews()+structurePanels.initializedViews()+dataPanels.initializedViews()+backupPanels.initializedViews()+serverBackupPanels.initializedViews()+comparisonPanels.initializedViews()+combinationPanels.initializedViews() };
}
export async function deactivate(): Promise<void> {resourceManager?.close();resourceManager=undefined; await manager?.close(); manager = undefined; }
