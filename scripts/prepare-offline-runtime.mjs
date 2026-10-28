import {readFile,mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import JSZip from 'jszip';
// Review this version/hash pair together when upgrading the official runtime.
const version='22.22.2',archiveSha256='7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c';
const name=`node-v${version}-win-x64.zip`,directory=resolve('.cache/node-distributions',version),archive=join(directory,name),target=resolve('runtime/win32-x64');
const source=`https://nodejs.org/dist/v${version}/${name}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(directory,{recursive:true});
let bytes;
try{bytes=await readFile(archive);}catch(error){
  if(error.code!=='ENOENT')throw error;
  console.log(`Downloading official Node.js ${version} Windows x64 runtime…`);
  const response=await fetch(source,{redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok||!response.body)throw new Error('Official runtime download failed: '+response.status);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>80_000_000)throw new Error('Unexpected runtime download size');chunks.push(chunk);}
  bytes=Buffer.concat(chunks);
  if(hash(bytes)!==archiveSha256)throw new Error('Official Node.js archive checksum mismatch; cache was not updated.');
  const pending=archive+'.'+randomUUID()+'.tmp';
  try{await writeFile(pending,bytes,{flag:'wx'});await rename(pending,archive);}finally{await unlink(pending).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
if(hash(bytes)!==archiveSha256)throw new Error('Cached Node.js archive checksum mismatch. Replace it with the pinned official archive.');
// Read only the two allowlisted entries from the verified ZIP. Never trust a
// previously extracted directory or extract arbitrary archive paths to disk.
const zip=await JSZip.loadAsync(bytes),prefix=`node-v${version}-win-x64/`;
const node=zip.file(prefix+'node.exe'),license=zip.file(prefix+'LICENSE');
if(!node||!license)throw new Error('Official runtime archive is missing its executable/license.');
const executable=await node.async('nodebuffer');
await mkdir(target,{recursive:true});
await writeFile(join(target,'node.exe'),executable);
await writeFile(join(target,'LICENSE.txt'),await license.async('nodebuffer'));
await writeFile(join(target,'provenance.json'),JSON.stringify({name:'Node.js',version,platform:'win32',arch:'x64',source,checksums:`https://nodejs.org/dist/v${version}/SHASUMS256.txt`,archiveSha256,executableSha256:hash(executable),license:'LICENSE.txt'},null,2)+'\n');
console.log(`Prepared official Node.js ${version} win32-x64 runtime; SHA-256 ${hash(executable)}`);
