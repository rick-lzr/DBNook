import {execFile} from 'node:child_process';
import {open} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import type {AuthenticationProfile} from '../../protocol/src/index.js';

export interface AuthenticationTarget {host:string;port:number;database:string;}
export interface ResolvedCredentials {user:string;password:string;}
type CommandProfile=Extract<AuthenticationProfile,{kind:'command'}>;
const OUTPUT_LIMIT=64*1024,FILE_LIMIT=1024*1024;
const pathValue=(root:unknown,path:string):unknown=>{
  let value=root;for(const key of path.split('.')){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=(value as Record<string,unknown>)[key];}return value;
};
export function commandCredentials(profile:CommandProfile,stdout:string,now=Date.now()):ResolvedCredentials&{expiresAt?:number}{
  const output=stdout.replace(/\r?\n$/,'');let user=profile.user,password:unknown,expiresAt:number|undefined;
  if(profile.output==='password')password=output;
  else if(profile.output==='user-password'){
    const split=output.indexOf(':');if(split<1)throw new Error('Credential command must return user:password.');
    user=output.slice(0,split);password=output.slice(split+1);
  }else{
    let value:unknown;try{value=JSON.parse(output);}catch{throw new Error('Credential command returned invalid JSON.');}
    password=pathValue(value,profile.passwordPath);
    if(profile.userPath){const mapped=pathValue(value,profile.userPath);if(typeof mapped!=='string')throw new Error('Credential command username mapping must resolve to a string.');user=mapped;}
    if(profile.expiresAtPath){const expiry=pathValue(value,profile.expiresAtPath);expiresAt=typeof expiry==='number'?expiry*1000:typeof expiry==='string'?Date.parse(expiry):NaN;if(!Number.isFinite(expiresAt)||expiresAt<=now)throw new Error('Credential command returned an invalid or expired expiration time.');}
  }
  if(!user||user.length>1000||/[\r\n\0]/.test(user)||typeof password!=='string'||password.includes('\0'))throw new Error('Credential command returned invalid credentials. Check the output format and mappings.');
  if(user!==profile.user)throw new Error('Credential command returned a different database user. Update the Authentication Profile user before reconnecting.');
  return {user,password,...(expiresAt===undefined?{}:{expiresAt})};
}
export function pgpassPath(custom:string,env:NodeJS.ProcessEnv=process.env,home=homedir(),platform:NodeJS.Platform=process.platform):string{
  return resolve(custom||env.PGPASSFILE||(platform==='win32'?join(env.APPDATA||join(home,'AppData','Roaming'),'postgresql','pgpass.conf'):join(home,'.pgpass')));
}
export const pgpassModeAllowed=(mode:number,platform:NodeJS.Platform=process.platform)=>platform==='win32'||(mode&0o077)===0;
export function pgpassPassword(text:string,target:AuthenticationTarget,user:string):string|undefined{
  for(const line of text.split(/\r?\n/)){
    if(!line||line.startsWith('#'))continue;
    const fields:{value:string;wildcard:boolean}[]=[];let value='',raw='',escaped=false;
    for(const character of line){
      if(escaped){value+=character;raw+='\\'+character;escaped=false;}
      else if(character==='\\')escaped=true;
      else if(character===':'){fields.push({value,wildcard:raw==='*'});value='';raw='';if(fields.length===5)break;}
      else{value+=character;raw+=character;}
    }
    if(fields.length<5)fields.push({value:value+(escaped?'\\':''),wildcard:raw==='*'});
    if(fields.length<5)continue;
    const expected=[target.host||'localhost',String(target.port),target.database,user];
    if(expected.every((part,index)=>fields[index]!.wildcard||fields[index]!.value===part))return fields[4]!.value;
  }
  return undefined;
}
async function readPgpass(profile:Extract<AuthenticationProfile,{kind:'pgpass'}>,target:AuthenticationTarget):Promise<ResolvedCredentials>{
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    file=await open(pgpassPath(profile.path),'r');const info=await file.stat();
    if(!info.isFile())throw new Error('pgpass must be a regular file.');
    if(!pgpassModeAllowed(info.mode))throw new Error('pgpass permissions allow group or other access. Set its permissions to 0600.');
    const buffer=Buffer.alloc(FILE_LIMIT+1);let offset=0;
    try{
      while(offset<buffer.length){const read=await file.read(buffer,offset,buffer.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
      if(offset>FILE_LIMIT)throw new Error('pgpass exceeds the 1 MiB file limit.');
      const text=buffer.toString('utf8',0,offset);if(text.includes('\0'))throw new Error('pgpass contains invalid NUL characters.');
      const password=pgpassPassword(text,target,profile.user);if(password===undefined)throw new Error('No pgpass entry matches this database host, port, database and user.');return {user:profile.user,password};
    }finally{buffer.fill(0);}
  }catch(error){const code=(error as NodeJS.ErrnoException).code;if(code)throw new Error('Cannot read pgpass on the extension host. Check its path and permissions.');throw error;}
  finally{await file?.close();}
}
/** Credentials stay in extension-host memory. Cache keys include the logical database endpoint. */
export class AuthenticationResolver {
  private cache=new Map<string,{id:string;value:ResolvedCredentials;expiresAt:number}>();
  private pending=new Map<string,{id:string;promise:Promise<ResolvedCredentials>}>();
  private generations=new Map<string,number>();
  private commands=new Set<AbortController>();private closed=false;
  close():void{this.closed=true;this.cache.clear();for(const command of this.commands)command.abort();this.commands.clear();}
  clear(id:string):void{this.generations.set(id,(this.generations.get(id)??0)+1);for(const[key,entry]of this.cache)if(entry.id===id)this.cache.delete(key);}
  async resolve(profile:Exclude<AuthenticationProfile,{kind:'password'}>,target?:AuthenticationTarget):Promise<ResolvedCredentials>{
    if(this.closed)throw new Error('Authentication resolver is closed.');
    if(profile.kind==='pgpass'){if(!target)throw new Error('pgpass requires a database connection target.');const value=await readPgpass(profile,target);if(this.closed)throw new Error('Authentication resolver is closed.');return value;}
    const generation=this.generations.get(profile.id)??0,key=JSON.stringify([profile,target,generation]),now=Date.now();
    for(const[k,entry]of this.cache)if(entry.expiresAt<=now)this.cache.delete(k);
    const cached=this.cache.get(key);if(cached)return {...cached.value};
    const existing=this.pending.get(key);if(existing)return {...await existing.promise};
    if(this.pending.size>=32)throw new Error('Too many credential commands are running. Retry after they finish.');
    const promise=this.command(profile,target).then(result=>{
      if(this.closed)throw new Error('Authentication resolver is closed.');
      if(generation!==(this.generations.get(profile.id)??0))throw new Error('Credential cache was cleared while the command was running. Retry explicitly.');
      const value={user:result.user,password:result.password};
      const expiresAt=Math.min(Date.now()+profile.cacheTtl*1000,result.expiresAt??Infinity);
      if(profile.cacheTtl&&expiresAt>Date.now()){if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,{id:profile.id,value,expiresAt});}return value;
    });this.pending.set(key,{id:profile.id,promise});
    try{return {...await promise};}finally{if(this.pending.get(key)?.promise===promise)this.pending.delete(key);}
  }
  private command(profile:CommandProfile,target?:AuthenticationTarget):Promise<ResolvedCredentials&{expiresAt?:number}>{
    return new Promise((resolve,reject)=>{
      const controller=new AbortController();this.commands.add(controller);
      execFile(profile.executable,profile.args,{cwd:profile.cwd||undefined,timeout:profile.timeout,maxBuffer:OUTPUT_LIMIT,encoding:'utf8',windowsHide:true,shell:false,signal:controller.signal,env:{...process.env,DBW_AUTH_HOST:target?.host??'',DBW_AUTH_PORT:target?String(target.port):'',DBW_AUTH_DATABASE:target?.database??'',DBW_AUTH_USER:profile.user}},(error,stdout)=>{
        this.commands.delete(controller);
        if(error){reject(new Error(error.killed?'Credential command timed out or exceeded its output limit.':'Credential command failed. Check the executable, arguments, working directory and exit status.'));return;}
        try{resolve(commandCredentials(profile,stdout));}catch(error){reject(error);}
      });
    });
  }
}
