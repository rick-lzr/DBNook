import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import ssh2 from 'ssh2';
import {discoverSshConfigs,sshConfigWords,sshPatternsMatch,knownHostFingerprints} from '../packages/core/src/ssh-config.js';
import {sshFingerprint} from '../packages/core/src/tunnels.js';
import {ConnectionResources} from '../packages/core/src/resources.js';
import {ProfileSchema,type ResourceSummary} from '../packages/protocol/src/index.js';
const keyPair=ssh2.utils.generateKeyPairSync('rsa',{bits:2048}),publicKey=ssh2.utils.parseKey(keyPair.public);if(publicKey instanceof Error)throw publicKey;
const knownKey=publicKey.type+' '+publicKey.getPublicSSH().toString('base64'),pin=sshFingerprint(publicKey.getPublicSSH());
async function fixture(t:{after:(action:()=>Promise<unknown>)=>void}){const home=await mkdtemp(join(tmpdir(),'dbw-ssh-config-'));t.after(()=>rm(home,{recursive:true,force:true}));const directory=join(home,'.ssh');await mkdir(directory);const root=join(directory,'config'),known=join(directory,'known_hosts');await writeFile(known,'* '+knownKey+'\n');const defaults=`\nHost *\n  User db-user\n  UserKnownHostsFile "${known}"\n  GlobalKnownHostsFile none\n  IdentityAgent none\n`;return {home,directory,root,known,defaults,discover:()=>discoverSshConfigs([root],{home,user:'local-user',env:{},systemPaths:[]})};}

test('SSH Config tokenization preserves Windows paths and handles quoted values, equals and comments',()=>{
  assert.deepEqual(sshConfigWords(' IdentityFile = "C:\\Users\\Name Space\\id_rsa" # comment'),['IdentityFile','C:\\Users\\Name Space\\id_rsa']);assert.deepEqual(sshConfigWords('HostName=db.example'),['HostName','db.example']);assert.deepEqual(sshConfigWords('User "hash#name"'),['User','hash#name']);assert.throws(()=>sshConfigWords('User "unfinished'),/Unclosed/);
  assert(sshPatternsMatch('Database',['data*','!prod*']));assert(!sshPatternsMatch('prod-db',['*','!prod*']));assert(!sshPatternsMatch('anything',['!excluded']));
});

test('SSH discovery applies first values, wildcard negation, lexical Include order and restores Include match state',async t=>{
  const f=await fixture(t),include=join(f.directory,'config.d');await mkdir(include);await writeFile(join(include,'01.conf'),'Host alpha beta\n  Port 2201\nHost unrelated\n  Port 9999\n');await writeFile(join(include,'02.conf'),'Host alpha\n  Port 2202\n');
  await writeFile(f.root,'Host alpha\n  HostName first.example\nInclude config.d/*.conf\n  User root-user\nHost beta\n  HostName second.example\nHost * !beta\n  User wildcard-user'+f.defaults);
  const snapshot=await f.discover(),alpha=snapshot.tunnels.find(v=>v.name==='alpha')!,beta=snapshot.tunnels.find(v=>v.name==='beta')!;
  assert.equal(alpha.host,'first.example');assert.equal(alpha.port,2201);assert.equal(alpha.user,'root-user');assert.equal(beta.host,'second.example');assert.equal(beta.port,22);assert.equal(beta.user,'db-user');assert.equal(alpha.source?.path,f.root);assert.equal(alpha.source?.line,1);assert.equal(alpha.source?.issues.length,0);assert(snapshot.directories.includes(include));assert(!snapshot.directories.includes(join(f.home,'..')));
});

test('SSH config expands identity paths and environment tokens, adds multiple identities and preserves stable IDs across metadata changes',async t=>{
  const f=await fixture(t);await writeFile(join(f.directory,'id_rsa'),'not read during discovery');await writeFile(join(f.directory,'alpha-remote.key'),'not read during discovery');
  await writeFile(f.root,'Host alpha\n  HostName %h.example\n  User remote\n  IdentityFile ~/.ssh/id_rsa\n  IdentityFile %d/.ssh/%n-%r.key\n  IdentityAgent ${AGENT_PATH}\n  IdentitiesOnly yes'+f.defaults);
  const discover=()=>discoverSshConfigs([f.root],{home:f.home,env:{AGENT_PATH:'test-agent'},systemPaths:[]}),first=(await discover()).tunnels[0]!;assert.equal(first.host,'alpha.example');assert.equal(first.agent,'test-agent');assert.equal(first.user,'remote');assert.deepEqual(first.source?.identityFiles,[join(f.directory,'id_rsa'),join(f.directory,'alpha-remote.key')]);assert.deepEqual(first.source?.authMethods,['publickey','password']);
  await writeFile(f.root,'# metadata line changed\nHost alpha\n  HostName alpha.example\n  User remote'+f.defaults);const next=(await discover()).tunnels[0]!;assert.equal(next.id,first.id);assert.equal(next.source?.line,2);
});

test('known_hosts verifies hashed and negated host lists, nonstandard ports and revoked keys',()=>{
  const host='[db.example]:2200',salt=randomBytes(20),hashed='|1|'+salt.toString('base64')+'|'+createHmac('sha1',salt).update(host).digest('base64');
  assert.deepEqual(knownHostFingerprints(hashed+' '+knownKey,host).trusted,[pin]);assert.equal(knownHostFingerprints(hashed+' '+knownKey,'db.example').trusted.length,0);assert.equal(knownHostFingerprints('*,!blocked '+knownKey,'blocked').trusted.length,0);
  const found=knownHostFingerprints(host+' '+knownKey+'\n@revoked '+host+' '+knownKey+'\n@cert-authority '+host+' '+knownKey,host);assert.deepEqual(found,{trusted:[pin],revoked:[pin]});assert.equal(knownHostFingerprints(host+' ssh-ed25519 '+publicKey.getPublicSSH().toString('base64'),host).trusted.length,0);
});

test('Discovery removes revoked host keys and diagnoses unsupported routing without executing commands',async t=>{
  const f=await fixture(t);await writeFile(f.root,'Host alpha\n  HostName db.example\n  ProxyCommand unexecuted-secret-command\n  ProxyJump bastion'+f.defaults);let found=(await f.discover()).tunnels[0]!;assert(found.source?.issues.some(v=>v.includes('proxycommand')));assert(!JSON.stringify(found).includes('unexecuted-secret-command'));
  await writeFile(f.known,'db.example '+knownKey+'\n@revoked db.example '+knownKey);await writeFile(f.root,'Host alpha\n  HostName db.example'+f.defaults);found=(await f.discover()).tunnels[0]!;assert.equal(found.source?.fingerprints.length,0);assert(found.source?.issues.some(v=>v.includes('No trusted host key')));
});

test('Conditional Match, recursive Include, malformed settings and missing expansions remain visibly unavailable',async t=>{
  const f=await fixture(t);for(const extra of ['Match exec "never-run-this"\nUser other','Include config','IdentityFile ${UNSET}/key','Port invalid','ConnectTimeout 999']){
    await writeFile(f.root,'Host alpha\nHostName db.example\n'+extra+f.defaults);const snapshot=await f.discover();assert(snapshot.tunnels.some(v=>v.source?.issues.length)||snapshot.diagnostics.length,extra);assert(!JSON.stringify(snapshot).includes('never-run-this'));
  }
  await writeFile(f.root,'Host alpha\nHostName "unclosed');const snapshot=await f.discover();assert(snapshot.diagnostics.length>0);assert(snapshot.tunnels.every(v=>v.source?.issues.length));
});

test('User/system precedence and HostKeyAlias match the explicitly configured trust name',async t=>{
  const f=await fixture(t),system=join(f.directory,'system');await writeFile(f.known,'trusted-alias '+knownKey);await writeFile(f.root,'Host alpha\n HostName db.example\n HostKeyAlias trusted-alias\n User first'+f.defaults);await writeFile(system,'Host alpha\n User second\n Port 2200');const snapshot=await discoverSshConfigs([f.root,system],{home:f.home,systemPaths:[system],env:{}});assert.equal(snapshot.tunnels[0]?.user,'first');assert.equal(snapshot.tunnels[0]?.port,2200);assert.equal(snapshot.tunnels[0]?.source?.issues.length,0);
});

test('Discovered definitions remain read-only, store credentials separately and invalidate changed physical bindings',async t=>{
  const f=await fixture(t);await writeFile(f.root,'Host alpha\n HostName db.example'+f.defaults);const tunnel=(await f.discover()).tunnels[0]!,vault=new Map<string,string>(),store:ResourceSummary={authentication:[],tunnels:[]};let writes=0;
  const resources=new ConnectionResources({list:()=>store,save:async()=>{writes++;},remove:async()=>{writes++;}},{get:async id=>vault.get(id),store:async(id,value)=>{vault.set(id,value);},delete:async id=>{vault.delete(id);}},()=>[]);t.after(async()=>resources.close());resources.setDiscoveredTunnels([tunnel]);
  await assert.rejects(resources.save('tunnel',tunnel,{remember:false,revision:resources.revision('tunnel',tunnel.id)}),/read-only/);await assert.rejects(resources.remove('tunnel',tunnel.id),/read-only/);
  await resources.saveTunnelCredentials(tunnel.id,{password:'private-password',passphrase:'private-passphrase',remember:true,revision:resources.revision('tunnel',tunnel.id)});assert.equal(writes,0);assert.equal(vault.size,1);assert(!JSON.stringify(resources.list()).includes('private-password'));assert(!JSON.stringify(resources.list()).includes('private-passphrase'));
  const profile=ProfileSchema.parse({id:'pg',name:'PG',driver:'postgresql',storage:'server',host:'localhost',database:'db',user:'db',tunnelRef:tunnel.id}),binding=resources.binding(profile,false);resources.setDiscoveredTunnels([{...tunnel,source:{...tunnel.source!,line:9}}]);assert.equal(resources.binding(profile,false),binding);resources.setDiscoveredTunnels([{...tunnel,host:'changed.example'}]);assert.notEqual(resources.binding(profile,false),binding);resources.setDiscoveredTunnels([]);assert.throws(()=>resources.validate(profile),/no longer exists/);
});
