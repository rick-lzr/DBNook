import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuthenticationSchema} from '../packages/protocol/src/index.js';
import {AuthenticationResolver,commandCredentials,pgpassPassword,pgpassPath,pgpassModeAllowed} from '../packages/core/src/authentication.js';
const target={host:'db.internal',port:5432,database:'app'};
const command=(extra:Record<string,unknown>={})=>AuthenticationSchema.parse({id:'test-command',name:'Test command',kind:'command',user:'db-user',executable:process.execPath,args:['-e','process.stdout.write("password")'],...extra}) as Extract<ReturnType<typeof AuthenticationSchema.parse>,{kind:'command'}>;

test('Credential command output mappings preserve password bytes and never include secret output in errors',()=>{
  assert.equal(commandCredentials(command(), '  password:with spaces  \r\n').password,'  password:with spaces  ');
  assert.equal(commandCredentials(command({output:'user-password'}),'db-user:pass:word\n').password,'pass:word');
  const profile=command({output:'json',userPath:'credentials.0.name',passwordPath:'credentials.0.token',expiresAtPath:'expiration'}),now=Date.now();
  assert.deepEqual(commandCredentials(profile,JSON.stringify({credentials:[{name:'db-user',token:'secret'}],expiration:(now+30000)/1000}),now),{user:'db-user',password:'secret',expiresAt:now+30000});
  for(const output of ['secret-output',JSON.stringify({credentials:[{name:'db-user',token:99}],expiration:0})])assert.throws(()=>commandCredentials(profile,output),error=>error instanceof Error&&!error.message.includes(output));
  assert.throws(()=>commandCredentials(command({output:'user-password'}),'other-user:secret'),/different database user/);
  assert.throws(()=>commandCredentials(command({output:'json',passwordPath:'toString'}),'{}'),/invalid credentials/);
});

test('Credential commands run literal argv without a shell and receive logical endpoint environment variables',async t=>{
  const resolver=new AuthenticationResolver();t.after(()=>resolver.close());const literal='$(echo unwanted) & | > < `whoami`';
  const profile=command({output:'json',passwordPath:'token',args:['-e','process.stdout.write(JSON.stringify({token:process.argv[1]+"|"+process.env.DBW_AUTH_HOST+":"+process.env.DBW_AUTH_PORT+"/"+process.env.DBW_AUTH_DATABASE+"/"+process.env.DBW_AUTH_USER}))',literal]});
  assert.deepEqual(await resolver.resolve(profile,target),{user:'db-user',password:literal+'|db.internal:5432/app/db-user'});
});

test('Credential command cache coalesces concurrent opens, separates endpoints and explicitly refreshes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dbw-auth-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));const counter=join(directory,'calls');
  const script='const fs=require("node:fs");const p=process.argv[1];fs.appendFileSync(p,"x");setTimeout(()=>process.stdout.write(String(fs.readFileSync(p).length)),100)';
  const profile=command({cacheTtl:60,args:['-e',script,counter]}),resolver=new AuthenticationResolver();t.after(()=>resolver.close());
  const results=await Promise.all(Array.from({length:8},()=>resolver.resolve(profile,target)));assert(results.every(r=>r.password==='1'));results[0]!.password='mutated';assert.equal((await resolver.resolve(profile,target)).password,'1');assert.equal(await readFile(counter,'utf8'),'x');
  await resolver.resolve(profile,{...target,database:'second'});assert.equal(await readFile(counter,'utf8'),'xx');resolver.clear(profile.id);assert.equal((await resolver.resolve(profile,target)).password,'3');
});

test('No-cache commands run for each later session; output expiration bounds a longer cache lifetime',async t=>{
  const resolver=new AuthenticationResolver();t.after(()=>resolver.close());
  const profile=command({args:['-e','process.stdout.write(String(process.pid))']});const first=await resolver.resolve(profile,target),second=await resolver.resolve(profile,target);assert.notEqual(first.password,second.password);
  const directory=await mkdtemp(join(tmpdir(),'dbw-auth-expiry-'));t.after(()=>rm(directory,{recursive:true,force:true}));const counter=join(directory,'calls'),clock=Date.now();t.mock.timers.enable({apis:['Date'],now:clock});
  const script='const fs=require("node:fs"),p=process.argv[1];fs.appendFileSync(p,"x");const n=fs.readFileSync(p).length;process.stdout.write(JSON.stringify({password:String(process.pid),expires:(Number(process.argv[2])+n*10000)/1000}))';
  const expiring=command({id:'expiring',cacheTtl:60,output:'json',expiresAtPath:'expires',args:['-e',script,counter,String(clock)]});
  const initial=await resolver.resolve(expiring,target);assert.equal((await resolver.resolve(expiring,target)).password,initial.password);t.mock.timers.tick(10001);assert.notEqual((await resolver.resolve(expiring,target)).password,initial.password);assert.equal(await readFile(counter,'utf8'),'xx');
  assert.throws(()=>commandCredentials({...expiring,expiresAtPath:'expires'},JSON.stringify({password:'sensitive',expires:Date.now()/1000-1})),/expired/);
});

test('Failed, timed-out and oversized credential commands suppress stdout/stderr and do not cache failures',async t=>{
  const resolver=new AuthenticationResolver();t.after(()=>resolver.close());
  for(const extra of [{args:['-e','process.stdout.write("secret-output");process.stderr.write("secret-error");process.exit(7)']},{timeout:200,args:['-e','process.stdout.write("secret-output");setTimeout(()=>{},10000)']},{args:['-e','process.stdout.write("secret-output".repeat(10000))']}]){
    await assert.rejects(resolver.resolve(command(extra),target),error=>error instanceof Error&&/Credential command/.test(error.message)&&!error.message.includes('secret-output')&&!error.message.includes('secret-error'));
  }
  assert.equal((await resolver.resolve(command(),target)).password,'password');
});

test('Clearing a cache during a command rejects its stale result; closing cancels child processes',async t=>{
  const resolver=new AuthenticationResolver();t.after(()=>resolver.close());const profile=command({cacheTtl:60,args:['-e','setTimeout(()=>process.stdout.write("private-output"),300)']});
  const pending=resolver.resolve(profile,target);resolver.clear(profile.id);await assert.rejects(pending,/cleared while/);assert.equal((await resolver.resolve(command(),target)).password,'password');
  const running=resolver.resolve(command({id:'long',args:['-e','setTimeout(()=>{},10000)']}),target);resolver.close();await assert.rejects(running,/Credential command/);await assert.rejects(resolver.resolve(profile,target),/closed/);
});

test('pgpass matching honors first match, escaped colons/backslashes, literal stars and malformed rows',()=>{
  const text='# comment\r\nmalformed\r\ndb.internal:5432:app:other:no\r\ndb.internal:5432:app:db-user:p\\:ass\\\\word\r\n*:*:*:*:fallback';
  assert.equal(pgpassPassword(text,target,'db-user'),'p:ass\\word');assert.equal(pgpassPassword(text,{...target,host:'elsewhere'},'db-user'),'fallback');
  assert.equal(pgpassPassword('\\*:*:*:*:literal\n*:*:*:*:wildcard',target,'db-user'),'wildcard');assert.equal(pgpassPassword('\\*:*:*:*:literal',{...target,host:'*'},'db-user'),'literal');
  assert.equal(pgpassPassword('db\\:host:5432:app:db-user:trailing\\\\',{...target,host:'db:host'},'db-user'),'trailing\\');
  assert.equal(pgpassPassword('*:*:*:*:',target,'db-user'),'');assert.equal(pgpassPassword(text,{...target,port:5433},'someone'),'fallback');assert.equal(pgpassPassword('db.internal:5432:app:no:password',target,'db-user'),undefined);
});

test('pgpass chooses explicit paths, PGPASSFILE and OS defaults; Unix permissions disallow group/world access',()=>{
  const home=join(tmpdir(),'dbw-home'),custom=join(home,'custom'),environment=join(home,'environment');assert.equal(pgpassPath(custom,{PGPASSFILE:environment},home),custom);assert.equal(pgpassPath('',{PGPASSFILE:environment},home),environment);assert.equal(pgpassPath('',{},home,'linux'),join(home,'.pgpass'));assert.equal(pgpassPath('',{APPDATA:home},'unused','win32'),join(home,'postgresql','pgpass.conf'));
  assert(pgpassModeAllowed(0o600,'linux'));assert(!pgpassModeAllowed(0o640,'linux'));assert(!pgpassModeAllowed(0o604,'linux'));assert(pgpassModeAllowed(0o666,'win32'));
});

test('pgpass rereads rotated credentials and reports missing matches without exposing file contents',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dbw-pgpass-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'pgpass'),resolver=new AuthenticationResolver();t.after(()=>resolver.close());
  const profile=AuthenticationSchema.parse({id:'file',name:'File',kind:'pgpass',user:'db-user',path}) as Extract<ReturnType<typeof AuthenticationSchema.parse>,{kind:'pgpass'}>;
  await writeFile(path,'db.internal:5432:app:db-user:first',{mode:0o600});assert.equal((await resolver.resolve(profile,target)).password,'first');await writeFile(path,'db.internal:5432:app:db-user:rotated');assert.equal((await resolver.resolve(profile,target)).password,'rotated');await assert.rejects(resolver.resolve(profile,{...target,port:5433}),/No pgpass entry/);await assert.rejects(resolver.resolve(profile),/connection target/);
});
