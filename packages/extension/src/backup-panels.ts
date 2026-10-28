import * as vscode from 'vscode';
import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from '../../core/src/connections.js';
import {SqliteBackups,type BackupReport} from '../../core/src/sqlite-backups.js';
import {WebEnvelopeSchema,errorMessage,ProfileSchema,type WorkbenchBoot} from '../../protocol/src/index.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';

export class BackupPanels implements vscode.Disposable {
  private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
  constructor(private context:vscode.ExtensionContext,private manager:ConnectionManager,readonly backups:SqliteBackups,private log:(e:unknown)=>void){}
  initializedViews(){return this.initialized.size;}
  async open(profileId:string){
    const profile=this.manager.profile(profileId);if(profile.driver!=='sqlite')throw new Error('This online backup workflow currently supports SQLite. Server native tools are still being implemented.');
    const panel=vscode.window.createWebviewPanel('dbWorkbench.sqliteBackup',`Backup / Restore · ${profile.name}`,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);
    let controller:AbortController|undefined,disposed=false,lastReport:BackupReport|undefined,added=false;const tokens=new Set<string>();
    const cleanup=async()=>{for(const token of tokens)await this.backups.forget(token);tokens.clear();};
    const file=(uri:vscode.Uri)=>{if(uri.scheme!=='file')throw new Error('Choose a file on the extension host filesystem.');return uri.fsPath;};
    const destination=async()=>{const uri=await vscode.window.showSaveDialog({title:'Choose a new SQLite file · existing files are preserved',filters:{'SQLite database':['db','sqlite','sqlite3']}});return uri?file(uri):undefined;};
    panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='',ownsOperation=false;try{
      const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before accessing databases.');const request=envelope.request;
      if(request.method==='backup.cancel'){controller?.abort();await panel.webview.postMessage({version:1,id,result:null});return;}
      if(controller)throw new Error('Wait for the current backup operation.');controller=new AbortController();ownsOperation=true;let result:unknown;
      const progress=(p:import('../../core/src/sqlite-backups.js').BackupProgress)=>{void panel.webview.postMessage({event:'backup-progress',progress:p});};
      switch(request.method){
        case 'initialize':result={view:'sqlite-backup',profile:this.manager.profile(profileId)} satisfies WorkbenchBoot;this.initialized.add(panel);break;
        case 'backup.create':{const path=await destination();result=path?lastReport=await this.backups.backup(profileId,path,progress,controller.signal):null;break;}
        case 'backup.previewRestore':{await cleanup();const uri=(await vscode.window.showOpenDialog({title:'Select SQLite backup to inspect',canSelectMany:false,filters:{'SQLite database':['db','sqlite','sqlite3'],'All files':['*']}}))?.[0];if(!uri){result=null;break;}const path=await destination();if(!path){result=null;break;}const preview=await this.backups.previewRestore(file(uri),path,progress,controller.signal);tokens.add(preview.token);result=preview;break;}
        case 'backup.restore':if(!tokens.has(request.params.token))throw new Error('Preview this backup in the current editor first.');tokens.delete(request.params.token);result=lastReport=await this.backups.restore(request.params.token,progress,controller.signal);added=false;break;
        case 'backup.report':if(!lastReport?.reportPath)throw new Error('No report was written.');await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(lastReport.reportPath)),{preview:false});result=null;break;
        case 'backup.addConnection':if(added||lastReport?.kind!=='restore'||!lastReport.published)throw new Error('Restore a new database before adding its connection.');result=await this.manager.save(ProfileSchema.parse({id:randomUUID(),name:`${profile.name} · restored`,driver:'sqlite',storage:'file',path:lastReport.destination,scope:profile.scope,group:profile.group,color:profile.color,createIfMissing:false}));added=true;break;
        default:throw new Error('Unavailable in this backup editor.');
      }
      await panel.webview.postMessage({version:1,id,result});
    }catch(e){this.log(e);await panel.webview.postMessage({version:1,id,error:{code:'BACKUP_ERROR',message:errorMessage(e)}});}finally{if(ownsOperation)controller=undefined;if(disposed&&!controller)void cleanup().catch(this.log);}});
    panel.onDidDispose(()=>{disposed=true;controller?.abort();if(!controller)void cleanup().catch(this.log);this.panels.delete(panel);this.initialized.delete(panel);});configureWebview(this.context,panel);
  }
  dispose(){for(const panel of this.panels)panel.dispose();this.panels.clear();void this.backups.dispose().catch(this.log);}
}
