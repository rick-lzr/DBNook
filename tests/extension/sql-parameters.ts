import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {ProfileSchema} from '../../packages/protocol/src/index.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {SqlDocuments} from '../../packages/core/src/sql-documents.js';
import type {SqlParameterPanels} from '../../packages/extension/src/sql-parameter-panels.js';
import {sqlParameters} from '../../packages/core/src/sql-parameters.js';

export async function sqlParameterChecks(api:{manager:ConnectionManager;sqlDocuments:SqlDocuments;parameterPanels:SqlParameterPanels},check:(s:string)=>void){
 const profile=ProfileSchema.parse({id:'native-parameters',name:'Native parameters',driver:'sqlite',storage:'memory'});await api.manager.save(profile);let serverId:string|undefined;
 const put=async(document:vscode.TextDocument,text:string)=>{const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);assert(await vscode.workspace.applyEdit(edit));assert(await document.save());};
 const format=async(document:vscode.TextDocument)=>{const edits=await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider',document.uri,{tabSize:2,insertSpaces:true});assert(edits?.length,'The native formatting provider must return edits');const edit=new vscode.WorkspaceEdit();edit.set(document.uri,edits);assert(await vscode.workspace.applyEdit(edit));assert(await document.save());};
 try{
  const session=await api.manager.connect(profile.id),sql="SELECT :{value||O'Reilly;你好||string}, :{id||9223372036854775807||number}",scan=sqlParameters(sql,'sqlite'),abort=new AbortController(),before=api.parameterPanels.initializedViews();
  const waiting=api.parameterPanels.request({sql,parameters:scan.parameters,values:scan.parameters.map(p=>({key:p.key,type:p.type,value:p.defaultValue??''}))},session,abort.signal),cancelled=assert.rejects(waiting,/cancelled/);
  const end=Date.now()+15000;while(api.parameterPanels.initializedViews()<=before&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert(api.parameterPanels.initializedViews()>before,'Parameter form must initialize under the actual VS Code CSP');abort.abort();await cancelled;
  check('Native SQL parameter form initializes under the packaged CSP and aborting input closes it without submitting SQL');
  const owner='native-parameter-submit.sql';await api.sqlDocuments.bind(owner,profile.id);const pending=api.sqlDocuments.run(owner,sql);let panel=api.parameterPanels.current();const pendingDeadline=Date.now()+15000;while(!panel&&Date.now()<pendingDeadline){await new Promise(r=>setTimeout(r,50));panel=api.parameterPanels.current();}assert(panel);
  const readyDeadline=Date.now()+15000;while(api.parameterPanels.initializedViews()<=before&&Date.now()<readyDeadline)await new Promise(r=>setTimeout(r,100));assert(api.parameterPanels.initializedViews()>before);
  await api.parameterPanels.dispatchForTest(panel,{version:1,id:'native-parameter-submit',request:{method:'parameters.submit',params:{values:scan.parameters.map(p=>({key:p.key,type:p.type,value:p.defaultValue??''}))}}});
  const submitted=await pending;assert.equal(submitted.status,'succeeded',submitted.error);assert.deepEqual(submitted.statements[0]?.result?.rows[0],{c0:"O'Reilly;你好",c1:{type:'integer',value:'9223372036854775807'}});assert.equal(api.parameterPanels.current(),undefined);await api.sqlDocuments.close(owner);
  check('Native parameter submission traverses the strict owned-panel RPC handler, closes the form and executes exact text/int64 values in the document session');
  api.sqlDocuments.configureParameters(async form=>form.values);await vscode.commands.executeCommand('dbWorkbench.newQuery',{profileId:profile.id});
  const editor=vscode.window.activeTextEditor!,doc=editor.document,source="SELECT :{text||O'Reilly;\n你好||string} AS value;\nSELECT 99;";await put(doc,source);editor.selection=new vscode.Selection(doc.positionAt(3),doc.positionAt(3));await vscode.commands.executeCommand('dbWorkbench.executeCurrent');
  const run=api.sqlDocuments.lastRun(doc.uri.toString());assert(run);assert.equal(run.status,'succeeded',run.error);assert.equal(run.statements.length,1);assert.equal(run.statements[0]?.result?.rows[0]?.c0,"O'Reilly;\n你好");assert.equal(run.sql,source.slice(0,source.indexOf('\nSELECT 99;')));
  check('Native execute-current preserves parameter defaults containing quotes, semicolons and newlines while excluding adjacent statements');
  await put(doc,"select :{code||0001||||opaque} as code,'left\nright' as value,9223372036854775807 as big");const original=await api.sqlDocuments.execute(doc.uri.toString(),doc.getText());await format(doc);assert.match(doc.getText(),/SELECT/);assert.ok(doc.getText().includes(':{code||0001||||opaque}'));assert.deepEqual((await api.sqlDocuments.execute(doc.uri.toString(),doc.getText())).rows,original.rows);assert.equal(original.rows[0]?.c0,'0001');
  check('Native formatter preserves parameter metadata, leading-zero String defaults and multiline literal values in actual SQLite execution');
  await put(doc,'SELECT :{account||1||number}, :acc');const position=doc.positionAt(doc.getText().length),completion=await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',doc.uri,position);const item=completion?.items.find(i=>i.label===':account');assert(item);assert.equal(item.kind,vscode.CompletionItemKind.Variable);assert(item.range instanceof vscode.Range);assert.equal(doc.getText(item.range),'acc');assert.equal(item.insertText,'account');
  check('Native completion provides parameter names as variables with exact replacement ranges through the SQL worker');
  if(process.env.DBW_MYSQL_PORT){
   const p=ProfileSchema.parse({id:'native-parameter-mode',name:'Native parameter mode',driver:process.env.DBW_TEST_ENGINE==='mariadb'?'mariadb':'mysql',storage:'server',host:'localhost',port:Number(process.env.DBW_MYSQL_PORT),database:'dbworkbench',user:'dbw',sslMode:'verify-full',caPath:process.env.DBW_MYSQL_CA});serverId=p.id;await api.manager.save(p);await api.manager.setPassword(p.id,process.env.DBW_MYSQL_PASSWORD!,'session');await vscode.commands.executeCommand('dbWorkbench.newQuery',{profileId:p.id});const document=vscode.window.activeTextEditor!.document,owner=document.uri.toString();await api.sqlDocuments.execute(owner,"SET sql_mode='NO_BACKSLASH_ESCAPES,ANSI_QUOTES'");await put(document,String.raw`select '\' as value, :{code||0001||||opaque} as code`);const before=await api.sqlDocuments.execute(owner,document.getText());await format(document);const after=await api.sqlDocuments.execute(owner,document.getText());assert.deepEqual(after.rows,before.rows);assert.equal(after.rows[0]?.c0,'\\');assert.equal(after.rows[0]?.c1,'0001');
   check('Native MySQL formatter uses the actual document-session SQL mode and preserves backslashes and String parameters under strict TLS');
  }
 }finally{
  api.sqlDocuments.configureParameters((form,session,signal)=>api.parameterPanels.request(form,session,signal),()=>vscode.workspace.getConfiguration('dbWorkbench').get('sqlParameters.enabled',true));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(profile.id);if(serverId)await api.manager.remove(serverId);
 }
}
