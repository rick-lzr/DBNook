import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mysqlDdlModeText} from '../packages/core/src/mysql-ddl-text.js';
import {parseTableScript} from '../packages/core/src/table-script.js';
test('MySQL catalog literal conversion preserves paths, Unicode, quotes, control characters and identifier boundaries across lexical modes',()=>{
 const escaped={noBackslashEscapes:false,ansiQuotes:true},ordinary={noBackslashEscapes:true,ansiQuotes:false};
 const sql=String.raw`CREATE TABLE "db"."t" ("added" varchar(80) DEFAULT 'C:\\new\\中文''quote', "line" TEXT COMMENT 'a\nb', "tick${'``'}name" INT) COMMENT='AUTO_INCREMENT=88 kept'`;
 const normalized=mysqlDdlModeText(sql,'mysql',escaped,ordinary);assert(normalized.includes("'C:\\new\\中文''quote'"));assert(normalized.includes("COMMENT 'a\nb'"));assert(normalized.includes('`tick````name`'));
 const parsed=parseTableScript(normalized,'mysql',{schema:'db',label:'t'},ordinary);assert.equal(parsed.columns[0]?.name,'added');assert.equal(parsed.columns[2]?.name,'tick``name');const roundtrip=mysqlDdlModeText(normalized,'mysql',ordinary,escaped);assert(roundtrip.includes(String.raw`'C:\\new\\中文''quote'`));assert.equal(parseTableScript(roundtrip,'mysql',{schema:'db',label:'t'},escaped).columns.length,3);
 assert.throws(()=>mysqlDdlModeText(String.raw`DEFAULT '\0'`.replace('\\\\','\\'),'mysql',escaped,ordinary),/NUL/);
});
