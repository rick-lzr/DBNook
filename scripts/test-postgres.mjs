// Isolated, disposable PostgreSQL service. Does not use the user's Docker config.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
const docker = process.env.DBW_DOCKER ?? (process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker');
const config = resolve('.cache/docker-test'); await mkdir(config,{recursive:true}); await mkdir('artifacts',{recursive:true});
const prefix = ['--config',config,...(process.platform==='win32' ? ['-H','npipe:////./pipe/dockerDesktopLinuxEngine'] : [])];
const call = async args => (await exec(docker,[...prefix,...args],{windowsHide:true,maxBuffer:5_000_000})).stdout.trim();
const name = `dbw-pg-test-${Date.now()}`, password = randomBytes(24).toString('base64url');
const plaintext=process.argv.includes('--plaintext');
const setup = `mkdir -p /tmp/dbw-tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/dbw-tls/server.key -out /tmp/dbw-tls/server.crt -days 2 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2>/dev/null
chown postgres:postgres /tmp/dbw-tls/server.key /tmp/dbw-tls/server.crt
chmod 600 /tmp/dbw-tls/server.key
exec docker-entrypoint.sh postgres -c ssl=${plaintext?'off':'on'} -c ssl_cert_file=/tmp/dbw-tls/server.crt -c ssl_key_file=/tmp/dbw-tls/server.key`;
let container,previewPassfile;
try {
  container = (await exec(docker,[...prefix,'run','--detach','--name',name,'--label','db-workbench.role=integration-test','--publish','127.0.0.1::5432','--tmpfs','/var/lib/postgresql/data','--env','POSTGRES_PASSWORD','--env','POSTGRES_USER=dbw','--env','POSTGRES_DB=dbworkbench','postgres:17-bookworm','bash','-ceu',setup],{env:{...process.env,POSTGRES_PASSWORD:password},windowsHide:true})).stdout.trim();
  let ready=false;
  for(let attempt=0;attempt<60;attempt++) {
    try { await call(['exec',container,'pg_isready','-U','dbw','-d','dbworkbench']);ready=true;break; } catch { await new Promise(resolve=>setTimeout(resolve,500)); }
  }
  if(!ready) throw new Error('Disposable PostgreSQL did not become ready.');
  const port = Number((await call(['port',container,'5432/tcp'])).split(':').pop());
  const caDirectory = resolve('.cache/docker-test',name);await mkdir(caDirectory,{recursive:true});
  const ca = resolve(caDirectory,'postgres-ca.crt'); await call(['cp',`${container}:/tmp/dbw-tls/server.crt`,ca]);
  const version = await call(['exec',container,'psql','-U','dbw','-d','dbworkbench','-Atc','SHOW server_version']);
  const native = process.argv.includes('--extension'), preview = process.argv.includes('--preview');
  if(preview){previewPassfile=resolve(caDirectory,'preview.pgpass');await writeFile(previewPassfile,`localhost:${port}:dbworkbench:dbw:${password}\n127.0.0.1:${port}:dbworkbench:dbw:${password}\n`,{mode:0o600});}
  const env={...process.env,DBW_PG_TEST:'1',DBW_PG_PORT:String(port),DBW_PG_PASSWORD:password,DBW_PG_CA:ca,...(preview?{DBW_PREVIEW_DRIVER:'postgresql',DBW_PREVIEW_PORT:'4323',...(process.argv.includes('--ssh')?{DBW_PREVIEW_SSH:'1'}:{})}:{})};
  if(previewPassfile)env.PGPASSFILE=previewPassfile;
  if(preview&&process.argv.includes('--ssh-config')){env.DBW_PREVIEW_SSH='1';env.DBW_PREVIEW_SSH_CONFIG='1';}
  if(native && !env.VSCODE_EXECUTABLE) env.VSCODE_EXECUTABLE=resolve('.vscode-test/insiders/Code - Insiders.exe');
  const child=spawn(process.execPath,preview?['--import','tsx','packages/dev-server/src/main.ts']:native?['scripts/test-extension.mjs']:['--import','tsx','--test',plaintext?'tests/postgres-plaintext.integration.ts':'tests/postgres.integration.ts'],{env,stdio:preview?['ignore','inherit','inherit']:'inherit',windowsHide:true});
  const stop = ()=>child.kill();
  if(preview) { console.log('Press Enter on this test session to stop the preview and remove its disposable database.'); process.stdin.once('data',stop);process.stdin.resume(); }
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(preview) { process.stdin.removeListener('data',stop);process.stdin.pause(); }
  else { const imageId=await call(['inspect','--format','{{.Image}}',container]); await writeFile(`artifacts/postgres-${native?'extension':plaintext?'plaintext-integration':'integration'}.json`,JSON.stringify({testedAt:new Date().toISOString(),serverVersion:version,image:'postgres:17-bookworm',imageId,container,loopback:true,tls:!plaintext,passed:code===0},null,2)+'\n'); process.exitCode=code===0?0:1; }
} finally {
  try{if(previewPassfile)await unlink(previewPassfile).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  finally{if(container) { await call(['rm','--force',container]); console.log('Removed disposable PostgreSQL test container.'); }}
}
