import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertSqliteFeatures} from '../packages/drivers/sqlite/runtime.js';
import {sqliteRuntimePath} from '../packages/core/src/sqlite-runtime-path.js';

test('SQLite API validation rejects the older API even if sqlite_version and basic reads work',()=>{
  const statement={sourceSQL:'SELECT 1',get(){return {one:1};},run(){},iterate(){},setReadBigInts(){}};
  assert.throws(()=>assertSqliteFeatures({},statement,undefined,'22.14.0'),/22\.14\.0.*StatementSync.columns.*setReturnArrays.*isTransaction.*backup.*offline VSIX/);
  const full={...statement,columns(){},setReturnArrays(){}};
  assert.doesNotThrow(()=>assertSqliteFeatures({isTransaction:false},full,()=>{},'22.22.2'));
  assert.throws(()=>assertSqliteFeatures({},full,()=>{},'22.22.2'),/DatabaseSync.isTransaction/);
});

test('SQLite runtime selection honors explicit configuration and only selects a matching bundled platform',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dbw-runtime-'));
  try{
    assert.deepEqual(sqliteRuntimePath(root,undefined,'win32','x64'),{source:'vscode'});
    const runtime=join(root,'runtime','win32-x64','node.exe');await mkdir(join(root,'runtime','win32-x64'),{recursive:true});await writeFile(runtime,'fixture');
    assert.deepEqual(sqliteRuntimePath(root,undefined,'win32','x64'),{source:'bundled',path:runtime});
    assert.deepEqual(sqliteRuntimePath(root,'explicit-node','win32','x64'),{source:'configured',path:'explicit-node'});
    assert.deepEqual(sqliteRuntimePath(root,undefined,'linux','x64'),{source:'vscode'});
    assert.deepEqual(sqliteRuntimePath(root,undefined,'win32','arm64'),{source:'vscode'});
  }finally{await rm(root,{recursive:true,force:true});}
});
