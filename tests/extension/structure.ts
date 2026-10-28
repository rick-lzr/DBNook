import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {DdlIntentSchema,ProfileSchema} from '../../packages/protocol/src/index.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {SchemaChanges} from '../../packages/core/src/schema-changes.js';
import type {TableEditorProvider} from '../../packages/extension/src/table-editor.js';
export async function structureChecks(api:{manager:ConnectionManager;schemaChanges:SchemaChanges;tableEditors:TableEditorProvider;initializedViews():number},check:(s:string)=>void){
  const p=ProfileSchema.parse({id:'native-structure',name:'Native table structure',driver:'sqlite',storage:'memory'});await api.manager.save(p);const session=await api.manager.connect(p.id);await session.query('CREATE TABLE items(id INTEGER PRIMARY KEY,v TEXT)');await session.query("INSERT INTO items VALUES(1,'preserved')");
  const until=async(fn:()=>boolean)=>{const end=Date.now()+15000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert(fn());};
  const object=(await session.schema())[0]!,node={profileId:p.id,object};const cancellation=new vscode.CancellationTokenSource();
  try{
    const before=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.tableStructure',node);await until(()=>api.initializedViews()>before);check('Native table structure command loads the React designer under actual Webview CSP');
    const preview=await api.schemaChanges.preview(p.id,'items',DdlIntentSchema.parse({action:'alterColumn',column:'v',change:'type',value:'VARCHAR(80)'}));assert.equal((await session.details('items')).columns[1]?.dataType,'TEXT');assert.match(preview.steps[0]!.sql,/CREATE TABLE/);
    await vscode.commands.executeCommand('dbWorkbench.openTable',node);await until(()=>api.tableEditors.getDocuments().some(d=>d.model.profile.id===p.id&&d.initialized.size>0));const doc=api.tableEditors.getDocuments().find(d=>d.model.profile.id===p.id)!;
    api.tableEditors.update(doc,doc.model.state().revision,{keyColumns:['id'],added:[],edits:{r0:{kind:'update',original:doc.model.state().result.rows[0],values:{v:'unsaved'}}}});
    const blocked=await api.schemaChanges.apply(p.id,preview.token);assert.equal(blocked.status,'failed');assert.match(blocked.error!,/Save or revert/);assert(doc.model.dirty);assert.equal((await session.query('SELECT v FROM items')).rows[0]?.c0,'preserved');
    await vscode.commands.executeCommand('workbench.action.files.revert');const applied=await api.schemaChanges.apply(p.id,preview.token);assert.equal(applied.status,'succeeded',applied.error);assert.equal((await session.details('items')).columns[1]?.dataType,'VARCHAR(80)');assert.equal(doc.model.details.columns[1]?.dataType,'VARCHAR(80)');assert.equal(doc.model.state().busy,false);assert.equal((await session.query('SELECT v FROM items')).rows[0]?.c0,'preserved');check('Reviewed structure SQL protects dirty grids, preserves rows and refreshes the open native grid after SQLite rebuild');
    const views=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.createTable',{profileId:p.id});await until(()=>api.initializedViews()>views);check('Native Create Table opens a separate designer and completes its initialization RPC');
  }finally{cancellation.dispose();await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(p.id);}
}
