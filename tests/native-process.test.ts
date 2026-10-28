import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeProcess} from '../packages/core/src/native-process.js';

test('native tool files stream without a shell and preserve binary bytes and literal arguments',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'dbw native '));try{
    const input=join(cwd,'中文 input.bin'),output=join(cwd,'out.bin'),bytes=Buffer.alloc(2_000_000);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;await writeFile(input,bytes);
    const value='literal "$() & spaces';const result=await nativeProcess({executable:process.execPath,args:['-e','if(process.argv[1]!==process.env.EXPECT)process.exit(3);process.stdin.pipe(process.stdout)',value],cwd,env:{EXPECT:value},input,output});assert.equal(result.bytes,bytes.length);assert.deepEqual(await readFile(output),bytes);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('native cancellation waits for process exit and prevents a late side effect',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'dbw-native-cancel-'));try{
    const marker=join(cwd,'late'),controller=new AbortController();const promise=nativeProcess({executable:process.execPath,args:['-e','process.stdout.write("ready");setTimeout(()=>require("fs").writeFileSync(process.argv[1],"late"),3000)',marker],cwd,signal:controller.signal,progress:()=>controller.abort()});await assert.rejects(promise,/cancel|abort/i);await assert.rejects(stat(marker),{code:'ENOENT'});
  }finally{await rm(cwd,{recursive:true,force:true});}
});
test('native failures redact exact secrets and enforce bounded inspection output',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'dbw-native-errors-'));try{
    await assert.rejects(nativeProcess({executable:process.execPath,args:['-e','process.stderr.write("secret-value-67");process.exit(2)'],cwd,redact:['secret-value-67']}),e=>{assert(e instanceof Error);assert(!e.message.includes('secret-value-67'));return true;});
    await assert.rejects(nativeProcess({executable:process.execPath,args:['-e','process.stdout.write("a".repeat(2000000))'],cwd,captureLimit:1000}),/exceeds/);
    const summary=await nativeProcess({executable:process.execPath,args:['-e','process.stdout.write("a".repeat(2000000))'],cwd,captureLimit:1000,truncateCapture:true});assert.equal(summary.bytes,2_000_000);assert(summary.stdout.length<1200);assert(summary.stdout.includes('truncated'));
    await assert.rejects(nativeProcess({executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd,timeoutMs:30}),/timed out/);
  }finally{await rm(cwd,{recursive:true,force:true});}
});
