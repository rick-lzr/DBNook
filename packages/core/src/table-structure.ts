import type {DriverSession} from '../../driver-sdk/src/index.js';
import type {TableStructure} from '../../protocol/src/ddl.js';
import {ddlLiteral,ddlQuote,ddlSegments} from './ddl-syntax.js';
import {sqlIdentifier,sqlTokens} from './sql-editing.js';
import {tableIdentifier} from './table-script.js';
import {mysqlDdlModeText} from './mysql-ddl-text.js';

export async function readTableStructure(session:DriverSession,table:string):Promise<TableStructure>{
  const driver=session.profile.driver,details=await session.details(table),q=(s:string)=>ddlQuote(s,driver);
  const s:TableStructure={name:details.name,label:details.name,schema:undefined,type:details.type,identity:'',definition:details.sql??'',notes:[],editable:details.type==='table',columns:details.columns.map(c=>({name:c.name,dataType:c.dataType,nullable:c.nullable,defaultSql:c.defaultValue??null,generated:c.generated,primaryKey:c.primaryKey,definition:''})),indexes:details.indexes.map(i=>({...i,definition:'',protected:false})),constraints:[],auxiliary:[]};
  s.sqlMode=session.sqlMode;
  if(driver==='sqlite'){
    const storageType=String((await session.query(`SELECT type FROM pragma_table_list WHERE schema='main' AND name=${ddlLiteral(table,driver)}`,1)).rows[0]?.c0??'');
    if(storageType==='shadow'){s.editable=false;s.notes.push('SQLite virtual-table shadow storage is managed by its module and cannot be changed here.');}
    const result=await session.query('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name',0);
    s.identity=JSON.stringify(result.rows);s.definition=details.sql??'';
    s.auxiliary=result.rows.filter(r=>r.c2===table&&['index','trigger'].includes(String(r.c0))&&r.c4!==null).map(r=>({type:String(r.c0),name:String(r.c1),sql:String(r.c4)}));
    for(const i of s.indexes){i.definition=s.auxiliary.find(a=>a.type==='index'&&a.name===i.name)?.sql??'';i.protected=!i.definition;}
    if(s.type==='table'&&!/^CREATE\s+VIRTUAL\b/i.test(s.definition)){
      const parsed=ddlSegments(s.definition,driver);
      for(const c of s.columns)c.definition=parsed.segments.find(p=>p.column===c.name)?.text??'';
      parsed.segments.forEach((p,i)=>{if(!p.column){const named=p.tokens[0]?.text.toUpperCase()==='CONSTRAINT';s.constraints.push({name:named?sqlIdentifier(p.tokens[1]!.text):`@${i}`,kind:p.tokens[named?2:0]?.text.toLowerCase()??'other',definition:p.text});}});
    }else if(s.type==='table'){s.editable=false;s.notes.push('Virtual tables require a module-specific structure editor.');}
    s.notes.push('SQLite definition is read from sqlite_schema. Indexes and triggers are listed separately.');
    return s;
  }
  if(driver==='mysql'||driver==='mariadb'){
    const modes=String((await session.query('SELECT @@SESSION.sql_mode',1)).rows[0]?.c0??'');if(/(?:^|,)(?:ANSI|ORACLE|DB2|POSTGRESQL|MSSQL|MAXDB|NO_FIELD_OPTIONS|NO_KEY_OPTIONS|NO_TABLE_OPTIONS)(?:,|$)/i.test(modes)){s.editable=false;s.notes.push('This SQL mode can omit attributes from SHOW CREATE output. Use a normal-mode connection or an explicit SQL migration to preserve all attributes.');}
    const create=await session.query(`SHOW CREATE TABLE ${details.name}`,0);s.definition=String(create.rows[0]?.c1??'');s.identity=details.name;
    // The tested servers escape SHOW CREATE literal backslashes even under NO_BACKSLASH_ESCAPES.
    // Normalize catalog text into the actual session mode before it becomes an editable draft.
    if(session.sqlMode?.noBackslashEscapes)s.definition=mysqlDdlModeText(s.definition,driver,{...session.sqlMode,noBackslashEscapes:false},session.sqlMode);
    const qualified=details.name.match(/^`((?:``|[^`])*)`\.`((?:``|[^`])*)`$/);s.schema=qualified?.[1]?.replaceAll('``','`');s.label=qualified?.[2]?.replaceAll('``','`')??details.name;
    if(s.type==='table'){
      const parsed=ddlSegments(s.definition,driver,session.sqlMode);
      for(const c of s.columns)c.definition=parsed.segments.find(p=>p.column===c.name)?.text??'';
      for(const p of parsed.segments.filter(p=>!p.column)){
        const first=p.tokens[0]?.text.toUpperCase(),named=first==='CONSTRAINT';
        if(first==='PRIMARY')s.constraints.push({name:'PRIMARY',kind:'primary',definition:p.text});
        else if(first==='UNIQUE'){const i=p.tokens.findIndex(t=>['KEY','INDEX'].includes(t.text.toUpperCase()));s.constraints.push({name:sqlIdentifier(p.tokens[i>=0?i+1:1]!.text),kind:'unique',definition:p.text});}
        else if(named)s.constraints.push({name:sqlIdentifier(p.tokens[1]!.text),kind:p.tokens[2]!.text.toLowerCase(),definition:p.text});
        if(!named&&['PRIMARY','UNIQUE','KEY','INDEX','FULLTEXT','SPATIAL'].includes(first??'')){
          let at=0;if(['UNIQUE','FULLTEXT','SPATIAL'].includes(first??''))at++;if(['KEY','INDEX'].includes(p.tokens[at]?.text.toUpperCase()??''))at++;
          const indexName=first==='PRIMARY'?'PRIMARY':p.tokens[at]?sqlIdentifier(p.tokens[at]!.text):undefined;
          const index=s.indexes.find(i=>i.name===indexName);if(index)index.definition=p.text;
        }
      }
      for(const i of s.indexes)i.protected=i.name==='PRIMARY'||s.constraints.some(c=>c.name===i.name&&c.kind!=='unique');
    }
    s.notes.push('Server SHOW CREATE TABLE output. DDL implicitly commits; rollback cannot undo a completed change.');return s;
  }
  const name=ddlLiteral(details.name,'postgresql');
  const result=await session.query(`SELECT json_build_object('oid',c.oid::text,'kind',c.relkind,'persistence',c.relpersistence,'options',c.reloptions,'partition',c.relispartition,'children',c.relhassubclass,'schema',n.nspname,'label',c.relname,
    'columns',COALESCE((SELECT json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'collation',CASE WHEN a.attcollation<>t.typcollation THEN quote_ident(cn.nspname)||'.'||quote_ident(co.collname) END) ORDER BY a.attnum) FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::json),
    'constraints',COALESCE((SELECT json_agg(json_build_object('name',k.conname,'kind',k.contype,'sql',pg_get_constraintdef(k.oid,true),'comment',obj_description(k.oid,'pg_constraint'),'targetSchema',rn.nspname,'targetTable',rc.relname) ORDER BY k.conname) FROM pg_constraint k LEFT JOIN pg_class rc ON rc.oid=k.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace WHERE k.conrelid=c.oid),'[]'::json),
    'indexes',COALESCE((SELECT json_agg(json_build_object('name',ci.relname,'sql',pg_get_indexdef(i.indexrelid),'owned',EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid),'comment',obj_description(ci.oid,'pg_class'),'clustered',i.indisclustered,'replicaIdentity',i.indisreplident) ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid),'[]'::json))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass(${name})`,0);
  const data=JSON.parse(String(result.rows[0]?.c0));s.identity=JSON.stringify(data);s.schema=data.schema;s.label=data.label;
  for(const c of s.columns){const a=data.columns.find((a:any)=>a.name===c.name);if(!a)throw new Error('Table structure changed while reading columns. Reload.');c.defaultSql=a.generated||a.identity?null:a.default;c.generated=Boolean(a.generated||a.identity);c.definition=`${q(c.name)} ${a.type}${a.collation?' COLLATE '+a.collation:''}${a.generated?' GENERATED ALWAYS AS ('+a.default+') STORED':a.identity?' GENERATED '+(a.identity==='a'?'ALWAYS':'BY DEFAULT')+' AS IDENTITY':a.default!==null?' DEFAULT '+a.default:''}${a.notnull?' NOT NULL':''}`;}
  const kinds:Record<string,string>={p:'primary',u:'unique',f:'foreign',c:'check',x:'exclusion'};
  s.constraints=data.constraints.map((c:any)=>{let sql=String(c.sql);if(c.kind==='f'&&c.targetSchema&&c.targetTable){const ts=sqlTokens(sql,'postgresql').filter(t=>t.kind!=='comment'),at=ts.findIndex(t=>t.kind==='word'&&t.text.toUpperCase()==='REFERENCES');if(at<0)throw new Error('Foreign-key reference is missing from its catalog definition.');const ref=tableIdentifier(ts,at+1,'postgresql');sql=sql.slice(0,ts[at+1]!.start)+q(c.targetSchema)+'.'+q(c.targetTable)+sql.slice(ts[ref.end-1]!.end);}return {name:c.name,kind:kinds[c.kind]??c.kind,definition:`CONSTRAINT ${q(c.name)} ${sql}`,comment:c.comment??null};});
  for(const i of s.indexes){const item=data.indexes.find((v:any)=>v.name===i.name);i.definition=item?.sql??'';i.protected=item?.owned??false;i.comment=item?.comment??null;i.clustered=!!item?.clustered;i.replicaIdentity=!!item?.replicaIdentity;}
  if(s.type==='view')s.definition=`CREATE ${data.kind==='m'?'MATERIALIZED ':''}VIEW ${details.name} AS\n${details.sql}`;
  else s.definition=`CREATE ${data.persistence==='u'?'UNLOGGED ':''}TABLE ${details.name} (\n  ${[...s.columns.map(c=>c.definition),...s.constraints.map(c=>c.definition)].join(',\n  ')}\n);\n${s.indexes.filter(i=>!i.protected).map(i=>i.definition+';').join('\n')}`;
  if(data.kind!=='r'||data.partition||data.children){s.editable=false;s.notes.push('Partitioned/inherited tables require a dedicated designer; definitions can be inspected here.');}
  s.notes.push('PostgreSQL DDL is reconstructed from catalogs. It is not pg_dump: sequence creation/options, grants, ownership, comments, storage and partition/inheritance clauses are not exported.');
  return s;
}
