import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {ProfileSchema} from '../../packages/protocol/src/index.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {SqlDocuments} from '../../packages/core/src/sql-documents.js';
import {QueryHistory} from '../../packages/core/src/query-history.js';
export async function sqlEditingChecks(api:{manager:ConnectionManager;sqlDocuments:SqlDocuments;history:QueryHistory},check:(message:string)=>void){
  const config=vscode.workspace.getConfiguration('dbWorkbench'),previous=config.inspect<boolean>('history.enabled')?.globalValue;
  const profile=ProfileSchema.parse({id:'native-sql-editing',name:'Native SQL editing',driver:'sqlite',storage:'memory'});
  await api.manager.save(profile);const session=await api.manager.connect(profile.id);
  await session.query('CREATE TABLE teams(id INTEGER PRIMARY KEY,name TEXT)');await session.query("INSERT INTO teams VALUES(1,'a;中文')");
  const change=async(document:vscode.TextDocument,text:string,offset=0)=>{const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);assert(await vscode.workspace.applyEdit(edit));assert(await document.save());const editor=await vscode.window.showTextDocument(document,{preview:false});editor.selection=new vscode.Selection(document.positionAt(offset),document.positionAt(offset));return editor;};
  try{
    await config.update('history.enabled',false,vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('dbWorkbench.newQuery',{profileId:profile.id});const document=vscode.window.activeTextEditor!.document,owner=document.uri.toString();
    const sql="INSERT INTO teams VALUES(99,'must not run');\nSELECT 'wanted;中文';\nDELETE FROM teams;";
    await change(document,sql,sql.indexOf('wanted'));
    await vscode.commands.executeCommand('dbWorkbench.executeCurrent');const run=api.sqlDocuments.lastRun(owner);assert.equal(run?.status,'succeeded');assert.equal(run.statements.length,1);assert.equal(run.statements[0]?.result?.rows[0]?.c0,'wanted;中文');assert.equal(run.sourceOffset,sql.indexOf('SELECT'));assert.equal((await session.query('SELECT count(*) FROM teams')).rows[0]?.c0,1);
    assert.equal((await api.history.list({profileId:profile.id})).length,0);check('Current statement command executes only the cursor statement and default-disabled history captures nothing');
    const completionSql='SELECT t.na FROM teams t';await change(document,completionSql,completionSql.indexOf('.na')+3);
    const completions=await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',document.uri,document.positionAt(completionSql.indexOf('.na')+3));
    assert(completions.items.some(i=>i.label==='name'&&i.insertText==='"name"'));check('Native completion provider returns actual SQLite columns for a table alias through the worker');
    await change(document,"select id,name from teams where name='a;中文'");
    const edits=await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider',document.uri,{tabSize:2,insertSpaces:true});assert(edits.length>0);assert.match(edits[0]!.newText,/SELECT/);
    const formatEdit=new vscode.WorkspaceEdit();formatEdit.set(document.uri,edits);assert(await vscode.workspace.applyEdit(formatEdit));assert(await document.save());
    const formatted=await api.sqlDocuments.run(owner,document.getText());assert.equal(formatted.status,'succeeded');assert.equal(formatted.statements[0]?.result?.rows[0]?.c1,'a;中文');check('Native formatting provider uses the connection dialect and its formatted SQL executes with unchanged literal values');
    await config.update('history.enabled',true,vscode.ConfigurationTarget.Global);await api.sqlDocuments.run(owner,"SELECT 'history;中文';");
    const entries=await api.history.list({profileId:profile.id});assert.equal(entries.length,1);assert.equal(entries[0]!.status,'succeeded');
    const fresh=new QueryHistory(api.history.directory,()=>({enabled:true,recordsPerDatabase:1000,logFailedQueries:true}));assert.equal((await fresh.sql(entries[0]!.id)).sql,"SELECT 'history;中文';");
    const reopened=await vscode.commands.executeCommand<string>('dbWorkbench.history.open',entries[0]!.id);assert(reopened);assert.equal(api.sqlDocuments.connection(reopened),profile.id);assert.equal(api.sqlDocuments.lastRun(reopened),undefined);assert.equal(vscode.window.activeTextEditor?.document.getText(),"SELECT 'history;中文';");
    await vscode.commands.executeCommand('dbWorkbench.history.delete',entries[0]!.id);assert.equal((await fresh.list({profileId:profile.id})).length,0);check('Opt-in history persists SQL across service instances, reopens bound scratch without execution and deletes its local entry');
  }finally{await config.update('history.enabled',previous,vscode.ConfigurationTarget.Global);await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(profile.id);}
}
