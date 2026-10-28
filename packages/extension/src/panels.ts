import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ConnectionManager } from '../../core/src/connections.js';
import type { SqlDocuments } from '../../core/src/sql-documents.js';
import { ConnectionTransfers, exportConnections, mapConnectionHeaders, parseConnectionCsv } from '../../core/src/connection-transfer.js';
import { parseConnectionString } from '../../core/src/connection-strings.js';
import { exportResult } from '../../core/src/export.js';
import { errorMessage, ProfileSchema, WebEnvelopeSchema, type ConnectionProfile, type QueryResult, type RpcResponse, type TableDetails, type WorkbenchBoot } from '../../protocol/src/index.js';
import { TableEditorProvider } from './table-editor.js';
import { configureWebview,isWebviewDiagnostic } from './webview.js';
import type {ConnectionResources} from '../../core/src/resources.js';
import type {SshTunnels} from '../../core/src/tunnels.js';

export interface PanelState { panel: vscode.WebviewPanel; profileId: string; view: WorkbenchBoot['view']; table?: string; result?: QueryResult; details?: TableDetails; queryOwner?: string; runId?: string; statementCount?: number; importDirectory?: string; dirty: boolean; initialized?: boolean; }
export class PanelManager implements vscode.Disposable {
  private panels = new Map<string, PanelState>();
  readonly tableEditors: TableEditorProvider;
  readonly transfers: ConnectionTransfers;
  constructor(private context: vscode.ExtensionContext, private manager: ConnectionManager, private refresh: () => void, private log: (error: unknown) => void, private sqlDocuments: SqlDocuments,private resources?:ConnectionResources,private tunnels?:SshTunnels) {
    this.tableEditors = new TableEditorProvider(context, manager, refresh, log);
    this.transfers = new ConnectionTransfers(manager, (profile,credentialChanged) => this.prepareSave(profile,credentialChanged));
  }
  initializedViews(): number { return this.tableEditors.initializedViews() + [...this.panels.values()].filter(state => state.initialized).length; }
  private async create(view: WorkbenchBoot['view'], profile: ConnectionProfile, table?: string, initialResult?: QueryResult, queryOwner?: string, ownsSession = false): Promise<PanelState> {
    const key = `${view}:${profile.id}:${table ?? queryOwner ?? ''}`;
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(undefined, view === 'query'); if (initialResult) { existing.result = initialResult; await existing.panel.webview.postMessage({ event: 'result', result: initialResult }); } return existing; }
    const sourceName = queryOwner && !ownsSession ? vscode.Uri.parse(queryOwner).path.split('/').pop() : undefined;
    const title = view === 'connections-import' ? 'Import Connections' : view === 'connection' ? (this.manager.profiles().some(p => p.id === profile.id) ? `Edit: ${profile.name}` : 'New Connection') : view === 'table' ? `${profile.name}/main/${table}` : `${sourceName ? `${sourceName} · ` : ''}${profile.name}/Query Results`;
    const panel = vscode.window.createWebviewPanel('dbWorkbench.workbench', title, { viewColumn: view === 'query' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: view === 'query' }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')] });
    const state: PanelState = { panel, profileId: profile.id, view, table, result: initialResult, queryOwner, dirty: false };
    this.panels.set(key, state);
    const post = (response: RpcResponse) => panel.webview.postMessage(response);
    panel.webview.onDidReceiveMessage(async raw => {
      if(isWebviewDiagnostic(raw))return;
      let id = '';
      try {
        const envelope = WebEnvelopeSchema.parse(raw); id = envelope.id; const { request } = envelope;
        let result: unknown;
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to a database.');
        switch (request.method) {
          case 'initialize': {
            const editor=view==='connection'?await this.manager.editorState(profile.id):undefined;
            if(view==='connection')profile=this.manager.profiles().find(p=>p.id===profile.id)??profile;
            if (view === 'table' && table) { const session = await this.manager.connect(profile.id); state.details = await session.details(table); state.result = await session.table({ table, where: '', order: [], offset: 0, limit: vscode.workspace.getConfiguration('dbWorkbench').get('rowsToLoad', 100) }); }
            result = { view, profile, connectionEditor:editor,resources:this.resources?.list(), table, result: state.result, details: state.details, query: queryOwner ? this.sqlDocuments.state(queryOwner) : undefined, run: queryOwner ? this.sqlDocuments.lastRun(queryOwner) : undefined, transfer: view === 'connections-import' ? { workspaceAvailable: Boolean(vscode.workspace.workspaceFolders?.length), workspaceDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath } : undefined } satisfies WorkbenchBoot; state.initialized = true; break;
          }
          case 'file.pick': {
            if (view !== 'connection') throw new Error('File picking is only available in the connection editor.');
            const filters = { 'SQLite Databases': ['db', 'sqlite', 'sqlite3'], 'All Files': ['*'] };
            const uri = request.params.create ? await vscode.window.showSaveDialog({ filters, title: 'Create SQLite Database', saveLabel: 'Use this path' }) : (await vscode.window.showOpenDialog({ filters, canSelectMany: false, title: 'Select SQLite Database' }))?.[0];
            result = uri?.scheme === 'file' ? uri.fsPath : null; break;
          }
          case 'profile.test': {
            if (view !== 'connection') throw new Error('Unavailable in this view.'); result = await this.manager.test(request.params); break;
          }
          case 'profile.edit.test': {
            if(view!=='connection'||request.params.profile.id!==profile.id)throw new Error('Connection form identity mismatch.');
            result=await this.manager.test(request.params.profile,request.params.password);break;
          }
          case 'resources.list':result=this.resources?.list()??{authentication:[],tunnels:[]};break;
          case 'profile.edit.save': {
            const input=request.params;
            if(view!=='connection'||input.profile.id!==profile.id)throw new Error('Connection form identity mismatch.');
            await this.manager.save(input.profile,{password:input.password,rememberPassword:input.rememberPassword,revision:input.revision,beforeReconnect:changed=>this.prepareSave(input.profile,changed)});
            const editor=await this.manager.editorState(profile.id);profile=this.manager.profile(profile.id);
            this.refresh();panel.title=`Edit: ${profile.name}`;result={profile,editor};break;
          }
          case 'profile.save': {
            if (view !== 'connection' || request.params.id !== profile.id) throw new Error('Connection form identity mismatch.');
            if (!await this.prepareSave(request.params)) throw new Error('Connection settings were not changed.');
            const saved = await this.manager.save(request.params); profile = saved; this.refresh(); result = saved; panel.title = `Edit: ${saved.name}`; break;
          }
          case 'profile.parseString': {
            if (view !== 'connection' || request.params.id !== profile.id) throw new Error('Connection form identity mismatch.');
            result = parseConnectionString(request.params.text, { baseDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }); break;
          }
          case 'connections.import.pick': {
            if (view !== 'connections-import') throw new Error('Open Import Connections first.');
            const uri = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Connection files': ['json', 'csv'], 'All files': ['*'] }, title: 'Import Connections' }))?.[0];
            if (!uri) { result = null; break; }
            if ((await vscode.workspace.fs.stat(uri)).size > 5_000_000) throw new Error('Connection imports are limited to 5 MB.');
            const bytes = await vscode.workspace.fs.readFile(uri); let text: string;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Save the connection file as UTF-8 JSON or CSV before importing.'); }
            state.importDirectory = vscode.Uri.joinPath(uri, '..').fsPath;
            result = { filename: uri.path.split('/').pop(), sourceDirectory: state.importDirectory, text, format: uri.path.toLowerCase().endsWith('.csv') ? 'csv' : 'json' }; break;
          }
          case 'connections.import.inspect': {
            if (view !== 'connections-import') throw new Error('Open Import Connections first.');
            const headers = parseConnectionCsv(request.params.text, request.params.delimiter)[0]!; result = { headers, mapping: mapConnectionHeaders(headers) }; break;
          }
          case 'connections.import.preview': {
            if (view !== 'connections-import') throw new Error('Open Import Connections first.');
            const baseDirectory = request.params.pathBase === 'source' && state.importDirectory ? state.importDirectory : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            result = this.transfers.preview(request.params.text, request.params.format, { delimiter: request.params.delimiter, mapping: request.params.mapping, baseDirectory }); break;
          }
          case 'connections.import.apply': {
            if (view !== 'connections-import') throw new Error('Open Import Connections first.');
            if (request.params.scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace before importing workspace connections.');
            result = await this.transfers.apply(request.params.token, request.params.decisions, request.params.scope,request.params.rememberPasswords); this.refresh(); break;
          }
          case 'table.load': {
            if (view !== 'table' || request.params.table !== table) throw new Error('Table identity mismatch.');
            const session = await this.manager.connect(profile.id); state.details = await session.details(table); state.result = await session.table(request.params); result = state.result; break;
          }
          case 'table.apply': {
            if (view !== 'table' || request.params.table !== table) throw new Error('Table identity mismatch.');
            result = await (await this.manager.connect(profile.id)).apply(table, request.params.keyColumns, request.params.changes); this.refresh(); break;
          }
          case 'query.execute': {
            if (view !== 'query' || !queryOwner) throw new Error('Use a SQL query view to execute SQL.');
            result = state.result = await this.sqlDocuments.execute(queryOwner, request.params.sql, request.params.limit); this.refresh(); break;
          }
          case 'query.run': {
            if (!queryOwner) throw new Error('Use a SQL document to run a script.');
            result = await this.sqlDocuments.run(queryOwner, request.params.sql, request.params.limit); this.refresh(); break;
          }
          case 'query.result.select': {
            const run = queryOwner ? this.sqlDocuments.lastRun(queryOwner) : undefined;
            const statement = run?.statements[request.params.index]; if (!statement) throw new Error('This result set no longer exists.');
            state.result = statement.result; result = null; break;
          }
          case 'query.cancel': result = queryOwner ? await this.sqlDocuments.cancel(queryOwner) : await this.manager.cancel(profile.id); break;
          case 'query.transaction': {
            if (!queryOwner) throw new Error('Transactions belong to a SQL document.');
            result = await this.sqlDocuments.transaction(queryOwner, request.params.action); this.refresh(); break;
          }
          case 'query.reset': {
            if (!queryOwner) throw new Error('Sessions belong to a SQL document.');
            if (this.sqlDocuments.state(queryOwner).transaction === 'active' && await vscode.window.showWarningMessage('Resetting this SQL session rolls back its open transaction. Continue?', { modal: true }, 'Roll Back and Reset') !== 'Roll Back and Reset') { result = false; break; }
            await this.sqlDocuments.reset(queryOwner); result = true; break;
          }
          case 'clipboard.write':if(view!=='query'&&view!=='table')throw new Error('Clipboard is available in a data grid.');await vscode.env.clipboard.writeText(request.params.text);result=null;break;
          case 'clipboard.read':if(view!=='table')throw new Error('Paste is available in a table editor.');result=await vscode.env.clipboard.readText();break;
          case 'file.export': {
            if (!state.result) throw new Error('There are no results to export.');
            const format = request.params.format;
            const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${table ?? 'query-results'}.${format}`), filters: { [format.toUpperCase()]: [format] }, title: 'Export loaded result rows' });
            if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(exportResult(state.result, format), 'utf8'));
            result = uri?.toString() ?? null; break;
          }
          case 'confirm.discard': result = await vscode.window.showWarningMessage('Discard unsaved data changes?', { modal: true }, 'Discard') === 'Discard'; break;
          case 'view.dirty': state.dirty = request.params.dirty; panel.title = (state.dirty ? '● ' : '') + title; result = null; break;
        }
        await post({ version: 1, id, result });
      } catch (error) { this.log(error); await post({ version: 1, id, error: { code: 'OPERATION_FAILED', message: errorMessage(error), sessionLost: Boolean((error as { sessionLost?: boolean }).sessionLost) } }); }
    });
    panel.onDidDispose(() => { this.panels.delete(key); if (ownsSession && queryOwner) void this.sqlDocuments.close(queryOwner).catch(this.log); });
    configureWebview(this.context, panel);
    return state;
  }
  async connection(profile?: ConnectionProfile): Promise<PanelState> {
    const value: ConnectionProfile = profile ?? { schemaVersion: 1, id: randomUUID(), driver: 'sqlite', name: '', storage: 'file', path: '', scope: 'global', group: '', color: '#2684a6', readOnly: false, createIfMissing: false };
    return this.create('connection', value);
  }
  async importConnections(): Promise<PanelState> {
    return this.create('connections-import', { schemaVersion: 1, id: '__connections-import', driver: 'sqlite', name: '', storage: 'file', path: '', scope: 'global', group: '', color: '#2684a6', readOnly: false, createIfMissing: false });
  }
  async exportConnections(ids?: string[]): Promise<void> {
    const values = this.manager.profiles().filter(profile => !ids || ids.includes(profile.id));
    if (!values.length) throw new Error('There are no connections to export.');
    const format = await vscode.window.showQuickPick([{ label: 'JSON', value: 'json' as const }, { label: 'CSV', value: 'csv' as const }], { title: `Export ${values.length} connection${values.length === 1 ? '' : 's'}` }); if (!format) return;
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`db-workbench-connections.${format.value}`), filters: { [format.label]: [format.value] } }); if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(exportConnections(values, format.value), 'utf8'));
  }
  async prepareSave(profile: ConnectionProfile, credentialChanged=false): Promise<boolean> {
    if(!this.manager.profiles().some(p=>p.id===profile.id))return true;
    if (!this.manager.willReconnect(profile)&&!credentialChanged) return true;
    const current = this.manager.profile(profile.id), consequences: string[] = [];
    if (current.storage === 'memory' && this.manager.isConnected(profile.id)) consequences.push('The current in-memory database contents will be lost.');
    const transactions = this.sqlDocuments.activeTransactions(profile.id).length;
    if (transactions) consequences.push(`${transactions} open SQL transaction${transactions === 1 ? '' : 's'} will be rolled back.`);
    const running=this.manager.documentSessions(profile.id).filter(lease=>this.sqlDocuments.state(lease.owner).busy).length;
    if(running)consequences.push(`${running} running SQL operation(s) will be stopped.`);
    if (consequences.length && await vscode.window.showWarningMessage(`Changing these connection settings closes its existing sessions. ${consequences.join(' ')}`, { modal: true }, 'Close Sessions and Save') !== 'Close Sessions and Save') return false;
    if (!await this.confirmDisconnect(profile.id)) return false;
    this.closeForConnection(profile.id); return true;
  }
  async table(profile: ConnectionProfile, table: string): Promise<void> { return this.tableEditors.open(profile, table); }
  async query(profile: ConnectionProfile, result?: QueryResult, owner?: string): Promise<PanelState> {
    const queryOwner = owner ?? `db-workbench-query:${randomUUID()}`; if (!owner) await this.sqlDocuments.bind(queryOwner, profile.id);
    return this.create('query', profile, undefined, result, queryOwner, !owner);
  }
  refreshQueryStates(): void {
    for (const state of this.panels.values()) if (state.queryOwner) {
      const run = this.sqlDocuments.lastRun(state.queryOwner);
      if (run && (state.runId !== run.id || state.statementCount !== run.statements.length)) {
        state.runId = run.id; state.statementCount = run.statements.length; state.result = [...run.statements].reverse().find(statement => statement.result)?.result;
      }
      if (state.initialized) {
        void state.panel.webview.postMessage({ event: 'query-state', state: this.sqlDocuments.state(state.queryOwner) });
        if (run) void state.panel.webview.postMessage({ event: 'query-run', run });
      }
    }
  }
  closeQuery(owner: string): void { for (const state of [...this.panels.values()]) if (state.queryOwner === owner) state.panel.dispose(); }
  async confirmDisconnect(profileId: string): Promise<boolean> {
    if (!await this.tableEditors.closeForConnection(profileId)) return false;
    if (![...this.panels.values()].some(p => p.profileId === profileId && p.dirty)) return true;
    return await vscode.window.showWarningMessage('This connection has unsaved data changes. Disconnect and close its data views?', { modal: true }, 'Disconnect') === 'Disconnect';
  }
  closeForConnection(profileId: string): void { for (const state of [...this.panels.values()]) if (state.profileId === profileId && state.view !== 'connection') state.panel.dispose(); }
  dispose(): void { for (const state of [...this.panels.values()]) state.panel.dispose(); this.tableEditors.dispose(); }
}
