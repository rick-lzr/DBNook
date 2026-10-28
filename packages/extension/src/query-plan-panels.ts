import * as vscode from 'vscode';
import type {ConnectionManager} from '../../core/src/connections.js';
import {WebEnvelopeSchema,errorMessage,type QueryPlanReport,type PlanProposal,type WorkbenchBoot} from '../../protocol/src/index.js';
import type {QueryPlans} from '../../core/src/query-plans.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';
export class QueryPlanPanels implements vscode.Disposable{
 private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
 private reviews=new Map<string,{proposal:PlanProposal;sourceVersion:number}>();private subscriptions:vscode.Disposable[]=[];
 constructor(private context:vscode.ExtensionContext,private manager:ConnectionManager,private plans:QueryPlans,private log:(e:unknown)=>void){
  this.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('dbw-plan',{provideTextDocumentContent:uri=>{const r=this.reviews.get(uri.toString());if(!r)throw new Error('Plan review closed or expired.');const safe=(s:string)=>s.replace(/[\r\n\u2028\u2029]/g,' ');return `-- ANALYZE EXECUTES THE STATEMENT. Review, then use Execute Reviewed Analysis.\n-- ${safe(r.proposal.connection)} / ${r.proposal.driver} ${safe(r.proposal.serverVersion)}\n${r.proposal.context.map(c=>'-- '+safe(c.name)+': '+safe(c.value)).join('\n')}\n-- Transaction: ${r.proposal.transaction}. No automatic commit or rollback.\n-- Review expires: ${r.proposal.expiresAt}\n\n${r.proposal.executedSql}`;}}),vscode.workspace.onDidCloseTextDocument(doc=>{const r=this.reviews.get(doc.uri.toString());if(r){this.plans.forget(r.proposal.token);this.reviews.delete(doc.uri.toString());}}));
 }
 async review(proposal:PlanProposal,sourceVersion:number){const uri=vscode.Uri.parse(`dbw-plan:/${proposal.token}.sql`);this.reviews.set(uri.toString(),{proposal,sourceVersion});await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:false});return uri;}
 currentReview(){const uri=vscode.window.activeTextEditor?.document.uri;return uri?this.reviews.get(uri.toString()):undefined;}
 initializedViews(){return this.initialized.size;}
 open(report:QueryPlanReport){
  const profile={...this.manager.profile(report.profileId)},panel=vscode.window.createWebviewPanel('dbWorkbench.queryPlan',`${report.mode==='analyze'?'Analyze':'Explain'} · ${report.connection}`,vscode.ViewColumn.Beside,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);
  panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='';try{const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;let result:unknown=null;
   if(envelope.request.method==='initialize'){result={view:'query-plan',profile,queryPlan:report} satisfies WorkbenchBoot;this.initialized.add(panel);}
   else if(envelope.request.method==='plan.action'){
    switch(envelope.request.params.action){
     case 'source':await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(report.owner)),{preview:false});break;
     case 'copy':await vscode.env.clipboard.writeText(report.raw);break;
     case 'export':{const uri=await vscode.window.showSaveDialog({title:'Export frozen execution plan',defaultUri:vscode.Uri.joinPath(this.context.globalStorageUri,`plan-${report.id}.json`),filters:{'Execution plan':['json']}});if(uri)await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify(report,null,2)));break;}
    }
   }else throw new Error('Unavailable in the frozen execution plan view.');await panel.webview.postMessage({version:1,id,result});
  }catch(error){this.log(error);await panel.webview.postMessage({version:1,id,error:{code:'PLAN_ERROR',message:errorMessage(error)}});}});
  panel.onDidDispose(()=>{this.panels.delete(panel);this.initialized.delete(panel);});configureWebview(this.context,panel);return panel;
 }
 dispose(){for(const p of this.panels)p.dispose();for(const s of this.subscriptions)s.dispose();for(const r of this.reviews.values())this.plans.forget(r.proposal.token);this.reviews.clear();}
}
