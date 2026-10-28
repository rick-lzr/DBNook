import type { ColumnMeta, ConnectionProfile, SchemaObject } from '../../protocol/src/index.js';
import { currentSql, sqlIdentifier, sqlTokens, type SqlToken } from './sql-editing.js';
import type { MysqlSqlMode } from '../../drivers/mysql/sql.js';
import {sqlParameters,maskSqlParameters,type ParameterScan} from './sql-parameters.js';
export interface CompletionObject extends SchemaObject{columns?:ColumnMeta[];}
export interface SqlSuggestion{label:string;insert:string;kind:'table'|'column'|'keyword'|'schema'|'parameter';detail:string;start:number;end:number;}
const keywords='SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON AS GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE WITH UNION ALL DISTINCT RETURNING CREATE TABLE ALTER DROP BEGIN COMMIT ROLLBACK NULL AND OR NOT IS IN EXISTS CASE WHEN THEN ELSE END'.split(' ');
const reserved=new Set([...keywords,'CROSS','FULL','NATURAL','USING','FOR','ASC','DESC','WINDOW','FETCH','USING']);
const ident=(t:SqlToken|undefined)=>t&&(t.kind==='word'||t.kind==='identifier');
const parts=(value:string,driver:ConnectionProfile['driver'])=>sqlTokens(value,driver).filter(ident).map(t=>sqlIdentifier(t.text));
export const quoteSqlName=(value:string,driver:ConnectionProfile['driver'])=>driver==='mysql'||driver==='mariadb'?'`'+value.replaceAll('`','``')+'`':'"'+value.replaceAll('"','""')+'"';
function parameterSuggestions(text:string,offset:number,scan:ParameterScan):SqlSuggestion[]|undefined{
  const active=scan.occurrences.find(o=>offset>o.start&&offset<=o.end);
  if(active){
    const raw=text.slice(active.start,active.end),first=raw.indexOf('||'),second=first<0?-1:raw.indexOf('||',first+2),third=second<0?-1:raw.indexOf('||',second+2),bracket=raw[1]==='{'||raw[1]==='(',close=bracket&&(raw.endsWith('}')||raw.endsWith(')'))?1:0;
    if(second>=0&&offset>=active.start+second+2&&offset<=active.start+(third<0?raw.length-close:third)){
      const start=active.start+second+2,end=active.start+(third<0?raw.length-close:third),prefix=text.slice(start,offset).toLowerCase();
      return ['string','number','date','identifier'].filter(t=>t.startsWith(prefix)).map(t=>({label:t,insert:t,kind:'parameter',detail:'SQL parameter type',start,end}));
    }
    if(first>=0&&offset>active.start+first)return [];
    if(bracket&&offset>active.end-close)return [];
  }
  const fragment=text.slice(Math.max(0,offset-300),offset),match=/(?:([&$:])([A-Za-z_]\w*|[1-9]\d*)?|([&$:%])([({])([A-Za-z_][\w ]*)?)$/.exec(fragment);if(!match)return active?[]:undefined;
  const prefix=match[1]??match[3]!,name=match[2]??match[5]??'',bracket=Boolean(match[4]),start=offset-match[0].length;
  if(/[\p{L}\p{N}_$:.\-@&'"`]/u.test(text[start-1]??' '))return undefined;
  const end=active?.end??offset,nameStart=start+1+(bracket?1:0),raw=text.slice(start,end),metadata=raw.indexOf('||');
  const closed=bracket&&(raw.endsWith('}')||raw.endsWith(')')),nameEnd=metadata>=0?start+metadata:end-(closed?1:0);
  const candidates=scan.parameters.filter(p=>p.key[0]===prefix&&p.name.toLowerCase().startsWith(name.toLowerCase())&&(p.key!==active?.key||p.occurrences>1||p.defaultValue!==undefined));
  return candidates.slice(0,256).map(p=>{
    const needsBrackets=/\s/.test(p.name)&&!bracket,missingClose=bracket&&metadata<0&&!raw.endsWith('}')&&!raw.endsWith(')');
    const replaceWhole=needsBrackets||missingClose,insert=needsBrackets?prefix+'{'+p.name+(metadata>=0?raw.slice(metadata):'')+'}':missingClose?prefix+match[4]+p.name+(match[4]==='{'?'}':')'):p.name;
    return {label:p.key,insert,kind:'parameter',detail:`SQL parameter · ${p.type==='auto'?'string':p.type} · ${p.occurrences} uses`,start:replaceWhole?start:nameStart,end:replaceWhole?end:nameEnd};
  });
}
export function sqlCompletions(text:string,offset:number,driver:ConnectionProfile['driver'],objects:CompletionObject[],mode?:MysqlSqlMode,parameters=false):{items:SqlSuggestion[];needs:string[]}{
  if(!Number.isInteger(offset)||offset<0||offset>text.length)throw new Error('Invalid SQL cursor offset.');
  if(parameters){
    const scan=sqlParameters(text,driver,mode,true),masked=maskSqlParameters(text,scan),context=sqlTokens(masked,driver,mode).find(t=>t.start<=offset&&offset<=t.end);
    if(context?.kind!=='string'&&context?.kind!=='comment'&&context?.kind!=='identifier'){const items=parameterSuggestions(text,offset,scan);if(items!==undefined)return {items,needs:[]};}
    text=masked;
  }
  const context=sqlTokens(text,driver,mode).find(t=>t.start<=offset&&t.end>=offset);
  if(context?.kind==='comment'&&(offset<context.end||!context.text.endsWith('*/'))||context?.kind==='string'&&offset<context.end)return {items:[],needs:[]};
  const source=currentSql(text,offset,driver,mode)??{start:0,end:text.length,sql:text};
  const origin=source.start,local=offset-origin,tokens=sqlTokens(source.sql,driver,mode),inside=tokens.find(t=>t.start<local&&t.end>=local);
  if(inside&&(inside.kind==='comment'||inside.kind==='string')){const closed=inside.kind==='comment'?inside.text.startsWith('/*')&&inside.text.endsWith('*/'):inside.text.length>1&&inside.text.endsWith(inside.text[0]!);if(local<inside.end||!closed)return {items:[],needs:[]};}
  const all=tokens.filter(t=>t.kind!=='comment'&&t.kind!=='string');
  const at=all.find(t=>ident(t)&&t.start<local&&t.end>=local),fragment=at?source.sql.slice(at.start,local):'',prefix=at?.kind==='identifier'&&!fragment.endsWith(fragment[0]!)?fragment.slice(1):sqlIdentifier(fragment);
  const start=origin+(at?.start??local),before=all.filter(t=>t.end<=(at?.start??local));
  const cursorDepth=inside?.depth??all.filter(t=>t.end<=local).at(-1)?.depth??0;
  const refs=new Map<string,CompletionObject>(),needs=new Set<string>(),relations:{object:CompletionObject;qualifier:string}[]=[];
  const lookup=(names:string[])=>{const found=objects.filter(o=>{const actual=o.schema?[o.schema,o.label??parts(o.name,driver).at(-1)!]:[o.label??o.name];return names.length===1?actual.at(-1)?.toLowerCase()===names[0]!.toLowerCase():actual.map(v=>v.toLowerCase()).join('.')===names.map(v=>v.toLowerCase()).join('.');});return found.length===1?found[0]:undefined;};
  for(let i=0;i<all.length;i++){
    const token=all[i]!;if(token.depth>cursorDepth||!['FROM','JOIN','UPDATE','INTO'].includes(token.text.toUpperCase()))continue;
    let j=i+1;if(!ident(all[j]))continue;const names=[sqlIdentifier(all[j]!.text)];j++;
    while(all[j]?.text==='.'&&ident(all[j+1])){names.push(sqlIdentifier(all[j+1]!.text));j+=2;}
    const object=lookup(names);if(!object)continue;needs.add(object.name);refs.set(names.at(-1)!.toLowerCase(),object);refs.set(names.join('.').toLowerCase(),object);
    if(all[j]?.text.toUpperCase()==='AS')j++;const alias=ident(all[j])&&!reserved.has(all[j]!.text.toUpperCase())?sqlIdentifier(all[j]!.text):undefined;if(alias)refs.set(alias.toLowerCase(),object);
    relations.push({object,qualifier:alias??names.at(-1)!});
  }
  let qualifier:string|undefined;
  if(before.at(-1)?.text==='.'){
    let j=before.length-2;const names:string[]=[];while(j>=0&&ident(before[j])){names.unshift(sqlIdentifier(before[j]!.text));j--;if(before[j]?.text!=='.')break;j--;}
    qualifier=names.join('.');
  }
  const items:SqlSuggestion[]=[];const add=(label:string,insert:string,kind:SqlSuggestion['kind'],detail:string)=>{if(label.toLowerCase().startsWith(prefix.toLowerCase()))items.push({label,insert,kind,detail,start,end:at?origin+at.end:offset});};
  if(qualifier!==undefined){
    const object=refs.get(qualifier.toLowerCase())??lookup(qualifier.split('.'));
    if(object){needs.add(object.name);for(const c of object.columns??[])add(c.name,quoteSqlName(c.name,driver),'column',`${object.name} · ${c.dataType}${c.nullable?'':' · NOT NULL'}`);}
    else for(const o of objects.filter(o=>o.schema?.toLowerCase()===qualifier!.toLowerCase()))add(o.label??o.name,quoteSqlName(o.label??parts(o.name,driver).at(-1)!,driver),'table',o.type);
  }else{
    const tableContext=['FROM','JOIN','UPDATE','INTO'].includes(before.at(-1)?.text.toUpperCase()??'');
    if(!tableContext){for(const {object:o,qualifier:q} of relations)for(const c of o.columns??[]){const ambiguous=relations.filter(r=>r.object.columns?.some(other=>other.name.toLowerCase()===c.name.toLowerCase())).length>1;add(c.name,(ambiguous?quoteSqlName(q,driver)+'.':'')+quoteSqlName(c.name,driver),'column',`${q} · ${o.name} · ${c.dataType}`);}for(const k of new Set(keywords))add(k,k,'keyword',driver);}
    for(const o of objects)add(o.label??o.name,o.schema?o.name:quoteSqlName(o.name,driver),'table',`${o.schema??'main'} · ${o.type}`);
    for(const name of new Set(objects.map(o=>o.schema).filter((v):v is string=>Boolean(v))))add(name,quoteSqlName(name,driver),'schema','Database / schema');
  }
  return {items:items.slice(0,500),needs:[...needs].slice(0,16)};
}
