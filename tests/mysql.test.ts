import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMysqlStatement, mysqlRelation } from '../packages/drivers/mysql/sql.js';
import { ProfileSchema, parseCell } from '../packages/protocol/src/index.js';
import { parseConnectionString, connectionString } from '../packages/core/src/connection-strings.js';
test('MySQL scanner respects quotes, comments, executable comments and DELIMITER routines',()=>{
  const text="-- first\nSELECT 'a;\\\'b', `semi;``colon`;#ignore\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\n/*!80000 SET @a=1 */; SELECT 1--not_a_comment;";
  const results=[];let offset=0,delimiter=';';while(offset<text.length){const next=nextMysqlStatement(text,offset,delimiter);if(!next)break;results.push(next);assert.equal(text.slice(next.start,next.end),next.sql);offset=next.next;delimiter=next.delimiter;}
  assert.equal(results.length,4);assert.match(results[1]!.sql,/CREATE PROCEDURE.*SELECT 2/s);assert.match(results[2]!.sql,/\/\*!80000/);assert.match(results[3]!.sql,/not_a_comment/);
  const mode={noBackslashEscapes:true,ansiQuotes:true};assert.equal(nextMysqlStatement("SELECT 'a\\'; SELECT 2",0,';',mode)?.sql,"SELECT 'a\\'");
});
test('MySQL schema, URI and unsigned values retain the intended target and precision',()=>{
  const parsed=parseConnectionString('mysql://u:p%40ss@[::1]:3307/db%20name?sslMode=verify-full&connectTimeout=1200');assert.equal(parsed.driver,'mysql');assert.equal(parsed.password,'p@ss');assert.equal(parsed.host,'::1');
  const {suggestedName,password,...fields}=parsed;const profile=ProfileSchema.parse({...fields,id:'mysql',name:suggestedName});const roundtrip=parseConnectionString(connectionString(profile));assert.equal(roundtrip.password,undefined);assert.equal(roundtrip.host,parsed.host);assert.equal(roundtrip.connectTimeout,1200);assert.equal(roundtrip.database,'db name');
  assert(ProfileSchema.safeParse({...profile,database:undefined}).success);assert(!ProfileSchema.safeParse({...profile,sslMode:'prefer'}).success);assert.throws(()=>parseConnectionString('mysql://u@localhost/db?password=leak'),/option/);
  assert.deepEqual(mysqlRelation('`odd``db`.`table.with.dot`'),['odd`db','table.with.dot']);
  assert.deepEqual(parseCell('18446744073709551615',{key:'n',name:'n',dataType:'bigint unsigned',nullable:false,primaryKey:0,generated:false}),{type:'integer',value:'18446744073709551615'});
});
test('MariaDB has a distinct profile and URI while retaining MySQL-family defaults',()=>{
  const parsed=parseConnectionString('jdbc:mariadb://user:p%40ss@localhost/database?sslMode=verify-ca');assert.equal(parsed.driver,'mariadb');assert.equal(parsed.port,3306);assert.equal(parsed.password,'p@ss');
  const {suggestedName,password,...fields}=parsed,profile=ProfileSchema.parse({...fields,id:'maria',name:suggestedName,database:undefined});assert.equal(profile.driver,'mariadb');assert.equal(parseConnectionString(connectionString(profile)).driver,'mariadb');assert(!connectionString(profile).includes('p%40ss'));
  assert(!ProfileSchema.safeParse({...profile,sslMode:'allow'}).success);assert.equal(nextMysqlStatement('/*M! SET @n=42 */;',0,';',{noBackslashEscapes:false,ansiQuotes:false,mariaDb:true})?.sql,'/*M! SET @n=42 */');assert.equal(nextMysqlStatement('/*M! SET @n=42 */;'),undefined);
});
