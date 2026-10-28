import * as vscode from 'vscode';
import {randomUUID} from 'node:crypto';
import {AuthenticationSchema,TunnelSchema,WebEnvelopeSchema,errorMessage,type ResourceKind,type ConnectionResource,type ResourceSummary,type WorkbenchBoot} from '../../protocol/src/index.js';
import {ConnectionResources,type ResourceStore} from '../../core/src/resources.js';
import {SshTunnels} from '../../core/src/tunnels.js';
import {commitProfileSettings,type SettingWrite} from '../../core/src/profile-write.js';
import {configureWebview,isWebviewDiagnostic} from './webview.js';
const setting=(kind:ResourceKind)=>kind==='authentication'?'authenticationProfiles':'tunnels';
export async function openSshConfigSource(resources:ConnectionResources,id:string,file:'config'|'known-hosts'='config'):Promise<void>{
  if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before opening SSH configuration.');const value=resources.get('tunnel',id);if(value.kind!=='ssh'||!value.source)throw new Error('Select a discovered SSH Config tunnel.');let path=file==='config'?value.source.path:undefined;if(file==='known-hosts')for(const candidate of value.source.knownHostsFiles){try{await vscode.workspace.fs.stat(vscode.Uri.file(candidate));path=candidate;break;}catch{}}if(!path)throw new Error('No known_hosts file exists for this alias. Create its UserKnownHostsFile on the extension host.');
  const document=await vscode.workspace.openTextDocument(vscode.Uri.file(path));const line=file==='config'?Math.min(value.source.line-1,document.lineCount-1):0;await vscode.window.showTextDocument(document,{preview:false,selection:new vscode.Range(line,0,line,0)});
}
export class VscodeResourceStore implements ResourceStore {
  private pending:Promise<unknown>=Promise.resolve();
  constructor(private log:(message:string)=>void){}
  list():ResourceSummary{return {authentication:this.read('authentication') as ResourceSummary['authentication'],tunnels:this.read('tunnel') as ResourceSummary['tunnels']};}
  private read(kind:ResourceKind):ConnectionResource[]{
    const inspected=vscode.workspace.getConfiguration('dbWorkbench').inspect<unknown>(setting(kind)),map=new Map<string,ConnectionResource>(),schema=kind==='authentication'?AuthenticationSchema:TunnelSchema;
    for(const [scope,raw]of [['global',inspected?.globalValue],['workspace',inspected?.workspaceValue]] as const){
      if(raw===undefined)continue;if(!Array.isArray(raw)){this.log(`Invalid ${setting(kind)} array in ${scope} settings.`);continue;}
      const counts=new Map<string,number>();for(const value of raw)if(value&&typeof value==='object'&&typeof value.id==='string')counts.set(value.id,(counts.get(value.id)??0)+1);
      for(let index=0;index<raw.length;index++){const value=raw[index],parsed=schema.safeParse(value&&typeof value==='object'?{...value,scope}:value),id=value&&typeof value==='object'?value.id:undefined;
        if(kind==='tunnel'&&value&&typeof value==='object'&&(value.source||typeof id==='string'&&id.startsWith('ssh-config:'))){this.log('Discovered SSH Config definitions cannot be stored in tunnel settings.');continue;}
        if(typeof id==='string'&&(counts.get(id)??0)>1){map.delete(id);this.log(`Duplicate ${setting(kind)} ID in ${scope} settings.`);continue;}
        if(!parsed.success){if(typeof id==='string')map.delete(id);this.log(`Invalid ${setting(kind)} row ${index+1} in ${scope} settings.`);continue;}map.set(parsed.data.id,parsed.data);
      }
    }return [...map.values()];
  }
  private mutate(action:()=>Promise<void>):Promise<void>{const result=this.pending.then(action);this.pending=result.catch(()=>{});return result;}
  save(kind:ResourceKind,value:ConnectionResource):Promise<void>{return this.mutate(async()=>{
    if(value.scope==='workspace'&&!vscode.workspace.workspaceFolders?.length)throw new Error('Open a workspace before saving a workspace profile.');
    const configuration=vscode.workspace.getConfiguration('dbWorkbench'),name=setting(kind),inspect=configuration.inspect<unknown[]>(name),writes:SettingWrite[]=[];
    for(const [scope,raw]of [['global',inspect?.globalValue],['workspace',inspect?.workspaceValue]] as const){
      if(raw!==undefined&&!Array.isArray(raw))throw new Error(`Fix the ${name} array before saving.`);
      const hasId=(v:unknown)=>v&&typeof v==='object'&&(v as {id?:unknown}).id===value.id,matching=(raw??[]).filter(hasId);
      const schema=kind==='authentication'?AuthenticationSchema:TunnelSchema;
      if(matching.length>1||matching.some(v=>!schema.safeParse(v).success))throw new Error('Fix duplicate or invalid records for this profile ID before saving.');
      if(scope===value.scope)writes.unshift({scope,before:raw,after:[...(raw??[]).filter(v=>!hasId(v)),value]});
      else if(matching.length)writes.push({scope,before:raw,after:raw!.filter(v=>!hasId(v))});
    }await commitProfileSettings(writes,(scope,next)=>configuration.update(name,next,scope==='workspace'?vscode.ConfigurationTarget.Workspace:vscode.ConfigurationTarget.Global));
  });}
  remove(kind:ResourceKind,id:string):Promise<void>{return this.mutate(async()=>{const configuration=vscode.workspace.getConfiguration('dbWorkbench'),name=setting(kind),inspect=configuration.inspect<unknown[]>(name),writes:SettingWrite[]=[];
    for(const [scope,raw]of [['global',inspect?.globalValue],['workspace',inspect?.workspaceValue]] as const)if(Array.isArray(raw)&&raw.some(v=>v&&typeof v==='object'&&(v as {id?:unknown}).id===id))writes.push({scope,before:raw,after:raw.filter(v=>!(v&&typeof v==='object'&&(v as {id?:unknown}).id===id))});
    await commitProfileSettings(writes,(scope,next)=>configuration.update(name,next,scope==='workspace'?vscode.ConfigurationTarget.Workspace:vscode.ConfigurationTarget.Global));
  });}
}
export class ResourceNode extends vscode.TreeItem {constructor(readonly kind:ResourceKind,readonly value:ConnectionResource){super(value.name,vscode.TreeItemCollapsibleState.None);this.id=JSON.stringify([kind,value.id]);this.contextValue=kind==='authentication'?'authenticationProfile':value.kind==='ssh'&&value.source?'sshConfigTunnel':'sshTunnel';this.iconPath=new vscode.ThemeIcon(kind==='authentication'?'key':value.kind==='ssh'&&value.source?.issues.length?'warning':'remote');this.description=value.kind==='ssh'?`${value.source?'from ssh.config · ':''}${value.user}@${value.host}:${value.port}`:`${value.user} · ${value.kind}`;if(value.kind==='ssh'&&value.source)this.tooltip=`${value.source.path}:${value.source.line}\n${value.source.issues.join('\n')||'Read-only SSH Config source. Credentials are stored separately.'}`;this.command={command:kind==='authentication'?'dbWorkbench.auth.edit':'dbWorkbench.tunnel.edit',title:'Edit',arguments:[this]};}}
export class ResourceTree implements vscode.TreeDataProvider<ResourceNode>,vscode.Disposable {
  private emitter=new vscode.EventEmitter<ResourceNode|undefined>();readonly onDidChangeTreeData=this.emitter.event;
  constructor(private resources:ConnectionResources,private tunnels:SshTunnels,private kind:ResourceKind){}
  refresh():void{this.emitter.fire(undefined);}
  getTreeItem(node:ResourceNode):ResourceNode{return node;}
  getChildren():ResourceNode[]{return (this.kind==='authentication'?this.resources.list().authentication:this.resources.list().tunnels).sort((a,b)=>a.name.localeCompare(b.name)).map(value=>{const node=new ResourceNode(this.kind,value);if(value.kind==='ssh'){const active=this.tunnels.status().filter(t=>t.id===value.id);if(active.length)node.description=`${value.source?'from ssh.config · ':''}${active.length} endpoint(s) · ${active.reduce((n,t)=>n+t.references,0)} session(s)`;}return node;});}
  dispose():void{this.emitter.dispose();}
}
export class ResourcePanels implements vscode.Disposable {
  private panels=new Map<string,vscode.WebviewPanel>();
  private initialized=new Set<string>();
  constructor(private context:vscode.ExtensionContext,private resources:ConnectionResources,private tunnels:SshTunnels,private log:(error:unknown)=>void,private refreshSsh?:()=>Promise<void>){}
  initializedViews():number{return this.initialized.size;}
  async open(kind:ResourceKind,existing?:ConnectionResource):Promise<void>{
    let value:ConnectionResource=existing??(kind==='authentication'?{id:randomUUID(),name:'',kind:'password',user:'',scope:'global'}:{id:randomUUID(),name:'',kind:'ssh',host:'',port:22,user:'',auth:'password',fingerprint:'',readyTimeout:15000,scope:'global'});
    const key=JSON.stringify([kind,value.id]),previous=this.panels.get(key);if(previous){previous.reveal();return;}
    const panel=vscode.window.createWebviewPanel('dbWorkbench.resource',existing?`Edit: ${value.name}`:kind==='authentication'?'New Authentication Profile':'New SSH Tunnel',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'dist','webview')]});this.panels.set(key,panel);
    panel.webview.onDidReceiveMessage(async raw=>{if(isWebviewDiagnostic(raw))return;let id='';try{const envelope=WebEnvelopeSchema.parse(raw);id=envelope.id;const request=envelope.request;if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before editing database authentication or SSH tunnels.');let result:unknown;
      switch(request.method){
        case 'initialize':{if(value.kind==='ssh'&&value.source){await this.refreshSsh?.();value=this.resources.get('tunnel',value.id);}const editor=await this.resources.editor(kind,value.id);value=(kind==='authentication'?this.resources.list().authentication:this.resources.list().tunnels).find(v=>v.id===value.id)??value;this.initialized.add(key);result={view:kind,profile:{schemaVersion:1,id:'resource',name:'',driver:'sqlite',storage:'memory',path:'',scope:'global',group:'',color:'#2684a6',readOnly:false,createIfMissing:false},resource:{kind,value,editor},resources:this.resources.list(),transfer:{workspaceAvailable:Boolean(vscode.workspace.workspaceFolders?.length)}} satisfies WorkbenchBoot;break;}
        case 'resource.save':{if(request.params.kind!==kind||request.params.value.id!==value.id)throw new Error('Profile identity mismatch.');value=await this.resources.save(kind,request.params.value,request.params);result={value,editor:await this.resources.editor(kind,value.id)};panel.title=`Edit: ${value.name}`;break;}
        case 'tunnel.test':if(kind!=='tunnel'||request.params.value.id!==value.id)throw new Error('Tunnel identity mismatch.');result=await this.tunnels.test(value.kind==='ssh'&&value.source?this.resources.get('tunnel',value.id):request.params.value,value.kind==='ssh'&&value.source?undefined:request.params.secret);break;
        case 'tunnel.source.open':if(kind!=='tunnel'||request.params.id!==value.id)throw new Error('Tunnel identity mismatch.');await openSshConfigSource(this.resources,value.id,request.params.file);result=null;break;
        case 'tunnel.credentials.save':if(kind!=='tunnel'||request.params.id!==value.id)throw new Error('Tunnel identity mismatch.');value=await this.resources.saveTunnelCredentials(value.id,request.params);result={value,editor:await this.resources.editor(kind,value.id)};break;
        case 'tunnel.fingerprint':if(kind!=='tunnel')throw new Error('Open an SSH tunnel editor first.');result={fingerprint:await SshTunnels.fingerprint(request.params.host,request.params.port,request.params.timeout)};break;
        case 'resources.list':result=this.resources.list();break;
        case 'authentication.clearCache':if(kind!=='authentication'||request.params.id!==value.id)throw new Error('Profile identity mismatch.');this.resources.clearCredentials(value.id);result=null;break;
        default:throw new Error('This operation is unavailable in this profile editor.');
      }await panel.webview.postMessage({version:1,id,result});
    }catch(error){this.log(error);await panel.webview.postMessage({version:1,id,error:{code:'RESOURCE_OPERATION_FAILED',message:errorMessage(error)}});}});
    panel.onDidDispose(()=>{this.panels.delete(key);this.initialized.delete(key);});configureWebview(this.context,panel);
  }
  dispose():void{for(const panel of this.panels.values())panel.dispose();this.panels.clear();}
}
