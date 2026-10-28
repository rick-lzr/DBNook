import type {DdlPreview} from '../../protocol/src/ddl.js';
/** A manually executable copy uses SQL CHECK assertions, never comments as validation. */
export function previewSql(preview:DdlPreview,driver:string){
  const sqlite=driver==='sqlite',pre=preview.policy==='sqlite-rebuild'?['PRAGMA foreign_keys=OFF;','PRAGMA legacy_alter_table=ON;','BEGIN IMMEDIATE;']:preview.policy==='transactional'?[sqlite?'BEGIN IMMEDIATE;':'BEGIN;']:['-- DDL implicitly commits. Completed changes cannot be rolled back.'];
  const assertion='"dbw_assert_'+preview.token.replaceAll('-','')+'"',checked=sqlite&&preview.steps.some(s=>s.expect);
  const body=preview.steps.map(s=>{if(!s.expect)return s.sql.replace(/;\s*$/,'')+';';const sql=s.expect==='empty'?'SELECT NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)':s.expect==='integrity'?"SELECT integrity_check='ok' FROM pragma_integrity_check":s.sql;return `INSERT INTO ${assertion} ${sql};\nDELETE FROM ${assertion};`;});
  return ['-- Manual SQL document: this does not recheck the managed preview token or schema fingerprint.\n-- On any error, ROLLBACK and Reset Session before continuing.',...pre,...(checked?[`CREATE TEMP TABLE ${assertion}(ok INTEGER NOT NULL CHECK(ok=1));`]:[]),...body,...(checked?[`DROP TABLE ${assertion};`]:[]),...(preview.policy==='implicit-commit'?[]:['COMMIT;']),...(preview.policy==='sqlite-rebuild'?['PRAGMA legacy_alter_table=OFF;','PRAGMA foreign_keys=ON;']:[])].join('\n\n');
}
