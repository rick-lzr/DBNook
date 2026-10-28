import {mkdir,appendFile,rename,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export function redactDiagnostic(text:string):string {
  return text.replace(/(authorization\s*:\s*Bearer\s+)\S+/gi,'$1[REDACTED]').replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s@/]+@/gi,'$1[REDACTED]@')
    .replace(/((?:["']?)(?:password|passwd|pwd|token|secret|passphrase|authorization|api[_-]?key)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi,'$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[PRIVATE KEY REDACTED]');
}
export function sanitizeDiagnostic<T>(value:T):T {
  const clean=(v:unknown,depth=0):unknown=>{if(depth>12)return '[Nested data omitted]';if(typeof v==='string')return redactDiagnostic(v);if(Array.isArray(v))return v.map(item=>clean(item,depth+1));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([key,item])=>[key,/^(password|passwd|pwd|token|secret|passphrase|authorization|api[_-]?key)$/i.test(key)?'[REDACTED]':clean(item,depth+1)]));return v;};return clean(value) as T;
}
export interface DiagnosticEntry {time:string;level:'info'|'error';stage:string;id:string;message:string;details?:Record<string,unknown>;}
/** Bounded session records and rotating local JSONL; diagnostics must never break a database operation. */
export class DiagnosticLog {
  private rows:DiagnosticEntry[]=[];private pending=Promise.resolve();private failed=false;
  readonly path:string;
  constructor(readonly directory:string,private output:(line:string)=>void,private maxBytes=1_000_000){this.path=join(directory,'db-workbench.jsonl');}
  record(level:DiagnosticEntry['level'],stage:string,message:string,details?:Record<string,unknown>):string {
    const id=randomUUID(),row:DiagnosticEntry=sanitizeDiagnostic({time:new Date().toISOString(),level,stage,id,message:message.slice(0,16000),details});this.rows.push(row);if(this.rows.length>200)this.rows.shift();
    try{this.output(`[${row.time}] ${level.toUpperCase()} ${stage} (${id}) ${row.message}${row.details?' '+JSON.stringify(row.details):''}`);}catch{}
    this.pending=this.pending.then(async()=>{await mkdir(this.directory,{recursive:true});let size=0;try{size=(await stat(this.path)).size;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(size>this.maxBytes){await rm(this.path+'.1',{force:true});await rename(this.path,this.path+'.1');}await appendFile(this.path,JSON.stringify(row)+'\n',{mode:0o600});}).catch(e=>{if(!this.failed){this.failed=true;try{this.output('Diagnostic file could not be written: '+redactDiagnostic(String(e)));}catch{}}});return id;
  }
  entries(){return structuredClone(this.rows);}
  async flush(){await this.pending;}
}
