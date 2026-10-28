import { randomUUID, createHash } from 'node:crypto';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { defaultPort, isMysqlFamily, ProfileSchema, type ConnectionEditorState, type ConnectionProfile, type RuntimeInfo } from '../../protocol/src/index.js';
import type { DriverSession } from '../../driver-sdk/src/index.js';
import { SessionLostError, SqliteSession } from '../../drivers/sqlite/session.js';
import { PostgresSession } from '../../drivers/postgresql/session.js';
import { MysqlSession } from '../../drivers/mysql/session.js';
import { profileTarget } from './profile-target.js';
import type {ConnectionResources} from './resources.js';
import type {SshTunnels} from './tunnels.js';

export interface CredentialStore { get(id: string): Promise<string | undefined>; store(id: string, password: string): Promise<void>; delete(id: string): Promise<void>; }
export interface ConnectionSaveOptions { password?: string; rememberPassword?: boolean; revision?: string; beforeReconnect?: (credentialChanged: boolean) => Promise<boolean>; }
/** Extension-host-only native tool context. Never send credentials or this object to a Webview. */
export interface NativeConnection {profile:ConnectionProfile;session:DriverSession;host:string;port:number;user:string;password?:string;assertCurrent():void;}

export interface ProfileStore {
  list(): ConnectionProfile[];
  save(profile: ConnectionProfile): Promise<void>;
  remove(id: string): Promise<void>;
}
interface LeaseRecord {
  owner: string; profileId: string; session?: DriverSession; opening: Promise<DriverSession>; ready: boolean; retired: boolean;
}
const sameTarget = (first: ConnectionProfile, second: ConnectionProfile) => JSON.stringify(profileTarget(first)) === JSON.stringify(profileTarget(second)) && first.readOnly === second.readOnly && first.connectTimeout === second.connectTimeout && (first.applicationName||'DBNook')===(second.applicationName||'DBNook');
export class ConnectionManager {
  private sessions = new Map<string, DriverSession>();
  private passwords = new Map<string, string>();
  private credentialVersions = new Map<string,number>();
  private bindings=new WeakMap<DriverSession,string|undefined>();
  private opening = new Map<string, Promise<DriverSession>>();
  private openingSessions = new Map<string, DriverSession>();
  private leases = new Map<string, LeaseRecord>();
  private disconnecting = new Map<string, Promise<void>>();
  private closed = false;
  private saves = new Set<string>();
  private targetSaves = new Set<string>();
  constructor(readonly store: ProfileStore, private runtime: { runnerPath: string; nodePath?: string; log?: (message: string) => void; credentials?: CredentialStore;resources?:ConnectionResources;tunnels?:SshTunnels }, private onChange: () => void = () => {}) {}
  /** Schema-only planning uses its own in-memory runner, never a user's memory database. */
  async withSqliteSchemaSandbox<T>(action:(session:DriverSession)=>Promise<T>):Promise<T>{
    if(this.closed)throw new Error('The connection manager is closed.');
    const profile=ProfileSchema.parse({id:'schema-sandbox:'+randomUUID(),name:'Schema-only planning',driver:'sqlite',storage:'memory'}),session=new SqliteSession(profile,this.runtime);
    try{await session.open();return await action(session);}finally{await session.close();}
  }
  resourceBinding(profile:ConnectionProfile):string|undefined{return this.runtime.resources?.binding(profile,false);}
  connectionUser(profile:ConnectionProfile):string{return profile.authRef?this.runtime.resources?.list().authentication.find(p=>p.id===profile.authRef)?.user??'(missing Authentication Profile)':profile.user??'';}
  private binding(profile:ConnectionProfile):string|undefined{return this.runtime.resources?.binding(profile);}
  editorRevision(id: string): string { const profile=this.profiles().find(p=>p.id===id);return createHash('sha256').update(JSON.stringify([profile??null,this.credentialVersions.get(id)??0,profile?this.binding(profile):null])).digest('hex'); }
  async editorState(id: string): Promise<ConnectionEditorState> { const saved=await this.runtime.credentials?.get(id);return {revision:this.editorRevision(id),hasPassword:this.passwords.has(id)||saved!==undefined,rememberPassword:saved!==undefined}; }
  private credentialChanged(id: string): void { this.credentialVersions.set(id,(this.credentialVersions.get(id)??0)+1); }
  async passwordChanged(id: string, password: string): Promise<boolean> { return (this.passwords.get(id) ?? await this.runtime.credentials?.get(id)) !== password; }
  async persistPassword(id: string, remember: boolean): Promise<void> {
    if(this.saves.has(id))throw new Error('Connection settings are already being saved.');
    const value = this.passwords.get(id) ?? await this.runtime.credentials?.get(id);
    if (value !== undefined) this.passwords.set(id,value);
    if (remember && value !== undefined) { if (!this.runtime.credentials) throw new Error('Secure credential storage is unavailable in this host.'); await this.runtime.credentials.store(id,value); }
    if (!remember) await this.runtime.credentials?.delete(id);
    this.credentialChanged(id);
  }
  async setPassword(id: string, password: string, persist: 'session' | 'remember' | 'forget'): Promise<void> {
    if(this.saves.has(id))throw new Error('Connection settings are already being saved.');
    if (await this.passwordChanged(id, password)) await this.disconnect(id);
    this.passwords.set(id, password);
    if (persist === 'remember') { if (!this.runtime.credentials) throw new Error('Secure credential storage is unavailable in this host.'); await this.runtime.credentials.store(id, password); }
    if (persist === 'forget') await this.runtime.credentials?.delete(id);
    this.credentialChanged(id);
  }
  private session(profile: ConnectionProfile, password?: string): DriverSession {
    this.validateEndpoint(profile);
    const ServerSession=isMysqlFamily(profile.driver)?MysqlSession:PostgresSession;
    const session=profile.driver==='sqlite'?new SqliteSession(profile,this.runtime):new ServerSession(profile,async()=>password!==undefined?password:this.passwords.get(profile.id)??await this.runtime.credentials?.get(profile.id),{
      ...(profile.authRef?{credentials:async()=>{const auth=await this.runtime.resources!.authenticate(profile.authRef!,{host:profile.host!,port:profile.port??defaultPort(profile.driver),database:profile.database??''});return {...auth,password:password??auth.password};}}:{}),
      ...(profile.tunnelRef?{endpoint:(signal:AbortSignal)=>this.runtime.tunnels!.acquire(profile.tunnelRef!,profile.host!,profile.port??defaultPort(profile.driver),signal)}:{}),
    });this.bindings.set(session,this.binding(profile));return session;
  }
  profiles(): ConnectionProfile[] { return this.store.list().map(profile => ProfileSchema.parse(profile)); }
  async withNativeConnection<T>(id:string,signal:AbortSignal,action:(connection:NativeConnection)=>Promise<T>):Promise<T>{
    this.available(id);const profile=this.profile(id);this.validateEndpoint(profile);
    if(profile.driver==='sqlite'||!profile.database)throw new Error('Choose a server connection with an explicit database for native backup / restore.');
    const revision=this.editorRevision(id),owner='native-tool:'+randomUUID(),releaseReferences=this.runtime.resources?.reserve(profile);
    let endpoint:Awaited<ReturnType<SshTunnels['acquire']>>|undefined;
    try{
      const session=await this.lease(id,owner);
      const assertCurrent=()=>{if(signal.aborted)throw signal.reason instanceof Error?signal.reason:new Error('Native operation cancelled.');this.available(id);if(!session.connected||endpoint&&!endpoint.active()||this.editorRevision(id)!==revision)throw new Error('Connection settings, credentials, tunnel or session changed during the native operation. Inspect its result before retrying.');};
      assertCurrent();const credentials=profile.authRef?await this.runtime.resources!.authenticate(profile.authRef,{host:profile.host!,port:profile.port??defaultPort(profile.driver),database:profile.database}):{user:profile.user!,password:this.passwords.get(id)??await this.runtime.credentials?.get(id)};
      if(credentials.user!==this.connectionUser(profile))throw new Error('Native tools require the saved authentication identity.');
      if(profile.tunnelRef)endpoint=await this.runtime.tunnels!.acquire(profile.tunnelRef,profile.host!,profile.port??defaultPort(profile.driver),signal);
      assertCurrent();return await action({profile,session,host:endpoint?.host??profile.host!,port:endpoint?.port??profile.port??defaultPort(profile.driver),...credentials,assertCurrent});
    }finally{try{await endpoint?.release();}finally{try{await this.releaseLease(owner);}finally{releaseReferences?.();}}}
  }
  async withSqliteFile<T>(path:string,action:(session:DriverSession)=>Promise<T>):Promise<T>{
    if(!isAbsolute(path))throw new Error('Choose an absolute SQLite file path.');
    const session=this.session(ProfileSchema.parse({id:randomUUID(),name:'SQLite file inspection',driver:'sqlite',storage:'file',path,readOnly:true,createIfMissing:false}));
    try{await session.open();return await action(session);}finally{await session.close();}
  }
  profile(id: string): ConnectionProfile {
    const profile = this.profiles().find(profile => profile.id === id);
    if (!profile) throw new Error('Connection no longer exists.');
    return profile;
  }
  isConnected(id: string): boolean { return Boolean(this.sessions.get(id)?.connected || [...this.leases.values()].some(lease => lease.profileId === id && lease.session?.connected)); }
  runtimeInfo(id: string): RuntimeInfo | undefined { return this.sessions.get(id)?.info ?? [...this.leases.values()].find(lease => lease.profileId === id && lease.session?.connected)?.session?.info; }
  private available(id: string): void { if (this.closed || this.disconnecting.has(id)) throw new Error('This connection is closing. Wait for disconnect to finish.'); if (this.targetSaves.has(id)) throw new Error('Connection settings are being saved. Wait before reconnecting.'); }
  willReconnect(profile: ConnectionProfile): boolean {
    const existing = this.store.list().find(value => value.id === profile.id);
    return Boolean(existing && !sameTarget(existing, profile));
  }
  private validateEndpoint(profile:ConnectionProfile):void {
    if((profile.authRef||profile.tunnelRef)&&!this.runtime.resources)throw new Error('Shared connection profiles are unavailable in this host.');
    this.runtime.resources?.validate(profile);
    if(profile.tunnelRef&&!this.runtime.tunnels)throw new Error('SSH tunnels are unavailable in this host.');
    if(profile.tunnelRef&&profile.host?.startsWith('/'))throw new Error('SSH TCP tunnels require a database hostname or IP address; remote Unix sockets are not implemented yet.');
    if(profile.storage==='file'&&!isAbsolute(profile.path))throw new Error('Select an absolute database file path.');
    if(profile.driver!=='sqlite')for(const key of ['caPath','certPath','keyPath'] as const)if(profile[key]&&!isAbsolute(profile[key]))throw new Error('Certificate and private key paths must be absolute paths on the extension host.');
  }
  validateProfile(value:unknown):ConnectionProfile{const profile=ProfileSchema.parse(value);this.validateEndpoint(profile);return profile;}
  async save(value: unknown, options: ConnectionSaveOptions = {}): Promise<ConnectionProfile> {
    const profile = ProfileSchema.parse(value);
    this.validateEndpoint(profile);
    if (this.saves.has(profile.id)) throw new Error('Connection settings are already being saved. Wait for that update to finish.');
    if((profile.driver==='sqlite'||profile.authRef)&&(options.password!==undefined||options.rememberPassword!==undefined))throw new Error('Edit the selected Authentication Profile to change its credentials.');
    const assertCurrent=()=>{if(options.revision!==undefined&&options.revision!==this.editorRevision(profile.id))throw new Error('Connection settings or credentials changed after this form opened. Reload the connection before saving; your draft has been kept.');};
    this.saves.add(profile.id);
    const previousMemory=this.passwords.get(profile.id);let previousSecret:string|undefined,secretTouched=false,releaseReferences:(()=>void)|undefined;
    try {
      releaseReferences=this.runtime.resources?.reserve(profile);
      assertCurrent();
      const credentialWrite=options.password!==undefined||options.rememberPassword!==undefined||Boolean(profile.authRef);
      if(credentialWrite)previousSecret=await this.runtime.credentials?.get(profile.id);
      const password=options.password??previousMemory??previousSecret;
      if(options.rememberPassword&&password!==undefined&&!this.runtime.credentials)throw new Error('Secure credential storage is unavailable in this host.');
      const credentialChange=options.password!==undefined&&options.password!==(previousMemory??previousSecret);
      const reconnect=this.willReconnect(profile)||credentialChange;
      if(reconnect&&options.beforeReconnect&&!await options.beforeReconnect(credentialChange))throw new Error('Connection settings were not changed.');
      assertCurrent();
      if(reconnect){this.targetSaves.add(profile.id);await this.disconnect(profile.id);}
      if((options.rememberPassword!==undefined||profile.authRef)&&this.runtime.credentials) {
        secretTouched=true;
        if(options.rememberPassword&&password!==undefined)await this.runtime.credentials.store(profile.id,password);
        else if(!options.rememberPassword||profile.authRef)await this.runtime.credentials.delete(profile.id);
      }
      assertCurrent();await this.store.save(profile);
      if(profile.authRef)this.passwords.delete(profile.id);else if(credentialWrite&&password!==undefined)this.passwords.set(profile.id,password);
      if(credentialWrite)this.credentialChanged(profile.id);
      return profile;
    } catch(error) {
      if(secretTouched&&this.runtime.credentials) {
        try {if(previousSecret===undefined)await this.runtime.credentials.delete(profile.id);else await this.runtime.credentials.store(profile.id,previousSecret);}
        catch {throw new Error('Connection save failed and the previous saved password could not be restored. Review the connection credentials before reconnecting.');}
      }
      throw error;
    }
    finally { releaseReferences?.();this.saves.delete(profile.id); this.targetSaves.delete(profile.id); this.onChange(); }
  }
  async duplicate(id: string): Promise<ConnectionProfile> { const profile = this.profile(id); return this.save({ ...profile, id: randomUUID(), name: `${profile.name} Copy` }); }
  async remove(id: string): Promise<void> { if(this.saves.has(id))throw new Error('Wait for connection settings to finish saving before deleting.');await this.disconnect(id); await this.store.remove(id); this.passwords.delete(id); await this.runtime.credentials?.delete(id); this.credentialChanged(id);this.onChange(); }
  async connect(id: string): Promise<DriverSession> {
    this.available(id);
    const profile = this.profile(id);
    const current = this.sessions.get(id);
    if (current?.connected) {
      if (!sameTarget(current.profile, profile)||this.bindings.get(current)!==this.binding(profile)) throw new Error('Connection settings changed outside the connection editor, or a shared profile changed. Disconnect this connection before using its new settings.');
      return current;
    }
    const existing = this.opening.get(id); if (existing) return existing;
    const session = this.session(profile);
    this.openingSessions.set(id, session);
    const opening = (async () => {
      try { await session.open(); if (!sameTarget(profile, this.profile(id))||this.bindings.get(session)!==this.binding(this.profile(id))) throw new Error('Connection settings changed while connecting. Retry with the current settings.'); this.sessions.set(id, session); this.onChange(); return session; }
      catch (error) { await session.close(); throw error; }
      finally { this.opening.delete(id); this.openingSessions.delete(id); }
    })();
    this.opening.set(id, opening); return opening;
  }
  /** A document's transaction always stays on its own physical connection. */
  lease(id: string, owner: string): Promise<DriverSession> {
    this.available(id); if (!owner) throw new Error('A document session requires an owner.');
    const existing = this.leases.get(owner);
    if (existing) {
      if (existing.profileId !== id) throw new Error('Release this document session before switching connections.');
      if (existing.session && (!sameTarget(existing.session.profile, this.profile(id))||this.bindings.get(existing.session)!==this.binding(this.profile(id)))) return Promise.reject(new Error('Connection settings changed outside the connection editor. Reset this document session before executing SQL.'));
      if (existing.ready && !existing.session?.connected) return Promise.reject(new SessionLostError('The document session was lost. Reset its session explicitly; interrupted work will not be replayed.'));
      return existing.opening;
    }
    const profile = this.profile(id);
    const record: LeaseRecord = { owner, profileId: id, opening: undefined!, ready: false, retired: false };
    this.leases.set(owner, record);
    record.opening = (async () => {
      try {
        if (profile.driver === 'sqlite' && profile.storage === 'memory') {
          await this.connect(id);
          if (record.retired) throw new SessionLostError('This document was closed while connecting.');
          record.session = (this.sessions.get(id)! as SqliteSession).sibling();
        } else record.session = this.session(profile);
        await record.session.open();
        if (record.retired) throw new SessionLostError('This document was closed while connecting.');
        if (!sameTarget(record.session.profile, this.profile(id))||this.bindings.get(record.session)!==this.binding(this.profile(id))) throw new Error('Connection settings changed while opening this document session. Retry with the current settings.');
        record.ready = true; this.onChange(); return record.session;
      } catch (error) {
        await record.session?.close(); if (this.leases.get(owner) === record) this.leases.delete(owner); throw error;
      }
    })();
    return record.opening;
  }
  documentSession(owner: string): DriverSession | undefined { return this.leases.get(owner)?.session; }
  documentSessions(id?: string): { owner: string; profileId: string; session?: DriverSession }[] { return [...this.leases.values()].filter(lease => !id || lease.profileId === id).map(({ owner, profileId, session }) => ({ owner, profileId, session })); }
  async releaseLease(owner: string): Promise<void> {
    const record = this.leases.get(owner); if (!record) return;
    record.retired = true; this.leases.delete(owner);
    await record.session?.close(); try { await record.opening; } catch { /* The opening caller receives its original error. */ }
    this.onChange();
  }
  async cancelLease(owner: string): Promise<boolean> {
    const record = this.leases.get(owner); if (!record) return false;
    const result = record.session ? await record.session.cancel() : await this.openingSessions.get(record.profileId)?.cancel(); this.onChange(); return result ?? false;
  }
  async test(value: unknown, password?: string): Promise<RuntimeInfo> {
    const profile = ProfileSchema.parse(value);
    this.validateEndpoint(profile);
    if (profile.storage === 'file') {
      if (!isAbsolute(profile.path)) throw new Error('Select an absolute database file path.');
      try { const info = await stat(profile.path); if (!info.isFile()) throw new Error('The selected path is not a file.'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !profile.createIfMissing) throw error;
        if (profile.readOnly) throw new Error('Read-only connections require an existing database file.');
        await access(dirname(profile.path), constants.W_OK);
        // Verify the runtime without creating the user's new database file.
        const session = new SqliteSession({ ...profile, storage: 'memory', readOnly: false }, this.runtime);
        try { return { ...await session.open(), path: profile.path }; } finally { await session.close(); }
      }
      await access(profile.path, profile.readOnly ? constants.R_OK : constants.R_OK | constants.W_OK);
    }
    const session = this.session({ ...profile, createIfMissing: false },password);
    try { return await session.open(); } finally { await session.close(); }
  }
  disconnect(id: string): Promise<void> {
    const existing = this.disconnecting.get(id); if (existing) return existing;
    const closing = (async () => {
      await Promise.all(this.documentSessions(id).map(lease => this.releaseLease(lease.owner)));
      const opening = this.opening.get(id);
      if (opening) { await this.openingSessions.get(id)?.close(); try { await opening; } catch { /* Opening failure already reported to its caller. */ } }
      const session = this.sessions.get(id); this.sessions.delete(id);
      await session?.close(); this.onChange();
    })();
    this.disconnecting.set(id, closing);
    return closing.finally(() => { this.disconnecting.delete(id); });
  }
  async cancel(id: string): Promise<boolean> {
    const results = await Promise.all([...(this.documentSessions(id).map(lease => lease.session?.cancel())), (this.sessions.get(id) ?? this.openingSessions.get(id))?.cancel()]);
    if (!this.sessions.get(id)?.connected) this.sessions.delete(id); this.onChange(); return results.some(Boolean);
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...new Set([...this.sessions.keys(), ...this.opening.keys(), ...this.documentSessions().map(lease => lease.profileId)])].map(id => this.disconnect(id))); }
}
