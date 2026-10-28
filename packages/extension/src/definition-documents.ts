import * as vscode from 'vscode';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {mkdir,readFile,writeFile,stat,rename,unlink} from 'node:fs/promises';
import {z} from 'zod';
import {DefinitionSnapshotSchema,type DefinitionRef,type DefinitionSnapshot,type DefinitionPreview,type DefinitionReport} from '../../protocol/src/index.js';
import type {ConnectionManager} from '../../core/src/connections.js';
import type {SqlDocuments} from '../../core/src/sql-documents.js';
import {DatabaseDefinitions} from '../../core/src/database-definitions.js';
import {definitionDocument} from '../../core/src/definition-sql.js';
import {parseTableScript,columnNameKey} from '../../core/src/table-script.js';
import {sqlTokens} from '../../core/src/sql-editing.js';
import {validateColumnRenames} from '../../core/src/sqlite-table-migration.js';
import type {DdlIntent} from '../../protocol/src/ddl.js';

const RenameSchema=z.array(z.object({from:z.string().min(1).max(255),to:z.string().min(1).max(255)}).strict()).max(256);
const RecordSchema=z.object({version:z.literal(1),baseline:DefinitionSnapshotSchema,renames:RenameSchema.default([])}).strict();
const mappingPrefix='-- DB Workbench column renames: ';
/** Native SQL drafts are persistent files; review/diff contents are read-only virtual documents. */
export class DefinitionDocuments implements vscode.Disposable,vscode.TextDocumentContentProvider{
  private records=new Map<string,DefinitionSnapshot>();private plans=new Map<string,{preview:DefinitionPreview;text:string}>();
  private contents=new Map<string,{text:string;source:string}>();private disposables:vscode.Disposable[]=[];
  private root:string;
  private cache(owner:string,baseline:DefinitionSnapshot){this.records.set(owner,baseline);while(this.records.size>20||this.records.size>1&&[...this.records.values()].reduce((n,b)=>n+Buffer.byteLength(JSON.stringify(b)),0)>64*1024*1024)this.records.delete(this.records.keys().next().value!);}
  constructor(context:vscode.ExtensionContext,private manager:ConnectionManager,readonly service:DatabaseDefinitions,private documents:SqlDocuments){
    this.root=resolve(context.globalStorageUri.fsPath,'definitions');
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider('dbw-definition',this),vscode.window.onDidChangeActiveTextEditor(()=>this.updateContext()),vscode.workspace.onDidCloseTextDocument(doc=>{try{this.path(doc.uri);const owner=doc.uri.toString(),plan=this.plans.get(owner);if(plan)this.service.forget(plan.preview.token);this.plans.delete(owner);this.records.delete(owner);}catch{}}));
    this.updateContext();
  }
  provideTextDocumentContent(uri:vscode.Uri){return this.contents.get(uri.toString())?.text??'This definition review expired. Create a fresh preview.';}
  private source(uri:vscode.Uri){return this.contents.get(uri.toString())?.source??uri.toString();}
  private path(uri:vscode.Uri){if(uri.scheme!=='file'||dirname(resolve(uri.fsPath))!==this.root||!/^definition-[a-f0-9-]{36}\.sql$/.test(uri.path.split('/').at(-1)??''))throw new Error('Open a managed object definition first. Use DBNook: Open Object Definition.');return uri.fsPath;}
  private async record(uri:vscode.Uri){
    const owner=this.source(uri),source=vscode.Uri.parse(owner),path=this.path(source);let baseline=this.records.get(owner);
    if(!baseline){const sidecar=path+'.json';if((await stat(sidecar)).size>16*1024*1024)throw new Error('Definition metadata exceeds the budget. Reopen the object.');baseline=RecordSchema.parse(JSON.parse(await readFile(sidecar,'utf8'))).baseline;this.cache(owner,baseline);}
    const bound=this.documents.connection(owner);if(bound&&bound!==baseline.profileId)throw new Error('This definition was rebound to another connection. Reopen the object before applying.');
    this.manager.profile(baseline.profileId);await this.documents.bind(owner,baseline.profileId);
    return {owner,uri:source,path,baseline,doc:await vscode.workspace.openTextDocument(source)};
  }
  private async persist(owner:string,path:string,baseline:DefinitionSnapshot,renames:Extract<DdlIntent,{action:'editDefinition'}>['renames']=[]){const json=JSON.stringify({version:1,baseline,renames},null,2)+'\n';if(Buffer.byteLength(json)>16*1024*1024)throw new Error('Definition metadata exceeds the 16 MiB draft budget.');const pending=path+'.json.'+randomUUID()+'.tmp';try{await writeFile(pending,json,{flag:'wx'});await rename(pending,path+'.json');}finally{await unlink(pending).catch(()=>{});}this.cache(owner,baseline);this.updateContext();}
  private mappingPreamble(text:string,baseline:DefinitionSnapshot){if(Buffer.byteLength(text)>4*1024*1024)throw new Error('Definition exceeds the 4 MiB draft limit.');const start=sqlTokens(text,baseline.driver,baseline.tableStructure?.sqlMode).find(t=>t.kind!=='comment')?.start??text.length;return {header:text.slice(0,start),body:text.slice(start)};}
  private mappings(text:string,baseline:DefinitionSnapshot){const lines=this.mappingPreamble(text,baseline).header.split(/\r?\n/).map(s=>s.trimStart()).filter(s=>s.startsWith(mappingPrefix));if(lines.length>1)throw new Error('The SQL draft has multiple column mapping declarations. Use Map Renamed Columns to replace them.');return lines.length?RenameSchema.parse(JSON.parse(lines[0]!.slice(mappingPrefix.length))):[];}
  private virtual(source:string,text:string,label:string){const uri=vscode.Uri.from({scheme:'dbw-definition',path:`/${randomUUID()}/${label}.sql`});this.contents.set(uri.toString(),{source,text});while(this.contents.size>40||this.contents.size>1&&[...this.contents.values()].reduce((n,c)=>n+Buffer.byteLength(c.text),0)>64*1024*1024)this.contents.delete(this.contents.keys().next().value!);return uri;}
  private updateContext(){
    const uri=vscode.window.activeTextEditor?.document.uri;let managed=false,owner='';if(uri){try{owner=this.source(uri);this.path(vscode.Uri.parse(owner));managed=true;}catch{}}
    const flags=(baseline?:DefinitionSnapshot)=>{void vscode.commands.executeCommand('setContext','dbWorkbench.editableDefinition',managed&&baseline?.editable===true);void vscode.commands.executeCommand('setContext','dbWorkbench.tableDefinition',managed&&baseline?.ref.kind==='table');};
    void vscode.commands.executeCommand('setContext','dbWorkbench.managedDefinition',managed);flags(this.records.get(owner));
    if(managed&&!this.records.has(owner))void (async()=>{try{const path=this.path(vscode.Uri.parse(owner));if((await stat(path+'.json')).size>16*1024*1024)return;const baseline=RecordSchema.parse(JSON.parse(await readFile(path+'.json','utf8'))).baseline;this.cache(owner,baseline);if(vscode.window.activeTextEditor?.document.uri.toString()===uri?.toString())flags(baseline);}catch{}})();
  }
  async open(id:string,ref:DefinitionRef){
    const baseline=await this.service.read(id,ref);if(!baseline)throw new Error('The object no longer exists. Refresh its catalog.');return this.openPrepared(baseline,baseline.sql);
  }
  async openPrepared(input:DefinitionSnapshot,text:string,notes:string[]=[]){
    const baseline=DefinitionSnapshotSchema.parse(input),id=baseline.profileId;await mkdir(this.root,{recursive:true});
    const uri=vscode.Uri.file(join(this.root,`definition-${randomUUID()}.sql`)),owner=uri.toString();
    const heading=`${this.manager.profile(id).name} · ${baseline.ref.kind} · ${baseline.ref.schema?baseline.ref.schema+'.':''}${baseline.ref.name}`.replace(/[\r\n]/g,' ');
    const content=`-- ${heading}\n-- Preview Definition Changes, then Apply Definition Changes. Saving this draft does not run SQL.\n${[...notes,...baseline.notes].map(n=>'-- '+n.replace(/[\r\n]/g,' ')).join('\n')}\n\n${text}`;if(Buffer.byteLength(content)>4*1024*1024)throw new Error('Definition draft exceeds the 4 MiB text budget.');
    await writeFile(uri.fsPath,content);
    await this.persist(owner,uri.fsPath,baseline);await this.documents.bind(owner,id);const doc=await vscode.workspace.openTextDocument(uri);await vscode.languages.setTextDocumentLanguage(doc,'sql');await vscode.window.showTextDocument(doc,{preview:false});this.updateContext();return uri;
  }
  async compare(uri:vscode.Uri){const r=await this.record(uri),current=await this.service.read(r.baseline.profileId,r.baseline.ref);const old=this.virtual(r.owner,r.baseline.sql,'Opened Definition'),server=this.virtual(r.owner,current?.sql??'-- Object no longer exists.','Current Server Definition');await vscode.commands.executeCommand('vscode.diff',old,server,`${r.baseline.ref.name} · Opened ↔ Server`);return current;}
  async setColumnMappings(uri:vscode.Uri,input:Extract<DdlIntent,{action:'editDefinition'}>['renames']){
    const r=await this.record(uri),s=r.baseline.tableStructure;if(!s)throw new Error('Open a managed table definition to map renamed columns.');const mappings=RenameSchema.parse(input);
    if(mappings.length)validateColumnRenames(s,parseTableScript(r.doc.getText(),r.baseline.driver,{label:s.label,schema:s.schema},s.sqlMode),mappings,r.baseline.driver);
    const old=this.plans.get(r.owner);if(old)this.service.forget(old.preview.token);this.plans.delete(r.owner);
    const current=r.doc.getText(),parts=this.mappingPreamble(current,r.baseline),header=parts.header.split('\n').filter(line=>!line.trimStart().startsWith(mappingPrefix)).join('\n'),content=(mappings.length?mappingPrefix+JSON.stringify(mappings)+'\n':'')+header+parts.body;
    const edit=new vscode.WorkspaceEdit();edit.replace(r.uri,new vscode.Range(r.doc.positionAt(0),r.doc.positionAt(current.length)),content);if(!await vscode.workspace.applyEdit(edit)||!await r.doc.save())throw new Error('Could not save column mappings with the SQL draft.');await this.persist(r.owner,r.path,r.baseline,mappings);
  }
  async mapColumns(uri:vscode.Uri){
    const r=await this.record(uri),s=r.baseline.tableStructure;if(!s)throw new Error('Open a managed table definition first.');const next=parseTableScript(r.doc.getText(),r.baseline.driver,{label:s.label,schema:s.schema},s.sqlMode),mappings=this.mappings(r.doc.getText(),r.baseline),key=(n:string)=>columnNameKey(n,r.baseline.driver);
    const removed=s.columns.filter(c=>!next.columns.some(n=>key(n.name)===key(c.name))),added=next.columns.filter(c=>!s.columns.some(o=>key(o.name)===key(c.name)));
    const choice=await vscode.window.showQuickPick([{label:'Clear all rename mappings',name:undefined as string|undefined},...removed.map(c=>({label:c.name,description:mappings.find(m=>m.from===c.name)?.to,name:c.name}))],{title:'Map Renamed Columns · choose original column'});if(!choice)return;
    if(!choice.name){await this.setColumnMappings(r.uri,[]);return;}
    const target=await vscode.window.showQuickPick(added.filter(c=>!mappings.some(m=>m.to===c.name&&m.from!==choice.name)).map(c=>({label:c.name})),{title:`Preserve ${choice.name} values as…`});if(!target)return;
    await this.setColumnMappings(r.uri,[...mappings.filter(m=>m.from!==choice.name),{from:choice.name,to:target.label}]);void vscode.window.showInformationMessage(`Column mapping saved: ${choice.name} → ${target.label}. Preview Definition Changes to review the migration.`);
  }
  async preview(uri:vscode.Uri){
    const r=await this.record(uri);const old=this.plans.get(r.owner);if(old)this.service.forget(old.preview.token);this.plans.delete(r.owner);
    const text=r.doc.getText(),result=await this.service.preview(r.baseline,text,this.mappings(text,r.baseline));
    if(result.kind==='conflict'){await this.compare(uri);return result;}
    this.plans.set(r.owner,{preview:result.preview,text});
    while(this.plans.size>20||this.plans.size>1&&[...this.plans.values()].reduce((n,p)=>n+Buffer.byteLength(p.text)+Buffer.byteLength(JSON.stringify(p.preview)),0)>64*1024*1024){const key=this.plans.keys().next().value!;this.service.forget(this.plans.get(key)!.preview.token);this.plans.delete(key);}
    const body=result.preview.sql??`${result.preview.policy==='transactional'?(r.baseline.driver==='sqlite'?'BEGIN IMMEDIATE;\n':'BEGIN;\n'):''}${result.preview.steps.map(s=>definitionDocument(s,r.baseline.driver,/^\s*CREATE\b/i.test(s)?r.baseline.ref.kind:'statement')).join('\n')}${result.preview.policy==='transactional'?'\nCOMMIT;\n':''}`;
    const sql=`-- REVIEW ONLY · ${this.manager.profile(r.baseline.profileId).name} · ${result.preview.target}\n-- Policy: ${result.preview.policy}. Use Apply Definition Changes to recheck the server before executing.\n${result.preview.warnings.map(w=>'-- '+w.replace(/[\r\n]/g,' ')).join('\n')}\n\n${body}`;
    const review=this.virtual(r.owner,sql,'Definition Preview');await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(review),{preview:false});return result;
  }
  /** Explicit acceptance updates only the conflict baseline; it never executes SQL. */
  async acceptServer(uri:vscode.Uri,fingerprint:string){const r=await this.record(uri);if(this.manager.editorRevision(r.baseline.profileId)!==r.baseline.revision)throw new Error('Connection changed. Reopen this definition.');const current=await this.service.read(r.baseline.profileId,r.baseline.ref);if(!current||current.fingerprint!==fingerprint)throw new Error('Server changed again. Compare the definition again.');await this.persist(r.owner,r.path,current,this.mappings(r.doc.getText(),r.baseline));return this.preview(r.uri);}
  async reload(uri:vscode.Uri){const r=await this.record(uri),current=await this.service.read(r.baseline.profileId,r.baseline.ref);if(!current)throw new Error('Object no longer exists.');const edit=new vscode.WorkspaceEdit();edit.replace(r.uri,new vscode.Range(r.doc.positionAt(0),r.doc.positionAt(r.doc.getText().length)),current.sql);if(!await vscode.workspace.applyEdit(edit)||!await r.doc.save())throw new Error('Definition draft could not be refreshed.');await this.persist(r.owner,r.path,current);const old=this.plans.get(r.owner);if(old)this.service.forget(old.preview.token);this.plans.delete(r.owner);await vscode.window.showTextDocument(r.doc,{preview:false});}
  async pending(uri:vscode.Uri){const r=await this.record(uri),p=this.plans.get(r.owner);if(!p||p.text!==r.doc.getText()||Date.parse(p.preview.expiresAt)<Date.now())return undefined;return p.preview;}
  async apply(uri:vscode.Uri,signal?:AbortSignal):Promise<DefinitionReport>{
    const r=await this.record(uri),p=this.plans.get(r.owner);if(!p||p.text!==r.doc.getText())throw new Error('The draft changed or has no reviewed preview. Preview Definition Changes again.');
    const result=await this.service.apply(r.baseline.profileId,p.preview.token,signal);this.plans.delete(r.owner);
    if(result.status==='succeeded'&&result.snapshot){
      if(result.snapshot.tableStructure){
        if(!r.doc.isClosed&&r.doc.getText()===p.text){try{const edit=new vscode.WorkspaceEdit();edit.replace(r.uri,new vscode.Range(r.doc.positionAt(0),r.doc.positionAt(r.doc.getText().length)),result.snapshot.sql);if(!await vscode.workspace.applyEdit(edit)||!await r.doc.save())throw new Error('Draft refresh failed.');}catch{result.warnings.push('Applied, but refreshing the table SQL draft failed. Reopen the definition before another change.');}}
      }
      try{await this.persist(r.owner,r.path,result.snapshot);}catch{result.warnings.push('Applied, but saving the refreshed draft baseline failed. Preserve the SQL draft and reopen the server definition before another change.');}
    }
    return result;
  }
  dispose(){for(const p of this.plans.values())this.service.forget(p.preview.token);for(const d of this.disposables)d.dispose();this.plans.clear();this.contents.clear();this.records.clear();}
}
