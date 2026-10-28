import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {ProfileSchema,type TableStructure,type DefinitionSnapshot} from '../packages/protocol/src/index.js';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {DatabaseDefinitions} from '../packages/core/src/database-definitions.js';
import {parseTableScript} from '../packages/core/src/table-script.js';
import {sqlTokens} from '../packages/core/src/sql-editing.js';
import {StructureColumnOverridesSchema} from '../packages/protocol/src/structure-comparisons.js';
import {portableType,portableDefault,renderPortableColumn,portableColumn} from '../packages/core/src/portable-types.js';
import {translateTable,validateColumnOverride,declaredColumnType,translatedColumnKey,requiredSupportingIndexes} from '../packages/core/src/portable-table.js';
const fixture=(driver:DefinitionSnapshot['driver'],sql:string,primary:string[]=[]):DefinitionSnapshot=>{
 const ref={kind:'table' as const,id:'1',name:'items',schema:driver==='sqlite'?undefined:driver==='postgresql'?'public':'db'},s:TableStructure={name:ref.schema?ref.schema+'.items':'items',label:'items',schema:ref.schema,type:'table',identity:'fixture',definition:sql,notes:[],editable:true,columns:[],constraints:[],indexes:[],auxiliary:[],sqlMode:driver==='mysql'||driver==='mariadb'?{noBackslashEscapes:false,ansiQuotes:false}:undefined},value:DefinitionSnapshot={profileId:driver,driver,ref,sql,rawSql:sql,identity:'fixture',revision:'a'.repeat(64),fingerprint:'b'.repeat(64),editable:true,notes:[],extras:[],tableStructure:s};
 const parsed=parseTableScript(sql,driver,s,s.sqlMode);s.columns=parsed.columns.map(c=>({name:c.name,dataType:declaredColumnType(c.definition,value),nullable:!(/\bNOT\s+NULL\b/i.test(c.definition)),defaultSql:null,primaryKey:primary.indexOf(c.name)+1,generated:sqlTokens(c.definition,driver,s.sqlMode).some(t=>t.kind==='word'&&t.depth===0&&t.text.toUpperCase()==='GENERATED'),definition:c.definition}));return value;
};
const empty=(driver:DefinitionSnapshot['driver'])=>fixture(driver,`CREATE TABLE ${driver==='sqlite'?'items':driver==='postgresql'?'public.items':'db.items'}(retained INT)`);

test('Portable numeric mappings preserve signed/unsigned range choices and never route decimal defaults through Number',()=>{
 assert.deepEqual(portableType('BIGINT UNSIGNED','mysql'),{kind:'integer',bits:64,unsigned:true});assert.equal(portableType('tinyint','sqlite').kind,'integer');assert.equal((portableType('tinyint','sqlite') as {bits:number}).bits,64);
 const source=fixture('mysql','CREATE TABLE db.items(n BIGINT UNSIGNED DEFAULT 18446744073709551615,amount DECIMAL(65,30) DEFAULT 12345678901234567890.123456789012345678901234567890)');
 const pg=translateTable(source,empty('postgresql'));assert.match(pg.columns[0]!.sql!,/numeric\(20,0\).*18446744073709551615/);assert.match(pg.columns[1]!.sql!,/numeric\(65,30\).*12345678901234567890\.123456789012345678901234567890/);assert(pg.columns[0]!.warnings.length);
 const sqlite=translateTable(source,empty('sqlite'));assert.match(sqlite.columns[0]!.sql!,/TEXT DEFAULT '18446744073709551615'/);assert.match(sqlite.columns[1]!.sql!,/TEXT DEFAULT '12345678901234567890\.123456789012345678901234567890'/);
 const unbounded=fixture('postgresql','CREATE TABLE public.items(n numeric)');assert.match(translateTable(unbounded,empty('mysql')).columns[0]!.reason!,/precision\/scale/);
});

test('Primitive default conversion handles catalog casts, escaped Unicode/paths, binary constants and clocks without executing expressions',()=>{
 const pg=empty('postgresql'),mysql=empty('mysql');assert.deepEqual(portableDefault("'ready'::character varying",pg),{kind:'string',value:'ready'});assert.deepEqual(portableDefault("E'C:\\\\new\\u4e2d''quote'::text",pg),{kind:'string',value:"C:\\new中'quote"});assert.deepEqual(portableDefault("decode('00ff'::text,'hex'::text)",pg),{kind:'binary',value:'00ff'});assert.deepEqual(portableDefault('CURRENT_TIMESTAMP(6)',mysql),{kind:'clock',value:'CURRENT_TIMESTAMP',precision:6});
 assert.throws(()=>portableDefault('nextval(\'public.source_seq\'::regclass)',pg),/target/);assert.throws(()=>portableDefault("'secret'::public.domain",pg),/cast/);assert.throws(()=>portableDefault('(SELECT password FROM users)',mysql),/target/);assert.throws(()=>portableDefault('uuid()',mysql),/target/);
 const def=fixture('postgresql',"CREATE TABLE public.items(v character varying(20) DEFAULT 'ready'::character varying)");assert(!translateTable(def,empty('mysql')).columns[0]!.reason);
});

test('Translated PostgreSQL primitives execute in actual SQLite with precise defaults, target-owned identity and binary values',async()=>{
 const p=ProfileSchema.parse({id:'portable-sqlite',name:'portable',driver:'sqlite',storage:'memory'}),manager=new ConnectionManager({list:()=>[p],save:async()=>{},remove:async()=>{}},{runnerPath:resolve('dist/sqlite-runner.cjs')});
 try{const session=await manager.connect(p.id),source=fixture('postgresql',"CREATE TABLE public.items(id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,v text DEFAULT E'C:\\\\new''中文'::text,n bigint DEFAULT 9223372036854775807,b bytea DEFAULT '\\x00ff'::bytea,flag boolean DEFAULT true,amount numeric(30,10) DEFAULT 12345678901234567890.1234567890,CONSTRAINT items_pk PRIMARY KEY(id))",['id']),converted=translateTable(source,empty('sqlite'));assert(converted.columns.every(c=>c.sql),JSON.stringify(converted.columns));assert.equal(Object.keys(converted.issues).length,0);
  const sql='CREATE TABLE items('+[...converted.model.columns.map(c=>c.definition),...converted.model.objects.filter(o=>o.kind!=='index').map(o=>o.definition)].join(',')+')';await session.query(sql);await session.query('INSERT INTO items DEFAULT VALUES');assert.deepEqual((await session.query('SELECT * FROM items')).rows[0],{c0:1,c1:"C:\\new'中文",c2:{type:'integer',value:'9223372036854775807'},c3:{type:'binary',base64:'AP8='},c4:1,c5:'12345678901234567890.1234567890'});
  const actual=await new DatabaseDefinitions(manager).read(p.id,{kind:'table',id:'items',name:'items'});for(const c of converted.model.columns){const target=actual!.tableStructure!.columns.find(v=>v.name===c.name)!;assert.equal(translatedColumnKey(c.definition,actual!,source.tableStructure!.columns.find(v=>v.name===c.name)!.primaryKey),translatedColumnKey(target.definition,actual!,target.primaryKey),c.name);}
 }finally{await manager.close();}
});

test('Unportable source attributes remain explicit and complete target column overrides are constrained to one column',()=>{
 const source=fixture('mysql',"CREATE TABLE db.items(v ENUM('a','b'),g INT GENERATED ALWAYS AS(1) STORED,secret VARCHAR(10) INVISIBLE,stamp TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)"),target=empty('postgresql');let converted=translateTable(source,target);assert(converted.columns.every(c=>c.reason));
 converted=translateTable(source,target,{v:'"v" character varying(10) NOT NULL DEFAULT \'a\''});assert(converted.columns[0]!.manual);assert(!converted.columns[0]!.reason);assert(converted.columns[1]!.reason);
 for(const bad of ['"other" TEXT','v TEXT, injected INT','v TEXT); DROP TABLE public.items; --','v TEXT); CREATE INDEX sneaky ON public.items(v); --'])assert.throws(()=>validateColumnOverride(bad,'v',target));assert.doesNotThrow(()=>validateColumnOverride('"v" text DEFAULT \'keep; source text\'','v',target));
});

test('Cross-engine table constraints and simple indexes retarget self references, preserve directions and reject unsupported index tails',()=>{
 const source=fixture('postgresql','CREATE TABLE public.items(id integer NOT NULL,parent integer,v character varying(10),CONSTRAINT p PRIMARY KEY(id),CONSTRAINT self_ref FOREIGN KEY(parent) REFERENCES public.items(id) ON DELETE CASCADE,CONSTRAINT positive CHECK(id>0)); CREATE INDEX by_v ON public.items(v DESC); CREATE INDEX partial ON public.items(v) WHERE id>0;',['id']),converted=translateTable(source,empty('mysql'));
 const fk=converted.model.objects.find(o=>o.kind==='foreign')!;assert.match(fk.definition,/REFERENCES `db`.`items`/);assert.match(fk.definition,/ON DELETE CASCADE/);assert(converted.model.objects.some(o=>o.definition.includes('`v` DESC')));assert(Object.values(converted.issues).some(v=>v.includes('predicate')));assert(converted.warnings['check:items__positive']?.length);
 const external=fixture('postgresql','CREATE TABLE public.items(id int,parent int,CONSTRAINT remote FOREIGN KEY(parent) REFERENCES outside.other(id))');assert(Object.values(translateTable(external,empty('sqlite')).issues).some(v=>v.includes('dependency mapping')));
 const mixed=fixture('sqlite','CREATE TABLE items(Foo INT,parent INT,CONSTRAINT positive CHECK(foo>0)); CREATE INDEX by_foo ON items(foo)'),mixedResult=translateTable(mixed,empty('postgresql'));assert(mixedResult.model.objects.some(o=>o.kind==='index'&&o.definition.includes('("Foo")')));assert(mixedResult.model.objects.some(o=>o.kind==='check'&&o.definition.includes('"Foo" > 0')));
 const distinct=fixture('mysql','CREATE TABLE db.items(id INT,parent INT,CONSTRAINT fk FOREIGN KEY(parent) REFERENCES db.Items(id))');assert(translateTable(distinct,empty('postgresql')).model.objects.find(o=>o.kind==='foreign')!.definition.includes('REFERENCES "public"."Items"'));
});

test('Target-only attributes are not silently removed and MySQL Boolean aliases compare without inferring source tinyint semantics',()=>{
 const source=fixture('postgresql','CREATE TABLE public.items(v text,flag boolean DEFAULT true)'),target=fixture('mysql',"CREATE TABLE db.items(v VARCHAR(40) COLLATE utf8mb4_bin COMMENT 'keep')");assert.match(translateTable(source,target).columns[0]!.reason!,/target column/);
 const boolean=translateTable(source,empty('mysql')).columns.find(c=>c.name==='flag')!;assert.equal(translatedColumnKey(boolean.sql!,empty('mysql')),translatedColumnKey('`flag` tinyint(1) DEFAULT 1',empty('mysql')));
 const tiny=fixture('mysql','CREATE TABLE db.items(flag TINYINT(1))');assert.equal(portableColumn(tiny.tableStructure!.columns[0]!,tiny).type.kind,'integer');
 for(const [a,b] of [['b BLOB','b LONGBLOB'],['v TEXT','v LONGTEXT'],['stamp TIMESTAMP','stamp DATETIME']])assert.notEqual(translatedColumnKey(a!,empty('mysql')),translatedColumnKey(b!,empty('mysql')));
});

test('Identity-related text inside literal defaults is never promoted to column generation or used to remove primary keys',()=>{
 const source=fixture('postgresql',"CREATE TABLE public.items(id int NOT NULL,v text DEFAULT 'GENERATED ALWAYS AS IDENTITY; PRIMARY KEY AUTOINCREMENT'::text,CONSTRAINT p PRIMARY KEY(id))",['id']),converted=translateTable(source,empty('sqlite'));
 assert.equal(converted.model.objects.filter(o=>o.kind==='primary').length,0);assert.match(converted.columns[0]!.sql!,/^"id" INT NOT NULL PRIMARY KEY$/);assert.match(converted.columns[1]!.sql!,/DEFAULT 'GENERATED ALWAYS AS IDENTITY; PRIMARY KEY AUTOINCREMENT'/);assert.equal(portableColumn(source.tableStructure!.columns[1]!,source).identity,'none');
});

test('Target identifier collisions are explicit, while prototype-named columns remain literal conversion keys',()=>{
 const source=fixture('postgresql','CREATE TABLE public.items("Foo" text,"foo" text)');assert.throws(()=>translateTable(source,empty('mysql')),/collide/);
 const odd=fixture('postgresql','CREATE TABLE public.items("constructor" public.unknown,"__proto__" public.unknown)'),overrides=StructureColumnOverridesSchema.parse(JSON.parse('{"constructor":"constructor TEXT","__proto__":"__proto__ TEXT"}'));
 assert(Object.hasOwn(overrides,'__proto__'));assert.equal(Object.getPrototypeOf(overrides),Object.prototype);const converted=translateTable(odd,empty('sqlite'),overrides);assert(converted.columns.every(c=>c.sql&&c.manual));assert.equal(({} as Record<string,unknown>).polluted,undefined);
});

test('Only a required nonunique target FK index is retained; extra unique rules and redundant indexes stay differences',()=>{
 const source=fixture('postgresql','CREATE TABLE public.items(id bigint,parent bigint,CONSTRAINT fk FOREIGN KEY(parent) REFERENCES public.items(id))'),target=fixture('mysql','CREATE TABLE db.items(id BIGINT,parent BIGINT,KEY support(parent),KEY redundant(parent,id),UNIQUE KEY extra_unique(parent),CONSTRAINT fk FOREIGN KEY(parent) REFERENCES db.items(id))'),desired=translateTable(source,target).model,current=parseTableScript(target.sql,target.driver,target.tableStructure!);
 assert.deepEqual([...requiredSupportingIndexes(desired,current,target)],['support']);
 const uniqueOnly=fixture('mysql','CREATE TABLE db.items(id BIGINT,parent BIGINT,UNIQUE KEY extra_unique(parent))');assert.equal(requiredSupportingIndexes(desired,parseTableScript(uniqueOnly.sql,'mysql',uniqueOnly.tableStructure!),uniqueOnly).size,0);
 const indexed=fixture('postgresql','CREATE TABLE public.items(id bigint,parent bigint,CONSTRAINT fk FOREIGN KEY(parent) REFERENCES public.items(id)); CREATE INDEX from_source ON public.items(parent)');assert.equal(requiredSupportingIndexes(translateTable(indexed,target).model,current,target).size,0);
});
