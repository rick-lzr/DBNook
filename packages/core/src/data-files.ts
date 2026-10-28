import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {checkAbort} from './data-stream.js';
export interface SourceCell{text:string;quoted:boolean;}
export interface SourceRow{index:number;line?:number;cells?:SourceCell[];value?:unknown;}
export interface DataFileOptions{format:'csv'|'json';delimiter:','|';'|'\t';header:boolean;nullToken:string;}
export interface FileMetadata{headers:string[];typed:boolean;truncated:boolean;rows:number;sha256:string;bytes:number;}
export class ExactNumber{constructor(readonly text:string){}}
/** JSON number lexemes never pass through JavaScript Number before target-type conversion. */
export function parseExactJSON(text:string):unknown{
  let i=0;const ws=()=>{while(/[ \t\r\n]/.test(text[i]??'')&&i<text.length)i++;};
  const value=(depth:number):unknown=>{if(depth>128)throw new Error('JSON nesting exceeds 128 levels.');ws();const c=text[i];
    if(c==='"'){const start=i++;let escaped=false;while(i<text.length){const ch=text[i++]!;if(!escaped&&ch==='"')return JSON.parse(text.slice(start,i));if(!escaped&&ch==='\\')escaped=true;else escaped=false;}throw new Error('Unclosed JSON string.');}
    if(c==='['){i++;const result:unknown[]=[];ws();if(text[i]===']'){i++;return result;}for(;;){result.push(value(depth+1));ws();if(text[i]===']'){i++;return result;}if(text[i++]!==',')throw new Error('Invalid JSON array.');}}
    if(c==='{'){i++;const result:Record<string,unknown>=Object.create(null);ws();if(text[i]==='}'){i++;return result;}for(;;){ws();if(text[i]!=='"')throw new Error('JSON keys must be strings.');const key=value(depth+1) as string;ws();if(text[i++]!==':')throw new Error('Missing JSON colon.');if(Object.hasOwn(result,key))throw new Error(`Duplicate JSON key: ${key}`);result[key]=value(depth+1);ws();if(text[i]==='}'){i++;return result;}if(text[i++]!==',')throw new Error('Invalid JSON object.');}}
    for(const [token,result] of [['null',null],['true',true],['false',false]] as const)if(text.startsWith(token,i)){i+=token.length;return result;}
    const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));if(!number)throw new Error('Invalid JSON value.');i+=number[0].length;return new ExactNumber(number[0]);
  };const result=value(0);ws();if(i!==text.length)throw new Error('Unexpected trailing JSON content.');return result;
}
export function exactJson(value:unknown):string{if(value instanceof ExactNumber)return value.text;if(Array.isArray(value))return '['+value.map(exactJson).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+':'+exactJson(v)).join(',')+'}';return JSON.stringify(value);}
class CsvRows{
  private state:'plain'|'quoted'|'closed'='plain';private field='';private fields:SourceCell[]=[];private quoted=false;private skipLF=false;private prevCR=false;private line=1;private start=1;private index=0;private touched=false;private rowChars=0;
  constructor(private delimiter:string){}
  push(text:string,final=false):SourceRow[]{const result:SourceRow[]=[];
    const cell=()=>{this.fields.push({text:this.field,quoted:this.quoted});if(this.fields.length>10000)throw new Error('A CSV row exceeds 10,000 fields.');this.field='';this.quoted=false;this.state='plain';};
    const row=()=>{cell();result.push({index:this.index++,line:this.start,cells:this.fields});this.fields=[];this.touched=false;this.start=this.line;this.rowChars=0;};
    for(const c of text){if(++this.rowChars>16_000_000)throw new Error('A CSV row exceeds 16 million characters.');if(c==='\r')this.line++;else if(c==='\n'&&!this.prevCR)this.line++;this.prevCR=c==='\r';if(this.skipLF){this.skipLF=false;if(c==='\n')continue;}this.touched=true;
      if(this.state==='quoted'){if(c==='"')this.state='closed';else this.field+=c;}
      else if(this.state==='closed'){if(c==='"'){this.field+='"';this.state='quoted';}else if(c===this.delimiter)cell();else if(c==='\r'||c==='\n'){row();this.skipLF=c==='\r';}else throw new Error(`Unexpected character after CSV quote on line ${this.line}.`);}
      else if(c===this.delimiter)cell();else if(c==='\r'||c==='\n'){row();this.skipLF=c==='\r';}else if(c==='"'){if(this.field)throw new Error(`Unescaped CSV quote on line ${this.line}.`);this.quoted=true;this.state='quoted';}else this.field+=c;
      if(this.field.length>16_000_000)throw new Error('A CSV field exceeds 16 million characters.');
    }
    if(final){if(this.state==='quoted')throw new Error('CSV ends inside a quoted field.');if(this.touched||this.field||this.fields.length)row();}return result;
  }
}
class JsonRows{
  private phase='root';private arrayRoot=false;private rowsSeen=false;private canEnd=true;private key='';private keys=new Set<string>();private raw='';private purpose='';private kind='';private depth=0;private string=false;private escape=false;private index=0;
  readonly metadata:Record<string,unknown>=Object.create(null);
  push(text:string,final=false):SourceRow[]{const result:SourceRow[]=[];
    const finish=()=>{const raw=this.raw,purpose=this.purpose;this.purpose='';this.raw='';if(purpose==='row'){result.push({index:this.index++,value:parseExactJSON(raw)});this.phase='rowAfter';}else if(purpose==='key'){this.key=JSON.parse(raw);if(this.keys.has(this.key))throw new Error('Duplicate JSON envelope key.');this.keys.add(this.key);this.phase='colon';}else{this.metadata[this.key]=JSON.parse(raw);this.phase='objectAfter';}};
    const begin=(c:string,purpose:string)=>{this.purpose=purpose;this.kind=c==='{'||c==='['?'container':c==='"'?'string':'scalar';this.depth=0;this.string=false;this.escape=false;this.raw='';};
    for(let i=0;i<text.length;){const c=text[i]!;
      if(this.purpose){if(this.kind==='scalar'&&/[ \t\r\n,\]}]/.test(c)){finish();continue;}this.raw+=c;if(this.raw.length>16_000_000)throw new Error('A JSON row or metadata value exceeds 16 million characters.');
        if(this.string){if(this.escape)this.escape=false;else if(c==='\\')this.escape=true;else if(c==='"'){this.string=false;if(this.kind==='string'){i++;finish();continue;}}}
        else if(c==='"')this.string=true;else if(c==='{'||c==='[')this.depth++;else if(c==='}'||c===']')this.depth--;
        i++;if(this.kind==='container'&&this.depth===0&&!this.string)finish();continue;
      }
      if(/[ \t\r\n]/.test(c)){i++;continue;}
      if(this.phase==='root'){if(c==='['){this.arrayRoot=true;this.rowsSeen=true;this.phase='row';}else if(c==='{')this.phase='key';else throw new Error('JSON import needs an array or a rows/columns envelope.');i++;continue;}
      if(this.phase==='key'){if(c==='}'&&this.canEnd){this.phase='done';i++;continue;}if(c!=='"')throw new Error('Expected a JSON envelope key.');begin(c,'key');continue;}
      if(this.phase==='colon'){if(c!==':')throw new Error('Expected a JSON colon.');this.phase='value';i++;continue;}
      if(this.phase==='value'){if(this.key==='rows'){if(c!=='[')throw new Error('JSON rows must be an array.');this.rowsSeen=true;this.canEnd=true;this.phase='row';i++;}else begin(c,'meta');continue;}
      if(this.phase==='row'){if(c===']'&&this.canEnd){this.phase=this.arrayRoot?'done':'objectAfter';i++;continue;}begin(c,'row');continue;}
      if(this.phase==='rowAfter'){if(c===','){this.phase='row';this.canEnd=false;}else if(c===']')this.phase=this.arrayRoot?'done':'objectAfter';else throw new Error('Expected JSON row separator.');i++;continue;}
      if(this.phase==='objectAfter'){if(c===','){this.phase='key';this.canEnd=false;}else if(c==='}')this.phase='done';else throw new Error('Expected JSON envelope separator.');i++;continue;}
      throw new Error('Unexpected content after JSON document.');
    }
    if(final){if(this.purpose&&this.kind==='scalar')finish();if(this.phase!=='done'||!this.rowsSeen)throw new Error('Incomplete JSON rows document.');}return result;
  }
}
export async function* fileRows(path:string,options:DataFileOptions,metadata:FileMetadata,signal?:AbortSignal):AsyncGenerator<SourceRow>{
  const decoder=new TextDecoder('utf-8',{fatal:true}),hash=createHash('sha256'),csv=new CsvRows(options.delimiter),json=new JsonRows();let first=true,csvHeader=false,index=0;
  const handle=(text:string,final=false)=>options.format==='csv'?csv.push(text,final):json.push(text,final);
  for await(const chunk of createReadStream(path,{highWaterMark:65536})){checkAbort(signal);hash.update(chunk);metadata.bytes+=chunk.length;let text=decoder.decode(chunk,{stream:true});if(first&&text){text=text.replace(/^\uFEFF/,'');first=false;}
    for(const row of handle(text)){
      if(options.format==='csv'&&options.header&&!csvHeader){metadata.headers=row.cells!.map(c=>c.text);csvHeader=true;continue;}yield {...row,index:index++};
    }
  }
  for(const row of handle(decoder.decode(),true)){if(options.format==='csv'&&options.header&&!csvHeader){metadata.headers=row.cells!.map(c=>c.text);csvHeader=true;}else yield {...row,index:index++};}
  metadata.rows=index;metadata.sha256=hash.digest('hex');
  if(options.format==='json'){const columns=json.metadata.columns;if(columns!==undefined){if(!Array.isArray(columns)||columns.length>10000)throw new Error('Invalid JSON columns metadata.');metadata.headers=columns.map(c=>typeof c==='string'?c:typeof c?.name==='string'?c.name:(()=>{throw new Error('Invalid JSON column name.');})());metadata.typed=true;}metadata.truncated=json.metadata.truncated===true;if(json.metadata.format!==undefined&&json.metadata.format!=='db-workbench.rows')throw new Error('Unsupported JSON data format.');}
}
export const emptyMetadata=():FileMetadata=>({headers:[],typed:false,truncated:false,rows:0,sha256:'',bytes:0});
