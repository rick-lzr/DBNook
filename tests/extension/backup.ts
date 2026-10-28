import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {ProfileSchema} from '../../packages/protocol/src/index.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {SqliteBackups} from '../../packages/core/src/sqlite-backups.js';
export async function backupChecks(api:{manager:ConnectionManager;sqliteBackups:SqliteBackups;initializedViews():number},output:string,check:(text:string)=>void){
  const p=ProfileSchema.parse({id:'native-backup',name:'Native SQLite backup',driver:'sqlite',storage:'memory'});await api.manager.save(p);const session=await api.manager.connect(p.id);
  try{
    await session.query('CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT,b BLOB)');await session.query("INSERT INTO t VALUES(9223372036854775807,'原生备份',X'00FF')");
    const views=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.sqliteBackup',{profileId:p.id});const end=Date.now()+15000;while(api.initializedViews()<=views&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert(api.initializedViews()>views);check('SQLite backup command initializes the real React backup/restore editor under native CSP');
    const path=join(output,'native-backup.db'),backup=await api.sqliteBackups.backup(p.id,path);assert.equal(backup.status,'succeeded',backup.error);assert.equal(backup.info?.objectCount,1);assert(backup.sha256);check('Native runtime online backup snapshots the actual shared in-memory database into a verified SQLite file');
    const target=join(output,'native-restored.db'),preview=await api.sqliteBackups.previewRestore(path,target);assert.equal(preview.info.objects[0]?.name,'t');const restored=await api.sqliteBackups.restore(preview.token);assert.equal(restored.status,'succeeded',restored.error);await api.manager.withSqliteFile(target,async s=>{const result=await s.query('SELECT id,v,hex(b) FROM t');assert.deepEqual(result.rows[0]?.c0,{type:'integer',value:'9223372036854775807'});assert.equal(result.rows[0]?.c1,'原生备份');assert.equal(result.rows[0]?.c2,'00FF');});assert.equal(JSON.parse(await readFile(restored.reportPath!,'utf8')).published,true);check('Native reviewed restore creates a new database with exact values and a persisted job report');
    const abort=new AbortController(),cancelled=await api.sqliteBackups.backup(p.id,join(output,'native-cancel.db'),()=>abort.abort(),abort.signal);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.published,false);assert.equal((await session.query('SELECT count(*) FROM t')).rows[0]?.c0,1);check('Cancelling native backup publishes no file and keeps the source shared-memory session usable');
  }finally{await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(p.id);}
}
