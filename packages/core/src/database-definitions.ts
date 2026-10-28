import {createHash,randomUUID} from 'node:crypto';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import {DefinitionRefSchema,DefinitionSnapshotSchema,errorMessage,type DefinitionRef,type DefinitionSnapshot,type DefinitionPreview,type DefinitionPreviewResult,type DefinitionReport} from '../../protocol/src/index.js';
import type {ConnectionManager} from './connections.js';
import {ddlQuote,ddlLiteral} from './ddl-syntax.js';
import {definitionDocument,validateDefinition,replaceCreate,orderedTrigger} from './definition-sql.js';
import {readTableStructure} from './table-structure.js';
import {sqlTokens} from './sql-editing.js';
import {SchemaChanges} from './schema-changes.js';
import {structureFingerprint} from './structure-fingerprint.js';
import {tableDefinitionText,parseTableScript} from './table-script.js';
import {previewSql} from './ddl-script.js';
import type {DdlIntent} from '../../protocol/src/ddl.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sessionMode=(s:DefinitionSnapshot)=>({noBackslashEscapes:s.modeRaw?.split(',').includes('NO_BACKSLASH_ESCAPES')??false,ansiQuotes:s.modeRaw?.split(',').includes('ANSI_QUOTES')??false,mariaDb:s.driver==='mariadb'});
const target=(ref:DefinitionRef,driver:DefinitionSnapshot['driver'])=>ref.schema?`${ddlQuote(ref.schema,driver)}.${ddlQuote(ref.name,driver)}`:ddlQuote(ref.name,driver);
const rowsLimit=5000;
/** Catalog IDs are database-local; a snapshot additionally binds the connection revision. */
export async function listDefinitions(session:DriverSession,schema?:string):Promise<DefinitionRef[]>{
  const d=session.profile.driver,l=(s:string)=>ddlLiteral(s,d);let sql:string;
  if(d==='sqlite')sql="SELECT type,name,tbl_name FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
  else if(d==='postgresql')sql=`SELECT kind,id,schema,name,owner,label FROM (
    SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized-view' ELSE 'table' END kind,c.oid::text id,n.nspname schema,c.relname name,NULL::text owner,c.relname::text label FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('v','m','r','p')
    UNION ALL SELECT CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,p.oid::text,n.nspname,p.proname,NULL,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p')
    UNION ALL SELECT 'trigger',t.oid::text,n.nspname,t.tgname,quote_ident(n.nspname)||'.'||quote_ident(c.relname),t.tgname::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal
    ) objects WHERE schema NOT IN ('pg_catalog','information_schema') AND schema NOT LIKE 'pg_toast%' AND schema NOT LIKE 'pg_temp_%' ${schema?'AND schema='+l(schema):''} ORDER BY schema,kind,name`;
  else{
    schema=schema??session.profile.database;if(!schema)throw new Error('Select a database before opening object definitions.');
    sql=`SELECT LOWER(TABLE_TYPE) kind,TABLE_NAME name,NULL owner FROM information_schema.TABLES WHERE TABLE_SCHEMA=${l(schema)} AND TABLE_TYPE IN ('BASE TABLE','VIEW','SYSTEM VERSIONED')
      UNION ALL SELECT LOWER(ROUTINE_TYPE),ROUTINE_NAME,NULL FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=${l(schema)}
      UNION ALL SELECT 'trigger',TRIGGER_NAME,EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=${l(schema)} ORDER BY kind,name`;
  }
  const result=await session.query(sql,rowsLimit);if(result.truncated)throw new Error('Object catalog exceeds 5,000 entries. Choose a narrower schema.');
  return result.rows.map(r=>{
    if(d==='sqlite')return DefinitionRefSchema.parse({kind:r.c0,id:r.c1,name:r.c1,...(r.c0==='trigger'?{table:r.c2}:{})});
    if(d==='postgresql')return DefinitionRefSchema.parse({kind:r.c0,id:r.c1,schema:r.c2,name:r.c3,label:r.c5,...(r.c4?{table:r.c4}:{})});
    const kind=r.c0==='base table'||r.c0==='system versioned'?'table':r.c0;
    return DefinitionRefSchema.parse({kind,id:r.c1,schema,name:r.c1,...(r.c2?{table:r.c2}:{})});
  });
}

export async function readDefinition(session:DriverSession,input:DefinitionRef,revision:string):Promise<DefinitionSnapshot|null>{
  const ref=DefinitionRefSchema.parse(input),d=session.profile.driver,l=(s:string)=>ddlLiteral(s,d),q=(s:string)=>ddlQuote(s,d);
  let rawSql='',identity='',editable=!['table','materialized-view'].includes(ref.kind),notes:string[]=[],extras:{name:string;sql:string}[]=[],modeRaw:string|undefined,triggerState:string|undefined;
  let actual={...ref};
  if(ref.kind==='table'){
    let name=target(ref,d);
    if(d==='sqlite'){if(!(await session.query(`SELECT 1 FROM sqlite_schema WHERE type='table' AND name=${l(ref.name)}`,1)).rows.length)return null;name=ref.name;}
    else if(d==='postgresql'){
      if(!/^\d+$/.test(ref.id))throw new Error('Reopen the PostgreSQL table from its catalog.');
      const r=(await session.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=${Number(ref.id)}::oid AND c.relkind IN ('r','p')`,1)).rows[0];if(!r)return null;actual={...ref,schema:String(r.c0),name:String(r.c1)};name=target(actual,d);
    }else if(!ref.schema||!(await session.query(`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=${l(ref.schema)} AND TABLE_NAME=${l(ref.name)} AND TABLE_TYPE<>'VIEW'`,1)).rows.length)return null;
    const structure=await readTableStructure(session,name),rawSql=tableDefinitionText(structure,d);let editable=structure.editable;
    const notes=[...structure.notes,'Edit this CREATE TABLE and its CREATE INDEX definitions. Use Map Renamed Columns to preserve renamed values. Triggers are retained separately.'];
    try{parseTableScript(rawSql,d,{label:structure.label,schema:structure.schema},structure.sqlMode);}catch(e){editable=false;notes.push('This definition currently needs a dedicated migration: '+errorMessage(e));}
    return DefinitionSnapshotSchema.parse({profileId:session.profile.id,driver:d,ref:actual,sql:rawSql,rawSql,identity:structure.identity,revision,fingerprint:structureFingerprint(structure,d),editable,notes,extras:[],tableStructure:structure});
  }
  if(d==='sqlite'){
    if(!['table','view','trigger'].includes(ref.kind))throw new Error('SQLite has no stored procedures/functions in this editor.');
    const r=(await session.query(`SELECT rowid,type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE type=${l(ref.kind)} AND name=${l(ref.name)}`,1)).rows[0];if(!r)return null;
    rawSql=String(r.c5??'');if(ref.kind==='trigger')actual.table=String(r.c3);
    const dependencies=(await session.query(`SELECT rowid,type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE (type='trigger' AND tbl_name=${l(ref.kind==='trigger'?String(r.c3):ref.name)}) OR (type IN ('table','view') AND name=${l(String(r.c3))}) ORDER BY type,name`,0)).rows;
    identity=JSON.stringify({object:r,dependencies});
    if(ref.kind==='view')extras=dependencies.filter(v=>v.c1==='trigger').map(v=>({name:String(v.c2),sql:String(v.c5)}));
    if(!rawSql)editable=false;
    if(ref.kind==='view')notes.push('Replacing a SQLite view recreates its INSTEAD OF triggers in the same transaction. Multiple-trigger execution order is database-defined.');
  }else if(d==='postgresql'){
    if(!/^\d+$/.test(ref.id))throw new Error('PostgreSQL definition requires a catalog OID. Reopen it from the object list.');
    const where=`${Number(ref.id)}::oid`;
    if(ref.kind==='function'||ref.kind==='procedure'){
      const r=(await session.query(`SELECT n.nspname,p.proname,p.prokind,pg_get_functiondef(p.oid),p.xmin::text,p.oid::text,pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=${where}`,1)).rows[0];if(!r)return null;
      if(r.c2!==(ref.kind==='procedure'?'p':'f'))throw new Error('Object kind changed. Reopen the definition.');
      actual={...ref,schema:String(r.c0),name:String(r.c1)};rawSql=String(r.c3);identity=JSON.stringify(r);notes.push('Argument names/types identify this overload and must remain unchanged. Defaults and the body may be edited; PostgreSQL validates return-type compatibility.');
    }else if(ref.kind==='trigger'){
      const r=(await session.query(`SELECT n.nspname,t.tgname,quote_ident(n.nspname)||'.'||quote_ident(c.relname),pg_get_triggerdef(t.oid,true),t.tgenabled,t.xmin::text,t.oid::text,c.oid::text,obj_description(t.oid,'pg_trigger') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE t.oid=${where} AND NOT t.tgisinternal`,1)).rows[0];if(!r)return null;
      actual={...ref,schema:String(r.c0),name:String(r.c1),table:String(r.c2)};rawSql=String(r.c3);triggerState=String(r.c4);identity=JSON.stringify(r);
      if(r.c8!==null)extras.push({name:'comment',sql:`COMMENT ON TRIGGER ${q(actual.name)} ON ${actual.table} IS ${l(String(r.c8))}`});
    }else{
      const r=(await session.query(`SELECT n.nspname,c.relname,c.relkind,pg_get_viewdef(c.oid,true),array_to_json(c.reloptions)::text,c.xmin::text,c.oid::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=${where} AND c.relkind IN ('v','m')`,1)).rows[0];
      if(!r)return null;
      else{
        if((r.c2==='m')!==(ref.kind==='materialized-view'))throw new Error('Object kind changed. Reopen the definition.');actual={...ref,schema:String(r.c0),name:String(r.c1)};
        const options:string[]=r.c4?JSON.parse(String(r.c4)):[];
        const allowed=options.every(v=>/^(?:security_barrier|security_invoker)=(?:true|false)$|^check_option=(?:local|cascaded)$/.test(v));
        rawSql=`CREATE ${r.c2==='m'?'MATERIALIZED ':''}VIEW ${target(actual,d)}${options.length?' WITH ('+options.join(', ')+')':''} AS\n${String(r.c3).replace(/;\s*$/,'')}`;identity=JSON.stringify(r);
        if(!allowed){editable=false;notes.push('Unknown server view options require a version-specific editor.');}
      }
    }
  }else{
    if(!ref.schema)throw new Error('A MySQL/MariaDB definition requires a database.');
    let catalog:string;if(ref.kind==='view')catalog=`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=${l(ref.schema)} AND TABLE_NAME=${l(ref.name)} AND TABLE_TYPE='VIEW'`;
    else if(ref.kind==='trigger')catalog=`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=${l(ref.schema)} AND TRIGGER_NAME=${l(ref.name)}`;
    else catalog=`SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=${l(ref.schema)} AND ROUTINE_NAME=${l(ref.name)} AND ROUTINE_TYPE=${l(ref.kind.toUpperCase())}`;
    if(!(await session.query(catalog,1)).rows.length)return null;
    const result=await session.query(`SHOW CREATE ${ref.kind.toUpperCase()} ${target(ref,d)}`,1),row=result.rows[0];if(!row)throw new Error('Definition is not visible to this database user.');
    const column=result.columns.find(c=>c.name.toLowerCase()==='create '+ref.kind||ref.kind==='trigger'&&c.name.toLowerCase()==='sql original statement');
    if(!column||!row[column.key])throw new Error('Server did not expose CREATE SQL. Check SHOW ROUTINE/SHOW VIEW/TRIGGER privileges.');rawSql=String(row[column.key]);
    const mode=result.columns.find(c=>c.name.toLowerCase()==='sql_mode');modeRaw=mode?String(row[mode.key]):String((await session.query('SELECT @@SESSION.sql_mode',1)).rows[0]?.c0??'');
    if(/(?:^|,)(?:ANSI|ORACLE|DB2|POSTGRESQL|MSSQL|MAXDB|NO_FIELD_OPTIONS|NO_KEY_OPTIONS|NO_TABLE_OPTIONS)(?:,|$)/i.test(modeRaw)){editable=false;notes.push('This SQL mode can omit definition attributes or use a different grammar; use an explicit version-specific migration.');}
    const values=Object.fromEntries(result.columns.filter(c=>!['created','modified'].includes(c.name.toLowerCase())).map(c=>[c.name,row[c.key]]));identity=JSON.stringify(values);
    if(ref.kind==='trigger'){
      const siblings=(await session.query(`SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,ACTION_ORDER,ACTION_STATEMENT,DEFINER,SQL_MODE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=${l(ref.schema)} AND EVENT_OBJECT_TABLE=(SELECT EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=${l(ref.schema)} AND TRIGGER_NAME=${l(ref.name)}) ORDER BY ACTION_TIMING,EVENT_MANIPULATION,ACTION_ORDER,TRIGGER_NAME`,0)).rows;
      const me=siblings.find(r=>r.c0===ref.name);if(!me)throw new Error('Trigger changed while reading its definition.');actual.table=String(me.c1);
      const group=siblings.filter(r=>r.c2===me.c2&&r.c3===me.c3),index=group.findIndex(r=>r.c0===ref.name);extras=group.map(r=>({name:String(r.c0),sql:String(r.c5)}));
      // Keep ordered siblings and creation modes in the conflict fingerprint.
      identity=JSON.stringify({values,siblings});triggerState=JSON.stringify({timing:me.c2,event:me.c3,before:group[index+1]?.c0,after:group[index-1]?.c0});
    }
    notes.push('DDL implicitly commits. A failed replacement may leave the object missing or partially changed; no automatic retry or restoration is performed.');
    if(d==='mysql'&&['function','procedure'].includes(ref.kind))notes.push('MySQL routine replacement uses DROP/CREATE and revokes routine-specific grants. Review and restore those grants separately.');
    if(['function','procedure','trigger'].includes(ref.kind)){
      const context=(await session.query(`SELECT @@SESSION.character_set_client,@@SESSION.collation_connection,(SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=${l(ref.schema)})`,1)).rows[0];
      const names=['character_set_client','collation_connection','database collation'],expected=names.map(name=>{const c=result.columns.find(c=>c.name.toLowerCase()===name);return c?row[c.key]:undefined;});
      identity=JSON.stringify({definition:identity,effectiveCreationContext:context});
      if(!context||expected.some((v,i)=>!v||String(v)!==String(context['c'+i]))){editable=false;notes.push('Stored-program character set/collation differs from this connection or current database defaults. Definition remains inspectable; preserving that creation context needs a dedicated migration.');}
    }
  }
  if(Buffer.byteLength(rawSql)+Buffer.byteLength(identity)>12*1024*1024)throw new Error('Definition/catalog snapshot exceeds the editor budget. Use native database tooling.');
  if(!editable)notes.push('This definition is for reference. Use the table designer or an explicit migration for table/materialized-view structure changes.');
  if(d==='postgresql')notes.push('Version checks detect observed server changes; they cannot exclude every concurrent external DDL operation.');
  return DefinitionSnapshotSchema.parse({profileId:session.profile.id,driver:d,ref:actual,sql:definitionDocument(rawSql,d,ref.kind),rawSql,identity,revision,fingerprint:hash({identity,rawSql,ref:actual}),editable,notes,extras,modeRaw,triggerState});
}

interface Plan{baseline:DefinitionSnapshot;preview:DefinitionPreview;expires:number;tableToken?:string;}
export class DatabaseDefinitions{
  private plans=new Map<string,Plan>();private busy=new Set<string>();
  private tableChanges:SchemaChanges;
  constructor(private manager:ConnectionManager,private before:(id:string)=>Promise<void>=async()=>{},private settled:(id:string)=>Promise<void>=async()=>{},tableChanges?:SchemaChanges){this.tableChanges=tableChanges??new SchemaChanges(manager,()=>{},before,settled);}
  private async use<T>(id:string,action:(session:DriverSession)=>Promise<T>){const owner='definition-read:'+randomUUID();try{return await action(await this.manager.lease(id,owner));}finally{await this.manager.releaseLease(owner);}}
  list(id:string,schema?:string){return this.use(id,s=>listDefinitions(s,schema));}
  async read(id:string,ref:DefinitionRef){const revision=this.manager.editorRevision(id);const result=await this.use(id,s=>readDefinition(s,ref,revision));if(revision!==this.manager.editorRevision(id))throw new Error('Connection changed while reading the definition. Reopen it.');return result;}
  forget(token:string){const p=this.plans.get(token);if(p?.tableToken)this.tableChanges.forget(p.tableToken);this.plans.delete(token);}
  async preview(input:DefinitionSnapshot,text:string,renames:Extract<DdlIntent,{action:'editDefinition'}>['renames']=[]):Promise<DefinitionPreviewResult>{
    const baseline=DefinitionSnapshotSchema.parse(input),id=baseline.profileId;if(this.manager.profile(id).readOnly)throw new Error('This connection is read-only.');if(!baseline.editable)throw new Error('This object definition is for reference only.');
    if(this.manager.editorRevision(id)!==baseline.revision)throw new Error('Connection settings or credentials changed. Reopen the definition.');if(this.busy.has(id))throw new Error('An object definition is already being applied.');
    const current=await this.read(id,baseline.ref);if(!current||current.fingerprint!==baseline.fingerprint)return {kind:'conflict',baseline,current};if(!current.editable)throw new Error('The current server definition is for reference only. Reopen it to inspect compatibility notes.');
    if(baseline.ref.kind==='table'){
      if(!baseline.tableStructure)throw new Error('Reopen this older table draft to capture its schema baseline. Your SQL file is kept.');
      const p=await this.tableChanges.preview(id,baseline.tableStructure.name,{action:'editDefinition',sql:text,baselineSql:baseline.rawSql,renames},baseline.fingerprint),preview:DefinitionPreview={token:randomUUID(),profileId:id,target:target(baseline.ref,baseline.driver),kind:'table',policy:p.policy,steps:p.steps.map(s=>s.sql),warnings:[...baseline.notes,...p.warnings],expiresAt:p.expiresAt,sql:previewSql(p,baseline.driver)};
      for(const [key,value] of this.plans)if(value.expires<Date.now())this.forget(key);while(this.plans.size>=20||this.plans.size&&[...this.plans.values()].reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0)+Buffer.byteLength(JSON.stringify({baseline,preview}))>64*1024*1024)this.forget(this.plans.keys().next().value!);
      this.plans.set(preview.token,{baseline,preview,expires:Date.parse(p.expiresAt),tableToken:p.token});return {kind:'preview',preview:structuredClone(preview)};
    }
    const sql=validateDefinition(baseline,text),driver=baseline.driver,ref=baseline.ref,qualified=target(ref,driver),steps:string[]=[],warnings=[...baseline.notes];
    const transactional=driver==='sqlite'||driver==='postgresql';
    const unchanged=sql===validateDefinition(baseline,baseline.sql);
    if(unchanged)warnings.push('The definition is unchanged. No replacement statements will be sent.');
    else if(driver==='sqlite'){steps.push(`DROP ${ref.kind.toUpperCase()} ${qualified}`,sql);if(ref.kind==='view')steps.push(...baseline.extras.map(e=>e.sql));}
    else if(driver==='postgresql'){
      if(ref.kind==='trigger'){
        steps.push(`DROP TRIGGER ${ddlQuote(ref.name,driver)} ON ${ref.table}`,sql);
        const states:Record<string,string>={O:'ENABLE',D:'DISABLE',R:'ENABLE REPLICA',A:'ENABLE ALWAYS'};if(!states[baseline.triggerState??''])throw new Error('Unknown PostgreSQL trigger enabled state.');
        steps.push(`ALTER TABLE ${ref.table} ${states[baseline.triggerState!]} TRIGGER ${ddlQuote(ref.name,driver)}`);
        steps.push(...baseline.extras.map(e=>e.sql));
      }else steps.push(replaceCreate(sql,driver));
    }else{
      if(baseline.modeRaw!==undefined)steps.push('SET SESSION sql_mode='+ddlLiteral(baseline.modeRaw,driver));
      if(ref.kind==='view'||driver==='mariadb'&&['function','procedure'].includes(ref.kind))steps.push(replaceCreate(sql,driver,baseline.modeRaw));
      else{
        steps.push(`DROP ${ref.kind.toUpperCase()} ${qualified}`);
        const order=JSON.parse(baseline.triggerState??'{}');
        if(ref.kind==='trigger'){
          const tokens=sqlTokens(sql,driver,sessionMode(baseline)),timing=tokens.findIndex(t=>t.kind==='word'&&['BEFORE','AFTER'].includes(t.text.toUpperCase()));
          if(tokens[timing]?.text.toUpperCase()!==order.timing||tokens[timing+1]?.text.toUpperCase()!==order.event){delete order.before;delete order.after;}
        }
        steps.push(ref.kind==='trigger'?orderedTrigger(sql,order,s=>ddlQuote(s,driver),driver,baseline.modeRaw??''):sql);
      }
    }
    if(!transactional)warnings.push('A replacement is not a rollback-safe transaction. Preserve the original definition before applying.');
    const expires=Date.now()+15*60*1000,preview:DefinitionPreview={token:randomUUID(),profileId:id,target:qualified,kind:ref.kind,policy:transactional?'transactional':'implicit-commit',steps,warnings,expiresAt:new Date(expires).toISOString()};
    for(const [k,p] of this.plans)if(p.expires<Date.now())this.forget(k);
    const bytes=()=>[...this.plans.values()].reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0);while(this.plans.size>=20||this.plans.size&&bytes()+Buffer.byteLength(JSON.stringify({baseline,preview}))>64*1024*1024)this.forget(this.plans.keys().next().value!);
    this.plans.set(preview.token,{baseline,preview,expires});return {kind:'preview',preview:structuredClone(preview)};
  }
  async apply(id:string,token:string,signal?:AbortSignal):Promise<DefinitionReport>{
    const p=this.plans.get(token);if(!p||p.baseline.profileId!==id||p.expires<Date.now())throw new Error('Definition preview expired. Preview again.');
    if(this.busy.has(id))throw new Error('An object definition is already being applied.');if(this.manager.profile(id).readOnly)throw new Error('This connection is read-only.');if(this.manager.editorRevision(id)!==p.baseline.revision)throw new Error('Connection changed after preview. Reopen the definition.');
    if(p.tableToken){
      this.busy.add(id);try{const report=await this.tableChanges.apply(id,p.tableToken,signal),warnings=[...p.preview.warnings,...report.warnings??[]];this.tableChanges.forget(p.tableToken);this.plans.delete(token);let snapshot:DefinitionSnapshot|undefined;
        if(report.status==='succeeded'){try{snapshot=(await this.read(id,p.baseline.ref))??undefined;}catch(e){warnings.push('Applied, but definition refresh failed: '+errorMessage(e));}}
        return {status:report.status,completed:report.completed,committed:report.committed??report.status==='succeeded',rolledBack:report.rolledBack,error:report.error,warnings,snapshot};
      }finally{this.busy.delete(id);}
    }
    this.busy.add(id);const owner='definition-apply:'+token,driver=p.baseline.driver;let session:DriverSession|undefined,transaction=false,completed=0,sent=false,committing=false,committed=false,outcome:DefinitionReport|undefined;
    const check=()=>{if(signal?.aborted)throw new Error('Definition application cancelled.');if(this.manager.editorRevision(id)!==p.baseline.revision)throw new Error('Connection changed during definition application.');};
    const warnings=[...p.preview.warnings];
    try{
      check();await this.before(id);check();
      if(this.manager.documentSessions(id).some(l=>l.session?.transactionState==='active')||(await this.manager.connect(id)).transactionState==='active')throw new Error('Commit or roll back SQL transactions before applying definitions.');
      session=await this.manager.lease(id,owner);
      if(p.preview.policy==='transactional'){await session.query(driver==='sqlite'?'BEGIN IMMEDIATE':'BEGIN');transaction=true;}
      if(driver==='postgresql'&&p.baseline.ref.kind==='view')await session.query(`LOCK TABLE ${p.preview.target} IN ACCESS EXCLUSIVE MODE`);
      if(driver==='postgresql'&&p.baseline.ref.kind==='trigger')await session.query(`LOCK TABLE ${p.baseline.ref.table} IN ACCESS EXCLUSIVE MODE`);
      const current=await readDefinition(session,p.baseline.ref,p.baseline.revision);if(!current||current.fingerprint!==p.baseline.fingerprint)throw new Error('Server definition changed after preview. Compare and preview again; no definition steps were sent.');if(!current.editable)throw new Error('The server definition is now for reference only. Reopen its compatibility notes.');
      check();this.plans.delete(token);
      for(const sql of p.preview.steps){check();sent=true;await session.query(sql,0);completed++;const first=sqlTokens(sql,driver,session.sqlMode).find(t=>t.kind!=='comment');if(p.preview.policy==='implicit-commit'&&['CREATE','ALTER','DROP','RENAME','TRUNCATE'].includes(first?.text.toUpperCase()??''))committed=true;}
      // Compile a replaced view without executing a user-defined query body.
      if(driver==='sqlite'&&p.baseline.ref.kind==='view')await session.query(`SELECT * FROM ${p.preview.target} LIMIT 0`,1);
      if(p.preview.policy==='implicit-commit'&&committed&&signal?.aborted){if(this.manager.editorRevision(id)!==p.baseline.revision)throw new Error('Connection changed after DDL completed.');warnings.push('The DDL completed before cancellation took effect.');}else check();
      if(transaction){committing=true;await session.query('COMMIT');transaction=false;committing=false;}committed=true;
      let snapshot:DefinitionSnapshot|undefined;try{
        let ref=p.baseline.ref;
        if(driver==='postgresql'&&ref.kind==='trigger'){
          const r=(await session.query(`SELECT oid::text FROM pg_trigger WHERE tgrelid=to_regclass(${ddlLiteral(ref.table!,driver)}) AND tgname=${ddlLiteral(ref.name,driver)} AND NOT tgisinternal`,1)).rows[0];if(r)ref={...ref,id:String(r.c0)};
        }
        snapshot=(await readDefinition(session,ref,p.baseline.revision))??undefined;
      }catch(e){warnings.push('Applied, but definition refresh failed: '+errorMessage(e));}
      outcome={status:'succeeded',completed,committed:true,rolledBack:false,snapshot,warnings};return outcome;
    }catch(error){
      let rolledBack=false;if(transaction&&session?.connected&&!committing){try{await session.query('ROLLBACK');rolledBack=true;}catch{}}
      let objectExists:boolean|undefined;if(!transaction&&session?.connected){try{objectExists=!!await readDefinition(session,p.baseline.ref,p.baseline.revision);}catch{}}
      const unknown=committing||sent&&!session?.connected&&!rolledBack;
      outcome={status:unknown?'unknown':signal?.aborted?'cancelled':'failed',completed,committed,rolledBack,objectExists,error:errorMessage(error),warnings};return outcome;
    }finally{try{await this.manager.releaseLease(owner);}catch(e){warnings.push((committed?'Applied, but ':'')+'session cleanup failed: '+errorMessage(e));}finally{try{await this.settled(id);}catch(e){warnings.push((committed?'Applied, but ':'')+'editor refresh failed: '+errorMessage(e));}finally{this.busy.delete(id);}}}
  }
}
