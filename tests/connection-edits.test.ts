import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { ProfileSchema, type ConnectionProfile } from '../packages/protocol/src/index.js';
import { commitProfileSettings } from '../packages/core/src/profile-write.js';
const profile=()=>ProfileSchema.parse({id:'edit',name:'Existing',driver:'postgresql',storage:'server',host:'localhost',database:'db',user:'user'});
function fixture() {
  const rows=[profile()],vault=new Map([['edit','original-password']]);let failSettings=false,failCredential=false,writes=0;
  const manager=new ConnectionManager({list:()=>rows,save:async p=>{writes++;if(failSettings)throw new Error('Settings write failed');rows[0]=p;},remove:async()=>{rows.length=0;}},{runnerPath:'unused',credentials:{get:async id=>vault.get(id),store:async(id,p)=>{vault.set(id,p);if(failCredential&&p==='replacement')throw new Error('Credential write failed');},delete:async id=>{vault.delete(id);}}});
  return {manager,rows,vault,failSettings:()=>{failSettings=true;},failCredential:()=>{failCredential=true;},writes:()=>writes};
}
test('A stale editor cannot overwrite external settings or credentials, even after reconnection review',async()=>{
  const f=fixture();try{
    await assert.rejects(f.manager.save({...profile(),sslMode:'verify-full',caPath:'relative-root.crt'},{password:'replacement',rememberPassword:true}),/absolute paths/);assert.equal(f.writes(),0);
    const revision=f.manager.editorRevision('edit');f.rows[0]={...f.rows[0]!,name:'External rename'};
    await assert.rejects(f.manager.save({...profile(),name:'Stale'},{revision,password:'replacement',rememberPassword:true}),/changed after this form/);assert.equal(f.writes(),0);assert.equal(f.vault.get('edit'),'original-password');
    const current=f.manager.editorRevision('edit');await assert.rejects(f.manager.save({...f.rows[0]!,host:'other'},{revision:current,beforeReconnect:async()=>{f.rows[0]={...f.rows[0]!,name:'Edited during review'};return true;}}),/changed after this form/);assert.equal(f.rows[0]?.name,'Edited during review');
  }finally{await f.manager.close();}
});
test('Declining a password change leaves profile and secure storage untouched and requires only one review',async()=>{
  const f=fixture();let reviews=0;try{await assert.rejects(f.manager.save({...profile(),name:'New'},{password:'replacement',rememberPassword:true,revision:f.manager.editorRevision('edit'),beforeReconnect:async changed=>{reviews++;assert(changed);return false;}}),/were not changed/);assert.equal(reviews,1);assert.equal(f.writes(),0);assert.equal(f.vault.get('edit'),'original-password');}finally{await f.manager.close();}
});
test('Profile save failure restores the prior vault value and retains the previous in-memory credential',async()=>{
  const f=fixture();try{await f.manager.setPassword('edit','original-password','session');f.failSettings();await assert.rejects(f.manager.save({...profile(),name:'New'},{password:'replacement',rememberPassword:true}),/Settings write failed/);assert.equal(f.rows[0]?.name,'Existing');assert.equal(f.vault.get('edit'),'original-password');assert.equal(await f.manager.passwordChanged('edit','original-password'),false);}finally{await f.manager.close();}
});
test('A failing vault write is compensated before profile settings can change',async()=>{
  const f=fixture();try{f.failCredential();await assert.rejects(f.manager.save(profile(),{password:'replacement',rememberPassword:true}),/Credential write failed/);assert.equal(f.writes(),0);assert.equal(f.vault.get('edit'),'original-password');}finally{await f.manager.close();}
});
test('Forgetting a saved password preserves session use without changing the database target',async()=>{
  const f=fixture();try{await f.manager.save(profile(),{rememberPassword:false,revision:f.manager.editorRevision('edit')});assert.equal(f.vault.size,0);assert.equal(await f.manager.passwordChanged('edit','original-password'),false);assert.deepEqual({...await f.manager.editorState('edit'),revision:''},{revision:'',hasPassword:true,rememberPassword:false});}finally{await f.manager.close();}
});
test('Settings moves compensate a partial scope write, including a destination that wrote before throwing',async()=>{
  const original=[profile()],values=new Map<string,unknown>([['global',original],['workspace',undefined]]);let failed=false;
  await assert.rejects(commitProfileSettings([{scope:'workspace',before:undefined,after:[{...profile(),scope:'workspace'}]},{scope:'global',before:original,after:[]}],async(scope,value)=>{values.set(scope,value);if(scope==='global'&&!failed){failed=true;throw new Error('Scope write failed');}}),/Scope write failed/);
  assert.equal(values.get('workspace'),undefined);assert.equal(values.get('global'),original);
});
test('Settings rollback failures are reported as incomplete rather than successful saves',async()=>{
  await assert.rejects(commitProfileSettings([{scope:'global',before:[],after:[profile()]}],async()=>{throw new Error('Unavailable settings storage');}),/restoring earlier settings was incomplete/);
});
