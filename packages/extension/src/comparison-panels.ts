import * as vscode from 'vscode';
import {randomUUID} from 'node:crypto';
import type {ConnectionManager} from '../../core/src/connections.js';
import {Comparisons} from '../../core/src/comparisons.js';
import type {SqlDocuments} from '../../core/src/sql-documents.js';
import {WebEnvelopeSchema,errorMessage,type CompareSource,type CompareSummary,type SyncPreview,type WorkbenchBoot} from '../../protocol/src/index.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';

export class ComparisonPanels implements vscode.Disposable {
  private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
  constructor(private context:vscode.ExtensionContext,private manager:ConnectionManager,readonly comparisons:Comparisons,private sqlDocuments:SqlDocuments,private log:(e:unknown)=>void){}
  initializedViews(){return this.initialized.size;}
  async openScript(token:string){const content=this.comparisons.script(token),profileId=this.comparisons.scriptProfile(token),uri=vscode.Uri.joinPath(this.context.globalStorageUri,'comparison-scripts',randomUUID()+'.sql');await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.context.globalStorageUri,'comparison-scripts'));await vscode.workspace.fs.writeFile(uri,Buffer.from(content));const document=await vscode.workspace.openTextDocument(uri);await this.sqlDocuments.bind(document.uri.toString(),profileId);await vscode.window.showTextDocument(document,{preview:false});return document.uri;}
  async open(source?:CompareSource,target?:CompareSource){
    const profile=this.manager.profiles()[0];if(!profile)throw new Error('Add a database connection before comparing data.');
    const panel=vscode.window.createWebviewPanel('dbWorkbench.comparison','Compare data',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);
    let controller:AbortController|undefined,disposed=false,comparison:CompareSummary|undefined,preview:SyncPreview|undefined;const readers=new Set<AbortController>();
    const forget=()=>{if(comparison)this.comparisons.forget(comparison.token);comparison=undefined;preview=undefined;};
    panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='',owned=false,readController:AbortController|undefined;try{
      const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before comparing database data.');const request=envelope.request;let result:unknown;
      if(request.method==='compare.cancel'){controller?.abort();await panel.webview.postMessage({version:1,id,result:null});return;}
      if(['initialize','compare.catalog','compare.objects','compare.suggest','compare.page','compare.differenceIds'].includes(request.method)){
        readController=new AbortController();readers.add(readController);
        switch(request.method){
          case 'initialize':result={view:'comparison',profile,comparison:{source,target}} satisfies WorkbenchBoot;this.initialized.add(panel);break;
          case 'compare.catalog':result=this.comparisons.catalog();break;
          case 'compare.objects':result=await this.comparisons.objects(request.params.profileId);break;
          case 'compare.suggest':{const [sourceInfo,targetInfo]=await Promise.all([this.comparisons.describe(request.params.source,readController.signal),this.comparisons.describe(request.params.target,readController.signal)]);result={source:sourceInfo,target:targetInfo,pairs:this.comparisons.suggestedPairs(sourceInfo.columns,targetInfo.columns)};break;}
          case 'compare.page':if(request.params.token!==comparison?.token)throw new Error('This comparison belongs to another editor or expired.');result=this.comparisons.page(request.params.token,request.params.offset,request.params.limit,request.params.differencesOnly);break;
          case 'compare.differenceIds':if(request.params.token!==comparison?.token)throw new Error('Compare these datasets in this editor first.');result=this.comparisons.differenceIds(request.params.token);break;
        }
      }else{
        if(controller)throw new Error('Wait for the current comparison operation.');controller=new AbortController();owned=true;
        switch(request.method){
          case 'compare.run':forget();result=comparison=await this.comparisons.compare(request.params,controller.signal);break;
          case 'compare.previewSync':if(request.params.token!==comparison?.token)throw new Error('Compare these datasets in this editor first.');if(preview)this.comparisons.forgetPlan(preview.token);result=preview=this.comparisons.previewSync(request.params.token,request.params.rows);break;
          case 'compare.clearResults':forget();this.comparisons.clearResults();result=this.comparisons.catalog();break;
          case 'compare.openScript':if(request.params.token!==preview?.token)throw new Error('Generate the SQL preview in this editor first.');await this.openScript(preview.token);result=null;break;
          case 'compare.applySync':{
            if(request.params.token!==preview?.token)throw new Error('Review this synchronization in the current editor first.');
            if(await vscode.window.showWarningMessage(`Apply ${preview.steps} reviewed changes to ${preview.target}? ${preview.inserted} insert, ${preview.updated} update, ${preview.deleted} delete.`,{modal:true},'Apply reviewed changes')!=='Apply reviewed changes'){result=null;break;}
            const report=await this.comparisons.apply(preview.token,controller.signal);if(report.error)this.log(new Error(`Comparison synchronization ${report.status}: ${report.error}`));result=report;preview=undefined;break;
          }
          default:throw new Error('Unavailable in the comparison editor.');
        }
      }
      await panel.webview.postMessage({version:1,id,result});
    }catch(e){this.log(e);await panel.webview.postMessage({version:1,id,error:{code:'COMPARISON_ERROR',message:errorMessage(e)}});}finally{if(owned)controller=undefined;if(readController)readers.delete(readController);if(disposed&&!controller)forget();}});
    panel.onDidDispose(()=>{disposed=true;controller?.abort();for(const r of readers)r.abort();if(!controller)forget();this.panels.delete(panel);this.initialized.delete(panel);});configureWebview(this.context,panel);
  }
  dispose(){for(const panel of this.panels)panel.dispose();void this.comparisons.dispose().catch(this.log);}
}
