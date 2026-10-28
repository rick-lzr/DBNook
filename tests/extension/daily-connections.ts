import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {driverNames} from '../../packages/protocol/src/index.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {ConnectionsTree} from '../../packages/extension/src/tree.js';

/** Native entry/CSP evidence complements the separately recorded browser form inputs and database readback. */
export async function connectionEditorEntryChecks(api:{manager:ConnectionManager;tree:ConnectionsTree;initializedViews():number},check:(message:string)=>void,id?:string){
 const before=api.initializedViews(),profiles=api.manager.profiles().length;
 if(id){
  const node=(await api.tree.getChildren()).find(node=>node.profileId===id);assert(node);
  await vscode.commands.executeCommand('dbWorkbench.editConnection',node);
 }else await vscode.commands.executeCommand('dbWorkbench.addConnection');
 const deadline=Date.now()+15000;
 while(api.initializedViews()<=before&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
 assert(api.initializedViews()>before,'Connection editor initialization RPC did not complete under native CSP');
 assert.equal(api.manager.profiles().length,profiles,'Opening a connection editor must not save a profile');
 check(id?`${driverNames[api.manager.profile(id).driver]} native Edit Connection initializes under actual Webview CSP without changing saved profiles`:
  'Native Add Connection initializes under actual Webview CSP without creating a profile');
 await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}
