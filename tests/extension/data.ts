import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {ProfileSchema} from '../../packages/protocol/src/index.js';
import type {ConnectionManager} from '../../packages/core/src/connections.js';
import type {DataTransfers} from '../../packages/core/src/data-transfers.js';
import type {TableEditorProvider} from '../../packages/extension/src/table-editor.js';
export async function dataChecks(api:{manager:ConnectionManager;dataTransfers:DataTransfers;tableEditors:TableEditorProvider;initializedViews():number},output:string,check:(s:string)=>void){
  const p=ProfileSchema.parse({id:'native-data',name:'Native data transfers',driver:'sqlite',storage:'memory'});await api.manager.save(p);const session=await api.manager.connect(p.id);
  try{
    await session.query('CREATE TABLE src(id INTEGER PRIMARY KEY,v TEXT)');await session.query('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<801) INSERT INTO src SELECT x,\'中文\' FROM n');await session.query('CREATE TABLE target(id INTEGER PRIMARY KEY,v TEXT)');
    const path=join(output,'full-result.json'),exported=await api.dataTransfers.exportFile(p.id,{sql:'SELECT * FROM src'},path,{format:'json',batchSize:53});assert.equal(exported.rows,801);const source=await api.dataTransfers.inspect(path,{format:'json',delimiter:',',header:true,nullToken:'\\N'});assert.equal(source.rows,801);check('Native host streams all 801 query rows independently of grid page limits into a typed JSON file');
    const before=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.importTableData',{profileId:p.id,object:{name:'target'}});const end=Date.now()+15000;while(api.initializedViews()<=before&&Date.now()<end)await new Promise(r=>setTimeout(r,100));assert(api.initializedViews()>before);check('Data import command initializes its React mapping view under actual Webview CSP');
    const preview=await api.dataTransfers.preview(source.token,p.id,'target',{id:0,v:1});assert.equal(preview.invalid,0);assert.equal((await session.query('SELECT count(*) FROM target')).rows[0]?.c0,0);const report=await api.dataTransfers.apply(p.id,preview.token,{batchSize:100,reportPath:join(output,'import-report.jsonl')});assert.equal(report.status,'succeeded',report.error);assert.equal(report.affectedRows,801);assert.equal((await session.query('SELECT count(*) FROM target')).rows[0]?.c0,801);assert.match(await readFile(report.reportPath,'utf8'),/"status":"committed"/);check('Native mapped preview writes nothing, then appends committed batches and saves a readable execution report');
    const cancelled=join(output,'cancel.csv');await writeFile(cancelled,'original');const abort=new AbortController();await assert.rejects(api.dataTransfers.exportFile(p.id,{table:'src'},cancelled,{format:'csv',overwrite:true,batchSize:1},()=>abort.abort(),abort.signal),/cancel/);assert.equal(await readFile(cancelled,'utf8'),'original');assert.equal((await session.query('SELECT count(*) FROM src')).rows[0]?.c0,801);check('Native export cancellation preserves the existing output file and shared in-memory SQLite data');
  }finally{await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(p.id);}
}
