import * as vscode from 'vscode';
import {watch,type FSWatcher} from 'node:fs';
import {stat} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import {defaultSshConfigPaths,discoverSshConfigs,type SshConfigSnapshot} from '../../core/src/ssh-config.js';
import type {ConnectionResources} from '../../core/src/resources.js';
export class SshConfigDiscovery implements vscode.Disposable {
  private watchers:FSWatcher[]=[];private timer?:ReturnType<typeof setTimeout>;private closed=false;private generation=0;
  private last:SshConfigSnapshot={tunnels:[],files:[],directories:[],diagnostics:[]};
  constructor(private resources:ConnectionResources,private log:(message:string)=>void){}
  snapshot():SshConfigSnapshot{return structuredClone(this.last);}
  async refresh():Promise<void>{
    const generation=++this.generation;if(this.closed)return;
    const clear=()=>{this.last={tunnels:[],files:[],directories:[],diagnostics:[]};for(const watcher of this.watchers)watcher.close();this.watchers=[];this.resources.setDiscoveredTunnels([]);};
    if(!vscode.workspace.isTrusted){clear();return;}
    const configured=vscode.workspace.getConfiguration('dbWorkbench').get<unknown>('sshConfigPaths',[]);if(!Array.isArray(configured)||configured.some(path=>typeof path!=='string'||!isAbsolute(path))){clear();this.log('SSH Config paths must be an array of absolute extension-host paths.');return;}const paths=configured.length?configured:defaultSshConfigPaths();
    let snapshot:SshConfigSnapshot;try{snapshot=await discoverSshConfigs(paths);}catch{snapshot={tunnels:[],files:paths,directories:paths.map(dirname),diagnostics:['SSH Config discovery failed. Review the configured paths.']};}
    if(this.closed||generation!==this.generation)return;this.last=snapshot;this.resources.setDiscoveredTunnels(snapshot.tunnels);for(const message of snapshot.diagnostics)this.log(message);
    for(const watcher of this.watchers)watcher.close();this.watchers=[];const directories=new Set<string>();
    for(const initial of snapshot.directories){let directory=initial;for(let depth=0;depth<32;depth++){try{if((await stat(directory)).isDirectory()){directories.add(directory);break;}}catch{}const parent=dirname(directory);if(parent===directory)break;directory=parent;}}
    if(this.closed||generation!==this.generation)return;
    for(const directory of directories)try{const watcher=watch(directory,{persistent:false},()=>this.schedule());watcher.on('error',()=>{this.log('An SSH Config watcher stopped. Use Refresh SSH Config to reload.');});this.watchers.push(watcher);}catch{this.log('Could not watch an SSH Config directory. Use Refresh SSH Config to reload.');}
  }
  private schedule():void{if(this.closed)return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=undefined;void this.refresh();},250);}
  dispose():void{this.closed=true;this.generation++;if(this.timer)clearTimeout(this.timer);for(const watcher of this.watchers)watcher.close();this.watchers=[];}
}
