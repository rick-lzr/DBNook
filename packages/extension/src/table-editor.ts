import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { GridDocumentModel } from '../../core/src/grid-document.js';
import type { ConnectionManager } from '../../core/src/connections.js';
import { profileTarget } from '../../core/src/profile-target.js';
import { exportResult } from '../../core/src/export.js';
import { errorMessage, TableRequestSchema, WebEnvelopeSchema, type ConnectionProfile, type GridEditState, type RpcResponse, type WorkbenchBoot } from '../../protocol/src/index.js';
import { configureWebview,isWebviewDiagnostic } from './webview.js';
import {diagnosticsFor} from './diagnostics.js';

export const TABLE_EDITOR = 'dbWorkbench.tableEditor';
const SCHEME = 'db-workbench-table';
function identity(uri: vscode.Uri): { profileId: string; table: string } {
  const query = new URLSearchParams(uri.query), profileId = query.get('connection'), table = query.get('table');
  if (uri.scheme !== SCHEME || uri.authority !== 'database' || !profileId || !table) throw new Error('Invalid database table editor resource.');
  return { profileId, table };
}
class TableResourceProvider implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  stat(uri: vscode.Uri): vscode.FileStat { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.readFile(uri).length }; }
  readFile(uri: vscode.Uri): Uint8Array { return Buffer.from(JSON.stringify(identity(uri))); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions('Database table resources are saved through their custom editor.'); }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }
  dispose(): void { this.emitter.dispose(); }
}
export class TableDocument implements vscode.CustomDocument {
  readonly panels = new Set<vscode.WebviewPanel>();
  readonly initialized = new Set<vscode.WebviewPanel>();
  readonly flushes = new Map<string, { resolve(): void; reject(error: Error): void }>();
  constructor(readonly uri: vscode.Uri, readonly model: GridDocumentModel, private onDispose: () => void) {}
  dispose(): void { for (const request of this.flushes.values()) request.reject(new Error('The table editor was closed.')); this.flushes.clear(); this.panels.clear(); this.onDispose(); }
}
export class TableEditorProvider implements vscode.CustomEditorProvider<TableDocument>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<TableDocument>>();
  readonly onDidChangeCustomDocument = this.emitter.event;
  private documents = new Map<string, TableDocument>();
  private structureLocks=new Map<string,string>();
  private disposables: vscode.Disposable[];
  constructor(private context: vscode.ExtensionContext, private manager: ConnectionManager, private refresh: () => void, private log: (error: unknown) => void) {
    const resources = new TableResourceProvider();
    this.disposables = [resources, vscode.workspace.registerFileSystemProvider(SCHEME, resources, { isCaseSensitive: true }), vscode.window.registerCustomEditorProvider(TABLE_EDITOR, this, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false })];
  }
  initializedViews(): number { return [...this.documents.values()].reduce((n, doc) => n + doc.initialized.size, 0); }
  getDocuments(): readonly TableDocument[] { return [...this.documents.values()]; }
  async beginStructureChange(profileId:string,owner='structure'):Promise<void>{
    if(this.structureLocks.has(profileId))throw new Error('Another structure/import operation is running for this connection.');
    const docs=this.getDocuments().filter(d=>d.model.profile.id===profileId);
    for(const doc of docs)await this.flush(doc);
    if(docs.some(d=>d.model.dirty))throw new Error('Save or revert staged table edits before changing this connection structure.');
    if(docs.some(d=>d.model.state().busy))throw new Error('Wait for table loading or saving to finish before changing structure.');
    this.structureLocks.set(profileId,owner);for(const doc of docs){doc.model.freezeStructure(true);this.broadcast(doc);}
  }
  async finishStructureChange(profileId:string,owner='structure'):Promise<void>{
    if(this.structureLocks.get(profileId)!==owner)return;this.structureLocks.delete(profileId);
    const docs=this.getDocuments().filter(d=>d.model.profile.id===profileId);
    for(const doc of docs){try{
      const session=await this.session(doc);
      doc.model.freezeStructure(false);
      if(!doc.model.dirty)await doc.model.load(session,doc.model.state().request);
    }catch(error){this.log(error);const tabs=vscode.window.tabGroups.all.flatMap(g=>g.tabs).filter(t=>t.input instanceof vscode.TabInputCustom&&t.input.uri.toString()===doc.uri.toString());if(tabs.length)await vscode.window.tabGroups.close(tabs);}
    finally{doc.model.freezeStructure(false);this.broadcast(doc);}}
  }
  update(document: TableDocument, revision: number, state: GridEditState): void {
    const transition = document.model.update(revision, state);
    if (transition) this.emitter.fire({ document, label: transition.label, undo: () => { transition.undo(); this.broadcast(document); }, redo: () => { transition.redo(); this.broadcast(document); } });
  }
  async open(profile: ConnectionProfile, table: string): Promise<void> {
    const existing = [...this.documents.values()].find(doc => doc.model.profile.id === profile.id && doc.model.details.name === table);
    const uri = existing?.uri ?? vscode.Uri.from({ scheme: SCHEME, authority: 'database', path: `/${profile.id}/${profile.database ?? 'main'}/${table.replaceAll('/', '∕')}.dbwtable`, query: new URLSearchParams({ connection: profile.id, table }).toString() });
    diagnosticsFor(this.context)?.info('table.open.request',{driver:profile.driver,storage:profile.storage});
    try{await vscode.commands.executeCommand('vscode.openWith', uri, TABLE_EDITOR, { viewColumn: vscode.ViewColumn.Active, preview: false });}
    catch(error){diagnosticsFor(this.context)?.error('table.open.command',error,undefined,true);this.log(error);throw error;}
  }
  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): Promise<TableDocument> {
    let stage='table.open.resource';const diagnostics=diagnosticsFor(this.context);diagnostics?.info(stage);
    try{
    this.trusted(); const { profileId, table } = identity(uri), profile = this.manager.profile(profileId);
    if(this.structureLocks.has(profileId))throw new Error('Wait for the structure change to finish before opening a table.');
    let model: GridDocumentModel;
    if (openContext.backupId) {
      stage='table.open.restore';diagnostics?.info(stage);
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
      model = GridDocumentModel.restore(profile, table, Buffer.from(bytes).toString('utf8'),this.manager.resourceBinding(profile));
    } else {
      stage='table.open.connect';diagnostics?.info(stage,{driver:profile.driver,storage:profile.storage});
      const session = await this.manager.connect(profileId);
      const request = TableRequestSchema.parse({ table, limit: vscode.workspace.getConfiguration('dbWorkbench').get('rowsToLoad', 100) });
      stage='table.open.metadata';diagnostics?.info(stage);const details = await session.details(table);
      stage='table.open.rows';diagnostics?.info(stage,{limit:request.limit});const result = await session.table(request);
      stage='table.open.model';diagnostics?.info(stage);
      model = new GridDocumentModel(profile, details, result, request,this.manager.resourceBinding(profile));
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if(this.structureLocks.has(profileId))throw new Error('A structure change started while opening the table. Reopen after it finishes.');
    const document = new TableDocument(uri, model, () => this.documents.delete(uri.toString()));
    this.documents.set(uri.toString(), document);diagnostics?.info('table.open.loaded'); return document;
    }catch(error){diagnostics?.error(stage,error,undefined,true);this.log(error);throw error;}
  }
  private trusted(): void { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before accessing database data.'); }
  private session(document: TableDocument) {
    this.trusted(); const before = document.model.profile, now = this.manager.profile(before.id);
    if (JSON.stringify(profileTarget(before)) !== JSON.stringify(profileTarget(now)) || before.readOnly !== now.readOnly||document.model.binding!==this.manager.resourceBinding(now)) throw new Error('Connection settings changed. Preserve your edits and reopen this table before saving.');
    return this.manager.connect(before.id);
  }
  private broadcast(document: TableDocument): void { const state = document.model.state(); for (const panel of document.panels) void panel.webview.postMessage({ event: 'editor-state', state }); }
  private async activeCommand(document: TableDocument, panel: vscode.WebviewPanel, command: string): Promise<void> {
    if (!panel.active || !document.panels.has(panel)) throw new Error('Activate this table editor before using this action.');
    await vscode.commands.executeCommand(command);
  }
  resolveCustomEditor(document: TableDocument, panel: vscode.WebviewPanel): void {
    try{
    const { model } = document; document.panels.add(panel); panel.title = `${model.profile.name}/${model.profile.database ?? 'main'}/${model.details.name}`;
    const listener = panel.webview.onDidReceiveMessage(async raw => {
      if(isWebviewDiagnostic(raw))return;
      let id = '';
      let operation = '';
      const post = (response: RpcResponse) => panel.webview.postMessage(response);
      try {
        const envelope = WebEnvelopeSchema.parse(raw); id = envelope.id; const { request } = envelope; operation = request.method;
        this.trusted(); let result: unknown;
        switch (request.method) {
          case 'clipboard.write':await vscode.env.clipboard.writeText(request.params.text);result=null;break;
          case 'clipboard.read':result=await vscode.env.clipboard.readText();break;
          case 'data.openImport':result=await vscode.commands.executeCommand('dbWorkbench.importTableData',{profileId:model.profile.id,object:model.details});break;
          case 'data.exportAll':result=await vscode.commands.executeCommand('dbWorkbench.exportTableData',{profileId:model.profile.id,object:model.details},request.params.format);break;
          case 'initialize': {
            document.initialized.add(panel); result = { view: 'table', profile: model.profile, table: model.details.name, details: model.details, result: model.state().result, editor: model.state() } satisfies WorkbenchBoot; break;
          }
          case 'editor.update': {
            this.update(document, request.params.revision, request.params.state);
            result = model.state(); break;
          }
          case 'editor.keys': model.keys(request.params.keyColumns); result = null; break;
          case 'editor.save': await this.activeCommand(document, panel, 'workbench.action.files.save'); result = model.state(); break;
          case 'editor.undo': await this.activeCommand(document, panel, 'undo'); result = model.state(); break;
          case 'editor.redo': await this.activeCommand(document, panel, 'redo'); result = model.state(); break;
          case 'editor.flush-complete': { const pending = document.flushes.get(request.params.token); document.flushes.delete(request.params.token); request.params.error ? pending?.reject(new Error(request.params.error)) : pending?.resolve(); result = null; break; }
          case 'table.load': result = await model.load(await this.session(document), request.params); this.broadcast(document); break;
          case 'confirm.discard': if (model.dirty) await this.activeCommand(document, panel, 'workbench.action.files.revert'); result = !model.dirty; break;
          case 'query.cancel': result = await this.manager.cancel(model.profile.id); break;
          case 'file.export': {
            const format = request.params.format, uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${model.details.name}.${format}`), filters: { [format.toUpperCase()]: [format] }, title: 'Export loaded saved rows' });
            if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(exportResult(model.state().result, format), 'utf8'));
            result = uri?.toString() ?? null; break;
          }
          default: throw new Error('This operation is not available in a table editor.');
        }
        await post({ version: 1, id, result });
      } catch (error) { this.log(error); if (operation !== 'editor.update') this.broadcast(document); await post({ version: 1, id, error: { code: 'TABLE_EDITOR_ERROR', message: errorMessage(error) } }); }
    });
    panel.onDidDispose(() => { document.panels.delete(panel); document.initialized.delete(panel); listener.dispose(); });
    configureWebview(this.context, panel);
    }catch(error){diagnosticsFor(this.context)?.error('table.webview.resolve',error,undefined,true);this.log(error);throw error;}
  }
  private async flush(document: TableDocument): Promise<void> {
    const panel = [...document.initialized][0]; if (!panel) return;
    const token = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { document.flushes.delete(token); reject(new Error('The data editor did not finish its active edit. Retry Save.')); }, 10000);
      document.flushes.set(token, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
      void panel.webview.postMessage({ event: 'editor-flush', token });
    });
  }
  async saveCustomDocument(document: TableDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await this.flush(document); if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
    try { const save = document.model.save(await this.session(document)); this.broadcast(document); await save; this.refresh(); }
    finally { this.broadcast(document); }
  }
  async saveCustomDocumentAs(): Promise<void> { throw new Error('Save writes changes to the connected database. Use Export to save data to a separate file.'); }
  async revertCustomDocument(document: TableDocument): Promise<void> { document.model.revert(); this.broadcast(document); }
  async backupCustomDocument(document: TableDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    const data = Buffer.from(document.model.backup()); if (cancellation.isCancellationRequested) throw new vscode.CancellationError();
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(context.destination, '..'));
    await vscode.workspace.fs.writeFile(context.destination, data);
    return { id: context.destination.toString(), delete: () => { void vscode.workspace.fs.delete(context.destination).then(undefined, this.log); } };
  }
  async closeForConnection(profileId: string): Promise<boolean> {
    const uris = new Set([...this.documents.values()].filter(doc => doc.model.profile.id === profileId).map(doc => doc.uri.toString()));
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputCustom && uris.has(tab.input.uri.toString()));
    return !tabs.length || await vscode.window.tabGroups.close(tabs);
  }
  dispose(): void { this.emitter.dispose(); for (const disposable of this.disposables) disposable.dispose(); }
}
