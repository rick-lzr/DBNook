import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec=promisify(execFile),docker=process.env.DBW_DOCKER??(process.platform==='win32'?'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe':'docker');
const config=resolve('.cache/docker-test');await mkdir(config,{recursive:true});await mkdir('artifacts',{recursive:true});
const prefix=['--config',config,...(process.platform==='win32'?['-H','npipe:////./pipe/dockerDesktopLinuxEngine']:[])];
const call=async args=>(await exec(docker,[...prefix,...args],{windowsHide:true,maxBuffer:2_000_000})).stdout.trim();
const maria=process.argv.includes('--mariadb'),engine=maria?'mariadb':'mysql',image=maria?'mariadb:11.4':'mysql:8.4',client=maria?'mariadb':'mysql';
const name=`dbw-${engine}-test-${Date.now()}`,password=randomBytes(24).toString('base64url');let container;
const setup=`mkdir -p /tmp/dbw-tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/dbw-tls/server.key -out /tmp/dbw-tls/server.crt -days 2 -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' 2>/dev/null
chown mysql:mysql /tmp/dbw-tls/server.key /tmp/dbw-tls/server.crt
chmod 600 /tmp/dbw-tls/server.key
exec docker-entrypoint.sh ${maria?'mariadbd':'mysqld'} --ssl-ca=/tmp/dbw-tls/server.crt --ssl-cert=/tmp/dbw-tls/server.crt --ssl-key=/tmp/dbw-tls/server.key --skip-log-bin`;
try{
  container=(await exec(docker,[...prefix,'run','--detach','--name',name,'--label','db-workbench.role=integration-test','--publish','127.0.0.1::3306','--tmpfs','/var/lib/mysql','--env',maria?'MARIADB_ROOT_PASSWORD':'MYSQL_ROOT_PASSWORD','--env',maria?'MARIADB_PASSWORD':'MYSQL_PASSWORD','--env',`${maria?'MARIADB':'MYSQL'}_USER=dbw`,'--env',`${maria?'MARIADB':'MYSQL'}_DATABASE=dbworkbench`,image,'bash','-ceu',setup],{windowsHide:true,env:{...process.env,MYSQL_ROOT_PASSWORD:password,MYSQL_PASSWORD:password,MARIADB_ROOT_PASSWORD:password,MARIADB_PASSWORD:password}})).stdout.trim();
  let ready=false;
  for(let i=0;i<120;i++){try{await exec(docker,[...prefix,'exec','--env','MYSQL_PWD',container,client,'-h127.0.0.1','-udbw','-Nse','SELECT 1'],{windowsHide:true,env:{...process.env,MYSQL_PWD:password}});ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
  if(!ready){console.error((await call(['logs','--tail','30',container])));throw new Error('Disposable MySQL did not become ready.');}
  const port=Number((await call(['port',container,'3306/tcp'])).split(':').pop()),caDir=resolve('.cache/docker-test',name);await mkdir(caDir,{recursive:true});const ca=resolve(caDir,`${engine}-ca.crt`);await call(['cp',`${container}:/tmp/dbw-tls/server.crt`,ca]);
  const serverVersion=(await exec(docker,[...prefix,'exec','--env','MYSQL_PWD',container,client,'-h127.0.0.1','-udbw','-Nse','SELECT VERSION()'],{windowsHide:true,env:{...process.env,MYSQL_PWD:password}})).stdout.trim();
  const native=process.argv.includes('--extension'),preview=process.argv.includes('--preview');
  const env={...process.env,DBW_MYSQL_TEST:'1',DBW_TEST_ENGINE:engine,DBW_MYSQL_PORT:String(port),DBW_MYSQL_PASSWORD:password,DBW_MYSQL_CA:ca,...(preview?{DBW_PREVIEW_DRIVER:engine,DBW_PREVIEW_PORT:maria?'4325':'4324'}:{})};
  if(process.argv.includes('--mysql-only'))env.DBW_MYSQL_ONLY='1';
  if(native&&!env.VSCODE_EXECUTABLE)env.VSCODE_EXECUTABLE=resolve('.vscode-test/insiders/Code - Insiders.exe');
  const child=spawn(process.execPath,preview?['--import','tsx','packages/dev-server/src/main.ts']:native?['scripts/test-extension.mjs']:['--import','tsx','--test',`tests/${engine}.integration.ts`],{env,stdio:'inherit',windowsHide:true});
  const stop=()=>child.kill();if(preview){process.stdin.once('data',stop);process.stdin.resume();}
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(native&&!process.argv.includes('--mysql-only'))await writeFile(`artifacts/${engine}-full-native.json`,await readFile('artifacts/extension-integration.json','utf8'));
  if(preview){process.stdin.removeListener('data',stop);process.stdin.pause();}else{const imageId=await call(['inspect','--format','{{.Image}}',container]);await writeFile(`artifacts/${engine}-${native?'extension':'integration'}.json`,JSON.stringify({testedAt:new Date().toISOString(),serverVersion,image,imageId,container,loopback:true,tls:true,scope:native?process.argv.includes('--mysql-only')?'engine-only':'full':'driver-contract',passed:code===0},null,2)+'\n');process.exitCode=code===0?0:1;}
}finally{if(container){await call(['rm','--force',container]);console.log(`Removed disposable ${engine} test container.`);}}
