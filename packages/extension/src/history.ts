import * as vscode from 'vscode';
import {QueryHistory,historyTarget,type HistoryEntry} from '../../core/src/query-history.js';
import type {ConnectionManager} from '../../core/src/connections.js';
import type {SqlDocuments} from '../../core/src/sql-documents.js';
type HistoryNode={kind:'connection';id:string;name:string}|{kind:'database';id:string;name:string}|{kind:'entry';entry:HistoryEntry};
export class HistoryTree implements vscode.TreeDataProvider<HistoryNode>,vscode.Disposable{
  private event=new vscode.EventEmitter<HistoryNode|undefined>();readonly onDidChangeTreeData=this.event.event;
  search='';
  constructor(private history:QueryHistory,private enabled:()=>boolean){}
  refresh(){this.event.fire(undefined);}
  async getChildren(node?:HistoryNode):Promise<HistoryNode[]>{
    if(!this.enabled())return [];
    const entries=await this.history.list({profileId:node?.kind==='connection'||node?.kind==='database'?node.id:undefined,database:node?.kind==='database'?node.name:undefined,search:this.search});
    if(!node)return [...new Map(entries.map(e=>[e.profileId,{kind:'connection' as const,id:e.profileId,name:e.profileName}])).values()];
    if(node.kind==='connection')return [...new Set(entries.map(e=>e.database))].map(name=>({kind:'database',id:node.id,name}));
    return entries.map(entry=>({kind:'entry',entry}));
  }
  getTreeItem(node:HistoryNode){
    if(node.kind!=='entry'){const item=new vscode.TreeItem(node.name||'(default)',vscode.TreeItemCollapsibleState.Collapsed);item.iconPath=new vscode.ThemeIcon('database');return item;}
    const e=node.entry,item=new vscode.TreeItem(e.preview,vscode.TreeItemCollapsibleState.None);
    item.id=e.id;item.contextValue='queryHistory';item.description=`${new Date(e.startedAt).toLocaleString()} · ${e.status} · ${e.durationMs} ms`;
    item.tooltip=`${e.preview}\n${e.driver} · ${e.database}\n${e.statements} statement/result records · ${e.rows} loaded rows · ${e.affectedRows} affected${e.truncated?' · truncated':''}${e.error?'\n'+e.error:''}`;
    item.command={command:'dbWorkbench.history.open',title:'Open SQL',arguments:[e.id]};item.iconPath=new vscode.ThemeIcon(e.status==='succeeded'?'pass':'error');return item;
  }
  dispose(){this.event.dispose();}
}
export function registerHistory(context:vscode.ExtensionContext,history:QueryHistory,tree:HistoryTree,manager:ConnectionManager,documents:SqlDocuments,register:(name:string,fn:(...args:any[])=>unknown)=>void){
  const id=(value:string|HistoryNode)=>typeof value==='string'?value:value.kind==='entry'?value.entry.id:(()=>{throw new Error('Select a query history entry.');})();
  register('history.enable',()=>vscode.workspace.getConfiguration('dbWorkbench').update('history.enabled',true,vscode.ConfigurationTarget.Global));
  register('history.disable',()=>vscode.workspace.getConfiguration('dbWorkbench').update('history.enabled',false,vscode.ConfigurationTarget.Global));
  register('history.refresh',()=>tree.refresh());
  register('history.search',async()=>{const search=await vscode.window.showInputBox({title:'Search Query History',prompt:'Search SQL previews, connections, databases and errors. Empty clears the filter.',value:tree.search});if(search!==undefined){tree.search=search;tree.refresh();}});
  register('history.copy',async(value:string|HistoryNode)=>vscode.env.clipboard.writeText((await history.sql(id(value))).sql));
  register('history.open',async(value:string|HistoryNode)=>{
    const {entry,sql}=await history.sql(id(value)),profile=manager.profiles().find(p=>p.id===entry.profileId);
    if(!profile||historyTarget(profile)!==entry.target)throw new Error('The original connection was removed or its target changed. Use Copy SQL to choose a target explicitly.');
    const dir=vscode.Uri.joinPath(context.globalStorageUri,'scratch');await vscode.workspace.fs.createDirectory(dir);
    const uri=vscode.Uri.joinPath(dir,`history-${entry.id}-${Date.now()}.sql`);await vscode.workspace.fs.writeFile(uri,Buffer.from(sql));
    const document=await vscode.workspace.openTextDocument(uri);await documents.bind(uri.toString(),profile.id);await vscode.window.showTextDocument(document,{preview:false});return uri.toString();
  });
  register('history.delete',async(value:string|HistoryNode)=>history.remove(id(value)));
  register('history.clear',async()=>{if(await vscode.window.showWarningMessage('Delete all local query history SQL and summaries?',{modal:true},'Delete History')==='Delete History')await history.clear();});
}
