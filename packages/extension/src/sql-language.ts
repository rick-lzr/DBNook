import * as vscode from 'vscode';
import type {ConnectionManager} from '../../core/src/connections.js';
import type {SqlDocuments} from '../../core/src/sql-documents.js';
import type {CompletionObject,SqlSuggestion} from '../../core/src/sql-completion.js';
import type {SqlSource} from '../../core/src/sql-editing.js';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import {SqlWorkerClient} from './sql-worker-client.js';

/** Parsing/formatting runs outside the extension host; metadata remains on the selected connection. */
export class SqlLanguage implements vscode.Disposable{
  private worker:SqlWorkerClient;
  private cache=new Map<string,{key:string;at:number;objects:CompletionObject[]}>();
  private subscriptions:vscode.Disposable[]=[];
  constructor(context:vscode.ExtensionContext,private manager:ConnectionManager,private documents:SqlDocuments,private log:(error:unknown)=>void){
    this.worker=new SqlWorkerClient(vscode.Uri.joinPath(context.extensionUri,'dist','sql-worker.cjs').fsPath);
    this.subscriptions.push(vscode.languages.registerCompletionItemProvider({language:'sql'},{provideCompletionItems:(doc,pos,token)=>this.complete(doc,pos,token)},'.','"','`',':','$','&','{'));
    this.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider({language:'sql'},{provideDocumentFormattingEdits:(doc,options,token)=>this.format(doc,undefined,options,token)}));
    this.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider({language:'sql'},{provideDocumentRangeFormattingEdits:(doc,range,options,token)=>this.format(doc,range,options,token)}));
  }
  invalidate(id?:string){if(id)this.cache.delete(id);else this.cache.clear();}
  private profile(doc:vscode.TextDocument){
    const id=this.documents.connection(doc.uri.toString())||vscode.workspace.getConfiguration('dbWorkbench',doc.uri).get<string>('defaultConnection');
    return this.manager.profiles().find(p=>p.id===id);
  }
  async current(doc:vscode.TextDocument,offset:number):Promise<SqlSource|undefined>{
    const profile=this.profile(doc);if(!profile)throw new Error('Select a connection for this SQL document first.');
    const session=this.manager.documentSession(doc.uri.toString())??await this.manager.connect(profile.id);
    return this.worker.request('current',{text:doc.getText(),offset,driver:profile.driver,mode:session.sqlMode,parameters:this.documents.parametersEnabled});
  }
  private async metadata(id:string,session:DriverSession){
    const key=this.manager.editorRevision(id)+session.id,entry=this.cache.get(id);
    if(entry?.key===key&&Date.now()-entry.at<30000)return entry;
    const objects=(await session.schema()).slice(0,5000).map(o=>({...o,columns:o.columns?.slice(0,2000)}));
    const next={key,at:Date.now(),objects};this.cache.set(id,next);return next;
  }
  private async complete(doc:vscode.TextDocument,pos:vscode.Position,token:vscode.CancellationToken){
    if(!vscode.workspace.isTrusted||doc.getText().length>200000)return [];
    const profile=this.profile(doc);if(!profile)return [];
    const version=doc.version,revision=this.manager.editorRevision(profile.id);
    const stale=()=>token.isCancellationRequested||doc.isClosed||doc.version!==version||this.profile(doc)?.id!==profile.id||this.manager.editorRevision(profile.id)!==revision;
    try{
      const session=await this.manager.connect(profile.id);if(stale())return [];
      const entry=await this.metadata(profile.id,session);if(stale())return [];
      const params={text:doc.getText(),offset:doc.offsetAt(pos),driver:profile.driver,objects:entry.objects,mode:this.manager.documentSession(doc.uri.toString())?.sqlMode??session.sqlMode,parameters:this.documents.parametersEnabled};
      let result=await this.worker.request<{items:SqlSuggestion[];needs:string[]}>('completion',params);if(stale())return [];
      for(const name of result.needs){const object=entry.objects.find(o=>o.name===name);if(object&&!object.columns){object.columns=(await session.details(name)).columns.slice(0,2000);if(stale())return [];}}
      if(result.needs.length)result=await this.worker.request('completion',params);if(stale())return [];
      return result.items.map(s=>{const item=new vscode.CompletionItem(s.label,{table:vscode.CompletionItemKind.Class,column:vscode.CompletionItemKind.Field,keyword:vscode.CompletionItemKind.Keyword,schema:vscode.CompletionItemKind.Module,parameter:vscode.CompletionItemKind.Variable}[s.kind]);item.insertText=s.insert;item.detail=s.detail;item.range=new vscode.Range(doc.positionAt(s.start),doc.positionAt(s.end));return item;});
    }catch(error){if(!stale())this.log(error);return [];}
  }
  async format(doc:vscode.TextDocument,range:vscode.Range|undefined,options:vscode.FormattingOptions,token:vscode.CancellationToken):Promise<vscode.TextEdit[]>{
    if(!vscode.workspace.isTrusted)return [];
    const profile=this.profile(doc);if(!profile)return [];
    const version=doc.version,revision=this.manager.editorRevision(profile.id),source=doc.getText(range);
    try{
      const configured=vscode.workspace.getConfiguration('dbWorkbench',doc.uri).get<Record<string,unknown>>('formatting',{});
      const mode=profile.driver==='mysql'||profile.driver==='mariadb'?(this.manager.documentSession(doc.uri.toString())??await this.manager.connect(profile.id)).sqlMode:undefined;
      if(token.isCancellationRequested||doc.isClosed||doc.version!==version||this.profile(doc)?.id!==profile.id||this.manager.editorRevision(profile.id)!==revision)return [];
      const formatted=await this.worker.request<string>('format',{text:source,driver:profile.driver,options:{tabWidth:options.tabSize,useTabs:!options.insertSpaces,...configured},eol:doc.eol===vscode.EndOfLine.CRLF?'\r\n':'\n',parameters:this.documents.parametersEnabled,mode,selection:range?{text:doc.getText(),start:doc.offsetAt(range.start),end:doc.offsetAt(range.end)}:undefined});
      if(token.isCancellationRequested||doc.isClosed||doc.version!==version||this.profile(doc)?.id!==profile.id||this.manager.editorRevision(profile.id)!==revision)return [];
      return formatted===source?[]:[vscode.TextEdit.replace(range??new vscode.Range(doc.positionAt(0),doc.positionAt(source.length)),formatted)];
    }catch(error){this.log(error);void vscode.window.showWarningMessage(`DBNook formatting: ${error instanceof Error?error.message:String(error)}`);return [];}
  }
  dispose(){this.worker.dispose();for(const s of this.subscriptions)s.dispose();this.cache.clear();}
}
