import ssh2,{type Client as SshClient,type ClientChannel,type AuthMethod} from 'ssh2';
const {Client}=ssh2;
import {createHash} from 'node:crypto';
import {createServer,type Server,type Socket} from 'node:net';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {TunnelSchema,type TunnelDefinition} from '../../protocol/src/index.js';
import {ConnectionResources} from './resources.js';
export const sshFingerprint=(key:Buffer)=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
export interface EndpointLease {host:string;port:number;active():boolean;release():Promise<void>;}
interface Entry {key:string;definition:TunnelDefinition;stamp:string;refs:number;client:SshClient;server?:Server;port?:number;sockets:Set<Socket>;channels:Set<ClientChannel>;state:'opening'|'ready'|'closed';opening:Promise<void>;closed?:Promise<void>;}
export interface TunnelStatus {id:string;name:string;state:string;port?:number;references:number;remoteHost:string;remotePort:number;}
export class SshTunnels {
  private entries=new Map<string,Entry>();private closed=false;private messages=new Map<string,string[]>();
  constructor(private resources:ConnectionResources,private changed:()=>void=()=>{}){}
  private log(id:string,message:string):void{const rows=this.messages.get(id)??[];rows.push(`${new Date().toISOString()} ${message}`);this.messages.set(id,rows.slice(-200));this.changed();}
  logs(id:string):string[]{return [...(this.messages.get(id)??[])];}
  status():TunnelStatus[]{return [...this.entries.values()].map(e=>{const [id,host,port]=JSON.parse(e.key);return {id,name:e.definition.name,state:e.state,port:e.port,references:e.refs,remoteHost:host,remotePort:port};});}
  private async stop(entry:Entry):Promise<void>{
    if(entry.closed)return entry.closed;entry.state='closed';
    entry.closed=(async()=>{for(const socket of entry.sockets)socket.destroy();for(const channel of entry.channels)channel.destroy();entry.client.destroy();if(entry.server)await new Promise<void>(resolve=>{entry.server!.close(()=>resolve());});if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key);this.log(entry.definition.id,'Tunnel closed.');})();return entry.closed;
  }
  private async start(entry:Entry,host:string,port:number,secretOverride?:string):Promise<void>{
    const d=entry.definition;try{
      if(d.source?.issues.length)throw new Error(d.source.issues.join(' '));
      if(d.auth==='key'&&!isAbsolute(d.privateKeyPath!))throw new Error('SSH private key paths must be absolute paths on the extension host.');
      const secret=secretOverride??await this.resources.secret('tunnel',d.id),privateKey=d.auth==='key'&&!d.source?await readFile(d.privateKeyPath!):undefined;
      const authHandler:AuthMethod[]=[];if(d.source){let credentials:{password?:string;passphrase?:string}={};if(secret)try{credentials=JSON.parse(secret);}catch{throw new Error('Stored SSH Config credentials are invalid.');}
        for(const method of d.source.authMethods){if(method==='publickey'){for(const path of d.source.identityFiles){try{authHandler.push({type:'publickey',username:d.user,key:await readFile(path),passphrase:credentials.passphrase} as AuthMethod);}catch{this.log(d.id,'An SSH identity file could not be read.');}}}else if(method==='agent')authHandler.push({type:'agent',username:d.user,agent:d.agent||process.env.SSH_AUTH_SOCK||(process.platform==='win32'?'\\\\.\\pipe\\openssh-ssh-agent':'')} as AuthMethod);else if(credentials.password!==undefined)authHandler.push({type:'password',username:d.user,password:credentials.password} as AuthMethod);}
        if(!authHandler.length)throw new Error('SSH Config has no available credentials. Review its key files or save tunnel credentials.');
      }
      if(entry.closed)throw new Error('Tunnel opening was cancelled.');
      await new Promise<void>((resolve,reject)=>{
        let ready=false;const client=entry.client;
        client.once('ready',()=>{ready=true;resolve();});client.on('error',()=>{this.log(d.id,'SSH connection failed. Verify host key, credentials and forwarding permissions.');if(!ready)reject(new Error('SSH connection failed. Verify the host fingerprint and authentication settings.'));void this.stop(entry);});client.once('close',()=>{if(!ready)reject(new Error('SSH connection closed before authentication.'));void this.stop(entry);});
        client.connect({host:d.host,port:d.port,username:d.user,readyTimeout:d.readyTimeout,keepaliveInterval:15000,keepaliveCountMax:3,hostVerifier:(key:Buffer)=>d.source?d.source.fingerprints.includes(sshFingerprint(key)):sshFingerprint(key)===d.fingerprint,
          ...(d.source?{authHandler}:d.auth==='password'?{password:secret??''}:d.auth==='key'?{privateKey,passphrase:secret}:{agent:d.agent||process.env.SSH_AUTH_SOCK||(process.platform==='win32'?'\\\\.\\pipe\\openssh-ssh-agent':'')}),
        });
      });
      if(entry.closed)throw new Error('Tunnel opening was cancelled.');
      const server=createServer(socket=>{
        entry.sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>entry.sockets.delete(socket));
        entry.client.forwardOut('127.0.0.1',socket.remotePort??0,host,port,(error,channel)=>{
          if(error||entry.state!=='ready'||socket.destroyed){channel?.destroy();socket.destroy();if(error)this.log(d.id,'Database forwarding was refused. Check the destination and SSH forwarding permissions.');return;}
          entry.channels.add(channel);channel.on('error',()=>socket.destroy());channel.once('close',()=>{entry.channels.delete(channel);socket.destroy();});socket.pipe(channel).pipe(socket);
        });
      });entry.server=server;server.on('error',()=>{this.log(d.id,'Local forwarding listener failed.');void this.stop(entry);});
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
      if(entry.closed)throw new Error('Tunnel opening was cancelled.');entry.port=(server.address() as {port:number}).port;entry.state='ready';this.log(d.id,`Forwarding ready on 127.0.0.1:${entry.port}.`);
    }catch(error){await this.stop(entry);throw error;}
  }
  async acquire(id:string,host:string,port:number,signal?:AbortSignal):Promise<EndpointLease>{
    if(this.closed||signal?.aborted)throw new Error('Tunnel opening was cancelled.');
    const definition=this.resources.get('tunnel',id) as TunnelDefinition,key=JSON.stringify([id,host,port]);const stamp=this.resources.bindingRevision('tunnel',id);
    let entry=this.entries.get(key);
    if(entry&&entry.state!=='closed'&&entry.stamp!==stamp)throw new Error('SSH tunnel settings changed. Disconnect its sessions before reconnecting.');
    if(!entry||entry.state==='closed'){
      entry={key,definition,stamp,refs:0,client:new Client(),sockets:new Set(),channels:new Set(),state:'opening',opening:undefined!};this.entries.set(key,entry);entry.opening=this.start(entry,host,port);entry.opening.catch(()=>{});
    }
    const current=entry;current.refs++;let released=false;
    const release=async()=>{if(released)return;released=true;current.refs--;if(!current.refs)await this.stop(current);};
    let rejectAbort:(error:Error)=>void=()=>{};const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    const onAbort=()=>{void release();rejectAbort(new Error('Tunnel opening was cancelled.'));};signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
    try{await Promise.race([current.opening,aborted]);if(signal?.aborted||current.state!=='ready')throw new Error('Tunnel is no longer available.');if(current.stamp!==this.resources.bindingRevision('tunnel',id))throw new Error('SSH settings changed while opening. Retry explicitly.');return {host:'127.0.0.1',port:current.port!,active:()=>current.state==='ready',release};}
    catch(error){await release();throw error;}finally{signal?.removeEventListener('abort',onAbort);}
  }
  async test(value:unknown,secret?:string):Promise<{fingerprint:string}>{const d=TunnelSchema.parse(value),entry:Entry={key:JSON.stringify([d.id,'test',0]),definition:d,stamp:'test',refs:1,client:new Client(),sockets:new Set(),channels:new Set(),state:'opening',opening:Promise.resolve()};try{await this.start(entry,'127.0.0.1',1,secret);return {fingerprint:d.fingerprint};}finally{await this.stop(entry);}}
  async disconnect(id:string):Promise<void>{await Promise.all([...this.entries.values()].filter(e=>e.definition.id===id).map(e=>this.stop(e)));}
  async close():Promise<void>{this.closed=true;await Promise.all([...this.entries.values()].map(e=>this.stop(e)));}
  static fingerprint(host:string,port:number,timeout:number):Promise<string>{return new Promise((resolve,reject)=>{const client=new Client();let seen=false;client.on('error',()=>{if(!seen)reject(new Error('Could not read the SSH host key. Check host, port and timeout.'));client.destroy();});client.on('close',()=>{if(!seen)reject(new Error('SSH closed before providing a host key.'));});client.connect({host,port,username:'host-key-inspection',readyTimeout:timeout,hostVerifier:(key:Buffer)=>{seen=true;resolve(sshFingerprint(key));return false;}});});}
}
