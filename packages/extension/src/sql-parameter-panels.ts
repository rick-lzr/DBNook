import * as vscode from 'vscode';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import {WebEnvelopeSchema,errorMessage,type SqlParameterForm,type SqlParameterValue,type WorkbenchBoot} from '../../protocol/src/index.js';
import {renderSqlParameters} from '../../core/src/sql-parameters.js';
import {scriptSqlParameters} from '../../core/src/sql-script-parameters.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';

export class SqlParameterPanels implements vscode.Disposable{
 private panels=new Set<vscode.WebviewPanel>();private initialized=new Set<vscode.WebviewPanel>();
 private receivers=new Map<vscode.WebviewPanel,(raw:unknown)=>Promise<void>>();
 constructor(private context:vscode.ExtensionContext,private log:(error:unknown)=>void){}
 initializedViews(){return this.initialized.size;}
 current(){return [...this.panels].at(-1);}
 async dispatchForTest(panel:vscode.WebviewPanel,message:unknown){if(this.context.extensionMode!==vscode.ExtensionMode.Test)throw new Error('Only available during extension tests.');const receive=this.receivers.get(panel);if(!receive)throw new Error('Parameter form is no longer pending.');await receive(message);}
 request(form:SqlParameterForm,session:DriverSession,signal:AbortSignal):Promise<SqlParameterValue[]>{
  if(signal.aborted)return Promise.reject(Object.assign(new Error('SQL parameter input cancelled.'),{name:'AbortError'}));
  const panel=vscode.window.createWebviewPanel('dbWorkbench.sqlParameters',`Parameters · ${session.profile.name}`,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});this.panels.add(panel);
  return new Promise((resolve,reject)=>{
   let finished=false;const fail=()=>{if(finished)return;finished=true;reject(Object.assign(new Error('SQL parameter input cancelled. No pending statement was sent.'),{name:'AbortError'}));panel.dispose();};
   const scan=scriptSqlParameters(form.sql,session.profile.driver,session.sqlMode,false,form.delimiter),render=(values:SqlParameterValue[])=>renderSqlParameters(form.sql,scan,values,session.profile.driver,session.sqlMode);
   signal.addEventListener('abort',fail,{once:true});
   const receive=async(raw:unknown)=>{if(isWebviewDiagnostic(raw)||finished)return;let id='';try{
    const {request,...envelope}=WebEnvelopeSchema.parse(raw);id=envelope.id;
    if(request.method==='initialize'){this.initialized.add(panel);await panel.webview.postMessage({version:1,id,result:{view:'sql-parameters',profile:session.profile,sqlParameters:form} satisfies WorkbenchBoot});}
    else if(request.method==='parameters.cancel'){await panel.webview.postMessage({version:1,id,result:null});fail();}
    else if(request.method==='parameters.preview'){const sql=render(request.params.values);await panel.webview.postMessage({version:1,id,result:{sql:sql.slice(0,250000),truncated:sql.length>250000}});}
    else if(request.method==='parameters.submit'){render(request.params.values);await panel.webview.postMessage({version:1,id,result:null});if(!finished){finished=true;resolve(request.params.values);panel.dispose();}}
    else throw new Error('This view only accepts SQL parameter input.');
   }catch(error){this.log(error);await panel.webview.postMessage({version:1,id,error:{code:'PARAMETER_INPUT',message:errorMessage(error)}});}};
   this.receivers.set(panel,receive);panel.webview.onDidReceiveMessage(receive);
   panel.onDidDispose(()=>{this.receivers.delete(panel);this.panels.delete(panel);this.initialized.delete(panel);signal.removeEventListener('abort',fail);fail();});configureWebview(this.context,panel);
  });
 }
 dispose(){for(const p of this.panels)p.dispose();}
}
