import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,createConnection} from 'node:net';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import ssh2 from 'ssh2';
const {utils}=ssh2;
import {ConnectionResources,type ResourceStore} from '../packages/core/src/resources.js';
import {SshTunnels} from '../packages/core/src/tunnels.js';
import {TunnelSchema,type ResourceSummary} from '../packages/protocol/src/index.js';
import {sshFixture} from './fixtures/ssh-server.js';
import {discoverSshConfigs} from '../packages/core/src/ssh-config.js';
const cleanups:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(publicKey?:string){const ssh=await sshFixture({publicKey});cleanups.push(()=>ssh.close());const data:ResourceSummary={authentication:[],tunnels:[]},secrets=new Map<string,string>();const store:ResourceStore={list:()=>data,save:async(_kind,value)=>{data.tunnels=[value as ResourceSummary['tunnels'][number]];},remove:async()=>{data.tunnels=[];}};const resources=new ConnectionResources(store,{get:async id=>secrets.get(id),store:async(id,value)=>{secrets.set(id,value);},delete:async id=>{secrets.delete(id);}},()=>[]);
  const tunnel=TunnelSchema.parse({id:'ssh',name:'SSH integration',kind:'ssh',host:'127.0.0.1',port:ssh.port,user:'ssh-user',auth:'password',fingerprint:ssh.fingerprint,readyTimeout:3000});await resources.save('tunnel',tunnel,{secret:'ssh-test-password',remember:false,revision:resources.revision('tunnel','ssh')});const pool=new SshTunnels(resources);cleanups.push(()=>pool.close());return {ssh,resources,pool,tunnel};}
async function echo(){const sockets=new Set<ReturnType<typeof createConnection>>();const server=createServer(socket=>{sockets.add(socket);socket.pipe(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));cleanups.push(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});return (server.address() as {port:number}).port;}
async function roundtrip(port:number,text:string){return new Promise<string>((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port},()=>socket.write(text));socket.on('error',reject);socket.once('data',data=>{socket.destroy();resolve(data.toString());});});}
test('Real SSH password authentication forwards bytes, shares one loopback listener and releases it after the last lease',async()=>{
  const f=await fixture(),port=await echo();const [first,second]=await Promise.all([f.pool.acquire('ssh','127.0.0.1',port),f.pool.acquire('ssh','127.0.0.1',port)]);assert.equal(first.port,second.port);assert.equal(f.pool.status()[0]?.references,2);assert.equal(await roundtrip(first.port,'database bytes'),'database bytes');await first.release();assert(second.active());await second.release();assert.equal(f.pool.status().length,0);await assert.rejects(roundtrip(first.port,'closed'),/ECONNREFUSED/);
});
test('SSH rejects an incorrect host pin or password and host-key inspection sends no authentication credentials',async()=>{
  const f=await fixture();const attempts=f.ssh.authentications();assert.equal(await SshTunnels.fingerprint('127.0.0.1',f.ssh.port,3000),f.ssh.fingerprint);assert.equal(f.ssh.authentications(),attempts);await assert.rejects(f.pool.test({...f.tunnel,fingerprint:'SHA256:'+'B'.repeat(43)},'ssh-test-password'),/SSH connection failed/);await assert.rejects(f.pool.test(f.tunnel,'wrong-password'),/SSH connection failed/);
});
test('SSH supports encrypted private keys and does not leak the passphrase into logs',async()=>{
  const key=utils.generateKeyPairSync('rsa',{bits:2048,cipher:'aes256-cbc',passphrase:'private-passphrase',rounds:4}),f=await fixture(key.public);
  const root=resolve('.cache/test-ssh');await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,'key-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'id_rsa');await writeFile(path,key.private);
  const definition={...f.tunnel,auth:'key' as const,privateKeyPath:path};await f.resources.save('tunnel',definition,{secret:'private-passphrase',remember:false,revision:f.resources.revision('tunnel','ssh')});await f.pool.test(definition,'private-passphrase');const port=await echo(),lease=await f.pool.acquire('ssh','127.0.0.1',port);assert.equal(await roundtrip(lease.port,'key auth'),'key auth');await lease.release();assert(!f.pool.logs('ssh').join('\n').includes('private-passphrase'));
});
test('SSH disconnect invalidates old leases and reconnect obtains a new usable endpoint without replay',async()=>{
  const f=await fixture(),port=await echo(),lease=await f.pool.acquire('ssh','127.0.0.1',port);assert.equal(await roundtrip(lease.port,'before'),'before');f.ssh.drop();
  const deadline=Date.now()+5000;while(lease.active()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(lease.active(),false);const next=await f.pool.acquire('ssh','127.0.0.1',port);assert.equal(await roundtrip(next.port,'after'),'after');assert.equal(lease.active(),false);await lease.release();assert(next.active());await next.release();
});
test('Cancelling one pending SSH consumer leaves another lease usable and cancellation does not leak a listener',async()=>{
  const f=await fixture(),port=await echo(),controller=new AbortController();const first=f.pool.acquire('ssh','127.0.0.1',port,controller.signal),second=f.pool.acquire('ssh','127.0.0.1',port);const rejected=assert.rejects(first,/cancelled/);controller.abort();await rejected;const lease=await second;assert.equal(f.pool.status()[0]?.references,1);assert.equal(await roundtrip(lease.port,'remaining consumer'),'remaining consumer');await lease.release();assert.equal(f.pool.status().length,0);
});

test('Discovered SSH Config tries multiple private keys, keeps passphrases distinct and trusts known_hosts',async()=>{
  const key=utils.generateKeyPairSync('rsa',{bits:2048,cipher:'aes256-cbc',passphrase:'config-key-passphrase',rounds:4}),other=utils.generateKeyPairSync('rsa',{bits:2048}),f=await fixture(key.public),port=await echo();
  const root=resolve('.cache/test-ssh');await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,'config-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));const config=join(directory,'config'),known=join(directory,'known_hosts'),first=join(directory,'first.key'),second=join(directory,'second.key');await writeFile(first,other.private);await writeFile(second,key.private);await writeFile(known,`[127.0.0.1]:${f.ssh.port} ${f.ssh.publicHostKey}`);
  await writeFile(config,`Host integration-config\nHostName 127.0.0.1\nPort ${f.ssh.port}\nUser ssh-user\nIdentityFile "${first}"\nIdentityFile "${second}"\nIdentityAgent none\nPreferredAuthentications publickey,password\nUserKnownHostsFile "${known}"\nGlobalKnownHostsFile none\n`);
  const value=(await discoverSshConfigs([config])).tunnels[0]!;assert.deepEqual(value.source?.issues,[]);f.resources.setDiscoveredTunnels([value]);await f.resources.saveTunnelCredentials(value.id,{passphrase:'config-key-passphrase',password:'different-SSH-password',remember:false,revision:f.resources.revision('tunnel',value.id)});
  const lease=await f.pool.acquire(value.id,'127.0.0.1',port);assert.equal(await roundtrip(lease.port,'config key forwarding'),'config key forwarding');await lease.release();assert(!f.pool.logs(value.id).join().includes('config-key-passphrase'));assert(!JSON.stringify(f.resources.list()).includes('different-SSH-password'));
});

test('Discovered SSH Config password authentication refuses untrusted host keys before sending credentials',async()=>{
  const f=await fixture(),port=await echo(),root=resolve('.cache/test-ssh');await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,'config-password-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));const config=join(directory,'config'),known=join(directory,'known_hosts');
  await writeFile(known,`[127.0.0.1]:${f.ssh.port} ${f.ssh.publicHostKey}`);await writeFile(config,`Host password-config\nHostName 127.0.0.1\nPort ${f.ssh.port}\nUser ssh-user\nPubkeyAuthentication no\nUserKnownHostsFile "${known}"\nGlobalKnownHostsFile none\n`);
  const value=(await discoverSshConfigs([config])).tunnels[0]!;f.resources.setDiscoveredTunnels([value]);await f.resources.saveTunnelCredentials(value.id,{password:'ssh-test-password',passphrase:'must-not-be-used-as-password',remember:false,revision:f.resources.revision('tunnel',value.id)});const lease=await f.pool.acquire(value.id,'127.0.0.1',port);assert.equal(await roundtrip(lease.port,'config password'),'config password');await lease.release();
  f.resources.setDiscoveredTunnels([{...value,source:{...value.source!,fingerprints:['SHA256:'+'A'.repeat(43)]}}]);const before=f.ssh.authentications();await assert.rejects(f.pool.acquire(value.id,'127.0.0.1',port),/SSH connection failed/);assert.equal(f.ssh.authentications(),before);assert.equal(f.pool.status().length,0);
});
