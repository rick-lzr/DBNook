import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ProfileSchema} from '../../packages/protocol/src/index.js';
import {sqlTokens,sqlIdentifier} from '../../packages/core/src/sql-editing.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {DefinitionDocuments} from '../../packages/extension/src/definition-documents.js';
import type {SqlDocuments} from '../../packages/core/src/sql-documents.js';
import type {TableEditorProvider} from '../../packages/extension/src/table-editor.js';
export async function tableDefinitionChecks(api:{manager:ConnectionManager;definitionDocuments:DefinitionDocuments;sqlDocuments:SqlDocuments;tableEditors:TableEditorProvider},check:(s:string)=>void){
 const profile=ProfileSchema.parse({id:'native-table-definitions',name:'Native table definitions',driver:'sqlite',storage:'memory'});await api.manager.save(profile);const session=await api.manager.connect(profile.id);
 await session.query('CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT)');await session.query("INSERT INTO items(v) VALUES('before')");await session.query('CREATE INDEX value_idx ON items(v)');
 const node={profileId:profile.id,object:{name:'items',type:'table',sql:null}},until=async(fn:()=>boolean)=>{const end=Date.now()+15000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert(fn());};
 try{
  const uri=await vscode.commands.executeCommand<vscode.Uri>('dbWorkbench.openDefinition',node);assert(uri);let doc=await vscode.workspace.openTextDocument(uri);const original=doc.getText();let sql=original;
  for(const t of sqlTokens(original,'sqlite').filter(t=>['word','identifier'].includes(t.kind)&&sqlIdentifier(t.text)==='v').reverse())sql=sql.slice(0,t.start)+'"label"'+sql.slice(t.end);
  const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(doc.positionAt(0),doc.positionAt(original.length)),sql);assert(await vscode.workspace.applyEdit(edit));assert(await doc.save());
  await api.definitionDocuments.setColumnMappings(uri,[{from:'v',to:'label'}]);assert.deepEqual(JSON.parse(await readFile(uri.fsPath+'.json','utf8')).renames,[{from:'v',to:'label'}]);
  assert.match(doc.getText(),/^-- DB Workbench column renames:/);await vscode.window.showTextDocument(doc,{preview:false});await vscode.commands.executeCommand('undo');await until(()=>!doc.getText().includes('-- DB Workbench column renames:'));
  const unmapped=await api.definitionDocuments.preview(uri);assert.equal(unmapped.kind,'preview');if(unmapped.kind==='preview')assert(!unmapped.preview.steps.some(s=>/RENAME COLUMN/.test(s)));assert.equal((await session.query('SELECT v FROM items')).rows[0]?.c0,'before');
  await vscode.window.showTextDocument(doc,{preview:false});await vscode.commands.executeCommand('redo');await until(()=>doc.getText().includes('-- DB Workbench column renames:'));assert(await doc.save());
  check('Native SQL Undo/Redo changes column mapping configuration with the draft text and never applies a database change');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');doc=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(doc,{preview:false});
  const preview=await api.definitionDocuments.preview(uri);assert.equal(preview.kind,'preview');if(preview.kind==='preview')assert(preview.preview.steps.some(s=>/RENAME COLUMN "v" TO "label"/.test(s)));assert.match(vscode.window.activeTextEditor!.document.getText(),/PRAGMA foreign_keys=OFF/);assert.match(vscode.window.activeTextEditor!.document.getText(),/CHECK\(ok=1\)/);assert.equal((await session.query('SELECT v FROM items')).rows[0]?.c0,'before');
  check('Native table CREATE draft persists explicit rename mappings and opens a complete nonmutating rebuild SQL preview with validation');
  await vscode.commands.executeCommand('dbWorkbench.openTable',node);await until(()=>api.tableEditors.getDocuments().some(d=>d.model.profile.id===profile.id&&d.initialized.size>0));const grid=api.tableEditors.getDocuments().find(d=>d.model.profile.id===profile.id)!;
  api.tableEditors.update(grid,grid.model.state().revision,{keyColumns:['id'],added:[],edits:{r0:{kind:'update',original:grid.model.state().result.rows[0],values:{v:'unsaved'}}}});
  const blocked=await api.definitionDocuments.apply(uri);assert.equal(blocked.status,'failed');assert.match(blocked.error!,/Save or revert/);assert(grid.model.dirty);assert.equal((await session.query('SELECT v FROM items')).rows[0]?.c0,'before');
  await vscode.commands.executeCommand('workbench.action.files.revert');await until(()=>!grid.model.dirty);await api.definitionDocuments.preview(uri);const applied=await api.definitionDocuments.apply(uri);assert.equal(applied.status,'succeeded',applied.error);assert.equal((await session.query('SELECT label FROM items')).rows[0]?.c0,'before');assert(grid.model.details.columns.some(c=>c.name==='label'));assert.match(doc.getText(),/label/);assert.deepEqual(JSON.parse(await readFile(uri.fsPath+'.json','utf8')).renames,[]);
  const unchanged=await api.definitionDocuments.preview(uri);assert.equal(unchanged.kind,'preview');if(unchanged.kind==='preview')assert.equal(unchanged.preview.steps.length,0);
  check('Native table definition apply protects dirty grids, preserves mapped values, refreshes the open grid and updates canonical SQL without replaying renames');
 }finally{await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(profile.id);}
}
