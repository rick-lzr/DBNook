import {randomUUID} from 'node:crypto';
import type {DdlColumn,DdlConstraint,DdlIntent,DdlPreview,DdlStep,TableStructure} from '../../protocol/src/ddl.js';
import {alterColumnDefinition,ddlFragment,ddlLiteral,ddlQuote,ddlSegments,type DdlDriver} from './ddl-syntax.js';
import {sqlTokens} from './sql-editing.js';
export function renderDdl(driver:DdlDriver,intent:DdlIntent,s?:TableStructure,mode=s?.sqlMode):Pick<DdlPreview,'steps'|'warnings'|'policy'|'table'|'before'>{
  if(intent.action==='editDefinition')throw new Error('Text definitions require the schema-aware migration planner.');
  const q=(v:string)=>ddlQuote(v,driver),mysql=driver==='mysql'||driver==='mariadb';
  const warnings:string[]=[],steps:DdlStep[]=[];let policy:DdlPreview['policy']=mysql?'implicit-commit':'transactional';
  const qualified=(name:string,schema?:string)=>schema?`${q(schema)}.${q(name)}`:q(name);
  const constraint=(c:DdlConstraint,schema?:string)=>{
    const cols=c.columns.map(q).join(', ');if(c.kind!=='check'&&!c.columns.length)throw new Error('Choose at least one constraint column.');
    const prefix=`CONSTRAINT ${q(c.name)} `;
    if(c.kind==='check'){if(!c.expression)throw new Error('Enter a CHECK expression.');return prefix+`CHECK (${ddlFragment(c.expression,driver,mode)})`;}
    if(c.kind==='primary'||c.kind==='unique')return prefix+(c.kind==='primary'?'PRIMARY KEY':'UNIQUE')+` (${cols})`;
    if(!c.targetTable||c.targetColumns?.length!==c.columns.length)throw new Error('Choose a referenced table and the same number of referenced columns.');
    if(mysql&&(c.onDelete==='SET DEFAULT'||c.onUpdate==='SET DEFAULT'))throw new Error('MySQL/MariaDB foreign keys do not support SET DEFAULT.');
    if(driver==='sqlite'&&c.targetSchema)throw new Error('SQLite REFERENCES uses an unqualified table in the same database.');
    return prefix+`FOREIGN KEY (${cols}) REFERENCES ${qualified(c.targetTable,c.targetSchema??schema)} (${c.targetColumns.map(q).join(', ')}) ON DELETE ${c.onDelete} ON UPDATE ${c.onUpdate}`;
  };
  const column=(c:DdlColumn)=>`${q(c.name)} ${ddlFragment(c.dataType,driver,mode)}${c.nullable?'':' NOT NULL'}${c.defaultSql===null?'':' DEFAULT '+ddlFragment(c.defaultSql,driver,mode)}`;
  const add=(sql:string)=>steps.push({sql});
  let table=s?.name??'',targetSql=s?driver==='sqlite'?q(s.name):s.name:'';
  if(intent.action==='createTable'){
    if(driver!=='sqlite'&&!intent.schema)throw new Error('Enter a target schema/database for the new table.');
    if(driver==='sqlite'&&intent.schema&&intent.schema!=='main')throw new Error('The designer currently creates SQLite tables in main.');
    if(new Set(intent.columns.map(c=>c.name.toLowerCase())).size!==intent.columns.length)throw new Error('Column names must be unique.');
    const names=new Set(intent.columns.map(c=>c.name));for(const c of intent.constraints)if(c.columns.some(n=>!names.has(n)))throw new Error('Constraint references an unknown new column.');
    if(intent.constraints.filter(c=>c.kind==='primary').length>1)throw new Error('A table has one primary key.');
    targetSql=qualified(intent.name,driver==='sqlite'?undefined:intent.schema);table=driver==='sqlite'?intent.name:targetSql;
    add(`CREATE TABLE ${targetSql} (\n  ${[...intent.columns.map(column),...intent.constraints.map(c=>constraint(c,driver==='sqlite'?undefined:intent.schema))].join(',\n  ')}\n)${mysql?' ENGINE=InnoDB':''}`);
  }else{
    if(!s?.editable||s.type!=='table')throw new Error('This object supports definition viewing, but cannot be changed by this designer.');
    const requireColumn=(name:string)=>{const c=s.columns.find(c=>c.name===name);if(!c)throw new Error('This column no longer exists. Reload the structure.');return c;};
    switch(intent.action){
      case 'addColumn':if(s.columns.some(c=>c.name===intent.column.name))throw new Error('That column already exists.');add(`ALTER TABLE ${targetSql} ADD COLUMN ${column(intent.column)}`);break;
      case 'renameColumn':requireColumn(intent.column);add(`ALTER TABLE ${targetSql} RENAME COLUMN ${q(intent.column)} TO ${q(intent.name)}`);break;
      case 'dropColumn':requireColumn(intent.column);warnings.push('The column data will be deleted. The server may also remove dependent indexes and constraints or reject the operation.');add(`ALTER TABLE ${targetSql} DROP COLUMN ${q(intent.column)}`);break;
      case 'renameTable':add(`ALTER TABLE ${targetSql} RENAME TO ${q(intent.name)}`);table=driver==='sqlite'?intent.name:qualified(intent.name,s.schema);break;
      case 'dropTable':warnings.push('This deletes the table and its data. Dependent objects may prevent deletion.');add(`DROP TABLE ${targetSql}`);if(driver==='sqlite')policy='sqlite-rebuild';break;
      case 'addIndex':{
        for(const c of intent.columns)requireColumn(c.name);if(intent.where&&mysql)throw new Error('Partial indexes are available only for SQLite/PostgreSQL.');
        add(`CREATE ${intent.unique?'UNIQUE ':''}INDEX ${q(intent.name)} ON ${targetSql} (${intent.columns.map(c=>`${q(c.name)} ${c.direction.toUpperCase()}`).join(', ')})${intent.where?' WHERE '+ddlFragment(intent.where,driver,mode):''}`);break;
      }
      case 'dropIndex':{const index=s.indexes.find(i=>i.name===intent.name);if(!index)throw new Error('This index no longer exists.');if(index.protected)throw new Error('This index is owned by a constraint. Manage the owning constraint instead.');add(mysql?`ALTER TABLE ${targetSql} DROP INDEX ${q(intent.name)}`:`DROP INDEX ${qualified(intent.name,driver==='postgresql'?s.schema:undefined)}`);break;}
      case 'alterColumn':{
        const c=requireColumn(intent.column);if(c.generated&&intent.change!=='type')throw new Error('Generated/identity column attributes need a dedicated editor.');if(c.primaryKey&&intent.change==='nullable'&&intent.value===true)throw new Error('Remove the primary key before allowing NULL.');
        if(driver==='postgresql'){
          const p=`ALTER TABLE ${targetSql} ALTER COLUMN ${q(c.name)} `;
          if(intent.change==='type'){if(typeof intent.value!=='string')throw new Error('Enter a SQL type.');add(p+'TYPE '+ddlFragment(intent.value,driver));warnings.push('Type conversion uses the server default cast. A conversion needing USING must be written in a SQL document.');}
          else if(intent.change==='nullable'){if(typeof intent.value!=='boolean')throw new Error('Choose whether NULL is allowed.');add(p+(intent.value?'DROP':'SET')+' NOT NULL');}
          else{if(intent.value!==null&&typeof intent.value!=='string')throw new Error('Enter a default expression.');add(p+(intent.value===null?'DROP DEFAULT':'SET DEFAULT '+ddlFragment(intent.value,driver)));}
        }else if(mysql){if(!c.definition)throw new Error('The original column definition is unavailable.');add(`ALTER TABLE ${targetSql} MODIFY COLUMN ${alterColumnDefinition(c.definition,driver,intent.change,intent.value,mode)}`);}
        else{
          const parsed=ddlSegments(s.definition,driver),p=parsed.segments.find(p=>p.column===c.name);if(!p)throw new Error('Original SQLite column definition is unavailable.');p.text=alterColumnDefinition(p.text,driver,intent.change,intent.value);rebuild(parsed.segments.map(p=>p.text),parsed.suffix);
        }break;
      }
      case 'addConstraint':{
        for(const n of intent.constraint.columns)requireColumn(n);const sql=constraint(intent.constraint,driver==='sqlite'?undefined:s.schema);
        if(driver==='sqlite'){const parsed=ddlSegments(s.definition,driver);rebuild([...parsed.segments.map(p=>p.text),sql],parsed.suffix);}else add(`ALTER TABLE ${targetSql} ADD ${sql}`);break;
      }
      case 'dropConstraint':{
        const c=s.constraints.find(c=>c.name===intent.name);if(!c)throw new Error('This constraint no longer exists.');warnings.push('Removing a constraint can allow previously rejected data.');
        if(driver==='sqlite'){const parsed=ddlSegments(s.definition,driver),index=parsed.segments.findIndex((p,i)=>!p.column&&(intent.name===`@${i}`||p.tokens[0]?.text.toUpperCase()==='CONSTRAINT'&&p.text===c.definition));if(index<0)throw new Error('Inline constraints must be edited through their column or a SQL migration.');rebuild(parsed.segments.filter((_,i)=>i!==index).map(p=>p.text),parsed.suffix);}
        else add(`ALTER TABLE ${targetSql} ${driver==='postgresql'?'DROP CONSTRAINT '+q(c.name):c.kind==='primary'?'DROP PRIMARY KEY':c.kind==='foreign'?'DROP FOREIGN KEY '+q(c.name):c.kind==='unique'?'DROP INDEX '+q(c.name):driver==='mysql'?'DROP CHECK '+q(c.name):'DROP CONSTRAINT '+q(c.name)}`);break;
      }
    }
    function rebuild(segments:string[],suffix:string){
      policy='sqlite-rebuild';const temp='dbw_rebuild_'+randomUUID().replaceAll('-',''),withoutRowid=/\bWITHOUT\s+ROWID\b/i.test(suffix);
      const writable=s!.columns.filter(c=>!c.generated).map(c=>c.name);if(!writable.length)throw new Error('No writable columns to copy.');
      const alias=['rowid','_rowid_','oid'].find(a=>!s!.columns.some(c=>c.name.toLowerCase()===a));if(!withoutRowid&&!alias)throw new Error('All rowid aliases are shadowed. Use a custom migration to preserve hidden row identifiers.');
      const cols=[...(!withoutRowid?[alias!]:[]),...writable].map(q).join(', ');
      add(`CREATE TABLE ${q(temp)} (\n  ${segments.join(',\n  ')}\n${suffix}`);
      add(`INSERT INTO ${q(temp)} (${cols}) SELECT ${cols} FROM ${targetSql}`);
      steps.push({sql:`SELECT (SELECT count(*) FROM ${q(temp)}) = (SELECT count(*) FROM ${targetSql})`,expect:'one'});
      if(sqlTokens(s!.definition,driver).some(t=>t.kind==='word'&&t.text.toUpperCase()==='AUTOINCREMENT')){add(`DELETE FROM sqlite_sequence WHERE name=${ddlLiteral(temp,driver)}`);add(`INSERT INTO sqlite_sequence(name,seq) SELECT ${ddlLiteral(temp,driver)},seq FROM sqlite_sequence WHERE name=${ddlLiteral(s!.name,driver)}`);}
      add(`DROP TABLE ${targetSql}`);add(`ALTER TABLE ${q(temp)} RENAME TO ${q(s!.name)}`);
      for(const a of s!.auxiliary)add(a.sql);
      warnings.push('SQLite rebuilds this table inside a transaction. Existing data, accessible rowids, AUTOINCREMENT state, indexes and triggers are copied. Changing type affinity can convert stored values; constraints or casts can fail. Foreign keys are checked before commit.');
    }
  }
  if(mysql)warnings.push('MySQL/MariaDB DDL commits implicitly and may wait for metadata locks. A completed change cannot be rolled back. The structure check is best effort against simultaneous external DDL.');
  if(policy==='sqlite-rebuild'){steps.push({sql:'PRAGMA foreign_key_check',expect:'empty'},{sql:'PRAGMA integrity_check',expect:'integrity'});warnings.push('Foreign-key enforcement is disabled only on the dedicated migration session during the transaction; violations abort the change.');}
  return {steps,warnings,policy,table,before:s?.definition??''};
}
