import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {DiagnosticLog,redactDiagnostic,sanitizeDiagnostic} from '../packages/core/src/diagnostic-log.js';
import {webviewBootstrap} from '../packages/core/src/webview-bootstrap.js';
test('Diagnostics redact credential fields, URI passwords and private keys without breaking structured JSON',()=>{
  const value=sanitizeDiagnostic({password:'one',nested:{token:'two'},message:'postgres://user:three@localhost/db password="four with spaces" api_key=five Authorization: Bearer six\n-----BEGIN OPENSSH PRIVATE KEY-----\nseven\n-----END OPENSSH PRIVATE KEY-----'}),text=JSON.stringify(value);for(const secret of ['one','two','three','four with spaces','five','six','seven'])assert(!text.includes(secret),text);assert.equal(value.password,'[REDACTED]');assert.equal(JSON.parse(text).nested.token,'[REDACTED]');assert.match(redactDiagnostic('token=abc'),/REDACTED/);
});
test('Diagnostics persist errors in order, rotate bounded files and survive an unwritable log target',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'dbw-log-'));try{
    const output:string[]=[],log=new DiagnosticLog(directory,line=>output.push(line),80);const id=log.record('error','table.open.connect','missing runtime password=hidden');await log.flush();assert.equal(JSON.parse((await readFile(log.path,'utf8')).trim()).id,id);log.record('info','activation.ready','ready');await log.flush();assert.match(await readFile(log.path+'.1','utf8'),/table.open.connect/);assert(output.every(s=>!s.includes('hidden')));assert.equal(log.entries().length,2);
    const file=join(directory,'not-directory');await writeFile(file,'x');const broken=new DiagnosticLog(file,line=>output.push(line));broken.record('error','table.open.rows','failure');await broken.flush();assert(output.some(s=>s.includes('could not be written')));assert.equal(broken.entries()[0]?.message,'failure');
  }finally{await rm(directory,{recursive:true,force:true});}
});
function bootstrap(){const nodes:Record<string,any>={'dbw-startup':{hidden:false},root:{style:{display:''}},'dbw-startup-status':{textContent:''}},events:Record<string,Function>={},messages:any[]=[];let timer:Function|undefined,acquires=0,cleared=false;const window:any={addEventListener:(event:string,fn:Function)=>{events[event]=fn;}};runInNewContext(webviewBootstrap,{window,document:{getElementById:(id:string)=>nodes[id]},acquireVsCodeApi:()=>{acquires++;return {postMessage:(v:any)=>messages.push(v)};},setTimeout:(fn:Function)=>{timer=fn;return 1;},clearTimeout:()=>{cleared=true;}});return {window,nodes,events,messages,timeout:()=>timer?.(),acquires:()=>acquires,cleared:()=>cleared};}
test('Offline bootstrap reports missing local scripts and renders actionable diagnostics before the application loads',()=>{
  const b=bootstrap();assert.equal(b.acquires(),1);assert.equal(b.messages[0]?.event,'boot');b.events.error!({target:{tagName:'SCRIPT'}});assert.equal(b.messages.at(-1)?.stage,'webview.script.load');assert.match(b.nodes['dbw-startup-status'].textContent,/failed to load/);assert.equal(b.nodes.root.style.display,'none');b.timeout();assert.equal(b.messages.at(-1)?.stage,'webview.bootstrap.timeout');
});
test('A Webview acknowledgement clears startup state; later nonfatal exceptions keep existing editor data visible',()=>{
  const b=bootstrap();b.window.__dbwBoot.ready();assert(b.cleared());assert.equal(b.nodes['dbw-startup'].hidden,true);assert.equal(b.nodes.root.style.display,'');b.events.unhandledrejection!({reason:new Error('operation error')});assert.equal(b.nodes['dbw-startup'].hidden,true);b.window.__dbwBoot.report('webview.react.render','broken render','',true);assert.equal(b.nodes['dbw-startup'].hidden,false);assert.equal(b.messages.at(-1)?.stage,'webview.react.render');
});
