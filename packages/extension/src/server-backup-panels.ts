import * as vscode from 'vscode';
import type {ConnectionManager} from '../../core/src/connections.js';
import {ServerBackups,type ServerBackupReport,type ServerTools} from '../../core/src/server-backups.js';
import {WebEnvelopeSchema,errorMessage,type WorkbenchBoot,type ConnectionProfile} from '../../protocol/src/index.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';

export class ServerBackupPanels implements vscode.Disposable {
  private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
  constructor(private context:vscode.ExtensionContext,private manager:ConnectionManager,readonly backups:ServerBackups,private tools:(driver:ConnectionProfile['driver'])=>ServerTools,private log:(error:unknown)=>void){}
  initializedViews(){return this.initialized.size;}
  async open(profileId:string){
    const p=this.manager.profile(profileId);if(p.driver==='sqlite')throw new Error('Use SQLite Backup / Restore for this connection.');
    if(!p.database)throw new Error('Select an explicit database in the connection before backup or restore.');
    const panel=vscode.window.createWebviewPanel('dbWorkbench.serverBackup',`Backup / Restore · ${p.name}`,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);
    let controller:AbortController|undefined,disposed=false,lastReport:ServerBackupReport|undefined;const tokens=new Set<string>();
    const configuration=vscode.workspace.onDidChangeConfiguration(event=>{if(event.affectsConfiguration('dbWorkbench.nativeTools'))void panel.webview.postMessage({event:'native-tools',tools:this.tools(p.driver)});});
    const cleanup=async()=>{for(const token of tokens)await this.backups.forget(token);tokens.clear();};
    const file=(uri:vscode.Uri)=>{if(uri.scheme!=='file')throw new Error('Choose a file on the extension host filesystem.');return uri.fsPath;};
    panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='',owned=false;try{
      const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before running native database tools.');const request=envelope.request;
      if(request.method==='serverBackup.cancel'){controller?.abort();await panel.webview.postMessage({version:1,id,result:null});return;}
      if(controller)throw new Error('Wait for the current native operation.');controller=new AbortController();owned=true;let result:unknown;
      const progress=(value:import('../../core/src/server-backups.js').ServerBackupProgress)=>{void panel.webview.postMessage({event:'backup-progress',progress:value});};
      switch(request.method){
        case 'initialize':result={view:'server-backup',profile:this.manager.profile(profileId),nativeTools:this.tools(p.driver)} satisfies WorkbenchBoot;this.initialized.add(panel);break;
        case 'serverBackup.create':{const uri=await vscode.window.showSaveDialog({title:'Create a native backup · choose a new file',filters:p.driver==='postgresql'?{'PostgreSQL archive':['dump']}:{'SQL dump':['sql']}});result=uri?lastReport=await this.backups.backup(profileId,file(uri),progress,controller.signal):null;break;}
        case 'serverBackup.preview':{await cleanup();const uri=(await vscode.window.showOpenDialog({title:'Choose a trusted native backup to preview',canSelectMany:false,filters:p.driver==='postgresql'?{'PostgreSQL archive':['dump'],'All files':['*']}:{'SQL dump':['sql']}}))?.[0];if(!uri){result=null;break;}const preview=await this.backups.previewRestore(profileId,file(uri),progress,controller.signal);tokens.add(preview.token);result=preview;break;}
        case 'serverBackup.reviewSql':if(!tokens.has(request.params.token))throw new Error('Preview this backup in the current editor.');await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(await this.backups.reviewSql(request.params.token,controller.signal))),{preview:false});result=null;break;
        case 'serverBackup.restore':{
          if(!tokens.has(request.params.token))throw new Error('Preview this backup in the current editor.');
          const target=this.manager.profile(profileId);if(!request.params.trusted||request.params.database!==target.database)throw new Error('Confirm the database name and trusted backup source.');
          if(await vscode.window.showWarningMessage(`Restore the reviewed backup into ${target.host}:${target.port??(target.driver==='postgresql'?5432:3306)}/${target.database}? The target must be empty. ${target.driver==='postgresql'?'The archive runs database code.':'DDL may leave partial changes on failure or cancellation.'}`,{modal:true},'Restore reviewed backup')!=='Restore reviewed backup'){result=null;break;}
          result=lastReport=await this.backups.restore(request.params.token,request.params,progress,controller.signal);if(lastReport.outcome!=='not-started')tokens.delete(request.params.token);break;
        }
        case 'serverBackup.report':if(!lastReport?.reportPath)throw new Error('No job report is available.');await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(lastReport.reportPath)),{preview:false});result=null;break;
        case 'serverBackup.settings':await vscode.commands.executeCommand('workbench.action.openSettings','dbWorkbench.nativeTools');result=null;break;
        default:throw new Error('Unavailable in this server backup editor.');
      }await panel.webview.postMessage({version:1,id,result});
    }catch(error){this.log(error);await panel.webview.postMessage({version:1,id,error:{code:'SERVER_BACKUP_ERROR',message:errorMessage(error)}});}finally{if(owned)controller=undefined;if(disposed&&!controller)void cleanup().catch(this.log);}});
    panel.onDidDispose(()=>{disposed=true;configuration.dispose();controller?.abort();if(!controller)void cleanup().catch(this.log);this.panels.delete(panel);this.initialized.delete(panel);});configureWebview(this.context,panel);
  }
  dispose(){for(const panel of this.panels)panel.dispose();void this.backups.dispose().catch(this.log);}
}
