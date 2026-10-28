import {createHash} from 'node:crypto';
import type {DataRow,TableDetails,ExpectedTable} from '../../protocol/src/index.js';
import {canonicalCell,columnFamily} from './compare-values.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Order-independent multiset, retaining duplicate counts and exact wire values. */
export function tableSnapshot(details:TableDetails,rows:DataRow[],limit:number):ExpectedTable{
  const columns=details.columns.map(c=>c.name),digests=rows.map(row=>hash(columns.map(name=>row[name]))).sort();
  return {sha256:hash(digests),detailsSha256:hash({name:details.name,type:details.type,sql:details.sql,columns:details.columns,indexes:[...details.indexes].sort((a,b)=>order(a.name,b.name)),foreignKeys:[...details.foreignKeys].sort((a,b)=>order(JSON.stringify(a),JSON.stringify(b)))}),rowCount:rows.length,limit};
}
export function verifyTableSnapshot(details:TableDetails,rows:DataRow[],expected:ExpectedTable){
  const actual=tableSnapshot(details,rows,expected.limit);
  if(rows.length>expected.limit||actual.rowCount!==expected.rowCount||actual.sha256!==expected.sha256||actual.detailsSha256!==expected.detailsSha256)throw new Error('Target data or structure changed after comparison. Compare again; no synchronization changes were applied.');
}
export function verifyWrittenValues(details:TableDetails,rows:DataRow[],values:DataRow,deleted=false){
  if(deleted){if(rows.length)throw new Error('The database retained or recreated a deleted key. Synchronization was rejected before commit.');return;}
  if(rows.length!==1)throw new Error('The synchronized key did not identify exactly one written row.');
  for(const [name,value]of Object.entries(values)){const c=details.columns.find(c=>c.name===name);if(!c||!Object.hasOwn(rows[0]!,name))throw new Error('Written column metadata changed.');const family=columnFamily(c),mode=['integer','decimal','float'].includes(family)?'numeric':family==='boolean'?'boolean':'strict';if(canonicalCell(rows[0]![name]!,mode)!==canonicalCell(value,mode))throw new Error(`${name}: the database converted or changed the reviewed value. Synchronization was rejected before commit.`);}
}
