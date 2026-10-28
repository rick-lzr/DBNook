import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
const path=process.argv[2];if(!path)throw new Error('Usage: node scripts/verify-vsix.mjs FILE [--offline]');
const offline=process.argv.includes('--offline'),bytes=await readFile(path),zip=await JSZip.loadAsync(bytes),p=JSON.parse(await readFile('package.json','utf8'));
const payload=['package.json','README.md','CHANGELOG.md','LICENSE.txt','THIRD_PARTY_NOTICES.txt','NOTICE.md','media/database.svg','media/icon.png','media/icon.svg','dist/extension.cjs','dist/sqlite-runner.cjs','dist/sql-worker.cjs','dist/webview/app.js','dist/webview/app.css'];
if(offline)payload.push('runtime/win32-x64/node.exe','runtime/win32-x64/LICENSE.txt','runtime/win32-x64/provenance.json');
const entryName=file=>'extension/'+(file==='README.md'?'readme.md':file.toLowerCase()==='changelog.md'?'changelog.md':file);
const allowed=new Set(['[Content_Types].xml','extension.vsixmanifest',...payload.map(entryName)]);
for(const entry of Object.values(zip.files))if(!entry.dir&&!allowed.has(entry.name))throw new Error('Unexpected VSIX file: '+entry.name);
for(const file of payload)if(!zip.file(entryName(file)))throw new Error('Missing VSIX file: '+file);
const bundled=JSON.parse(await zip.file('extension/package.json').async('string'));
if(bundled.name!==p.name||bundled.version!==p.version||bundled.publisher!==p.publisher||bundled.license!==p.license)throw new Error('Packaged identity/license differs from source.');
for(const file of payload.filter(file=>file!=='README.md')){
  const packaged=await zip.file(entryName(file)).async('nodebuffer');
  if(!(await readFile(file)).equals(packaged))throw new Error('Packaged file differs from source: '+file);
}
if(!(await zip.file(entryName('README.md')).async('nodebuffer')).equals(await readFile('docs/extension-readme.md')))throw new Error('Packaged README differs.');
if(offline){const provenance=JSON.parse(await zip.file('extension/runtime/win32-x64/provenance.json').async('string'));const runtime=await zip.file('extension/runtime/win32-x64/node.exe').async('nodebuffer');if(createHash('sha256').update(runtime).digest('hex')!==provenance.executableSha256)throw new Error('Runtime provenance hash differs.');}
const sha256=createHash('sha256').update(bytes).digest('hex');
await writeFile(path+'.sha256',`${sha256}  ${path.split(/[\\/]/).at(-1)}\n`);
console.log(JSON.stringify({passed:true,name:p.name,version:p.version,offline,files:allowed.size,bytes:bytes.length,sha256},null,2));
