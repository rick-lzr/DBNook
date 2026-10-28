import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ProfileSchema} from '../../packages/protocol/src/index.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {DatabaseDefinitions} from '../../packages/core/src/database-definitions.js';
import type {DefinitionDocuments} from '../../packages/extension/src/definition-documents.js';
import type {SqlDocuments} from '../../packages/core/src/sql-documents.js';
export async function definitionChecks(api:{manager:ConnectionManager;databaseDefinitions:DatabaseDefinitions;definitionDocuments:DefinitionDocuments;sqlDocuments:SqlDocuments},check:(s:string)=>void){
 const p=ProfileSchema.parse({id:'native-definitions',name:'Native definitions',driver:'sqlite',storage:'memory'});await api.manager.save(p);const s=await api.manager.connect(p.id);
 await s.query('CREATE TABLE source(id INT,v TEXT)');await s.query("INSERT INTO source VALUES(1,'before')");await s.query('CREATE VIEW source_view AS SELECT id,v FROM source');
 try{
  const ref=(await api.databaseDefinitions.list(p.id)).find(r=>r.name==='source_view')!;
  const uri=await vscode.commands.executeCommand<vscode.Uri>('dbWorkbench.openDefinition',{profileId:p.id,object:{name:'source_view',type:'view',sql:null}});assert(uri);const doc=await vscode.workspace.openTextDocument(uri);assert.equal(doc.languageId,'sql');assert.equal(api.sqlDocuments.connection(uri.toString()),p.id);assert.equal(JSON.parse(await readFile(uri.fsPath+'.json','utf8')).baseline.ref.name,ref.name);
  const edit=async(text:string)=>{const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text);assert(await vscode.workspace.applyEdit(edit));};
  await edit(doc.getText().replace('SELECT id,v','SELECT id,upper(v) AS v'));await doc.save();
  const result=await vscode.commands.executeCommand<{kind:string}>('dbWorkbench.previewDefinition',uri);assert.equal(result?.kind,'preview');assert.equal(vscode.window.activeTextEditor?.document.uri.scheme,'dbw-definition');assert.match(vscode.window.activeTextEditor!.document.getText(),/BEGIN IMMEDIATE/);assert.equal((await s.query('SELECT v FROM source_view')).rows[0]?.c0,'before');
  check('Managed object definition opens a bound native SQL draft and a read-only SQL preview without mutating SQLite');
  await edit(doc.getText()+'\n-- changed after review\n');await assert.rejects(api.definitionDocuments.apply(uri),/draft changed/);await api.definitionDocuments.preview(uri);const report=await api.definitionDocuments.apply(uri);assert.equal(report.status,'succeeded',report.error);assert.equal((await s.query('SELECT v FROM source_view')).rows[0]?.c0,'BEFORE');
  check('Native definition workflow requires a fresh preview for edited drafts, then applies and refreshes the persisted server baseline');
  await doc.save();await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const reopened=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(reopened,{preview:false});assert.equal((await api.definitionDocuments.preview(uri)).kind,'preview');
  await s.query('DROP VIEW source_view');await s.query("CREATE VIEW source_view AS SELECT id,'external' AS v FROM source");const conflict=await api.definitionDocuments.preview(uri);assert.equal(conflict.kind,'conflict');
  const diffs=vscode.window.tabGroups.all.flatMap(g=>g.tabs).filter(t=>t.input instanceof vscode.TabInputTextDiff);assert(diffs.length>0);assert.match(reopened.getText(),/upper\(v\)/);
  if(conflict.kind!=='conflict'||!conflict.current)throw new Error('Expected current server conflict');await api.definitionDocuments.acceptServer(uri,conflict.current.fingerprint);assert.equal((await s.query('SELECT v FROM source_view')).rows[0]?.c0,'external');const applied=await api.definitionDocuments.apply(uri);assert.equal(applied.status,'succeeded',applied.error);assert.equal((await s.query('SELECT v FROM source_view')).rows[0]?.c0,'BEFORE');
  check('Closed definition drafts reload their metadata; external DDL opens a native diff and explicit baseline acceptance preserves the draft until apply');
 }finally{await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(p.id);}
}
