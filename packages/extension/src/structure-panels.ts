import * as vscode from 'vscode';
import type {ConnectionManager} from '../../core/src/connections.js';
import type {SqlDocuments} from '../../core/src/sql-documents.js';
import {SchemaChanges} from '../../core/src/schema-changes.js';
import {errorMessage,WebEnvelopeSchema,type WorkbenchBoot,type DdlPreview} from '../../protocol/src/index.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';
import {previewSql} from '../../core/src/ddl-script.js';
export class StructurePanels implements vscode.Disposable{
  private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
  constructor(private context:vscode.ExtensionContext,private manager:ConnectionManager,readonly changes:SchemaChanges,private documents:SqlDocuments,private log:(e:unknown)=>void){}
  initializedViews(){return this.initialized.size;}
  async open(profileId:string,initialTable?:string,initialSchema?:string){
    let table=initialTable;const profile=this.manager.profile(profileId),previews=new Map<string,DdlPreview>();
    const panel=vscode.window.createWebviewPanel('dbWorkbench.structure',table?`Structure · ${table}`:'Create Table',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);
    const boot=async():Promise<WorkbenchBoot>=>({view:'structure',profile:this.manager.profile(profileId),table,structureSchema:initialSchema,structure:table?await this.changes.structure(profileId,table):undefined});
    panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='';try{
      if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before connecting.');const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;const request=envelope.request;let result:unknown;
      switch(request.method){
        case 'initialize':case 'ddl.load':result=await boot();this.initialized.add(panel);break;
        case 'ddl.preview':{if(table&&request.params.intent.action==='createTable'||!table&&request.params.intent.action!=='createTable')throw new Error('Structure form target mismatch.');for(const p of previews.values())this.changes.forget(p.token);previews.clear();const preview=await this.changes.preview(profileId,table,request.params.intent);previews.set(preview.token,preview);result=preview;break;}
        case 'ddl.apply':{if(!previews.has(request.params.token))throw new Error('Create a SQL preview in this editor first.');const preview=previews.get(request.params.token)!;const report=await this.changes.apply(profileId,preview.token);if(report.status==='succeeded'){table=preview.intent.action==='dropTable'?undefined:report.table;panel.title=table?`Structure · ${table}`:'Create Table';previews.delete(preview.token);}result={report,boot:await boot()};break;}
        case 'ddl.openSql':{if(!request.params.token&&table){const s=(await boot()).structure!;await vscode.commands.executeCommand('dbWorkbench.openDefinition',{profileId,object:{name:s.name,label:s.label,schema:s.schema,type:s.type,sql:s.definition}});result=null;break;}const content=request.params.token?(()=>{const p=previews.get(request.params.token!);if(!p)throw new Error('This preview is no longer available.');return previewSql(p,profile.driver);})():'';const doc=await vscode.workspace.openTextDocument({language:'sql',content});await this.documents.bind(doc.uri.toString(),profileId);await vscode.window.showTextDocument(doc,{preview:false});result=null;break;}
        default:throw new Error('Unavailable in the structure editor.');
      }
      await panel.webview.postMessage({version:1,id,result});
    }catch(error){this.log(error);await panel.webview.postMessage({version:1,id,error:{code:'STRUCTURE_ERROR',message:errorMessage(error)}});}});
    panel.onDidDispose(()=>{this.panels.delete(panel);this.initialized.delete(panel);for(const p of previews.values())this.changes.forget(p.token);});configureWebview(this.context,panel);
  }
  dispose(){for(const panel of this.panels)panel.dispose();this.panels.clear();}
}
