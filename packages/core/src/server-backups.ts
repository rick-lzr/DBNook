import {randomUUID,createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,open,readFile,writeFile,rm,link,lstat,realpath,stat,readdir} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {join,dirname,basename,isAbsolute} from 'node:path';
import {rootCertificates} from 'node:tls';
import {type ConnectionManager,type NativeConnection} from './connections.js';
import {nativeProcess,type NativeExecutor} from './native-process.js';
import {checkAbort} from './data-stream.js';
import {redactDiagnostic} from './diagnostic-log.js';
import {errorMessage,type ConnectionProfile} from '../../protocol/src/index.js';

export interface ServerTools {dump:string;restore:string;}
export interface ServerBackupProgress {phase:string;bytes?:number;}
export interface ServerRestorePreview {token:string;driver:string;source:string;database:string;host:string;port:number;serverVersion:string;toolVersion:string;bytes:number;sha256:string;summary:string;expiresAt:string;warnings:string[];}
export interface ServerBackupReport {jobId:string;kind:'backup'|'restore';driver:string;database:string;status:'succeeded'|'failed'|'cancelled';outcome:'not-started'|'published'|'restored'|'unknown-or-partial';destination?:string;bytes?:number;sha256?:string;toolVersion?:string;serverVersion?:string;startedAt:string;finishedAt:string;reportPath?:string;error?:string;warnings:string[];}
type Plan={preview:ServerRestorePreview;path:string;directory:string;profileId:string;revision:string;toolPath:string;toolSha256:string;expires:number;busy?:boolean;discard?:boolean;};
const digest=async(path:string,signal?:AbortSignal)=>{const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(path)){checkAbort(signal);hash.update(chunk);bytes+=chunk.length;}return {sha256:hash.digest('hex'),bytes};};
const exists=async(path:string)=>{try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
const first=async(path:string,size=65536)=>{const file=await open(path,'r');try{const buffer=Buffer.alloc(size),result=await file.read(buffer,0,size,0);return buffer.subarray(0,result.bytesRead).toString('utf8');}finally{await file.close();}};
const option=(value:string)=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\r','\\r').replaceAll('\n','\\n').replaceAll('\t','\\t')+'"';

/** Native single-database backups and explicit, trusted restores into an empty existing database. */
export class ServerBackups {
  private plans=new Map<string,Plan>();private running=new Map<AbortController,Promise<unknown>>();private targets=new Set<string>();private closed=false;
  constructor(private manager:ConnectionManager,readonly directory:string,private tools:(driver:ConnectionProfile['driver'])=>ServerTools,private execute:NativeExecutor=nativeProcess,private beforeRestore:(id:string)=>Promise<void>=async()=>{},private settled:(id:string)=>Promise<void>=async()=>{}){}
  private operation<T>(signal:AbortSignal|undefined,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Server backup service is closed.'));
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const promise=Promise.resolve().then(async()=>{checkAbort(controller.signal);await mkdir(this.directory,{recursive:true,mode:0o700});return action(controller.signal);}).finally(()=>{this.running.delete(controller);signal?.removeEventListener('abort',abort);});this.running.set(controller,promise);return promise;
  }
  private async target(path:string){if(!isAbsolute(path))throw new Error('Choose an absolute backup destination on the extension host.');const key=join(await realpath(dirname(path)),basename(path));if(await exists(path))throw new Error('Backup destination already exists. Choose a new file.');return process.platform==='win32'?key.toLowerCase():key;}
  private async tool(path:string,driver:string,kind:'dump'|'restore',cwd:string,signal:AbortSignal){
    if(!isAbsolute(path))throw new Error(`Configure an absolute ${driver} ${kind} executable path on the extension host.`);
    const version=await this.execute({executable:path,args:['--version'],cwd,signal,timeoutMs:10000});
    const text=version.stdout.trim(),name=driver==='postgresql'?(kind==='dump'?'pg_dump':'pg_restore'):driver==='mariadb'?(kind==='dump'?'(?:mariadb-dump|mysqldump)':'(?:mariadb|mysql)'):(kind==='dump'?'mysqldump':'mysql');
    if(!new RegExp('(?:^|[/\\\\])'+name+'(?:\\.exe)?\\s','i').test(text)||(driver==='mariadb'?!/MariaDB/i.test(text):driver==='mysql'&&/MariaDB/i.test(text)))throw new Error('The configured native executable does not match the selected database engine and operation.');
    return {version:text,sha256:(await digest(path,signal)).sha256};
  }
  private async connection(c:NativeConnection,cwd:string){
    c.assertCurrent();const p=c.profile,password=c.password??'',env:NodeJS.ProcessEnv={},args:string[]=[];
    if(/[\0]/.test(password))throw new Error('Native password files cannot represent a NUL password.');
    if(p.driver==='postgresql'){
      if(/[\r\n]/.test(password))throw new Error('PostgreSQL native password files cannot represent newline passwords.');
      const pass=join(cwd,'pgpass'),escape=(s:string)=>s.replaceAll('\\','\\\\').replaceAll(':','\\:');await writeFile(pass,`*:*:*:*:${escape(password)}\n`,{mode:0o600,flag:'wx'});
      let ca=p.caPath;if(!ca&&['verify-ca','verify-full'].includes(p.sslMode??'')){ca=join(cwd,'node-root-ca.pem');await writeFile(ca,rootCertificates.join('\n'),{flag:'wx',mode:0o600});}
      Object.assign(env,{PGHOST:p.host,PGPORT:String(c.port),PGDATABASE:p.database,PGUSER:c.user,PGPASSFILE:pass,PGSSLMODE:p.host?.startsWith('/')?'disable':p.sslMode??'disable',PGSSLROOTCERT:ca??join(cwd,'no-default-ca.pem'),PGSSLCERT:p.certPath??join(cwd,'no-default-client.pem'),PGSSLKEY:p.keyPath??join(cwd,'no-default-client.key'),PGCONNECT_TIMEOUT:String(Math.ceil((p.connectTimeout??15000)/1000)),PGAPPNAME:'DBNook native backup',PGGSSENCMODE:'disable'});
      if(c.host!==p.host)env.PGHOSTADDR=c.host;
      args.push('--no-password');
    }else{
      if(p.tunnelRef&&(p.sslMode==='verify-full'))throw new Error('Native MySQL/MariaDB hostname verification through a loopback SSH tunnel is not supported. No TLS downgrade was made.');
      if(p.driver==='mariadb'&&p.sslMode==='verify-ca')throw new Error('The MariaDB native workflow currently supports disable, require without a CA, or verify-full. Certificate-authority-only verification needs separate validation.');
      if(p.driver==='mariadb'&&p.sslMode==='require'&&p.caPath)throw new Error('MariaDB native require with a CA needs separate verification; use a verified compatible profile.');
      const file=join(cwd,'client.cnf');await writeFile(file,`[client]\npassword=${option(password)}\n`,{flag:'wx',mode:0o600});args.push('--defaults-file='+file);
      if(p.driver==='mysql')args.push('--no-login-paths');
      args.push('--protocol=TCP','--host='+c.host,'--port='+c.port,'--user='+c.user,'--default-character-set=utf8mb4');
      const mode=p.sslMode??'disable';if(p.driver==='mysql')args.push('--ssl-mode='+({disable:'DISABLED',require:p.caPath?'VERIFY_CA':'REQUIRED','verify-ca':'VERIFY_CA','verify-full':'VERIFY_IDENTITY'} as Record<string,string>)[mode]);
      else args.push(mode==='disable'?'--skip-ssl':'--ssl',mode==='verify-full'?'--ssl-verify-server-cert':'--skip-ssl-verify-server-cert');
      for(const [key,name]of [['caPath','ssl-ca'],['certPath','ssl-cert'],['keyPath','ssl-key']] as const)if(p[key])args.push('--'+name+'='+p[key]);
    }
    return {args,env,redact:[password]};
  }
  private async checkTarget(c:NativeConnection){
    if(c.profile.readOnly)throw new Error('This connection is read-only. Restore is unavailable.');
    if(this.manager.documentSessions(c.profile.id).some(v=>v.session?.transactionState==='active')||(await this.manager.connect(c.profile.id)).transactionState==='active')throw new Error('Commit or roll back open transactions before restoring.');
    const sql=c.profile.driver==='postgresql'?"SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') AS objects":"SELECT (SELECT count(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()) + (SELECT count(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) + (SELECT count(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()) AS objects";
    if(Number((await c.session.query(sql)).rows[0]?.c0)!==0)throw new Error('Restore currently requires an existing empty database with no user objects. Existing databases are not cleared automatically.');c.assertCurrent();
  }
  private compatible(driver:string,version:string,server:string){
    const client=driver==='postgresql'?version.match(/PostgreSQL\)?\s+(\d+)(?:\.(\d+))?/i):version.match(/(?:Distrib|from)\s+(\d+)\.(\d+)/i)??version.match(/Ver\s+(\d+)\.(\d+)/i),database=server.match(/^(\d+)\.(\d+)/);
    if(!client||!database||Number(client[1])!==Number(database[1])||(driver!=='postgresql'&&Number(client[2])<Number(database[2])))throw new Error('Use native tools matching the server major version (and at least its minor series for MySQL/MariaDB). Cross-major restore needs separate validation.');
  }
  backup(profileId:string,destination:string,progress:(p:ServerBackupProgress)=>void=()=>{},signal?:AbortSignal):Promise<ServerBackupReport>{
    return this.operation(signal,async signal=>{
      const p=this.manager.profile(profileId),revision=this.manager.editorRevision(profileId),report=this.report('backup',p);report.destination=destination;let key:string|undefined,temp:string|undefined,work:string|undefined,acquired=false;
      try{key=await this.target(destination);if(this.targets.has(key))throw new Error('A backup already owns this destination.');this.targets.add(key);acquired=true;work=await mkdtemp(join(this.directory,'job-'));
        await this.manager.withNativeConnection(profileId,signal,async c=>{
          if(this.manager.editorRevision(profileId)!==revision)throw new Error('Source connection changed before backup. Retry with the current connection.');
          const tool=this.tools(p.driver).dump,version=await this.tool(tool,p.driver,'dump',work!,signal);report.toolVersion=version.version;report.serverVersion=c.session.info?.serverVersion??'';this.compatible(p.driver,version.version,report.serverVersion);
          if(p.driver!=='postgresql'&&Number((await c.session.query("SELECT count(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' AND ENGINE <> 'InnoDB'")).rows[0]?.c0))throw new Error('Consistent transactional dump requires all ordinary tables to use InnoDB. Nontransactional engines need a separately reviewed locking backup.');
          const connection=await this.connection(c,work!),args=[...connection.args];temp=join(dirname(destination),'.'+basename(destination)+'.dbw-'+report.jobId+'.tmp');
          if(p.driver==='postgresql')args.push('--format=custom');else args.push('--single-transaction','--quick','--skip-lock-tables','--skip-add-drop-table','--hex-blob','--routines','--events','--triggers',...(p.driver==='mysql'?['--no-tablespaces','--set-gtid-purged=OFF']:[]),'--',p.database!);
          progress({phase:'Creating consistent native dump'});const result=await this.execute({executable:tool,cwd:work!,...connection,args,output:temp,signal,guard:c.assertCurrent,progress:bytes=>progress({phase:'Writing backup',bytes})});if(result.stderr)report.warnings.push(result.stderr);
          c.assertCurrent();Object.assign(report,await digest(temp,signal));if(!report.bytes)throw new Error('Native tool produced an empty backup.');
          const fd=await open(temp,'r+');try{await fd.sync();}finally{await fd.close();}await this.target(destination);progress({phase:'Publishing backup'});checkAbort(signal);c.assertCurrent();await link(temp,destination);report.outcome='published';report.status='succeeded';
        });
      }catch(e){if(report.outcome==='published')report.warnings.push('After publication: '+redactDiagnostic(errorMessage(e)));else{report.status=signal.aborted?'cancelled':'failed';report.error=redactDiagnostic(errorMessage(e));}}
      finally{if(acquired&&key)this.targets.delete(key);for(const path of [temp,work])if(path)try{await rm(path,{recursive:path===work,force:true});}catch(e){report.warnings.push('Temporary cleanup: '+redactDiagnostic(errorMessage(e)));}await this.saveReport(report);}return report;
    });
  }
  previewRestore(profileId:string,source:string,progress:(p:ServerBackupProgress)=>void=()=>{},signal?:AbortSignal):Promise<ServerRestorePreview>{
    return this.operation(signal,async signal=>{
      for(const [token,plan]of this.plans)if(plan.expires<Date.now())await this.forget(token);if(this.plans.size>=10)throw new Error('Close an existing restore preview before creating another.');
      if(!isAbsolute(source)||(await lstat(source)).isSymbolicLink()||!(await stat(source)).isFile())throw new Error('Choose an ordinary backup file on the extension host.');
      const directory=await mkdtemp(join(this.directory,'review-')),path=join(directory,'snapshot'),revision=this.manager.editorRevision(profileId);let retained=false;
      try{progress({phase:'Freezing reviewed backup'});await pipeline(createReadStream(source),createWriteStream(path,{flags:'wx',mode:0o600}),{signal});const hash=await digest(path,signal);if(!hash.bytes)throw new Error('Backup file is empty.');
        const preview=await this.manager.withNativeConnection(profileId,signal,async c=>{
          await this.checkTarget(c);const driver=c.profile.driver,toolPath=this.tools(driver).restore,tool=await this.tool(toolPath,driver,'restore',directory,signal),serverVersion=c.session.info?.serverVersion??'';this.compatible(driver,tool.version,serverVersion);
          const header=await first(path);let summary:string;
          if(driver==='postgresql'){if(!header.startsWith('PGDMP'))throw new Error('Choose a PostgreSQL custom archive (PGDMP), not a plain SQL script.');summary=(await this.execute({executable:toolPath,args:['--list','--format=custom',path],cwd:directory,signal,timeoutMs:30000,truncateCapture:true})).stdout;}
          else{if(driver==='mysql'?(!header.includes('-- MySQL dump')||header.includes('MariaDB dump')):!header.includes('-- MariaDB dump'))throw new Error('Choose a native dump matching this database engine.');summary=header.slice(0,16000);}
          if(this.manager.editorRevision(profileId)!==revision)throw new Error('Target connection changed during preview. Preview again.');
          const sourceDatabase=driver==='postgresql'?summary.match(/;\s+dbname:\s*([^\r\n]+)/)?.[1]:header.match(/^-- Host:.*?Database:\s*(.*?)\r?$/m)?.[1];
          const token=randomUUID(),expires=Date.now()+15*60*1000,preview:ServerRestorePreview={token,driver,source,database:c.profile.database!,host:c.profile.host!,port:c.profile.port??(driver==='postgresql'?5432:3306),serverVersion,toolVersion:tool.version,...hash,summary,expiresAt:new Date(expires).toISOString(),warnings:[driver==='postgresql'?'Restores schema/data in one transaction, without original ownership or ACLs. Cluster roles and server configuration are not restored.':'DDL may commit implicitly. Errors or cancellation can leave partial changes; no automatic retry or rollback is promised.','The selected backup is executable database content. Only restore a trusted source; SQL can reference objects outside the selected database.','The preview freezes the selected bytes. It is not a sandbox or a complete audit of executable SQL. No other writer should use the target during restoration.',...(sourceDatabase&&sourceDatabase!==c.profile.database?[`The dump names source database ${sourceDatabase}. Explicit database references in views, routines and SQL are preserved; restoring under a different name does not rewrite them.`]:[])]};
          this.plans.set(token,{preview,path,directory,profileId,revision,toolPath,toolSha256:tool.sha256,expires});return structuredClone(preview);
        });retained=true;return preview;
      }finally{if(!retained)await rm(directory,{recursive:true,force:true});}
    });
  }
  restore(token:string,confirmation:{database:string;trusted:boolean},progress:(p:ServerBackupProgress)=>void=()=>{},signal?:AbortSignal):Promise<ServerBackupReport>{
    return this.operation(signal,async signal=>{
      const plan=this.plans.get(token);if(!plan||plan.expires<Date.now())throw new Error('Restore preview expired. Preview the backup again.');
      if(!confirmation.trusted||confirmation.database!==plan.preview.database)throw new Error('Confirm the exact target database name and that the backup source is trusted.');
      if(plan.busy)throw new Error('This reviewed backup is already in use.');
      const p=this.manager.profile(plan.profileId),report=this.report('restore',p),key='restore:'+JSON.stringify([p.driver,p.host,p.port??(p.driver==='postgresql'?5432:3306),p.database,p.tunnelRef]);let locked=false,prepared=false;report.sha256=plan.preview.sha256;report.bytes=plan.preview.bytes;report.toolVersion=plan.preview.toolVersion;report.serverVersion=plan.preview.serverVersion;
      plan.busy=true;try{
        if(this.targets.has(key))throw new Error('A restore is already running for this connection.');this.targets.add(key);locked=true;
        if(this.manager.editorRevision(plan.profileId)!==plan.revision||this.tools(p.driver).restore!==plan.toolPath)throw new Error('Target connection or native tool configuration changed after preview. Preview again.');
        if((await digest(plan.path,signal)).sha256!==plan.preview.sha256||(await digest(plan.toolPath,signal)).sha256!==plan.toolSha256)throw new Error('Reviewed backup or native executable changed. Preview again.');
        await this.beforeRestore(p.id);prepared=true;
        await this.manager.withNativeConnection(p.id,signal,async c=>{
          if(this.manager.editorRevision(p.id)!==plan.revision)throw new Error('Target connection changed after preview. Preview again.');
          await this.checkTarget(c);if(c.session.info?.serverVersion!==plan.preview.serverVersion)throw new Error('Server version changed after preview. Preview again.');
          const connection=await this.connection(c,plan.directory),args=[...connection.args];
          if(p.driver==='postgresql')args.push('--format=custom','--single-transaction','--exit-on-error','--no-owner','--no-acl','--dbname='+`host='${(p.host??'').replaceAll('\\','\\\\').replaceAll("'","\\'")}' dbname='${p.database!.replaceAll('\\','\\\\').replaceAll("'","\\'")}'`,plan.path);
          else args.push('--binary-mode','--local-infile=0',...(p.driver==='mariadb'?['--sandbox']:[]),'--database='+p.database!);
          progress({phase:'Restoring reviewed backup'});checkAbort(signal);c.assertCurrent();this.plans.delete(token);report.outcome='unknown-or-partial';
          const result=await this.execute({executable:plan.toolPath,cwd:plan.directory,...connection,args,input:p.driver==='postgresql'?undefined:plan.path,signal,guard:c.assertCurrent,progress:bytes=>progress({phase:'Restoring reviewed backup',bytes})});
          // Exit success is authoritative even if a subsequent UI notification or session cleanup fails.
          report.outcome='restored';report.status='succeeded';if(result.stderr)report.warnings.push(result.stderr);
        });
      }catch(e){if(report.outcome==='restored')report.warnings.push('After restore: '+redactDiagnostic(errorMessage(e)));else{report.status=signal.aborted?'cancelled':'failed';report.error=redactDiagnostic(errorMessage(e));}}
      finally{plan.busy=false;if(locked)this.targets.delete(key);if(!this.plans.has(token)||plan.discard)try{this.plans.delete(token);await rm(plan.directory,{recursive:true,force:true});}catch(e){report.warnings.push('Snapshot cleanup: '+redactDiagnostic(errorMessage(e)));}if(prepared)try{await this.settled(p.id);}catch(e){report.warnings.push('Refresh after restore: '+redactDiagnostic(errorMessage(e)));}await this.saveReport(report);}return report;
    });
  }
  private report(kind:ServerBackupReport['kind'],p:ConnectionProfile):ServerBackupReport{return {jobId:randomUUID(),kind,driver:p.driver,database:p.database??'',status:'failed',outcome:'not-started',startedAt:new Date().toISOString(),finishedAt:'',warnings:[]};}
  reviewSql(token:string,signal?:AbortSignal):Promise<string>{return this.operation(signal,async signal=>{
    const plan=this.plans.get(token);if(!plan||plan.expires<Date.now())throw new Error('Restore preview expired. Preview again.');if(plan.busy)throw new Error('This reviewed backup is already in use.');plan.busy=true;
    try{
    if((await digest(plan.path,signal)).sha256!==plan.preview.sha256||(await digest(plan.toolPath,signal)).sha256!==plan.toolSha256)throw new Error('Reviewed backup or executable changed. Preview again.');
    if(plan.preview.driver!=='postgresql')return plan.path;
    // Each inspection is regenerated from the frozen archive. A failed/cancelled
    // attempt or an edited inspection document must never become a cached review.
    const path=join(plan.directory,'review-'+randomUUID()+'.sql');
    try{await this.execute({executable:plan.toolPath,args:['--no-owner','--no-acl','--file=-',plan.path],cwd:plan.directory,output:path,signal});return path;}
    catch(error){await rm(path,{force:true});throw error;}
    }finally{plan.busy=false;if(plan.discard)await this.forget(token);}
  });}
  private async saveReport(report:ServerBackupReport){report.finishedAt=new Date().toISOString();const path=join(this.directory,report.jobId+'.report.json');try{await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});report.reportPath=path;}catch(e){report.warnings.push('Report write: '+redactDiagnostic(errorMessage(e)));}}
  async forget(token:string){const plan=this.plans.get(token);if(plan?.busy){plan.discard=true;return;}this.plans.delete(token);if(plan)await rm(plan.directory,{recursive:true,force:true});}
  async dispose(){this.closed=true;for(const c of this.running.keys())c.abort();await Promise.allSettled([...this.running.values()]);for(const token of this.plans.keys())await this.forget(token);}
}
