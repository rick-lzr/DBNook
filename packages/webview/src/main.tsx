import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type CellEditRequestEvent, type ColDef } from 'ag-grid-community';
import { defaultPort, driverNames, isMysqlFamily, displayCell, editableCell, errorMessage, parseCell, ProfileSchema, type ConnectionEditorState, type ConnectionEditResult, type CellValue, type ColumnMeta, type ConnectionProfile, type DataRow, type QueryResult, type QueryRun, type RowChange, type RuntimeInfo, type WorkbenchBoot } from '../../protocol/src/index.js';
import type { ParsedConnectionString } from '../../core/src/connection-strings.js';
import { getState, onQueryRun, onQueryState, onResult, rpc, setState,reportFrontend } from './bridge.js';
import { ROW_ID, fromWireEdits, useGridEditor, type GridRow, type EditSnapshot } from './use-grid-editor.js';
import './style.css';
import './responsive.css';
import './query.css';
import { ConnectionsImport } from './connections-import.js';
import {ResourceEditor} from './resource-editor.js';
import {StructureEditor} from './structure-editor.js';
import {DataImport} from './data-import.js';
import {SqliteBackup} from './sqlite-backup.js';
import {ServerBackup} from './server-backup.js';
import {ComparisonEditor} from './comparison.js';
import {CombinationEditor} from './combination.js';
import {QueryPlan} from './query-plan.js';
import {SqlParameters} from './sql-parameters.js';
import {copyGridValues,parseGridClipboard,pastedCell} from '../../core/src/grid-clipboard.js';
import {PastePreview,type PasteChange} from './paste-preview.js';
import {RawCellEditor} from './cell-editor.js';

ModuleRegistry.registerModules([AllCommunityModule]);
type IconName = 'database' | 'arrow' | 'folder' | 'refresh' | 'save' | 'plus' | 'minus' | 'undo' | 'redo' | 'play' | 'stop' | 'download' | 'key' | 'columns' | 'inspect' | 'close' | 'check' | 'bolt' | 'search';
const paths: Record<IconName, React.ReactNode> = {
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></>,
  arrow: <path d="m10 5-7 7 7 7M3 12h18"/>, folder: <path d="M3 7V4h7l2 3h9v13H3V7h18"/>, refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/></>,
  save: <><path d="M4 3h13l4 4v14H3V3h1M7 3v6h10V3M7 21v-8h10v8"/></>, plus: <path d="M12 4v16M4 12h16"/>, minus: <path d="M4 12h16"/>, undo: <path d="M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14"/>, redo: <path d="m16 4 5 5-5 5m5-5H11a7 7 0 0 0 0 14"/>,
  play: <path d="m7 3 14 9-14 9z"/>, stop: <rect x="5" y="5" width="14" height="14" rx="1"/>, download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>, key: <><circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-5-5 3-3m-1 5 3-3"/></>,
  columns: <><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18m6-18v18"/></>, inspect: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></>, close: <path d="m5 5 14 14M19 5 5 19"/>, check: <path d="m4 12 5 5L20 6"/>, bolt: <path d="m14 2-9 12h6l-1 8 9-12h-6z"/>, search: <><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></>,
};
function Icon({ name, size = 16 }: { name: IconName; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }
function Tool({ name, label, disabled, active, onClick }: { name: IconName; label: string; disabled?: boolean; active?: boolean; onClick(): void }) { return <button type="button" className={`tool ${active ? 'active' : ''}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon name={name}/></button>; }
function Notice({ message, success = false }: { message: string; success?: boolean }) { return <div className={`notice ${success ? 'success' : 'error'}`} role={success ? 'status' : 'alert'}><Icon name={success ? 'check' : 'inspect'}/><span>{message}</span></div>; }
function ConnectionEditor({ profile: initial, editor: initialEditor,resources:initialResources }: { profile: ConnectionProfile; editor?: ConnectionEditorState;resources?:WorkbenchBoot['resources'] }) {
  const cached = getState<{ profile?: ConnectionProfile; revision?:string }>();
  const [profile, update] = useState(cached?.profile?.id === initial.id ? cached.profile : initial);
  const [revision,setRevision]=useState(cached?.profile?.id===initial.id&&cached.revision?cached.revision:initialEditor?.revision??'');
  const [saved,setSaved]=useState(Boolean(initial.name));
  const [resources,setResources]=useState(initialResources??{authentication:[],tunnels:[]});
  const [step, setStep] = useState(initial.name ? 'form' : 'select');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | 'parse' | undefined>();
  const [notice, setNotice] = useState<{ message: string; success?: boolean }>();
  const [showString, setShowString] = useState(false), [stringInput, setStringInput] = useState('');
  const [password, setPassword] = useState<string | undefined>(), [rememberPassword, setRememberPassword] = useState(initialEditor?.hasPassword?initialEditor.rememberPassword:true);
  const cacheProfile=(value:ConnectionProfile)=>setState({profile:value,revision});
  const chooseDriver = (driver: ConnectionProfile['driver']) => {
    const next = { ...profile, driver, storage: driver === 'sqlite' ? 'file' as const : 'server' as const, path: '', createIfMissing: false, host: driver !== 'sqlite' ? 'localhost' : undefined, port: isMysqlFamily(driver) ? 3306 : driver === 'postgresql' ? 5432 : undefined, database: driver === 'postgresql' ? 'postgres' : undefined, user: isMysqlFamily(driver) ? 'root' : driver === 'postgresql' ? 'postgres' : undefined, sslMode: driver !== 'sqlite' ? 'verify-full' as const : undefined, caPath: undefined, certPath: undefined, keyPath: undefined, connectTimeout: undefined,applicationName:undefined };
    next.authRef=undefined;next.tunnelRef=undefined;update(next); cacheProfile(next); setPassword(undefined); setStep('form'); setShowString(false);
  };
  const importString = async () => {
    setBusy('parse'); setNotice(undefined);
    try {
      const parsed = await rpc<ParsedConnectionString>({ method: 'profile.parseString', params: { id: profile.id, text: stringInput } });
      const { suggestedName,password:importedPassword, ...fields } = parsed;
      const driver=parsed.driver??'sqlite';
      const next = { ...profile,authRef:undefined,tunnelRef:driver==='sqlite'?undefined:profile.tunnelRef,host:undefined,port:undefined,database:undefined,user:undefined,sslMode:undefined,caPath:undefined,certPath:undefined,keyPath:undefined,connectTimeout:undefined,applicationName:undefined,...fields,driver:driver as ConnectionProfile['driver'], name: profile.name || suggestedName };
      if(driver==='sqlite'||driver!==profile.driver)setPassword(undefined);if(importedPassword!==undefined)setPassword(importedPassword);
      update(next); cacheProfile(next); setStep('form'); setShowString(false); setStringInput(''); setNotice({ message: 'Connection string imported. Review the settings before saving.', success: true });
    } catch (reason) { setNotice({ message: errorMessage(reason) }); } finally { setBusy(undefined); }
  };
  const field = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => { const next = { ...profile, [key]: value }; update(next); cacheProfile(next); setNotice(undefined); };
  const act = async (operation: 'test' | 'save') => {
    setBusy(operation); setNotice(undefined);
    try {
      const parsed = ProfileSchema.safeParse(profile);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check connection settings.');
      if (operation === 'test') { const info = await rpc<RuntimeInfo>({ method: 'profile.edit.test', params: {profile:parsed.data,password:profile.driver!=='sqlite'&&!profile.authRef?password:undefined} }); setNotice({ message: `Connected successfully · ${profile.driver !== 'sqlite' ? `${driverNames[profile.driver]} ${info.serverVersion} · ${info.tls==='disabled'?'TLS disabled':info.tls==='verify-full'?'TLS identity verified':info.tls==='verify-ca'?'TLS certificate verified':'TLS encrypted'}` : `SQLite ${info.sqlite}`}${profile.createIfMissing ? ' · new file will be created when connected' : ''}`, success: true }); }
      else {
        const result = await rpc<ConnectionEditResult>({ method: 'profile.edit.save', params: {profile:parsed.data,password:profile.driver!=='sqlite'&&!profile.authRef?password:undefined,rememberPassword:profile.driver!=='sqlite'&&!profile.authRef?rememberPassword:undefined,revision} });
        setPassword(undefined);setRememberPassword(result.editor.rememberPassword);setRevision(result.editor.revision);setSaved(true);
        update(result.profile);setState({profile:result.profile,revision:result.editor.revision});setNotice({ message: 'Connection saved. Expand it in Connections to browse your database.', success: true });
      }
    } catch (error) { setNotice({ message: errorMessage(error) }); }
    finally { setBusy(undefined); }
  };
  const browse = async (create: boolean) => {
    try { const path = await rpc<string | null>({ method: 'file.pick', params: { create } }); if (path) { const next = { ...profile, path, createIfMissing: create }; update(next); cacheProfile(next); } }
    catch (error) { setNotice({ message: errorMessage(error) }); }
  };
  const reloadSaved=async()=>{setBusy('parse');try{const boot=await rpc<WorkbenchBoot>({method:'initialize',params:{}});update(boot.profile);setRevision(boot.connectionEditor?.revision??'');setRememberPassword(boot.connectionEditor?.rememberPassword??false);setPassword(undefined);setShowString(false);setStringInput('');setState({profile:boot.profile,revision:boot.connectionEditor?.revision});setNotice({message:'Reloaded current settings. Unsaved form changes were discarded.',success:true});}catch(reason){setNotice({message:errorMessage(reason)});}finally{setBusy(undefined);}};
  return <main className="connection-page">
    <div className="page-caption"><Icon name="database"/><span>Connections</span><span className="muted">/</span><span>{saved ? 'Edit connection' : 'New connection'}</span></div>
    {step === 'select' && notice && <Notice {...notice}/>}
    {showString && <section className="string-import"><label htmlFor="connection-string">Connection string</label><textarea id="connection-string" disabled={Boolean(busy)} value={stringInput} onChange={event => setStringInput(event.target.value)} placeholder="postgresql://user@localhost:5432/database?sslmode=verify-full or file:///D:/data/example.db?mode=ro"/><div className="string-actions"><button className="primary" disabled={Boolean(busy) || !stringInput.trim()} onClick={() => void importString()}>Apply connection string</button><button className="text-button" disabled={Boolean(busy)} onClick={() => setShowString(false)}>Cancel import</button></div></section>}
    {step === 'select' ? <section className="source-selector">
      <div className="section-eyebrow">CONNECT YOUR DATA</div><h1>Choose a database</h1><p className="muted">Connect to a server or open a local database.</p>
      <div className="search-box"><Icon name="search"/><input aria-label="Search databases" placeholder="Search databases…" value={search} onChange={event => setSearch(event.target.value)}/></div>
      <button className="text-button import-string-link" onClick={() => setShowString(!showString)}>Import connection string</button>
      <div className="category-label">SQL DATABASES <span>4</span></div>
      {(['sqlite', 'mysql', 'mariadb', 'postgresql'] as const).filter(driver => driver.includes(search.toLowerCase())).map(driver => <button key={driver} className="source-tile" onClick={() => chooseDriver(driver)}><span className="database-mark"><Icon name="database" size={29}/></span><span><strong>{driverNames[driver]}</strong><small>{driver === 'sqlite' ? 'File or in-memory database' : 'Server connection · password and TLS'}</small></span><span className="source-chevron">›</span></button>)}
      {search && !['sqlite','mysql','mariadb','postgresql'].some(driver=>driver.includes(search.toLowerCase())) && <p className="empty-hint">No matching databases found.</p>}
    </section> : <section className="connection-card">
      <header className="connection-heading"><Tool name="arrow" label="Back to database selection" disabled={Boolean(busy)} onClick={() => setStep('select')}/><span className="heading-rule"/><span className="database-mark"><Icon name="database" size={27}/></span><div><h1>{driverNames[profile.driver]}</h1><p className="muted">{saved ? 'Edit connection' : 'New connection'}</p></div><button className="text-button import-string-link" disabled={Boolean(busy)} onClick={() => setShowString(!showString)}>Import connection string</button></header>
      <form id="connection-form" onSubmit={event => { event.preventDefault(); void act('save'); }}>
        <fieldset className="connection-fields" disabled={Boolean(busy)}>
        <div className="form-row"><label htmlFor="name">Connection name <em>*</em></label><input id="name" autoFocus value={profile.name} placeholder="e.g. Local development" required maxLength={120} onChange={event => field('name', event.target.value)}/></div>
        {profile.driver === 'sqlite' && <div className="form-row"><label>Storage Type <em>*</em></label><div className="segmented" role="group" aria-label="Storage type"><button type="button" className={profile.storage === 'file' ? 'selected' : ''} onClick={() => field('storage', 'file')}>File</button><button type="button" className={profile.storage === 'memory' ? 'selected' : ''} onClick={() => field('storage', 'memory')}>In Memory <span>· Won’t be persisted</span></button></div></div>}
        {profile.driver !== 'sqlite' && <>
          <div className="form-row"><label htmlFor="host">Host <em>*</em></label><input id="host" required value={profile.host ?? ''} onChange={event=>field('host',event.target.value)}/></div>
          <div className="form-row"><label htmlFor="port">Port <em>*</em></label><input id="port" type="number" min={1} max={65535} required value={profile.port ?? defaultPort(profile.driver)} onChange={event=>field('port',Number(event.target.value))}/></div>
          <div className="form-row"><label htmlFor="database">Database {profile.driver === 'postgresql' && <em>*</em>}</label><input id="database" placeholder={isMysqlFamily(profile.driver) ? 'Optional · browse accessible databases' : undefined} required={profile.driver === 'postgresql'} value={profile.database ?? ''} onChange={event=>field('database',event.target.value||undefined)}/></div>
          <div className="form-row"><label htmlFor="authRef">Authentication Profile</label><div className="password-field"><select id="authRef" value={profile.authRef??''} onChange={event=>{field('authRef',event.target.value||undefined);setPassword(undefined);}}><option value="">Connection credentials</option>{profile.authRef&&!resources.authentication.some(p=>p.id===profile.authRef)&&<option value={profile.authRef}>Missing profile · {profile.authRef}</option>}{resources.authentication.filter(p=>!isMysqlFamily(profile.driver)||p.kind!=='pgpass').map(p=><option key={p.id} value={p.id}>{p.name} · {p.user}</option>)}</select><button type="button" className="text-button" onClick={()=>void rpc<NonNullable<WorkbenchBoot['resources']>>({method:'resources.list',params:{}}).then(setResources).catch(reason=>setNotice({message:errorMessage(reason)}))}>Refresh profiles</button></div></div>
          {!profile.authRef&&<>
          <div className="form-row"><label htmlFor="user">User <em>*</em></label><input id="user" required value={profile.user ?? ''} onChange={event=>field('user',event.target.value)}/></div>
          <div className="form-row"><label htmlFor="password">Password</label><div className="password-field"><input id="password" type="password" autoComplete="off" value={password ?? ''} placeholder="Leave unchanged to reuse the saved password" onChange={event=>setPassword(event.target.value)}/><label className="checkbox-line"><input type="checkbox" checked={rememberPassword} onChange={event=>setRememberPassword(event.target.checked)}/>Remember password in VS Code secure storage</label></div></div>
          </>}
          <div className="form-row"><label htmlFor="tunnelRef">SSH tunnel</label><div className="password-field"><select id="tunnelRef" value={profile.tunnelRef??''} onChange={event=>field('tunnelRef',event.target.value||undefined)}><option value="">Direct connection</option>{profile.tunnelRef&&!resources.tunnels.some(p=>p.id===profile.tunnelRef)&&<option value={profile.tunnelRef}>Missing tunnel · {profile.tunnelRef}</option>}{resources.tunnels.map(p=><option key={p.id} value={p.id} disabled={Boolean(p.source?.issues.length)}>{p.name} · {p.source?'SSH Config · ':''}{p.host}{p.source?.issues.length?' · Unavailable':''}</option>)}</select>{resources.tunnels.find(p=>p.id===profile.tunnelRef)?.source?.issues.map(issue=><span className="muted" key={issue}>{issue}</span>)}</div></div>
          <div className="form-row"><label htmlFor="sslMode">TLS</label><select id="sslMode" value={profile.sslMode ?? 'disable'} onChange={event=>field('sslMode',event.target.value as ConnectionProfile['sslMode'])}><option value="verify-full">Verify certificate and hostname</option><option value="verify-ca">Verify certificate authority</option><option value="require">Require encryption · CA verified when provided</option>{profile.driver === 'postgresql' && <><option value="prefer">Prefer TLS · allow plaintext fallback</option><option value="allow">Prefer plaintext · allow TLS fallback</option></>}<option value="disable">Disabled</option></select></div>
          {profile.sslMode !== 'disable' && <>{(['caPath','certPath','keyPath'] as const).map((key,i)=><div className="form-row" key={key}><label htmlFor={key}>{['CA certificate file','Client certificate file','Client private key file'][i]}</label><input id={key} value={profile[key] ?? ''} placeholder="Optional absolute path on the extension host" onChange={event=>field(key,event.target.value)}/></div>)}</>}
          <div className="form-row"><label htmlFor="connectTimeout">Connect timeout (ms)</label><input id="connectTimeout" type="number" min={0} max={120000} value={profile.connectTimeout ?? 15000} onChange={event=>field('connectTimeout',Number(event.target.value))}/></div>
          <div className="form-row"><label htmlFor="applicationName">Application name</label><input id="applicationName" value={profile.applicationName??''} placeholder="DBNook" maxLength={255} onChange={event=>field('applicationName',event.target.value)}/></div>
        </>}
        {profile.storage === 'file' && <div className="form-row file-row"><label htmlFor="path">File <em>*</em></label><div><div className="file-input"><input id="path" value={profile.path} placeholder="Select a SQLite database file" required onChange={event => { const next={ ...profile, path: event.target.value, createIfMissing: false };update(next);cacheProfile(next);setNotice(undefined); }}/><Tool name="folder" label="Browse database files" onClick={() => void browse(false)}/></div><button type="button" className="text-button" onClick={() => void browse(true)}>Create a new database file…</button></div></div>}
        <div className="form-divider"/>
        <div className="form-row"><label htmlFor="group">Group</label><input id="group" value={profile.group} placeholder="Optional connection group" onChange={event => field('group', event.target.value)}/></div>
        <div className="form-row"><label htmlFor="scope">Save location</label><select id="scope" value={profile.scope} onChange={event => field('scope', event.target.value as ConnectionProfile['scope'])}><option value="global">Global settings · available everywhere</option><option value="workspace">Workspace settings · shared with this project</option></select></div>
        <div className="form-row"><label htmlFor="readOnly">Access</label><label className="checkbox-line"><input id="readOnly" type="checkbox" checked={profile.readOnly} onChange={event => field('readOnly', event.target.checked)}/>Read only<span className="muted">Protect this connection from writes</span></label></div>
        <div className="form-row"><label htmlFor="color">Connection color</label><div className="color-field"><input id="color" type="color" value={profile.color} onChange={event => field('color', event.target.value)}/><code>{profile.color}</code></div></div>
        </fieldset>
      </form>
      {notice && <Notice {...notice}/>}
      <footer className="connection-actions"><button disabled={Boolean(busy)} className="secondary" onClick={() => void act('test')}><Icon name="bolt"/>{busy === 'test' ? 'Testing…' : 'Test'}</button>{saved&&<button className="text-button" disabled={Boolean(busy)} onClick={()=>void reloadSaved()}>Reload saved settings</button>}<span className="action-spacer"/><button className="text-button" disabled={Boolean(busy)} onClick={() => { if(saved){void reloadSaved().then(()=>setStep('select'));}else{update(initial);setPassword(undefined);setStringInput('');setShowString(false);setState({});setStep('select');} }}>Cancel</button><button form="connection-form" disabled={Boolean(busy)} className="primary" type="submit">{busy === 'save' ? 'Saving…' : 'Save connection'}</button></footer>
    </section>}
    <p className="connection-footnote"><Icon name="database" size={13}/>{profile.driver === 'sqlite' ? 'SQLite connections run in an isolated local process.' : 'Connect directly from the extension host. Passwords are excluded from settings and exports.'}</p>
  </main>;
}

function DataWorkbench({ boot }: { boot: WorkbenchBoot }) {
  const grid = useRef<AgGridReact<GridRow>>(null);
  const initialStatement = [...(boot.run?.statements ?? [])].reverse().find(statement => statement.result);
  const [result, setResult] = useState<QueryResult | undefined>(initialStatement?.result ?? boot.result);
  const [run, setRun] = useState(boot.run); const [selectedResult, setSelectedResult] = useState(initialStatement?.index ?? -1);
  const runVersion = useRef({ id: boot.run?.id, count: boot.run?.statements.length ?? 0 });
  const [where, setWhere] = useState(boot.editor?.request.where ?? ''); const [appliedWhere, setAppliedWhere] = useState(boot.editor?.request.where ?? '');
  const [offset, setOffset] = useState(boot.editor?.request.offset ?? 0); const [limit, setLimit] = useState(boot.editor?.request.limit ?? 100);
  const tableOrder=useRef(boot.editor?.request.order??[]),tableLoading=useRef(false),restoringSort=useRef(false);
  const [search, setSearch] = useState(''); const [sql, setSql] = useState(boot.run?.sql ?? boot.result?.sql ?? (boot.profile.driver !== 'sqlite' ? 'SELECT version();' : 'SELECT sqlite_version();'));
  const [localBusy, setBusy] = useState(false); const [error, setError] = useState<string | undefined>(boot.run?.error); const [message, setMessage] = useState<string>();
  const [queryState, setQueryState] = useState(boot.query); const busy = localBusy || Boolean(queryState?.busy);
  const [side, setSide] = useState<'inspector' | 'columns' | 'export' | undefined>(); const [selected, setSelected] = useState<GridRow[]>([]);
  const [hidden, setHidden] = useState<string[]>([]); const [keys, setKeys] = useState<string[]>(boot.editor?.edits.keyColumns ?? boot.details?.columns.filter(c => c.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey).map(c => c.name) ?? []);
  const [history, setHistory] = useState<EditSnapshot[]>([boot.editor ? fromWireEdits(boot.editor.edits) : { edits: {}, added: [] }]); const [cursor, setCursor] = useState(0);
  const current = history[cursor]!; const dirty = Boolean(Object.keys(current.edits).length || current.added.length);
  const resultRef=useRef(result);resultRef.current=result;
  const clipboardBusy=useRef(false);
  const savingRequested=useRef(false);
  const [cellEditing,setCellEditing]=useState(false);
  const [pastePreview,setPastePreview]=useState<{changes:PasteChange[];next:EditSnapshot;draft:EditSnapshot;result:QueryResult}|undefined>();
  const draftRef = useRef(current), cursorRef = useRef(cursor); draftRef.current = current; cursorRef.current = cursor;
  const theme = useMemo(() => themeQuartz.withParams({ backgroundColor: 'var(--vscode-editor-background)', foregroundColor: 'var(--vscode-editor-foreground)', headerBackgroundColor: 'var(--vscode-editorWidget-background)', headerTextColor: 'var(--vscode-foreground)', borderColor: 'var(--vscode-panel-border)', accentColor: 'var(--vscode-focusBorder)', fontFamily: 'var(--vscode-font-family)', fontSize: 13, rowHeight: 33, headerHeight: 39, wrapperBorderRadius: 0, cellHorizontalPadding: 16, rowBorder: false }), []);
  const nativeEditor = useGridEditor(boot.editor, {
    stopEditing: () => { if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur(); grid.current?.api.stopEditing(); }, error: setError,
    apply: state => {
      grid.current?.api.stopEditing(true); setResult(state.result); const draft = fromWireEdits(state.edits); draftRef.current = draft; cursorRef.current = 0; setHistory([draft]); setCursor(0);
      setKeys(state.edits.keyColumns); setWhere(state.request.where); setAppliedWhere(state.request.where); setOffset(state.request.offset); setLimit(state.request.limit);
      tableOrder.current=state.request.order;restoreTableSort();
      setMessage(state.message); setError(state.error); setSelected([]); grid.current?.api.deselectAll();
    },
  });
  const canEdit = boot.view === 'table' && !result?.readOnly;
  const editingLocked = busy || Boolean(nativeEditor.state?.busy);
  useEffect(() => { if (!nativeEditor.enabled) void rpc({ method: 'view.dirty', params: { dirty } }).catch(() => {}); }, [dirty]);
  useEffect(() => onResult(value => { setResult(value as QueryResult); setError(undefined); clearEdits(); }), []);
  useEffect(() => onQueryState(setQueryState), []);
  function acceptRun(next: QueryRun) {
    const changed = runVersion.current.id !== next.id, grew = runVersion.current.count !== next.statements.length;
    if (changed) { setSql(next.sql); setError(undefined); setMessage(undefined); }
    if (changed || grew) { const latest = [...next.statements].reverse().find(statement => statement.result); setResult(latest?.result); setSelectedResult(latest?.index ?? -1); clearEdits(); }
    runVersion.current = { id: next.id, count: next.statements.length }; setRun(next);
    if (next.error) setError(next.error);
  }
  useEffect(() => onQueryRun(acceptRun), []);
  const selectResult = (index: number) => {
    setSelectedResult(index); setResult(run?.statements[index]?.result); clearEdits();
    void rpc({ method: 'query.result.select', params: { index } }).catch(reason => setError(errorMessage(reason)));
  };
  function clearEdits() { const draft = { edits: {}, added: [] }; draftRef.current = draft; cursorRef.current = 0; setHistory([draft]); setCursor(0); setSelected([]); grid.current?.api.deselectAll(); }
  function push(snapshot: EditSnapshot) { const nextCursor = cursorRef.current + 1; draftRef.current = snapshot; cursorRef.current = nextCursor; setHistory(previous => [...previous.slice(0, nextCursor), snapshot]); setCursor(nextCursor); setError(undefined); setMessage(undefined); nativeEditor.update(snapshot, keys); }
  const changeKeys = (next: string[]) => { setKeys(next); nativeEditor.keys(next); };
  const visibleColumns=()=> (grid.current?.api.getAllDisplayedColumns()??[]).flatMap(c=>result?.columns.filter(meta=>meta.key===c.getColId())??[]);
  function clipboardText(selectedRows=false){
      const api=grid.current?.api,cell=api?.getFocusedCell();
      const cols=visibleColumns();let values:CellValue[][]=[];
      if(selectedRows){const selectedIds=new Set(api?.getSelectedNodes().map(n=>n.id));api?.forEachNodeAfterFilterAndSort(node=>{if(node.data&&selectedIds.has(node.id))values.push(cols.map(c=>node.data![c.key]??null));});}
      else{const row=cell&&api?.getDisplayedRowAtIndex(cell.rowIndex)?.data,meta=cell&&result?.columns.find(c=>c.key===cell.column.getColId());if(row&&meta)values=[[row[meta.key]??null]];}
      if(!values.length)throw new Error(selectedRows?'Select rows to copy.':'Focus a data cell to copy.');
      return {text:copyGridValues(values),cells:values.reduce((n,r)=>n+r.length,0)};
  }
  async function copyClipboard(selectedRows=false){
    if(clipboardBusy.current||busy||pastePreview)return;
    clipboardBusy.current=true;
    try{
      await nativeEditor.synchronize();const copied=clipboardText(selectedRows);
      await rpc({method:'clipboard.write',params:{text:copied.text}});setMessage(`Copied ${copied.cells} cells as tab-separated text.`);setError(undefined);
    }catch(reason){setError(errorMessage(reason));}finally{clipboardBusy.current=false;}
  }
  async function pasteClipboard(text?:string){
    if(clipboardBusy.current||editingLocked||pastePreview)return;
    if(!canEdit){setError('This result is read-only.');return;}
    clipboardBusy.current=true;setBusy(true);
    try{
      await nativeEditor.synchronize();const api=grid.current?.api,cell=api?.getFocusedCell();
      if(!cell||!api)throw new Error('Focus the first target cell before pasting.');
      const columns=visibleColumns(),start=columns.findIndex(c=>c.key===cell.column.getColId());
      const sourceResult=resultRef.current!,draft=draftRef.current;
      const fields=parseGridClipboard(text??await rpc<string>({method:'clipboard.read',params:{}}));
      if(sourceResult!==resultRef.current||draft!==draftRef.current)throw new Error('The grid changed while reading the clipboard. Paste again.');
      if(start<0||start+fields[0]!.length>columns.length||cell.rowIndex+fields.length>api.getDisplayedRowCount())throw new Error('Paste exceeds the loaded rows or visible columns. Load the target range first.');
      const next:EditSnapshot={edits:structuredClone(draft.edits),added:draft.added.map(row=>({...row}))},changes:PasteChange[]=[];
      for(let y=0;y<fields.length;y++){
        const row:GridRow|undefined=api.getDisplayedRowAtIndex(cell.rowIndex+y)?.data;if(!row)throw new Error('Target row is no longer loaded.');
        const id=row[ROW_ID];
        for(let x=0;x<fields[y]!.length;x++){
          const column=columns[start+x]!,value=pastedCell(fields[y]![x]!,column,row[column.key]);
          changes.push({row:String(cell.rowIndex+y+1),column:column.name,before:row[column.key]??null,after:value});
          if(id.startsWith('new')){const target=next.added.find(r=>r[ROW_ID]===id);if(!target)throw new Error('The new row changed. Paste again.');target[column.key]=value;}
          else{const original=sourceResult.rows[Number(id.slice(1))]!;const values={...next.edits[id]?.values,[column.key]:value};if(JSON.stringify(value)===JSON.stringify(original[column.key]))delete values[column.key];if(Object.keys(values).length)next.edits[id]={kind:'update',original,values};else delete next.edits[id];}
        }
      }
      setPastePreview({changes,next,draft,result:sourceResult});setError(undefined);
    }catch(reason){setError(errorMessage(reason));}finally{clipboardBusy.current=false;setBusy(false);}
  }
  function applyPaste(){
    if(!pastePreview)return;
    if(editingLocked||pastePreview.draft!==draftRef.current||pastePreview.result!==resultRef.current){setPastePreview(undefined);setError('The grid changed after the paste preview. Paste again.');return;}
    push(pastePreview.next);setMessage(`Pasted ${pastePreview.changes.length} cells into the draft. Save to write to the database.`);setPastePreview(undefined);
  }
  const historyAction = (direction: 'undo' | 'redo') => { if (nativeEditor.enabled) void nativeEditor.action(direction).catch(reason => setError(errorMessage(reason))); else setCursor(cursor + (direction === 'undo' ? -1 : 1)); };
  const rows = useMemo<GridRow[]>(() => {
    const loaded = (result?.rows ?? []).map((row, index) => ({ ...row, ...current.edits[`r${index}`]?.values, [ROW_ID]: `r${index}` }));
    return [...loaded, ...current.added].filter(row => current.edits[row[ROW_ID]]?.kind !== 'delete');
  }, [result, current]);
  const updateCell = (row: GridRow, column: ColumnMeta, value: CellValue) => {
    if (column.generated || !canEdit || editingLocked) return;
    const current = draftRef.current;
    const id = row[ROW_ID];
    if (id.startsWith('new')) { push({ ...current, added: current.added.map(item => item[ROW_ID] === id ? { ...item, [column.key]: value } : item) }); return; }
    const original = result!.rows[Number(id.slice(1))]!;
    const values = { ...current.edits[id]?.values, [column.key]: value };
    if (JSON.stringify(value) === JSON.stringify(original[column.key])) delete values[column.key];
    const edits = { ...current.edits };
    if (Object.keys(values).length) edits[id] = { kind: 'update', original, values }; else delete edits[id];
    push({ ...current, edits });
  };
  const columns = useMemo<ColDef<GridRow>[]>(() => (result?.columns ?? []).map(column => ({
    field: column.key, headerName: `${column.primaryKey ? '⚿ ' : ''}${column.name}`, headerTooltip: `${column.name} · ${column.dataType || 'dynamic'}`,
    hide: hidden.includes(column.key), minWidth: 145, flex: 1, sortable: !editingLocked, filter: true, resizable: true,
    // A table is paged by the database: preserve the returned order instead of sorting this page again.
    comparator:boot.view==='table'?()=>0:undefined,
    editable: params => { const value = params.data?.[column.key]; return canEdit && !editingLocked && !column.generated && !(typeof value === 'object' && value?.type === 'binary'); },
    cellEditor: RawCellEditor,
    valueFormatter: params => displayCell(params.value as CellValue),
    valueParser: params => { try { return params.newValue===params.oldValue?params.oldValue:parseCell(String(params.newValue ?? ''), column, params.oldValue as CellValue); } catch (error) { setError(errorMessage(error)); return params.oldValue; } },
    cellClassRules: { 'cell-null': params => params.value === null, 'cell-modified': params => Boolean(params.data && (params.data[ROW_ID].startsWith('new') || column.key in (current.edits[params.data[ROW_ID]]?.values ?? {}))) },
  })), [result?.columns, canEdit, editingLocked, hidden, current.edits]);
  function restoreTableSort(){
    if(boot.view!=='table'||!grid.current?.api)return;
    restoringSort.current=true;
    try{grid.current.api.applyColumnState({state:(result?.columns??[]).map(column=>{
      const index=tableOrder.current.findIndex(item=>item.column===column.name);
      return {colId:column.key,sort:index<0?null:tableOrder.current[index]!.direction,sortIndex:index<0?null:index};
    })});}finally{restoringSort.current=false;}
  }
  function sortTable(){
    if(boot.view!=='table'||restoringSort.current||tableLoading.current)return;
    const order=(grid.current?.api.getColumnState()??[]).filter(column=>column.sort).sort((a,b)=>(a.sortIndex??0)-(b.sortIndex??0)).flatMap(column=>{
      const meta=result?.columns.find(c=>c.key===column.colId);
      return meta&&column.sort?[{column:meta.name,direction:column.sort}]:[];
    });
    if(JSON.stringify(order)!==JSON.stringify(tableOrder.current))void load(0,appliedWhere,order);
  }
  const discard = async () => !(Object.keys(draftRef.current.edits).length||draftRef.current.added.length) || await rpc<boolean>({ method: 'confirm.discard', params: {} });
  const load = async (nextOffset = offset, nextWhere = appliedWhere, nextOrder=tableOrder.current, nextLimit=limit) => {
    if (busy||tableLoading.current) {restoreTableSort();return;}
    tableLoading.current=true;setBusy(true);
    try {
      await nativeEditor.synchronize();
      if(!await discard())return;
      setError(undefined);setMessage(undefined);
      const next = await rpc<QueryResult>({ method: 'table.load', params: { table: boot.table!, where: nextWhere, order:nextOrder, offset: nextOffset, limit:nextLimit } });
      tableOrder.current=nextOrder;setResult(next); setOffset(nextOffset); setAppliedWhere(nextWhere);setLimit(nextLimit); clearEdits();
    } catch (error) { setError(errorMessage(error)); } finally { restoreTableSort();tableLoading.current=false;setBusy(false); }
  };
  const execute = async () => {
    if (busy) return; setBusy(true); setError(undefined); setMessage(undefined);
    try { acceptRun(await rpc<QueryRun>({ method: 'query.run', params: { sql, limit: 100000 } })); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  };
  const transaction = async (action: 'begin' | 'commit' | 'rollback') => {
    if (busy) return; setBusy(true); setError(undefined);
    try { await rpc({ method: 'query.transaction', params: { action } }); setMessage(action === 'begin' ? 'Transaction started for this SQL document.' : action === 'commit' ? 'Transaction committed.' : 'Transaction rolled back.'); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (busy || savingRequested.current) return;
    savingRequested.current=true;
    try {
      // Commit the input before locking editable cells or reading the draft snapshot.
      await nativeEditor.synchronize();
      const snapshot=draftRef.current;
      if(!Object.keys(snapshot.edits).length&&!snapshot.added.length)return;
      if (!keys.length && Object.keys(snapshot.edits).length) { setSide('columns'); setError('Choose key columns that uniquely identify each row before saving.'); return; }
      setBusy(true); setError(undefined);
      if (nativeEditor.enabled) { await nativeEditor.action('save'); return; }
      const changes = [...Object.values(snapshot.edits), ...snapshot.added.map(row => ({ kind: 'insert' as const, values: Object.fromEntries(Object.entries(row)) }))];
      const report = await rpc<{ affectedRows: number }>({ method: 'table.apply', params: { table: boot.table!, keyColumns: keys, changes } });
      clearEdits(); setResult(await rpc<QueryResult>({ method: 'table.load', params: { table: boot.table!, where: appliedWhere, order: tableOrder.current, offset, limit } }));
      setMessage(`${report.affectedRows} row${report.affectedRows === 1 ? '' : 's'} saved to the database.`);
    } catch (error) { setError(errorMessage(error)); } finally { savingRequested.current=false;setBusy(false); }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if(pastePreview){if((event.ctrlKey||event.metaKey)&&['s','z','y'].includes(event.key.toLowerCase())){event.preventDefault();event.stopPropagation();}return;}
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save(); }
      if (nativeEditor.enabled && (event.ctrlKey || event.metaKey) && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); historyAction(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo'); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && boot.view === 'query') { event.preventDefault(); void execute(); }
    };
    // AG Grid can consume the editor key event; Save must run before its bubbling handlers.
    window.addEventListener('keydown', handler, true); return () => window.removeEventListener('keydown', handler, true);
  });
  const addRow = () => { if (editingLocked) return; const current = draftRef.current; push({ ...current, added: [...current.added, { [ROW_ID]: `new${Date.now()}-${current.added.length}` }] }); };
  const deleteRows = () => {
    if (editingLocked) return; const current = draftRef.current;
    const edits = { ...current.edits }; const ids = new Set(selected.map(row => row[ROW_ID]));
    for (const row of selected) if (!row[ROW_ID].startsWith('new')) edits[row[ROW_ID]] = { kind: 'delete', original: result!.rows[Number(row[ROW_ID].slice(1))]!, values: {} };
    push({ edits, added: current.added.filter(row => !ids.has(row[ROW_ID])) }); setSelected([]);
  };
  return <main className="workbench">
    {boot.view === 'query' && <section className="sql-area"><div className="sql-heading"><span>SQL QUERY</span><span>{boot.profile.name} / {boot.profile.database ?? 'main'}</span></div><textarea spellCheck={false} aria-label="SQL query" value={sql} onChange={event => setSql(event.target.value)}/></section>}
    {boot.view === 'query' && queryState && <div className="query-session"><span role="status" className={queryState.transaction === 'active' ? 'transaction-active' : 'muted'}>{busy ? 'Running…' : queryState.lost ? 'Session lost · reset to continue' : queryState.transaction === 'active' ? 'Transaction active · changes are uncommitted' : queryState.connected ? 'Autocommit' : 'Session not opened'}</span><div className="query-session-actions"><button disabled={busy || queryState.transaction === 'active' || queryState.lost} onClick={() => void transaction('begin')}>Begin</button><button disabled={busy || queryState.transaction !== 'active'} onClick={() => void transaction('commit')}>Commit</button><button disabled={busy || queryState.transaction !== 'active'} onClick={() => void transaction('rollback')}>Roll Back</button><button disabled={busy} onClick={() => { void rpc<boolean>({ method: 'query.reset', params: {} }).then(reset => { if (reset) { setMessage('Document session reset.'); setError(undefined); } }).catch(reason => setError(errorMessage(reason))); }}>Reset Session</button></div></div>}
    {boot.view === 'query' && run && <section className="query-run" aria-label="SQL run"><div className="run-summary"><strong>Run · {run.status}</strong><span>{run.statements.filter(statement => statement.status === 'succeeded').length} completed · {run.durationMs} ms</span>{run.status === 'failed' && <span className="warning">Stopped at first error · earlier statements may have taken effect</span>}</div><div className="result-tabs" role="tablist" aria-label="Statement results">{run.statements.map(statement => <button role="tab" aria-selected={selectedResult === statement.index} title={statement.sql} key={statement.index} onClick={() => selectResult(statement.index)}><span className={statement.status === 'failed' ? 'warning' : ''}>#{statement.index + 1}</span>{statement.status === 'failed' ? 'Failed' : statement.result?.columns.length ? `${statement.result.rows.length} rows${statement.result.truncated ? '+' : ''}` : `${statement.result?.affectedRows ?? 0} affected`}</button>)}</div></section>}
    <div className="workbench-toolbar">
      <Tool name={boot.view === 'query' ? 'play' : 'refresh'} label={boot.view === 'query' ? 'Execute SQL (Ctrl+Enter)' : 'Refresh table'} disabled={busy} onClick={() => { void (boot.view === 'query' ? execute() : load()); }}/>
      <Tool name="stop" label="Cancel running query" disabled={!busy} onClick={() => { void rpc({ method: 'query.cancel', params: {} }).catch(error => setError(errorMessage(error))); }}/>
      <span className="tool-separator"/>
      {canEdit && <><Tool name="save" label="Save changes (Ctrl+S)" disabled={busy || (!dirty && !cellEditing)} onClick={() => void save()}/><Tool name="undo" label="Undo edit" disabled={busy || (nativeEditor.enabled ? !nativeEditor.state?.canUndo : !cursor)} onClick={() => historyAction('undo')}/><Tool name="redo" label="Redo edit" disabled={busy || (nativeEditor.enabled ? !nativeEditor.state?.canRedo : cursor === history.length - 1)} onClick={() => historyAction('redo')}/><span className="tool-separator"/><Tool name="plus" label="Add row" disabled={busy} onClick={addRow}/><Tool name="minus" label="Delete selected rows" disabled={busy || !selected.length} onClick={deleteRows}/><span className="tool-separator"/></>}
      <Tool name="download" label="Export data" disabled={!result || busy} onClick={() => setSide(side === 'export' ? undefined : 'export')}/>
      <button className="text-button" disabled={busy||!result} onClick={()=>void copyClipboard()}>Copy cell</button><button className="text-button" disabled={busy||!selected.length} onClick={()=>void copyClipboard(true)}>Copy rows</button>{boot.view==='table'&&<button className="text-button" disabled={editingLocked||!canEdit} onClick={()=>void pasteClipboard()}>Paste</button>}
      {boot.view === 'table' && <form className="where-filter" onSubmit={event => { event.preventDefault(); void load(0, where); }}><label htmlFor="where">WHERE</label><input id="where" value={where} onChange={event => setWhere(event.target.value)} placeholder="SQL filter (e.g., status = 'Active')"/><button className="tool" type="submit" disabled={busy} aria-label="Apply WHERE filter"><Icon name="check"/></button></form>}
      <div className="quick-search"><Icon name="search"/><input aria-label="Quick Search loaded rows" placeholder="Quick Search" title="Search loaded rows only" value={search} onChange={event => setSearch(event.target.value)}/></div>
    </div>
    {error && <Notice message={error}/>}{message && <Notice message={message} success/>}
    {pastePreview&&<PastePreview changes={pastePreview.changes} cancel={()=>setPastePreview(undefined)} apply={applyPaste}/>}
    <div className="data-body"><div className="grid-shell" onCopyCapture={event=>{
      if((event.target as Element).closest('input,textarea,[contenteditable="true"]')||pastePreview)return;
      event.preventDefault();event.stopPropagation();
      try{const copied=clipboardText();event.clipboardData.setData('text/plain',copied.text);setMessage(`Copied ${copied.cells} cells as tab-separated text.`);setError(undefined);}catch(reason){setError(errorMessage(reason));}
    }} onPasteCapture={event=>{
      if((event.target as Element).closest('input,textarea,[contenteditable="true"]')||pastePreview)return;
      event.preventDefault();event.stopPropagation();void pasteClipboard(event.clipboardData.getData('text/plain'));
    }}>
      {result ? <AgGridReact<GridRow> ref={grid} theme={theme} rowData={rows} columnDefs={columns} getRowId={params => params.data[ROW_ID]} rowSelection={{ mode: 'multiRow', checkboxes: false, headerCheckbox: false, enableClickSelection: true }} readOnlyEdit suppressFieldDotNotation onCellEditingStarted={()=>setCellEditing(true)} onCellEditingStopped={()=>setCellEditing(false)} singleClickEdit={false} stopEditingWhenCellsLoseFocus quickFilterText={search} onGridReady={restoreTableSort} onSortChanged={sortTable} onSelectionChanged={event => setSelected(event.api.getSelectedRows())} onCellEditRequest={(event: CellEditRequestEvent<GridRow>) => { const column = result.columns.find(c => c.key === event.colDef.field); if (event.data && column) updateCell(event.data, column, event.newValue as CellValue); }} overlayNoRowsTemplate="<span>No rows to display</span>"/> : <div className="empty-data"><Icon name="database" size={36}/><p>Run a query to see its results.</p></div>}
    </div>
      <nav className="side-tabs" aria-label="Data panels"><button className={side === 'columns' ? 'active' : ''} onClick={() => setSide(side === 'columns' ? undefined : 'columns')}><Icon name="columns"/>Columns</button><button className={side === 'inspector' ? 'active' : ''} onClick={() => setSide(side === 'inspector' ? undefined : 'inspector')}><Icon name="inspect"/>Inspector</button><button className={side === 'export' ? 'active' : ''} onClick={() => setSide(side === 'export' ? undefined : 'export')}><Icon name="download"/>Export</button></nav>
      {side && <aside className="detail-panel"><div className="detail-heading"><strong>{side === 'columns' ? 'Columns' : side === 'inspector' ? 'Row inspector' : 'Export data'}</strong><Tool name="close" label="Close panel" onClick={() => setSide(undefined)}/></div>
        {side === 'columns' && <><p className="panel-hint">Choose visible columns. Key columns identify rows for updates and deletes.</p>{result?.columns.map(column => <div className="column-control" key={column.key}><label className="checkbox-line"><input type="checkbox" checked={!hidden.includes(column.key)} onChange={event => setHidden(event.target.checked ? hidden.filter(key => key !== column.key) : [...hidden, column.key])}/><span>{column.name}<small>{column.dataType}</small></span></label>{canEdit && <label className="key-toggle" title="Use as key column"><input aria-label={`Use ${column.name} as key`} type="checkbox" checked={keys.includes(column.name)} onChange={event => changeKeys(event.target.checked ? [...keys, column.name] : keys.filter(key => key !== column.name))}/><Icon name="key"/></label>}</div>)}</>}
        {side === 'inspector' && (selected[0] ? <><p className="panel-hint">{selected.length > 1 ? `${selected.length} rows selected · showing first` : 'Selected row'}</p>{result?.columns.map(column => <div className="inspector-field" key={column.key}><label htmlFor={`inspector-${column.key}`}>{column.name}<small>{column.dataType}</small></label><textarea id={`inspector-${column.key}`} key={`${selected[0]![ROW_ID]}:${column.key}:${JSON.stringify(selected[0]![column.key])}`} defaultValue={editableCell(selected[0]![column.key])} readOnly={!canEdit || column.generated || editingLocked} onBlur={event => { if (!canEdit || column.generated || event.target.value === editableCell(selected[0]![column.key])) return; try { updateCell(selected[0]!, column, parseCell(event.target.value, column, selected[0]![column.key])); } catch (error) { setError(errorMessage(error)); } }}/>{canEdit && column.nullable && !column.generated && <button className="text-button" disabled={editingLocked} onClick={() => updateCell(selected[0]!, column, null)}>Set NULL</button>}</div>)}</> : <p className="panel-hint">Select a row to inspect its values.</p>)}
        {side === 'export' && <><p className="panel-hint">Export {result?.rows.length ?? 0} loaded rows. Unloaded rows and unsaved changes are excluded.</p>{result?.truncated && <p className="panel-hint warning">This result was truncated. Increase the row limit to export more data.</p>}<button className="export-option" onClick={() => { void rpc({ method: 'file.export', params: { format: 'csv' } }).then(value => { if (value) setMessage('CSV exported.'); }).catch(error => setError(errorMessage(error))); }}><Icon name="download"/><span>CSV<small>Comma-separated values</small></span></button><button className="export-option" onClick={() => { void rpc({ method: 'file.export', params: { format: 'json' } }).then(value => { if (value) setMessage('JSON exported.'); }).catch(error => setError(errorMessage(error))); }}><Icon name="download"/><span>JSON<small>Typed rows with column metadata</small></span></button></>}
        {side==='export'&&boot.view==='table'&&<><p className="panel-hint">All saved rows · new read-only snapshot, independent of this page and local filters.</p>{(['csv','json']as const).map(format=><button key={format} className="export-option" onClick={()=>void rpc({method:'data.exportAll',params:{format}}).catch(e=>setError(errorMessage(e)))}><Icon name="download"/><span>Full table · {format.toUpperCase()}</span></button>)}<button className="export-option" disabled={dirty} onClick={()=>void rpc({method:'data.openImport',params:{}}).catch(e=>setError(errorMessage(e)))}><Icon name="plus"/><span>Import CSV / JSON<small>Map and validate before inserting</small></span></button></>}
      </aside>}
    </div>
    <footer className="data-status"><span className={`connection-dot ${busy ? 'busy' : ''}`}/><span>{busy ? 'Executing…' : `Rows: ${result?.rows.length ?? 0}`}</span><span className="muted">{result?.durationMs ?? 0} ms</span>{result?.affectedRows ? <span>{result.affectedRows} rows affected</span> : null}{dirty && <span className="dirty-status">{Object.keys(current.edits).length + current.added.length} unsaved changes</span>}{result?.truncated && <span className="warning">Row limit reached</span>}<span className="action-spacer"/>{boot.view === 'table' && <><span className="muted">Page {Math.floor(offset / limit) + 1}</span><button disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - limit))} aria-label="Previous page">‹</button><button disabled={busy || !result?.truncated} onClick={() => void load(offset + limit)} aria-label="Next page">›</button><select aria-label="Rows per page" value={limit} disabled={busy} onChange={event => void load(0,appliedWhere,tableOrder.current,Number(event.target.value))}>{[100, 200, 500, 1000, 10000].map(value => <option key={value} value={value}>{value} rows</option>)}</select></>}<span className="read-mode">{canEdit ? 'EDITABLE' : 'READ ONLY'}</span></footer>
  </main>;
}
function App() {
  const [boot, setBoot] = useState<WorkbenchBoot>(); const [error, setError] = useState<string>();
  useEffect(() => { void rpc<WorkbenchBoot>({ method: 'initialize', params: {} }).then(setBoot).catch(error => setError(errorMessage(error))); }, []);
  if (error) return <main className="boot-state"><Icon name="database" size={32}/><h1>Unable to open this view</h1><Notice message={error}/><button className="secondary" onClick={() => { setError(undefined); void rpc<WorkbenchBoot>({ method: 'initialize', params: {} }).then(setBoot).catch(error => setError(errorMessage(error))); }}>Retry</button><a href="command:dbWorkbench.collectDiagnostics">Open diagnostic report</a><a href="command:dbWorkbench.showOutput">Show output</a></main>;
  if (!boot) return <main className="boot-state"><span className="spinner"/><p>Loading database workspace…</p></main>;
  if(boot.view==='sql-parameters')return <SqlParameters boot={boot}/>;
  if(boot.view==='query-plan')return <QueryPlan boot={boot}/>;
  return boot.view==='combination'?<CombinationEditor boot={boot}/>:boot.view==='comparison'?<ComparisonEditor boot={boot}/>:boot.view==='server-backup'?<ServerBackup boot={boot}/>:boot.view==='sqlite-backup'?<SqliteBackup boot={boot}/>:boot.view==='data-import'?<DataImport boot={boot}/>:boot.view==='structure'?<StructureEditor boot={boot}/>:boot.view==='authentication'||boot.view==='tunnel'?<ResourceEditor boot={boot}/>:boot.view === 'connections-import' ? <ConnectionsImport boot={boot}/> : boot.view === 'connection' ? <ConnectionEditor profile={boot.profile} editor={boot.connectionEditor} resources={boot.resources}/> : <DataWorkbench boot={boot}/>;
}
class RenderBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(error:Error){reportFrontend('webview.react.render',error,true);}
  render(){return this.state.failed?<main className="boot-state"><h1>View failed to render</h1><p>Use DBNook: Collect Diagnostic Report.</p></main>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(<RenderBoundary><App/></RenderBoundary>);
