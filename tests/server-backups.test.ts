import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ServerBackups} from '../packages/core/src/server-backups.js';
import type {ConnectionManager,NativeConnection} from '../packages/core/src/connections.js';
import type {NativeExecutor,NativeProcessRequest} from '../packages/core/src/native-process.js';
import {ProfileSchema} from '../packages/protocol/src/index.js';

async function fixture(driver:'postgresql'|'mysql'|'mariadb'='mysql'){
  const root=await mkdtemp(join(tmpdir(),'dbw-server-backup-')),tool=join(root,'native-tool');await writeFile(tool,'test executable');let revision='r1',objects=0,failRestore=false,failReview=false,restores=0;
  const password='secret+84:/',profile=ProfileSchema.parse({id:'source',name:'Test',driver,storage:'server',host:'127.0.0.1',port:driver==='postgresql'?5432:3306,user:'user',database:'target',sslMode:'disable'});
  const session={connected:true,transactionState:'idle',info:{serverVersion:driver==='postgresql'?'17.11':driver==='mysql'?'8.4.11':'11.4.13-MariaDB'},query:async(sql:string)=>({rows:[{c0:sql.includes("ENGINE <> 'InnoDB'")?0:objects}]})};
  const manager={profile:()=>profile,documentSessions:()=>[],connect:async()=>session,editorRevision:()=>revision,withNativeConnection:async(_id:string,_signal:AbortSignal,action:(c:NativeConnection)=>Promise<unknown>)=>action({profile,session,host:profile.host!,port:profile.port!,user:'user',password,assertCurrent(){}} as unknown as NativeConnection)} as unknown as ConnectionManager;
  const calls:NativeProcessRequest[]=[],body=driver==='postgresql'?'PGDMP frozen archive':`-- ${driver==='mysql'?'MySQL':'MariaDB'} dump\nCREATE TABLE t(v int);`;
  const execute:NativeExecutor=async r=>{calls.push(r);assert(!r.args.some(a=>a.includes(password)));if(r.args.includes('--version'))return {stdout:driver==='postgresql'?'pg_restore (PostgreSQL) 17.11':driver==='mysql'?'mysql Ver 8.4.11 for Linux':'mariadb Ver 15.1 Distrib 11.4.13-MariaDB',stderr:'',bytes:0};
    if(r.args.includes('--list'))return {stdout:'TABLE public t\nTABLE DATA public t',stderr:'',bytes:32};
    if(r.output){await writeFile(r.output,body,{flag:'wx'});if(failReview&&r.args.includes('--file=-')){failReview=false;await writeFile(r.output,'partial SQL');throw new Error('injected SQL inspection failure');}r.progress?.(body.length);return {stdout:'',stderr:'',bytes:body.length};}
    if(r.input||r.args.includes('--single-transaction')){restores++;if(failRestore)throw new Error('injected native failure');if(r.input)assert.equal(await readFile(r.input,'utf8'),body);}
    return {stdout:'',stderr:'',bytes:0};};
  // Each role gets a distinct version string, catching swapped dump/restore paths.
  const wrapped:NativeExecutor=r=>{if(r.args.includes('--version')&&r.executable.endsWith('dump'))return Promise.resolve({stdout:driver==='postgresql'?'pg_dump (PostgreSQL) 17.11':driver==='mysql'?'mysqldump Ver 8.4.11 for Linux':'mariadb-dump Ver 10.19 Distrib 11.4.13-MariaDB',stderr:'',bytes:0});return execute(r);};
  const dump=tool+'dump';await writeFile(dump,'dump executable');const service=new ServerBackups(manager,join(root,'jobs'),()=>({dump,restore:tool}),wrapped);
  return {root,tool,dump,service,calls,profile,password,body,setRevision(){revision='r2';},setObjects(n:number){objects=n;},failRestore(){failRestore=true;},failReview(){failReview=true;},get restores(){return restores;},async close(){await service.dispose();await rm(root,{recursive:true,force:true});}};
}
test('native backup publishes exclusively, streams correct dump arguments and keeps credentials out of reports',async()=>{
  const f=await fixture();try{const path=join(f.root,'backup.sql'),report=await f.service.backup('source',path);assert.equal(report.status,'succeeded');assert.equal(report.outcome,'published');assert.equal(await readFile(path,'utf8'),f.body);assert(f.calls.some(c=>c.args.includes('--single-transaction')&&c.args.includes('--set-gtid-purged=OFF')&&c.args.at(-1)==='target'));assert(!(await readFile(report.reportPath!,'utf8')).includes(f.password));assert.equal((await f.service.backup('source',path)).status,'failed');assert.equal(await readFile(path,'utf8'),f.body);
  }finally{await f.close();}
});
test('restore executes frozen reviewed SQL once, preserves original source changes and enforces confirmation',async()=>{
  const f=await fixture();try{const source=join(f.root,'source.sql');await writeFile(source,f.body);const preview=await f.service.previewRestore('source',source);assert.equal(f.restores,0);await assert.rejects(f.service.restore(preview.token,{database:'wrong',trusted:true}),/Confirm/);await writeFile(source,'changed source');const report=await f.service.restore(preview.token,{database:'target',trusted:true});assert.equal(report.outcome,'restored');assert.equal(f.restores,1);await assert.rejects(f.service.restore(preview.token,{database:'target',trusted:true}),/expired/);assert(f.calls.some(c=>c.input&&c.args.includes('--binary-mode')&&c.args.includes('--local-infile=0')));
  }finally{await f.close();}
});
test('restore blocks nonempty targets, changed profiles, changed executables and tampered snapshots before execution',async()=>{
  const f=await fixture();try{const source=join(f.root,'source.sql');await writeFile(source,f.body);f.setObjects(1);await assert.rejects(f.service.previewRestore('source',source),/empty/);f.setObjects(0);const p=await f.service.previewRestore('source',source);await writeFile(f.tool,'changed executable');assert.match((await f.service.restore(p.token,{database:'target',trusted:true})).error!,/changed/);assert.equal(f.restores,0);await f.service.forget(p.token);const q=await f.service.previewRestore('source',source);const dir=(await readdir(join(f.root,'jobs'))).find(n=>n.startsWith('review-'))!;await writeFile(join(f.root,'jobs',dir,'snapshot'),'tampered');assert.match((await f.service.restore(q.token,{database:'target',trusted:true})).error!,/changed/);await f.service.forget(q.token);const r=await f.service.previewRestore('source',source);f.setRevision();assert.match((await f.service.restore(r.token,{database:'target',trusted:true})).error!,/connection.*changed/i);assert.equal(f.restores,0);
  }finally{await f.close();}
});
test('cancel before backup publication preserves the destination and a native restore failure is never reported as rolled back',async()=>{
  const f=await fixture();try{const destination=join(f.root,'cancel.sql'),controller=new AbortController();const cancelled=await f.service.backup('source',destination,p=>{if(p.phase==='Publishing backup')controller.abort();},controller.signal);assert.equal(cancelled.status,'cancelled');await assert.rejects(stat(destination),{code:'ENOENT'});const source=join(f.root,'source.sql');await writeFile(source,f.body);const p=await f.service.previewRestore('source',source);f.failRestore();const report=await f.service.restore(p.token,{database:'target',trusted:true});assert.equal(report.status,'failed');assert.equal(report.outcome,'unknown-or-partial');assert.equal(f.restores,1);
  }finally{await f.close();}
});
test('PostgreSQL archive inspection and restore use custom archives with a single transaction',async()=>{
  const f=await fixture('postgresql');try{const source=join(f.root,'archive.dump');await writeFile(source,f.body);const p=await f.service.previewRestore('source',source);assert(p.summary.includes('TABLE DATA'));const r=await f.service.restore(p.token,{database:'target',trusted:true});assert.equal(r.status,'succeeded');assert(f.calls.some(c=>c.args.includes('--single-transaction')&&c.args.includes('--exit-on-error')&&c.args.includes('--no-owner')));
  }finally{await f.close();}
});
test('PostgreSQL SQL inspection retries regenerate frozen content instead of reusing partial or edited files',async()=>{
  const f=await fixture('postgresql');try{const source=join(f.root,'archive.dump');await writeFile(source,f.body);const p=await f.service.previewRestore('source',source);f.failReview();await assert.rejects(f.service.reviewSql(p.token),/inspection failure/);const failed=f.calls.find(c=>c.args.includes('--file=-'))!.output!;await assert.rejects(stat(failed),{code:'ENOENT'});const complete=await f.service.reviewSql(p.token);assert.equal(await readFile(complete,'utf8'),f.body);await writeFile(complete,'edited inspection');const regenerated=await f.service.reviewSql(p.token);assert.notEqual(regenerated,complete);assert.equal(await readFile(regenerated,'utf8'),f.body);assert.equal(f.restores,0);
  }finally{await f.close();}
});
