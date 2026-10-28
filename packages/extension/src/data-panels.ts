import * as vscode from 'vscode';
import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from '../../core/src/connections.js';
import {DataTransfers,type ImportReport} from '../../core/src/data-transfers.js';
import {readTableStructure} from '../../core/src/table-structure.js';
import {WebEnvelopeSchema,errorMessage,type WorkbenchBoot} from '../../protocol/src/index.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';
export class DataPanels implements vscode.Disposable{
  private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
  constructor(private context:vscode.ExtensionContext,private manager:ConnectionManager,readonly transfers:DataTransfers,private log:(e:unknown)=>void){}
  initializedViews(){return this.initialized.size;}
  async open(profileId:string,table:string){
    const panel=vscode.window.createWebviewPanel('dbWorkbench.dataImport',`Import · ${table}`,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);let controller:AbortController|undefined,disposed=false,lastReport:ImportReport|undefined;
    const sources=new Set<string>(),previews=new Set<string>();const cleanup=()=>{for(const token of previews)void this.transfers.forget(token).catch(this.log);previews.clear();};
    panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='',ownsOperation=false;try{
      if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before accessing database files.');const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;const request=envelope.request;
      if(request.method==='data.cancel'){controller?.abort();await panel.webview.postMessage({version:1,id,result:null});return;}
      if(controller)throw new Error('Wait for the current transfer operation.');controller=new AbortController();ownsOperation=true;let result:unknown;
      switch(request.method){
        case 'initialize':result={view:'data-import',profile:this.manager.profile(profileId),table,structure:await readTableStructure(await this.manager.connect(profileId),table)} satisfies WorkbenchBoot;this.initialized.add(panel);break;
        case 'data.pick':{const selected=(await vscode.window.showOpenDialog({canSelectMany:false,title:'Choose UTF-8 data file',filters:{[request.params.format.toUpperCase()]:[request.params.format]}}))?.[0];if(!selected){result=null;break;}if(selected.scheme!=='file')throw new Error('This import currently reads files on the extension host filesystem.');result=await this.transfers.inspect(selected.fsPath,request.params,controller.signal);sources.add((result as {token:string}).token);break;}
        case 'data.preview':{if(!sources.has(request.params.source))throw new Error('Select a source file in this import editor.');cleanup();result=await this.transfers.preview(request.params.source,profileId,table,request.params.mapping,controller.signal);previews.add((result as {token:string}).token);break;}
        case 'data.apply':{if(!previews.has(request.params.token))throw new Error('Preview this import before applying.');await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);const reportPath=vscode.Uri.joinPath(this.context.globalStorageUri,`import-report-${randomUUID()}.jsonl`).fsPath;result=lastReport=await this.transfers.apply(profileId,request.params.token,{...request.params,reportPath},p=>{void panel.webview.postMessage({event:'transfer-progress',progress:p});},controller.signal);break;}
        case 'data.report.open':if(!lastReport?.reportPath)throw new Error('No import report has been written.');await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(lastReport.reportPath)),{preview:false});result=null;break;
        default:throw new Error('Unavailable in the data import editor.');
      }
      await panel.webview.postMessage({version:1,id,result});
    }catch(error){this.log(error);await panel.webview.postMessage({version:1,id,error:{code:'DATA_TRANSFER_ERROR',message:errorMessage(error)}});}finally{if(ownsOperation)controller=undefined;if(disposed&&!controller)cleanup();}});
    panel.onDidDispose(()=>{disposed=true;controller?.abort();if(!controller)cleanup();this.panels.delete(panel);this.initialized.delete(panel);});configureWebview(this.context,panel);
  }
  async export(profileId:string,source:{table:string}|{sql:string},format?:'csv'|'json',session?:import('../../driver-sdk/src/index.js').DriverSession,signal?:AbortSignal){
    format??=(await vscode.window.showQuickPick([{label:'CSV · NULL is \\N',value:'csv' as const},{label:'JSON · typed values',value:'json' as const}],{title:'Export all rows'}))?.value;if(!format)return;
    const uri=await vscode.window.showSaveDialog({title:'Export all rows · read-only snapshot on extension host',defaultUri:vscode.Uri.joinPath(this.context.globalStorageUri,`export.${format}`),filters:{[format.toUpperCase()]:[format]}});if(!uri)return;if(uri.scheme!=='file')throw new Error('Streaming export currently writes to the extension host filesystem.');
    const result=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Export all rows',cancellable:true},async(progress,token)=>{const abort=new AbortController(),cancel=()=>abort.abort(),subscription=token.onCancellationRequested(cancel);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)abort.abort();try{return await this.transfers.exportFile(profileId,source,uri.fsPath,{format:format!,overwrite:true},p=>progress.report({message:`${p.rows.toLocaleString()} rows · ${p.bytes.toLocaleString()} bytes`}),abort.signal,session);}finally{subscription.dispose();signal?.removeEventListener('abort',cancel);}});
    if(await vscode.window.showInformationMessage(`Exported ${result.rows.toLocaleString()} rows.`, 'Open File')==='Open File')await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));return result;
  }
  dispose(){for(const p of this.panels)p.dispose();this.panels.clear();void this.transfers.dispose().catch(this.log);}
}
