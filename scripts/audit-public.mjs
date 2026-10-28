// Checks Git's actual source set, including accidentally forced tracked files.
// Reports locations only; never prints matching credential values.
import {execFileSync} from 'node:child_process';
import {readFile,lstat} from 'node:fs/promises';
import {extname,resolve,relative,isAbsolute,posix} from 'node:path';
const release=process.argv.includes('--release'),issues=[];
const fail=(file,reason)=>issues.push({file,reason});
let files;
try{files=[...new Set(execFileSync('git',['-c','core.excludesFile=.git/info/exclude','ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8',maxBuffer:10_000_000}).split('\0').filter(Boolean))];}
catch{throw new Error('Git source inventory is unavailable. Initialize a repository and resolve any ownership/access errors shown above.');}
const excluded=/^(?:analysis|artifacts|\.cache|\.vscode-test|node_modules|dist|runtime)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|id_rsa[^/]*|id_ed25519[^/]*)$|\.(?:vsix|exe|db|sqlite3?|pem|key|pfx|p12|pgpass)(?:-|$)/i;
const allowedRoots=new Set(['packages','tests','scripts','docs','media','.github','.vscode']);
const allowedRootFiles=new Set(['.gitignore','.gitattributes','.editorconfig','.npmrc','.vscodeignore','.vscodeignore-offline','package.json','package-lock.json','tsconfig.json','vite.config.ts','README.md','README.en.md','LICENSE.txt','THIRD_PARTY_NOTICES.txt','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md','NOTICE.md']);
const publicDocs=new Set(['extension-readme.md','development.md','publishing.md','roadmap.md','privacy.md']);
const publicScripts=new Set(['build.mjs','generate-notices.mjs','prepare-offline-runtime.mjs','package.mjs','configure-publication.mjs','audit-public.mjs','verify-vsix.mjs','generate-icon.ps1','test-extension.mjs','test-postgres.mjs','test-mysql.mjs','test-mariadb.mjs','test-structure-matrix.mjs']);
const secretPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{32,}/g,/\b(?:ghp_|gho_|ghu_|ghs_)[A-Za-z0-9]{36,}\b/g,/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,/\bAKIA[0-9A-Z]{16}\b/g,/\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{30,}\b/g,/\b(?:_authToken|VSCODE_PAT|VSCE_PAT)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{20,}/g];
for(const file of files){
  const normalized=file.replaceAll('\\','/'),parts=normalized.split('/'),absolute=resolve(file),rel=relative(process.cwd(),absolute);
  if(rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel)){fail(file,'Path escapes repository');continue;}
  if(excluded.test(normalized)||(!allowedRoots.has(parts[0])&&!allowedRootFiles.has(normalized)))fail(file,'File is outside public source boundaries');
  if(parts[0]==='docs'&&(parts.length!==2||!publicDocs.has(parts[1])))fail(file,'Internal document is not in the public allowlist');
  if(parts[0]==='scripts'&&(parts.length!==2||!publicScripts.has(parts[1])))fail(file,'Internal script is not in the public allowlist');
  if(parts[0]==='.vscode'&&!['.vscode/launch.json','.vscode/tasks.json'].includes(normalized))fail(file,'Personal editor configuration');
  const info=await lstat(absolute);if(info.isSymbolicLink()||!info.isFile()){fail(file,'Only regular source files are allowed');continue;}
  if(info.size>2_000_000){fail(file,'Unexpectedly large source asset');continue;}
  if(extname(file)==='.png')continue;
  const text=await readFile(absolute,'utf8');
  for(const pattern of secretPatterns){pattern.lastIndex=0;if(pattern.test(text))fail(file,'Possible embedded credential: review privately');}
  if(/ag-grid-enterprise|LicenseManager\.setLicenseKey/.test(text)&&normalized.startsWith('packages/'))fail(file,'Unreviewed proprietary grid component');
  if(normalized.endsWith('.md')){
    for(const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)){
      const target=match[1];if(/^[a-z][a-z0-9+.-]*:|^#/i.test(target))continue;
      const path=posix.normalize(posix.join(posix.dirname(normalized),decodeURIComponent(target.split('#')[0])));
      if(!files.includes(path))fail(file,'Broken or non-public documentation link: '+path);
    }
  }
}
const p=JSON.parse(await readFile('package.json','utf8')),lock=JSON.parse(await readFile('package-lock.json','utf8'));
if(p.license!=='GPL-3.0-only'||lock.packages[''].license!==p.license)fail('package.json','GPL license metadata inconsistent');
if(lock.name!==p.name||lock.version!==p.version||lock.packages[''].name!==p.name||lock.packages[''].version!==p.version)fail('package-lock.json','Root identity/version differs');
const license=await readFile('LICENSE.txt','utf8');if(!license.includes('Version 3, 29 June 2007')||!license.includes('END OF TERMS AND CONDITIONS')||license.length<30000)fail('LICENSE.txt','Full GPLv3 text missing');
if(release){
  if(!p.publisher||/^local-|YOUR|example/i.test(p.publisher))fail('package.json','Actual Marketplace Publisher ID is required');
  const author=typeof p.author==='string'?p.author:p.author?.name;if(!author)fail('package.json','Public author/organization is required');
  if(!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(p.repository?.url??'')||/\/OWNER\/|\/REPO\./.test(p.repository?.url??''))fail('package.json','Actual GitHub repository URL is required');
  if(p.version==='0.27.0')fail('package.json','Use a new version for the public identity');
  if(p.preview!==true)fail('package.json','Keep Preview until release acceptance is complete');
  try{const icon=await readFile(p.icon);if(icon.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||icon.readUInt32BE(16)<128||icon.readUInt32BE(20)<128)fail(p.icon,'Marketplace needs a PNG icon of at least 128x128');}catch{fail('package.json','Marketplace PNG icon missing');}
}
console.log(JSON.stringify({scope:release?'publication-readiness':'public-source',files:files.length,passed:issues.length===0,issues},null,2));
if(issues.length)process.exitCode=1;
