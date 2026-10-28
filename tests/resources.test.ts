import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionResources,type ResourceStore} from '../packages/core/src/resources.js';
import {AuthenticationSchema,ProfileSchema,TunnelSchema,type ResourceSummary,type ConnectionProfile} from '../packages/protocol/src/index.js';
import {GridDocumentModel} from '../packages/core/src/grid-document.js';
import {ConnectionManager} from '../packages/core/src/connections.js';
import {ConnectionTransfers,previewConnections} from '../packages/core/src/connection-transfer.js';
function fixture(){const values:ResourceSummary={authentication:[],tunnels:[]},vault=new Map<string,string>(),profiles:ConnectionProfile[]=[];let failure=false;
  const store:ResourceStore={list:()=>structuredClone(values),save:async(kind,value)=>{if(failure)throw new Error('Resource settings unavailable');const rows=kind==='authentication'?values.authentication:values.tunnels;const index=rows.findIndex(v=>v.id===value.id);if(index<0)(rows as unknown[]).push(value);else (rows as unknown[])[index]=value;},remove:async(kind,id)=>{if(kind==='authentication')values.authentication=values.authentication.filter(v=>v.id!==id);else values.tunnels=values.tunnels.filter(v=>v.id!==id);}};
  const resources=new ConnectionResources(store,{get:async id=>vault.get(id),store:async(id,value)=>{vault.set(id,value);},delete:async id=>{vault.delete(id);}},()=>profiles);return {resources,values,vault,profiles,fail:()=>{failure=true;}};
}
test('Shared authentication stores secrets separately, preserves rename bindings and blocks deletion while referenced',async()=>{
  const f=fixture(),profile=AuthenticationSchema.parse({id:'auth',name:'Shared credentials',kind:'password',user:'db-user'});await f.resources.save('authentication',profile,{secret:'private-value',remember:true,revision:f.resources.revision('authentication','auth')});
  f.profiles.push(ProfileSchema.parse({id:'one',name:'Connection one',driver:'postgresql',storage:'server',host:'localhost',database:'db',authRef:'auth'}));
  assert.equal((await f.resources.authenticate('auth')).password,'private-value');assert(!JSON.stringify(f.resources.list()).includes('private-value'));const binding=f.resources.binding(f.profiles[0]!);
  await f.resources.save('authentication',{...profile,name:'Renamed'},{remember:true,revision:f.resources.revision('authentication','auth')});assert.equal(f.resources.binding(f.profiles[0]!),binding);await assert.rejects(f.resources.remove('authentication','auth'),/Connection one/);
  f.profiles.length=0;await f.resources.remove('authentication','auth');assert.equal(f.vault.size,0);
});
test('Shared profile changes use one review and compensate vault writes when settings fail',async()=>{
  const f=fixture(),p=AuthenticationSchema.parse({id:'auth',name:'Auth',kind:'password',user:'one'});await f.resources.save('authentication',p,{secret:'original',remember:true,revision:f.resources.revision('authentication','auth')});let reviews=0;
  f.resources.beforeChange=async()=>{reviews++;return false;};await assert.rejects(f.resources.save('authentication',{...p,user:'two'},{secret:'new',remember:true,revision:f.resources.revision('authentication','auth')}),/cancelled/);assert.equal(reviews,1);assert.equal((await f.resources.authenticate('auth')).user,'one');
  f.resources.beforeChange=async()=>true;f.fail();await assert.rejects(f.resources.save('authentication',p,{secret:'new',remember:true,revision:f.resources.revision('authentication','auth')}),/settings unavailable/);assert.equal((await f.resources.authenticate('auth')).password,'original');
});
test('Changing a shared identity invalidates session/draft bindings; stale resource editors cannot overwrite it',async()=>{
  const f=fixture(),p=AuthenticationSchema.parse({id:'auth',name:'Auth',kind:'password',user:'one'});await f.resources.save('authentication',p,{remember:false,revision:f.resources.revision('authentication','auth')});const revision=f.resources.revision('authentication','auth');
  const connection=ProfileSchema.parse({id:'one',name:'One',driver:'postgresql',storage:'server',host:'localhost',database:'db',authRef:'auth'}),binding=f.resources.binding(connection,false);
  await f.resources.save('authentication',{...p,user:'two'},{remember:false,revision});assert.notEqual(f.resources.binding(connection,false),binding);await assert.rejects(f.resources.save('authentication',p,{remember:false,revision}),/changed after/);
});
test('SSH profile metadata rejects plaintext secrets and changing authentication modes does not reuse an old password',async()=>{
  const f=fixture(),p=TunnelSchema.parse({id:'ssh',name:'SSH',kind:'ssh',host:'localhost',user:'user',auth:'password',fingerprint:'SHA256:'+'A'.repeat(43)});assert.throws(()=>TunnelSchema.parse({...p,password:'plain'}));await f.resources.save('tunnel',p,{secret:'old-password',remember:true,revision:f.resources.revision('tunnel','ssh')});
  await f.resources.save('tunnel',{...p,auth:'agent'},{remember:true,revision:f.resources.revision('tunnel','ssh')});assert.equal(await f.resources.secret('tunnel','ssh'),undefined);assert.equal(f.vault.size,0);
});
test('Recovered drafts reject a changed shared database identity while metadata-only renames retain the binding',async()=>{
  const f=fixture(),auth=AuthenticationSchema.parse({id:'auth',name:'Auth',kind:'password',user:'one'});await f.resources.save('authentication',auth,{remember:false,revision:f.resources.revision('authentication','auth')});const profile=ProfileSchema.parse({id:'db',name:'DB',driver:'postgresql',storage:'server',host:'localhost',database:'db',authRef:'auth'}),binding=f.resources.binding(profile,false);
  const model=new GridDocumentModel(profile,{name:'public.t',type:'table',sql:null,columns:[],indexes:[],foreignKeys:[]},{columns:[],rows:[],durationMs:0,affectedRows:0,truncated:false,sql:'SELECT * FROM public.t',readOnly:false},{table:'public.t',where:'',order:[],limit:100,offset:0},binding);
  assert.equal(GridDocumentModel.restore(profile,'public.t',model.backup(),binding).binding,binding);await f.resources.save('authentication',{...auth,user:'different-user'},{remember:false,revision:f.resources.revision('authentication','auth')});assert.throws(()=>GridDocumentModel.restore(profile,'public.t',model.backup(),f.resources.binding(profile,false)),/identity changed/);
});
test('Pending connection saves reserve their shared profiles and deleting resources rejects new references',async()=>{
  const f=fixture(),auth=AuthenticationSchema.parse({id:'auth',name:'Auth',kind:'password',user:'one'});await f.resources.save('authentication',auth,{remember:false,revision:f.resources.revision('authentication','auth')});const profile=ProfileSchema.parse({id:'db',name:'Pending connection',driver:'postgresql',storage:'server',host:'localhost',database:'db',authRef:'auth'}),release=f.resources.reserve(profile);
  await assert.rejects(f.resources.remove('authentication','auth'),/Pending connection/);release();let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;}),remove=f.resources.store.remove.bind(f.resources.store);f.resources.store.remove=async(kind,id)=>{enter();await gate;await remove(kind,id);};const deleting=f.resources.remove('authentication','auth');await entered;assert.throws(()=>f.resources.reserve(profile),/being deleted/);resume();await deleting;assert.equal(f.resources.list().authentication.length,0);
});
test('Import previews diagnose missing shared profiles and reject conflicting inline passwords before any save',async()=>{
  const f=fixture(),manager=new ConnectionManager({list:()=>[],save:async()=>{assert.fail('Preview must not save');},remove:async()=>{}},{runnerPath:'unused',resources:f.resources});
  const profile=ProfileSchema.parse({id:'db',name:'DB',driver:'postgresql',storage:'server',host:'localhost',database:'db',authRef:'missing'});try{const preview=new ConnectionTransfers(manager).preview(JSON.stringify([profile]),'json');assert.equal(preview.rows[0]?.profile,undefined);assert.match(preview.rows[0]!.errors.join(),/no longer exists/);const conflict=previewConnections(JSON.stringify([{...profile,password:'not-a-real-password'}]),'json',[]);assert.equal(conflict.rows[0]?.profile,undefined);assert(!JSON.stringify(conflict).includes('not-a-real-password'));}finally{await manager.close();}
});

test('Switching to an external provider removes stored secrets and rejects conflicting secret input',async()=>{
  const f=fixture(),password=AuthenticationSchema.parse({id:'auth',name:'Auth',kind:'password',user:'one'});await f.resources.save('authentication',password,{secret:'original-secret',remember:true,revision:f.resources.revision('authentication','auth')});
  const command=AuthenticationSchema.parse({id:'auth',name:'Auth command',kind:'command',user:'one',executable:process.execPath,args:['-e','process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'],cacheTtl:60});
  await assert.rejects(f.resources.save('authentication',command,{secret:'wrong-source',remember:true,revision:f.resources.revision('authentication','auth')}),/does not accept/);
  await f.resources.save('authentication',command,{remember:true,revision:f.resources.revision('authentication','auth')});assert.equal(await f.resources.secret('authentication','auth'),undefined);assert.equal(f.vault.size,0);const resolved=(await f.resources.authenticate('auth')).password!;assert.match(resolved,/^[0-9a-f]{32}$/);assert(!JSON.stringify(f.resources.list()).includes(resolved));f.resources.close();
});

test('Provider configuration changes reject pending credentials and invalidate later command cache results',async()=>{
  const f=fixture(),command=AuthenticationSchema.parse({id:'auth',name:'Auth',kind:'command',user:'one',executable:process.execPath,args:['-e','setTimeout(()=>process.stdout.write("stale-result"),250)'],cacheTtl:60});
  await f.resources.save('authentication',command,{remember:false,revision:f.resources.revision('authentication','auth')});const pending=f.resources.authenticate('auth'),rejection=assert.rejects(pending,/cleared while|changed while/);
  await f.resources.save('authentication',{...command,args:['-e','process.stdout.write("fresh-result")']},{remember:false,revision:f.resources.revision('authentication','auth')});await rejection;assert.equal((await f.resources.authenticate('auth')).password,'fresh-result');f.resources.close();
});
