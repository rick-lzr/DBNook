import {createHash,randomUUID} from 'node:crypto';
import type {ConnectionManager} from './connections.js';
import {DatabaseDefinitions,readDefinition} from './database-definitions.js';
import {readTableStructure} from './table-structure.js';
import {ddlQuote} from './ddl-syntax.js';
import {sqlTokens,sqlIdentifier,type SqlToken} from './sql-editing.js';
import {parseTableScript,tableIdentifier,columnNameKey,tableNameKey,scriptObjectKey,type TableScript,type ScriptObject} from './table-script.js';
import {StructureEndpointSchema,StructureColumnOverridesSchema,type StructureEndpoint,type StructureComparison,type StructureDifference,type PreparedStructureDraft} from '../../protocol/src/structure-comparisons.js';
import type {DefinitionSnapshot} from '../../protocol/src/definitions.js';
import {mysqlDdlModeText} from './mysql-ddl-text.js';
import {translateTable,translatedColumnKey,requiredSupportingIndexes,type TableTranslation} from './portable-table.js';

type Driver=DefinitionSnapshot['driver'];
const word=(t:SqlToken|undefined)=>t?.kind==='word'?t.text.toUpperCase():'';
const family=(d:Driver)=>d==='mysql'||d==='mariadb';
const qualified=(s:DefinitionSnapshot)=>[s.ref.schema,s.ref.name].filter((v):v is string=>v!==undefined).map(v=>ddlQuote(v,s.driver)).join('.');
const key=(v:string,d:Driver)=>columnNameKey(v,d);
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
const model=(s:DefinitionSnapshot)=>parseTableScript(s.sql,s.driver,s.tableStructure!,s.tableStructure?.sqlMode);
function counterOption(text:string,s:DefinitionSnapshot){const ts=sqlTokens(text,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment');let counter:string|undefined;for(let i=ts.length-3;i>=0;i--)if(word(ts[i])==='AUTO_INCREMENT'&&ts[i]!.depth===0&&ts[i+1]?.text==='='&&/^\d+$/.test(ts[i+2]?.text??'')){counter=ts[i+2]!.text;text=text.slice(0,ts[i]!.start)+text.slice(ts[i+2]!.end);}return {text,counter};}
const strippedCounter=(text:string,s:DefinitionSnapshot)=>family(s.driver)?counterOption(text,s).text:text;
/** Server deparsers can remove quotes from simple names. Preserve quoted case-sensitive PostgreSQL names. */
const canon=(text:string,s:DefinitionSnapshot)=>JSON.stringify(sqlTokens(references(text,s,s),s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment'||/^\/\*(?:!|[mM]!)/.test(t.text)).map(t=>{
 if(t.kind==='identifier'){const id=sqlIdentifier(t.text);if(s.driver==='postgresql'&&!/^[a-z_][a-z0-9_$]*$/.test(id))return ['id',id];return ['word',key(id,s.driver).toUpperCase()];}
 return t.kind==='word'?['word',t.text.toUpperCase()]:[t.kind,t.text];
}));
function objectCanon(sql:string,s:DefinitionSnapshot,kind:string){
 if(kind!=='check')return canon(sql,s);const ts=sqlTokens(sql,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment'),at=ts.findIndex(t=>word(t)==='CHECK'),open=ts[at+1],close=ts.find(t=>t.text===')'&&t.depth===0&&t.start>(open?.start??Infinity));if(open?.text!=='('||!close)return canon(sql,s);
 let inner=sql.slice(open.end,close.start),parts=sqlTokens(inner,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment');
 while(parts[0]?.text==='('&&parts.at(-1)?.text===')'&&!parts.slice(1,-1).some(t=>t.depth===0)){inner=inner.slice(parts[0].end,parts.at(-1)!.start);parts=sqlTokens(inner,s.driver,s.tableStructure?.sqlMode).filter(t=>t.kind!=='comment');}
 return canon(sql.slice(0,open.end)+inner+sql.slice(close.start),s);
}
function boundedName(prefix:string,name:string,d:Driver){
 const full=prefix+'__'+name,limit=d==='postgresql'?63:family(d)?64:255;
 if(Buffer.byteLength(full)<=limit)return full;
 const hash=createHash('sha256').update(full).digest('hex').slice(0,10);let body='';for(const c of full){if(Buffer.byteLength(body+c)>limit-12)break;body+=c;}return body+'__'+hash;
}
/** Retarget known object positions only. Values, function names and ordinary column references remain untouched. */
function references(text:string,source:DefinitionSnapshot,target:DefinitionSnapshot){
 const ts=sqlTokens(text,source.driver,source.tableStructure?.sqlMode).filter(t=>t.kind!=='comment'),edits:{start:number;end:number;text:string}[]=[];
 for(let i=0;i<ts.length;i++)if(word(ts[i])==='REFERENCES'){
  const ref=tableIdentifier(ts,i+1,source.driver),parts=ref.parts;let schema=parts.length===2?parts[0]:source.ref.schema,name=parts.at(-1)!;
  if(schema===source.ref.schema){schema=target.ref.schema;if(tableNameKey(name,source.driver)===tableNameKey(source.ref.name,source.driver))name=target.ref.name;}
  const value=[schema,name].filter((v):v is string=>v!==undefined).map(v=>ddlQuote(v,target.driver)).join('.');
  edits.push({start:ts[i+1]!.start,end:ts[ref.end-1]!.end,text:value});i=ref.end-1;
 }
 for(const e of edits.reverse())text=text.slice(0,e.start)+e.text+text.slice(e.end);return text;
}
/** Preserve MySQL string values and quoted names when the two sessions use different lexical modes. */
function modeText(text:string,s:DefinitionSnapshot,t:DefinitionSnapshot){
 if(!family(s.driver))return text;
 const normal={noBackslashEscapes:false,ansiQuotes:false};return mysqlDdlModeText(text,s.driver as 'mysql'|'mariadb',s.tableStructure?.sqlMode??normal,t.tableStructure?.sqlMode??normal);
}
function sourceModel(source:DefinitionSnapshot,target:DefinitionSnapshot):TableScript{
 const parsed=model(source);if(source.profileId===target.profileId&&source.ref.schema===target.ref.schema&&source.ref.name===target.ref.name)return parsed;
 const existing=model(target),d=target.driver,move=(v:string)=>modeText(references(v,source,target),source,target);
 const rename=(name:string)=>boundedName(target.ref.name,name,d);
 const objects=parsed.objects.map((o):ScriptObject=>{
  let definition=move(o.definition),name=d==='postgresql'||o.kind==='index'&&d==='sqlite'||family(d)&&['foreign','check'].includes(o.kind)?rename(o.name):o.name;
  if(d==='postgresql'&&o.kind==='primary')name=existing.objects.find(v=>v.kind==='primary')?.name??name;
  else if(existing.objects.some(v=>v.name===o.name&&v.kind===o.kind))name=o.name;
  if(o.kind==='index'&&(d==='sqlite'||d==='postgresql')){
   const ts=sqlTokens(definition,d,target.tableStructure?.sqlMode).filter(t=>t.kind!=='comment'),index=ts.findIndex(t=>word(t)==='INDEX'),id=tableIdentifier(ts,index+1,d),on=ts.findIndex(t=>word(t)==='ON');let start=on+1;if(word(ts[start])==='ONLY')start++;const owner=tableIdentifier(ts,start,d);
   definition=definition.slice(0,ts[start]!.start)+qualified(target)+definition.slice(ts[owner.end-1]!.end);
   definition=definition.slice(0,ts[index+1]!.start)+ddlQuote(name,d)+definition.slice(ts[id.end-1]!.end);
  }else if(name!==o.name){const ts=sqlTokens(definition,d).filter(t=>t.kind!=='comment');if(word(ts[0])!=='CONSTRAINT')throw new Error('Cannot retarget an unnamed PostgreSQL constraint.');definition=definition.slice(0,ts[1]!.start)+ddlQuote(name,d)+definition.slice(ts[1]!.end);}
  return {...o,name,definition};
 });
 return {...parsed,suffix:modeText(parsed.suffix,source,target),columns:parsed.columns.map(c=>({...c,definition:move(c.definition)})),objects,indexes:objects.filter(o=>o.kind==='index'&&(d==='sqlite'||d==='postgresql')).map(o=>({name:o.name,sql:o.definition}))};
}

/** Captures complete catalog definitions, never table rows. Draft preparation never executes DDL. */
export class StructureComparisons {
 private captures=new Map<string,StructureComparison>();private reading=false;
 constructor(private manager:ConnectionManager,private definitions:DatabaseDefinitions){}
 private async capture(input:StructureEndpoint){
  const endpoint=StructureEndpointSchema.parse(input),revision=this.manager.editorRevision(endpoint.profileId),owner='structure-compare:'+randomUUID();
  try{
   const session=await this.manager.lease(endpoint.profileId,owner),s=await readTableStructure(session,endpoint.table);
   if(s.type!=='table')throw new Error('Choose an ordinary table for structure comparison.');
   const id=session.profile.driver==='postgresql'?String(JSON.parse(s.identity).oid):s.label;
   const snapshot=await readDefinition(session,{kind:'table',id,schema:s.schema,name:s.label},revision);
   if(!snapshot||this.manager.editorRevision(endpoint.profileId)!==revision)throw new Error('Connection or table changed during comparison. Compare again.');
   if(bytes(snapshot)>24*1024*1024)throw new Error('Table metadata exceeds the 24 MiB comparison budget.');return snapshot;
  }finally{await this.manager.releaseLease(owner);}
 }
 private get(token:string){const value=this.captures.get(token);if(!value||Date.parse(value.expiresAt)<Date.now()){this.captures.delete(token);throw new Error('Structure comparison expired. Compare the tables again.');}return value;}
 forget(token:string){this.captures.delete(token);}
 async compare(source:StructureEndpoint,target:StructureEndpoint,inputOverrides:Record<string,string>={}):Promise<StructureComparison>{
  const columnOverrides=StructureColumnOverridesSchema.parse(inputOverrides);
  if(this.reading)throw new Error('A structure comparison is already being captured. Wait for it to finish.');this.reading=true;try{
  const captured=await Promise.allSettled([this.capture(source),this.capture(target)]);for(const result of captured)if(result.status==='rejected')throw result.reason;
  const [a,b]=captured.map(v=>(v as PromiseFulfilledResult<DefinitionSnapshot>).value) as [DefinitionSnapshot,DefinitionSnapshot],differences:StructureDifference[]=[],notes=[...new Set([...a.notes,...b.notes])];
  if(Object.keys(columnOverrides).some(n=>!a.tableStructure!.columns.some(c=>c.name===n)))throw new Error('A column conversion no longer matches the source. Refresh the comparison.');
  const compatible=a.driver===b.driver,canPrepare=a.editable&&b.editable&&!this.manager.profile(b.profileId).readOnly;let left:TableScript|undefined,right:TableScript|undefined,translation:TableTranslation|undefined;
  try{right=model(b);if(compatible)left=sourceModel(a,b);else{translation=translateTable(a,b,columnOverrides);left=translation.model;notes.push(...translation.notes);}}catch(error){notes.push('Managed synchronization unavailable: '+(error instanceof Error?error.message:String(error)));}
  const push=(kind:StructureDifference['kind'],name:string,source:string|undefined,target:string|undefined,equal:boolean,reason?:string,objectKind?:string,warnings:string[]=[])=>differences.push({id:'s'+differences.length,kind,objectKind,name,source,target,change:source===undefined?'remove':target===undefined?'add':equal?'equal':'change',selectable:canPrepare&&!!left&&!!right&&!reason,reason,warnings,requiresReview:!compatible});
  const sourceColumns=a.tableStructure!.columns,targetColumns=b.tableStructure!.columns;
  for(const c of sourceColumns){const target=targetColumns.find(v=>key(v.name,b.driver)===key(c.name,b.driver)),from=left?.columns.find(v=>v.name===c.name)?.definition??c.definition,to=right?.columns.find(v=>v.name===target?.name)?.definition??target?.definition;
   const tokens=sqlTokens(from,a.driver,a.tableStructure?.sqlMode),sequence=compatible&&tokens.some((t,i)=>word(t)==='NEXTVAL'&&tokens[i+1]?.text==='(')&&canon(from,b)!==canon(to??'',b)?'Sequence defaults need an explicit target sequence mapping.':undefined;
   let equal=target!==undefined&&canon(from,b)===canon(to??'',b);const converted=translation?.columns.find(v=>v.name===c.name),manualConstraints=converted?.manual&&sqlTokens(from,b.driver,b.tableStructure?.sqlMode).some((t,i)=>i>0&&t.depth===0&&['CHECK','UNIQUE','PRIMARY','REFERENCES','CONSTRAINT','COMMENT','GENERATED'].includes(word(t)));if(!compatible&&target&&converted?.sql&&!manualConstraints){try{equal=translatedColumnKey(from,b,c.primaryKey,sourceColumns.filter(v=>v.primaryKey).sort((x,y)=>x.primaryKey-y.primaryKey).map(v=>v.name))===translatedColumnKey(to??'',b,target.primaryKey);}catch{}}
   push('column',c.name,from,to,equal,translation?.issues['column:'+c.name]??sequence,undefined,translation?.warnings['column:'+c.name]);
  }
  for(const c of targetColumns)if(!sourceColumns.some(v=>key(v.name,b.driver)===key(c.name,b.driver)))push('column',c.name,undefined,c.definition,false);
  const requiredIndexes=!compatible&&left&&right?requiredSupportingIndexes(left,right,b,translation?.issues):new Set<string>();
  for(const kind of ['constraint','index'] as const){
   const objects=(p:TableScript|undefined,s:DefinitionSnapshot):{name:string;definition:string;kind:string}[]=>p?p.objects.filter(o=>(o.kind==='index')===(kind==='index')):(kind==='index'?s.tableStructure!.indexes.filter(i=>!i.protected).map(i=>({...i,kind:'index'})):s.tableStructure!.constraints);
   const as=objects(left,a),bs=objects(right,b);
   const objectId=(v:{name:string;kind:string})=>scriptObjectKey(v as ScriptObject,b.driver);
   for(const c of as){const other=bs.find(v=>objectId(v)===objectId(c));push(kind,c.name,c.definition,other?.definition,other!==undefined&&objectCanon(c.definition,b,c.kind)===objectCanon(other.definition,b,c.kind),translation?.issues[objectId(c)],c.kind,translation?.warnings[objectId(c)]);}
   for(const c of bs)if(!as.some(v=>objectId(v)===objectId(c))){if(kind==='index'&&requiredIndexes.has(c.name))push(kind,c.name,c.definition,c.definition,true,'Required target foreign-key support index is retained.',c.kind);else push(kind,c.name,undefined,c.definition,false,undefined,c.kind);}
  }
  const orderA=sourceColumns.map(c=>c.name).join(', '),orderB=targetColumns.map(c=>c.name).join(', ');push('order','Column order',orderA,orderB,orderA===orderB);
  const optionsA=(left?.unlogged?'UNLOGGED ':'')+(left?.suffix.slice(1).trim()??''),optionsB=(right?.unlogged?'UNLOGGED ':'')+(right?.suffix.slice(1).trim()??'');push('options','Table options',optionsA,optionsB,compatible?canon(strippedCounter(optionsA,b),b)===canon(strippedCounter(optionsB,b),b):optionsA===optionsB);
  notes.push('Source → target. Only selected structural changes are copied; target data and triggers stay in the target. Source is never modified.','Scope is captured table SQL: triggers, ownership, grants, full comments, sequence options and external dependencies are not synchronized or asserted equal.','Foreign keys in the source schema are resolved in the target schema; external schema references remain explicit. Review their dependencies.','Copied schema-scoped index/constraint names include the target table name to avoid conflicts with source objects. Existing primary-key constraint names are retained.');
  if(requiredIndexes.size)notes.push('Required target foreign-key support indexes are retained: '+[...requiredIndexes].join(', '));
  const value:StructureComparison={token:randomUUID(),source:a,target:b,capturedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15*60*1000).toISOString(),differences,notes,canPrepare:canPrepare&&!!left&&!!right,columnOverrides,conversions:translation?.columns};
  for(const [id,v] of this.captures)if(Date.parse(v.expiresAt)<Date.now())this.captures.delete(id);
  if(bytes(value)>64*1024*1024)throw new Error('Structure comparison exceeds the resident metadata budget.');
  while(this.captures.size>=10||this.captures.size&&[...this.captures.values()].reduce((n,v)=>n+bytes(v),0)+bytes(value)>64*1024*1024)this.captures.delete(this.captures.keys().next().value!);
  this.captures.set(value.token,value);return structuredClone(value);
  }finally{this.reading=false;}
 }
 async prepare(token:string,ids:string[]):Promise<PreparedStructureDraft>{
  const c=this.get(token);if(!c.canPrepare)throw new Error('This pair is available for comparison only. Use an explicit target-dialect migration.');
  if(!ids.length||new Set(ids).size!==ids.length||ids.length>c.differences.length)throw new Error('Select unique structure differences to synchronize.');
  const selected=ids.map(id=>{const d=c.differences.find(v=>v.id===id);if(!d||!d.selectable||d.change==='equal')throw new Error('A selected difference is unavailable. Compare again.');return d;});
  for(const s of [c.source,c.target]){if(this.manager.editorRevision(s.profileId)!==s.revision)throw new Error('Connection changed after comparison. Compare again.');const current=await this.definitions.read(s.profileId,s.ref);if(current?.fingerprint!==s.fingerprint)throw new Error('Source or target structure changed after comparison. Compare again.');}
  const source=c.source.driver===c.target.driver?sourceModel(c.source,c.target):translateTable(c.source,c.target,c.columnOverrides).model,target=model(c.target),d=c.target.driver;let columns=[...target.columns],objects=[...target.objects];
  for(const item of selected){if(item.kind==='column'){
   const index=columns.findIndex(v=>key(v.name,d)===key(item.name,d)),value=source.columns.find(v=>key(v.name,d)===key(item.name,d));if(value){if(index>=0)columns[index]=value;else columns.push(value);}else if(index>=0)columns.splice(index,1);
  }else if(item.kind==='index'||item.kind==='constraint'){
   const identity=scriptObjectKey({name:item.name,kind:item.objectKind as ScriptObject['kind']},d);objects=objects.filter(v=>scriptObjectKey(v,d)!==identity);const value=source.objects.find(v=>scriptObjectKey(v,d)===identity);if(value)objects.push(value);
  }}
  if(selected.some(v=>v.kind==='order'))columns.sort((a,b)=>{const rank=(n:string)=>{const i=source.columns.findIndex(c=>key(c.name,d)===key(n,d));return i<0?source.columns.length+target.columns.findIndex(c=>c.name===n):i;};return rank(a.name)-rank(b.name);});
  if(!columns.length)throw new Error('A table must retain at least one column.');
  let suffix=selected.some(v=>v.kind==='options')?source.suffix:target.suffix;
  if(family(d)){suffix=strippedCounter(suffix,c.target);const counter=counterOption(target.suffix,c.target).counter;if(counter)suffix+=' AUTO_INCREMENT='+counter;}
  const inline=objects.filter(o=>!(o.kind==='index'&&(d==='sqlite'||d==='postgresql'))),indexes=objects.filter(o=>o.kind==='index'&&(d==='sqlite'||d==='postgresql'));
  const sql=`CREATE ${d==='postgresql'&&(selected.some(v=>v.kind==='options')?source.unlogged:target.unlogged)?'UNLOGGED ':''}TABLE ${qualified(c.target)} (\n  ${[...columns.map(v=>v.definition),...inline.map(v=>v.definition)].join(',\n  ')}\n${suffix};\n${indexes.map(i=>i.definition.trim().replace(/;?\s*$/,';')).join('\n')}`;
  parseTableScript(sql,d,c.target.tableStructure!,c.target.tableStructure?.sqlMode);
  const conversionNotes=selected.flatMap(d=>(d.warnings??[]).map(w=>d.name+': '+w)),unconverted=c.differences.filter(d=>d.reason&&d.change!=='equal').map(d=>'Not synchronized · '+d.name+': '+d.reason),notes=[`Captured structure: ${this.manager.profile(c.source.profileId).name} · ${qualified(c.source)} → ${this.manager.profile(c.target.profileId).name} · ${qualified(c.target)} at ${c.capturedAt}.`,`${selected.length} selected differences. This draft is a frozen proposal; saving it does not run SQL.`,...c.notes,...conversionNotes,...unconverted];
  return {baseline:{...structuredClone(c.target),notes:[...new Set([...c.target.notes,...conversionNotes,...unconverted])]},sql,comparisonToken:token,notes};
 }
}
