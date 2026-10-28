import type {CellValue,DataRow,CombinationColumn,CombinationInput} from '../../protocol/src/index.js';
import {canonicalCell} from './compare-values.js';
import {checkAbort} from './data-stream.js';

export interface CombinationDataset {id:string;label:string;columns:CombinationColumn[];rows:DataRow[];}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function keyCell(value:CellValue,mode:'text'|'strict'|'numeric'|'boolean'){
  if(mode!=='text')return canonicalCell(value,mode);
  return typeof value==='object'&&value!==null?value.type==='integer'?value.value:'base64:'+value.base64:String(value);
}
/** Read-only bag operations. Join NULL keys never match; composite keys cannot collide on separators. */
export async function combineRows(datasets:CombinationDataset[],input:CombinationInput,byteLimit:number,signal:AbortSignal){
  const rows:DataRow[]=[],columns:CombinationColumn[]=[];let bytes=0,truncated=false,work=0;
  const checkpoint=async()=>{checkAbort(signal);if(++work%256===0){await tick();checkAbort(signal);}};
  const emit=async(values:CellValue[])=>{
    await checkpoint();const row=Object.fromEntries(values.map((v,i)=>['c'+i,v])),size=Buffer.byteLength(JSON.stringify(row));
    if(rows.length>=input.limit||bytes+size>byteLimit){truncated=true;return false;}rows.push(row);bytes+=size;return true;
  };
  const add=(column:CombinationColumn)=>{if(columns.length>=4096)throw new Error('The combined schema exceeds 4,096 columns. Select narrower source queries.');columns.push({...column,key:'c'+columns.length,primaryKey:0,generated:false,sourceColumn:undefined,sourceTable:undefined});};
  const value=(row:DataRow,key:string)=>{if(!Object.hasOwn(row,key))throw new Error('Dataset is missing a column value.');return row[key]!;};
  if(input.operation==='union'){
    const slots=new Map<string,number>(),maps:number[][]=[],names=new Set(datasets.flatMap(d=>d.columns.map(c=>c.name)));let sourceName='__source';while(names.has(sourceName))sourceName+=' (origin)';
    add({key:'',name:sourceName,dataType:'TEXT',nullable:false,primaryKey:0,generated:false,origins:[]});
    for(const dataset of datasets){const occurrences=new Map<string,number>(),mapping:number[]=[];
      for(const c of dataset.columns){const occurrence=occurrences.get(c.name)??0;occurrences.set(c.name,occurrence+1);const identity=JSON.stringify([c.name,occurrence]);let slot=slots.get(identity);
        if(slot===undefined){slot=columns.length;slots.set(identity,slot);add({...c,nullable:true,origins:[...c.origins]});}
        else {const column=columns[slot]!;if(column.dataType!==c.dataType)column.dataType='MIXED';column.origins.push(...c.origins);}
        mapping.push(slot);
      }maps.push(mapping);
    }
    outer:for(let n=0;n<datasets.length;n++){const dataset=datasets[n]!;for(const row of dataset.rows){const values:CellValue[]=Array(columns.length).fill(null);values[0]=dataset.label;dataset.columns.forEach((c,i)=>{values[maps[n]![i]!]=value(row,c.key);});if(!await emit(values))break outer;}}
  }else{
    const [left,right]=datasets as [CombinationDataset,CombinationDataset];
    const pairs=input.type==='cross'?[]:input.pairs;
    if(input.type!=='cross'&&!pairs.length)throw new Error('Choose at least one Join column pair.');
    if(new Set(pairs.map(p=>p.left)).size!==pairs.length||new Set(pairs.map(p=>p.right)).size!==pairs.length)throw new Error('Use each Join key column at most once on each side.');
    for(const p of pairs)if(!left.columns.some(c=>c.key===p.left)||!right.columns.some(c=>c.key===p.right))throw new Error('A Join key column no longer exists.');
    const rightKeys=new Set(pairs.map(p=>p.right)),rightColumns=right.columns.filter(c=>input.keepRightKeys||!rightKeys.has(c.key)),names=new Set(left.columns.map(c=>c.name));
    for(const c of left.columns){const corresponding=!input.keepRightKeys?pairs.find(p=>p.left===c.key):undefined,r=corresponding?right.columns.find(c=>c.key===corresponding.right):undefined;add({...c,dataType:r&&r.dataType!==c.dataType?'MIXED':c.dataType,nullable:c.nullable||input.type==='right'||input.type==='full',origins:[...c.origins,...(r?.origins??[])]});}
    for(const c of rightColumns){let name=names.has(c.name)?right.label+'.'+c.name:c.name;const base=name;let suffix=2;while(names.has(name))name=base+' ('+(suffix++)+')';names.add(name);add({...c,name,nullable:c.nullable||input.type==='left'||input.type==='full'});}
    const tuple=(row:DataRow,side:'left'|'right')=>{const values=pairs.map(p=>value(row,p[side]));if(values.some(v=>v===null))return undefined;return JSON.stringify(values.map((v,i)=>keyCell(v,pairs[i]!.mode)));};
    const index=new Map<string,number[]>();
    if(input.type!=='cross')for(let i=0;i<right.rows.length;i++){await checkpoint();const k=tuple(right.rows[i]!,'right');if(k===undefined)continue;const group=index.get(k);if(group)group.push(i);else index.set(k,[i]);}
    const matched=new Set<number>(),project=(l:DataRow|undefined,r:DataRow|undefined)=>[...left.columns.map(c=>{if(l)return value(l,c.key);const pair=!input.keepRightKeys&&pairs.find(p=>p.left===c.key);return pair&&r?value(r,pair.right):null;}),...rightColumns.map(c=>r?value(r,c.key):null)];
    outer:for(const l of left.rows){await checkpoint();if(input.type==='cross'){for(const r of right.rows)if(!await emit(project(l,r)))break outer;continue;}
      const k=tuple(l,'left'),matches=k===undefined?undefined:index.get(k);
      if(matches?.length){for(const i of matches){matched.add(i);if(!await emit(project(l,right.rows[i])))break outer;}}
      else if(input.type==='left'||input.type==='full')if(!await emit(project(l,undefined)))break;
    }
    if(!truncated&&(input.type==='right'||input.type==='full'))for(let i=0;i<right.rows.length;i++){await checkpoint();if(!matched.has(i)&&!await emit(project(undefined,right.rows[i])))break;}
  }
  checkAbort(signal);return {columns,rows,bytes,truncated};
}
