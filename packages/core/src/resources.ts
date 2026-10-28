import {isMysqlFamily} from '../../protocol/src/index.js';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {AuthenticationSchema,TunnelSchema,type AuthenticationProfile,type TunnelDefinition,type ConnectionResource,type ResourceKind,type ResourceEditorState,type ResourceSummary,type ConnectionProfile} from '../../protocol/src/index.js';
import type {CredentialStore} from './connections.js';
import {AuthenticationResolver,type AuthenticationTarget} from './authentication.js';
export interface ResourceStore {list():ResourceSummary;save(kind:ResourceKind,value:ConnectionResource):Promise<void>;remove(kind:ResourceKind,id:string):Promise<void>;}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const resourceTarget=(value:ConnectionResource)=>{if(value.kind==='ssh')return {kind:value.kind,host:value.host,port:value.port,user:value.user,auth:value.auth,privateKeyPath:value.privateKeyPath??'',agent:value.agent??'',fingerprint:value.fingerprint,readyTimeout:value.readyTimeout,...(value.source?{identityFiles:value.source.identityFiles,fingerprints:value.source.fingerprints,authMethods:value.source.authMethods,issues:value.source.issues}:{})};const {id,name,scope,...target}=value;return target;};
export class ConnectionResources {
  private memory=new Map<string,string>();private versions=new Map<string,number>();private bindingVersions=new Map<string,number>();private saving=new Set<string>();
  private deleting=new Set<string>();private pendingReferences=new Map<string,Map<symbol,ConnectionProfile>>();
  private resolver=new AuthenticationResolver();
  private discovered:TunnelDefinition[]=[];
  beforeChange:(kind:ResourceKind,id:string)=>Promise<boolean>=async()=>true;
  constructor(readonly store:ResourceStore,private secrets:CredentialStore,private connections:()=>ConnectionProfile[],private changed:()=>void=()=>{}){}
  private key(kind:ResourceKind,id:string):string{return JSON.stringify([kind,id]);}
  list():ResourceSummary{const result=this.store.list();return {...result,tunnels:[...result.tunnels.filter(v=>!v.id.startsWith('ssh-config:')&&!v.source),...structuredClone(this.discovered)]};}
  setDiscoveredTunnels(values:TunnelDefinition[]):void{const next=values.map(value=>TunnelSchema.parse(value));if(next.some(value=>!value.source||!value.id.startsWith('ssh-config:'))||new Set(next.map(value=>value.id)).size!==next.length)throw new Error('Invalid discovered SSH tunnel identities.');this.discovered=next;this.changed();}
  get(kind:ResourceKind,id:string):ConnectionResource {const value=(kind==='authentication'?this.list().authentication:this.list().tunnels).find(p=>p.id===id);if(!value)throw new Error(`The ${kind==='authentication'?'Authentication Profile':'SSH tunnel'} no longer exists.`);return value;}
  revision(kind:ResourceKind,id:string):string{const value=(kind==='authentication'?this.list().authentication:this.list().tunnels).find(p=>p.id===id)??null;return hash([value,this.versions.get(this.key(kind,id))??0]);}
  async editor(kind:ResourceKind,id:string):Promise<ResourceEditorState>{const key=this.key(kind,id),stored=await this.secrets.get(key);return {revision:this.revision(kind,id),hasSecret:this.memory.has(key)||stored!==undefined,rememberSecret:stored!==undefined};}
  references(kind:ResourceKind,id:string):ConnectionProfile[]{const rows=this.connections().filter(p=>(kind==='authentication'?p.authRef:p.tunnelRef)===id);return [...new Map([...rows,...(this.pendingReferences.get(this.key(kind,id))?.values()??[])].map(p=>[p.id,p])).values()];}
  validate(profile:ConnectionProfile):void{for(const[kind,id]of [['authentication',profile.authRef],['tunnel',profile.tunnelRef]] as const)if(id){if(this.deleting.has(this.key(kind,id)))throw new Error('A referenced profile is being deleted. Wait before connecting or saving.');const value=this.get(kind,id);if(isMysqlFamily(profile.driver)&&value.kind==='pgpass')throw new Error('pgpass is PostgreSQL-specific. Select password or command authentication for this database.');}}
  reserve(profile:ConnectionProfile):()=>void{this.validate(profile);const keys=([['authentication',profile.authRef],['tunnel',profile.tunnelRef]] as const).flatMap(([kind,id])=>id?[this.key(kind,id)]:[]),token=Symbol();let released=false;for(const key of keys){const rows=this.pendingReferences.get(key)??new Map<symbol,ConnectionProfile>();rows.set(token,profile);this.pendingReferences.set(key,rows);}return()=>{if(released)return;released=true;for(const key of keys){const rows=this.pendingReferences.get(key);rows?.delete(token);if(!rows?.size)this.pendingReferences.delete(key);}};}
  binding(profile:ConnectionProfile,includeSecrets=true):string|undefined{
    if(!profile.authRef&&!profile.tunnelRef)return undefined;
    return hash(([['authentication',profile.authRef],['tunnel',profile.tunnelRef]] as const).map(([kind,id])=>{if(!id)return null;try{return [kind,id,resourceTarget(this.get(kind,id)),includeSecrets?this.bindingVersions.get(this.key(kind,id))??0:0];}catch{return ['missing',kind,id];}}));
  }
  bindingRevision(kind:ResourceKind,id:string):string{return hash([resourceTarget(this.get(kind,id)),this.bindingVersions.get(this.key(kind,id))??0]);}
  async secret(kind:ResourceKind,id:string):Promise<string|undefined>{const key=this.key(kind,id);return this.memory.get(key)??await this.secrets.get(key);}
  clearCredentials(id:string):void{this.get('authentication',id);this.resolver.clear(id);}
  close():void{this.resolver.close();this.memory.clear();}
  async authenticate(id:string,target?:AuthenticationTarget):Promise<{user:string;password?:string}>{const before=this.revision('authentication',id),value=this.get('authentication',id) as AuthenticationProfile,result=value.kind==='password'?{user:value.user,password:await this.secret('authentication',id)}:await this.resolver.resolve(value,target);if(before!==this.revision('authentication',id))throw new Error('Authentication Profile changed while resolving credentials. Retry explicitly.');return result;}
  async save(kind:ResourceKind,input:unknown,options:{secret?:string;remember:boolean;revision:string}):Promise<ConnectionResource>{return this.write(kind,input,options);}
  async saveTunnelCredentials(id:string,options:{password?:string;passphrase?:string;remember:boolean;revision:string}):Promise<ConnectionResource>{
    const value=this.get('tunnel',id) as TunnelDefinition;if(!value.source)throw new Error('Select a discovered SSH Config tunnel.');
    let previous:{password?:string;passphrase?:string}={};const stored=await this.secret('tunnel',id);if(stored)try{previous=JSON.parse(stored);}catch{throw new Error('Stored SSH Config credentials are invalid. Recreate their secure entry.');}
    if(options.revision!==this.revision('tunnel',id))throw new Error('SSH Config changed while resolving credentials. Reload before saving.');
    return this.write('tunnel',value,{secret:JSON.stringify({password:options.password??previous.password,passphrase:options.passphrase??previous.passphrase}),remember:options.remember,revision:options.revision},true);
  }
  private async write(kind:ResourceKind,input:unknown,options:{secret?:string;remember:boolean;revision:string},sourceCredentials=false):Promise<ConnectionResource>{
    const value=kind==='authentication'?AuthenticationSchema.parse(input):TunnelSchema.parse(input),key=this.key(kind,value.id);
    if(value.kind==='ssh'&&(value.source||value.id.startsWith('ssh-config:'))&&!sourceCredentials)throw new Error('Discovered SSH Config tunnels are read-only. Edit their source file.');
    if(value.kind==='ssh'&&value.auth==='key'&&!isAbsolute(value.privateKeyPath!))throw new Error('SSH private key paths must be absolute paths on the extension host.');
    if(value.kind==='pgpass'&&value.path&&!isAbsolute(value.path))throw new Error('pgpass paths must be absolute paths on the extension host.');
    if(value.kind==='command'&&value.cwd&&!isAbsolute(value.cwd))throw new Error('Credential command working directories must be absolute paths on the extension host.');
    const acceptsSecret=value.kind==='password'||value.kind==='ssh'&&(value.auth!=='agent'||Boolean(value.source));
    if(!acceptsSecret&&options.secret!==undefined)throw new Error('This provider resolves credentials externally and does not accept a stored secret.');
    if(this.saving.has(key))throw new Error('This profile is already being saved.');this.saving.add(key);
    const assertCurrent=()=>{if(options.revision!==this.revision(kind,value.id))throw new Error('This profile changed after the editor opened. Reload before saving.');};
    let oldSecret:string|undefined,touched=false;
    try{
      assertCurrent();oldSecret=await this.secrets.get(key);const previous=this.memory.get(key)??oldSecret;
      const before=(kind==='authentication'?this.list().authentication:this.list().tunnels).find(p=>p.id===value.id);
      const authModeChanged=before&&(before.kind!==value.kind||value.kind==='ssh'&&before.kind==='ssh'&&value.auth!==before.auth);
      const next=acceptsSecret?options.secret??(authModeChanged?undefined:previous):undefined;
      const physical=Boolean(before&&hash(resourceTarget(before))!==hash(resourceTarget(value)))||options.secret!==undefined&&next!==previous;
      if(physical&&!await this.beforeChange(kind,value.id))throw new Error('Profile changes were cancelled.');assertCurrent();
      touched=true;if(options.remember&&next!==undefined)await this.secrets.store(key,next);else await this.secrets.delete(key);
      assertCurrent();if(!sourceCredentials)await this.store.save(kind,value);
      if(next!==undefined)this.memory.set(key,next);else this.memory.delete(key);
      if(kind==='authentication')this.resolver.clear(value.id);
      this.versions.set(key,(this.versions.get(key)??0)+1);if(physical)this.bindingVersions.set(key,(this.bindingVersions.get(key)??0)+1);
      this.changed();return value;
    }catch(error){if(touched)try{if(oldSecret===undefined)await this.secrets.delete(key);else await this.secrets.store(key,oldSecret);}catch{throw new Error('Profile save failed and its saved secret could not be restored. Review credentials before retrying.');}throw error;}
    finally{this.saving.delete(key);}
  }
  async remove(kind:ResourceKind,id:string):Promise<void>{
    if(kind==='tunnel'&&(this.get(kind,id) as TunnelDefinition).source)throw new Error('Discovered SSH Config tunnels are read-only. Remove the Host entry in their source file.');
    const key=this.key(kind,id);if(this.saving.has(key))throw new Error('Wait for the profile save to finish.');this.saving.add(key);this.deleting.add(key);
    try{const refs=this.references(kind,id);if(refs.length)throw new Error(`Cannot delete this profile; it is used by: ${refs.map(p=>p.name).join(', ')}.`);
      const before=this.get(kind,id),secret=await this.secrets.get(key);await this.store.remove(kind,id);
      try{await this.secrets.delete(key);}catch(error){try{if(secret!==undefined)await this.secrets.store(key,secret);await this.store.save(kind,before);}catch{throw new Error('Profile deletion failed and restoring its metadata or secret was incomplete. Review the profile before retrying.');}throw error;}
      this.memory.delete(key);if(kind==='authentication')this.resolver.clear(id);this.versions.set(key,(this.versions.get(key)??0)+1);this.changed();
    }finally{this.saving.delete(key);this.deleting.delete(key);}
  }
}
