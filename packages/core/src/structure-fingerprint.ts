import {createHash} from 'node:crypto';
import type {TableStructure} from '../../protocol/src/ddl.js';
import type {ConnectionProfile} from '../../protocol/src/index.js';
import {sqlTokens} from './sql-editing.js';
/** AUTO_INCREMENT's current counter changes on ordinary inserts, not only DDL. */
export function structureFingerprint(structure:TableStructure,driver:ConnectionProfile['driver']){
 let definition=structure.definition;
 if(driver==='mysql'||driver==='mariadb'){
  const ts=sqlTokens(definition,driver,structure.sqlMode);
  for(let i=ts.length-3;i>=0;i--)if(ts[i]?.kind==='word'&&ts[i]!.text.toUpperCase()==='AUTO_INCREMENT'&&ts[i]!.depth===0&&ts[i+1]?.text==='='&&/^\d+$/.test(ts[i+2]?.text??'')){
   let start=ts[i]!.start,end=ts[i+2]!.end;while(end<definition.length&&/\s/.test(definition[end]!))end++;if(end===definition.length)while(start>0&&/\s/.test(definition[start-1]!))start--;definition=definition.slice(0,start)+definition.slice(end);
  }
 }
 return createHash('sha256').update(JSON.stringify({...structure,definition})).digest('hex');
}
