import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';

const root=process.cwd(),script=(name:string)=>resolve(root,'scripts',name);
async function fixture(){
  const parent=resolve('.cache/publication-tests');await mkdir(parent,{recursive:true});
  const directory=await mkdtemp(join(parent,'repo-'));
  const manifest={name:'dbnook',version:'0.27.0',license:'GPL-3.0-only',preview:true,private:true};
  await writeFile(join(directory,'package.json'),JSON.stringify(manifest));
  await writeFile(join(directory,'package-lock.json'),JSON.stringify({name:manifest.name,version:manifest.version,packages:{'':manifest}}));
  await writeFile(join(directory,'LICENSE.txt'),await readFile(join(root,'LICENSE.txt')));
  execFileSync('git',['init','-b','main'],{cwd:directory,stdio:'ignore',windowsHide:true});
  const run=(name:string,args:string[]=[])=>spawnSync(process.execPath,[script(name),...args],{cwd:directory,encoding:'utf8',windowsHide:true});
  const cleanup=async()=>{assert(directory.startsWith(parent+ (process.platform==='win32'?'\\':'/')));await rm(directory,{recursive:true,force:true});};
  return {directory,run,cleanup};
}

test('Publication configuration updates both manifests without publishing and rejects credential-bearing URLs before changing files',async()=>{
  const f=await fixture();try{
    const before=await readFile(join(f.directory,'package.json'),'utf8');
    const bad=f.run('configure-publication.mjs',['--repository','https://user:secret@github.com/team/dbnook','--publisher','team','--author','Team','--version','0.28.0']);
    assert.notEqual(bad.status,0);assert.equal(await readFile(join(f.directory,'package.json'),'utf8'),before);
    const ok=f.run('configure-publication.mjs',['--repository','https://github.com/team/dbnook.git','--publisher','team','--author','Team','--version','0.28.0']);
    assert.equal(ok.status,0,ok.stderr);const p=JSON.parse(await readFile(join(f.directory,'package.json'),'utf8')),lock=JSON.parse(await readFile(join(f.directory,'package-lock.json'),'utf8'));
    assert.equal(p.repository.url,'https://github.com/team/dbnook.git');assert.equal(p.bugs.url,'https://github.com/team/dbnook/issues');assert.equal(p.author,'Team');assert.equal(lock.version,p.version);assert.equal(lock.packages[''].license,'GPL-3.0-only');
  }finally{await f.cleanup();}
});

test('Public audit distinguishes ignored private files from forcibly tracked files and never prints matched tokens',async()=>{
  const f=await fixture();try{
    await writeFile(join(f.directory,'.gitignore'),'.cache/\n*.vsix\n');await mkdir(join(f.directory,'.cache'));
    const token='ghp_'+'A'.repeat(36);await writeFile(join(f.directory,'.cache','private.txt'),token);
    assert.equal(f.run('audit-public.mjs').status,0);
    await writeFile(join(f.directory,'third-party.vsix'),token);
    execFileSync('git',['add','--force','third-party.vsix'],{cwd:f.directory,stdio:'ignore',windowsHide:true});
    const rejected=f.run('audit-public.mjs');assert.notEqual(rejected.status,0);assert(rejected.stdout.includes('third-party.vsix'));assert(!rejected.stdout.includes(token));assert(!rejected.stderr.includes(token));
  }finally{await f.cleanup();}
});

test('Public audit rejects links into ignored local evidence and blocks publication before identity is configured',async()=>{
  const f=await fixture();try{
    await writeFile(join(f.directory,'README.md'),'[Evidence](artifacts/private.json)');
    const rejected=f.run('audit-public.mjs');assert.notEqual(rejected.status,0);assert(rejected.stdout.includes('Broken or non-public'));
    await writeFile(join(f.directory,'README.md'),'# Example');
    const release=f.run('audit-public.mjs',['--release']);assert.notEqual(release.status,0);assert(release.stdout.includes('Publisher'));assert(release.stdout.includes('new version'));
  }finally{await f.cleanup();}
});

test('Offline runtime preparation rejects a tampered cached archive before replacing runtime files',async()=>{
  const f=await fixture();try{
    const directory=join(f.directory,'.cache','node-distributions','22.22.2');await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'node-v22.22.2-win-x64.zip'),'tampered archive');
    const runtime=join(f.directory,'runtime','win32-x64');await mkdir(runtime,{recursive:true});await writeFile(join(runtime,'node.exe'),'keep existing');
    const result=f.run('prepare-offline-runtime.mjs');assert.notEqual(result.status,0);assert.match(result.stderr,/checksum mismatch/);assert.equal(await readFile(join(runtime,'node.exe'),'utf8'),'keep existing');
  }finally{await f.cleanup();}
});
