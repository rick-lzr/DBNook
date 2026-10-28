import * as vscode from 'vscode';
import type {ConnectionManager} from '../../core/src/connections.js';
import type {Comparisons} from '../../core/src/comparisons.js';
import {Combinations} from '../../core/src/combinations.js';
import {WebEnvelopeSchema,errorMessage,type CombinationSource,type WorkbenchBoot} from '../../protocol/src/index.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';
export class CombinationPanels implements vscode.Disposable {
  private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
  constructor(private context:vscode.ExtensionContext,private manager:ConnectionManager,private captures:Comparisons,readonly combinations:Combinations,private log:(e:unknown)=>void){}
  initializedViews(){return this.initialized.size;}
  async open(operation:'join'|'union',sources:CombinationSource[]=[]){
    const profile=this.manager.profiles()[0];if(!profile)throw new Error('Add a connection before combining datasets.');
    const panel=vscode.window.createWebviewPanel('dbWorkbench.combination',operation==='join'?'Join datasets':'Union datasets',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);const owned=new Set<string>(),readers=new Set<AbortController>();let controller:AbortController|undefined;
    panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='',reader:AbortController|undefined,exclusive=false;try{
      const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before reading databases.');const request=envelope.request;let result:unknown;
      const own=(id:string)=>{if(!owned.has(id))throw new Error('Create this combined result in the current editor first.');return id;};
      if(request.method==='combine.cancel'){controller?.abort();result=null;}
      else if(request.method==='combine.run'){if(controller)throw new Error('Wait for the current combination.');controller=new AbortController();exclusive=true;const summary=await this.combinations.run(request.params,controller.signal);owned.add(summary.id);result=summary;}
      else {reader=new AbortController();readers.add(reader);switch(request.method){
        case 'initialize':result={view:'combination',profile,combination:{operation,sources,limit:Math.min(100000,Math.max(1,vscode.workspace.getConfiguration('dbWorkbench').get('queryRowLimit',100000)))}} satisfies WorkbenchBoot;this.initialized.add(panel);break;
        case 'combine.catalog':result=this.combinations.catalog();break;
        case 'compare.clearResults':this.captures.clearResults();result=this.combinations.catalog();break;
        case 'compare.objects':result=await this.captures.objects(request.params.profileId);break;
        case 'combine.describe':result=await this.combinations.describe(request.params.source,reader.signal);break;
        case 'combine.page':result=this.combinations.page(own(request.params.id),request.params.offset,request.params.columnOffset);break;
        case 'combine.lineage':result=this.combinations.lineage(own(request.params.id));break;
        case 'combine.forget':this.combinations.forget(own(request.params.id));owned.delete(request.params.id);result=null;break;
        case 'combine.export':{const content=this.combinations.export(own(request.params.id),request.params.format),uri=await vscode.window.showSaveDialog({title:'Export captured combined result',filters:{[request.params.format.toUpperCase()]:[request.params.format]},defaultUri:vscode.Uri.file('combined-result.'+request.params.format)});if(uri)await vscode.workspace.fs.writeFile(uri,Buffer.from(content));result=uri?.toString()??null;break;}
        default:throw new Error('Unavailable in the Join/Union editor.');
      }}await panel.webview.postMessage({version:1,id,result});
    }catch(e){this.log(e);await panel.webview.postMessage({version:1,id,error:{code:'COMBINATION_ERROR',message:errorMessage(e)}});}finally{if(exclusive)controller=undefined;if(reader)readers.delete(reader);}});
    panel.onDidDispose(()=>{controller?.abort();for(const r of readers)r.abort();this.panels.delete(panel);this.initialized.delete(panel);});configureWebview(this.context,panel);
  }
  dispose(){for(const p of this.panels)p.dispose();void this.combinations.dispose().catch(this.log);}
}
