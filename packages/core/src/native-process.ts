import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {isAbsolute} from 'node:path';
import {stat} from 'node:fs/promises';
import {redactDiagnostic} from './diagnostic-log.js';

export interface NativeProcessRequest {executable:string;args:string[];cwd:string;env?:NodeJS.ProcessEnv;input?:string;output?:string;signal?:AbortSignal;guard?:()=>void;progress?:(bytes:number)=>void;captureLimit?:number;truncateCapture?:boolean;timeoutMs?:number;redact?:string[];}
export interface NativeProcessResult {stdout:string;stderr:string;bytes:number;}
export type NativeExecutor=(request:NativeProcessRequest)=>Promise<NativeProcessResult>;
/** No shell, bounded diagnostics, streamed files, and completion only after the child and file streams close. */
export const nativeProcess:NativeExecutor=async request=>{
  if(!isAbsolute(request.executable)||(process.platform==='win32'&&/\.(?:cmd|bat|ps1)$/i.test(request.executable)))throw new Error('Choose an absolute native executable path on the extension host; shell scripts are not supported.');
  if(!(await stat(request.executable)).isFile())throw new Error('Native tool path is not a file.');
  request.guard?.();if(request.signal?.aborted)throw new Error('Native operation cancelled.');
  const env:NodeJS.ProcessEnv={};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','LD_LIBRARY_PATH'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{HOME:request.cwd,USERPROFILE:request.cwd,APPDATA:request.cwd,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},request.env);
  const child=spawn(request.executable,request.args,{cwd:request.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',bytes=0,failure:Error|undefined,closed=false;
  const fail=(error:unknown)=>{failure??=error instanceof Error?error:new Error(String(error));if(!closed)child.kill();};
  const exit=new Promise<void>((resolve,reject)=>{child.once('error',fail);child.once('close',code=>{closed=true;if(code!==0&&!failure)failure=new Error(`Native tool exited (${code}): ${stderr.trim()}`);failure?reject(failure):resolve();});});
  const abort=()=>fail(request.signal?.reason instanceof Error?request.signal.reason:new Error('Native operation cancelled.'));request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();
  const timer=setInterval(()=>{try{request.guard?.();}catch(e){fail(e);}},250),timeout=request.timeoutMs?setTimeout(()=>fail(new Error('Native tool timed out.')),request.timeoutMs):undefined;
  child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-32768);});
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;try{request.progress?.(bytes);if(!request.output){const limit=request.captureLimit??1024*1024;if(request.truncateCapture){const remaining=limit-Buffer.byteLength(stdout);if(remaining>0)stdout+=chunk.subarray(0,remaining).toString();}else{stdout+=chunk.toString();if(Buffer.byteLength(stdout)>limit)fail(new Error('Native tool inspection output exceeds its capture limit.'));}}}catch(e){fail(e);}});
  const transfers:Promise<unknown>[]=[];
  if(request.output)transfers.push(pipeline(child.stdout,createWriteStream(request.output,{flags:'wx',mode:0o600})).catch(e=>{fail(e);throw e;}));
  if(request.input)transfers.push(pipeline(createReadStream(request.input),child.stdin).catch(e=>{fail(e);throw e;}));else child.stdin.end();
  try{const results=await Promise.allSettled([exit,...transfers]);const rejected=results.find((r):r is PromiseRejectedResult=>r.status==='rejected');if(rejected)throw rejected.reason;for(const secret of request.redact??[])if(secret)stderr=stderr.split(secret).join('[redacted]');if(request.truncateCapture&&bytes>(request.captureLimit??1024*1024))stdout+='\n[Inspection output truncated. Open full SQL for inspection.]';return {stdout,stderr:redactDiagnostic(stderr),bytes};}
  catch(error){let message=error instanceof Error?error.message:String(error);for(const secret of request.redact??[])if(secret)message=message.split(secret).join('[redacted]');throw new Error(redactDiagnostic(message));}
  finally{clearInterval(timer);if(timeout)clearTimeout(timeout);request.signal?.removeEventListener('abort',abort);}
};
