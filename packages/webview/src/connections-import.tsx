import {defaultPort} from '../../protocol/src/index.js';
import { useState } from 'react';
import { IMPORT_FIELDS, errorMessage, type ImportAction, type ImportField, type ImportFormat, type ImportPreview, type ImportReport, type WorkbenchBoot } from '../../protocol/src/index.js';
import { rpc } from './bridge.js';
import './connections-import.css';

export function ConnectionsImport({ boot }: { boot: WorkbenchBoot }) {
  const [text, setText] = useState(''), [format, setFormat] = useState<ImportFormat>('json');
  const [filename, setFilename] = useState<string>(), [sourceDirectory, setSourceDirectory] = useState<string>();
  const [delimiter, setDelimiter] = useState<',' | ';' | '\t'>(','), [headers, setHeaders] = useState<string[]>();
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>>>();
  const [pathBase, setPathBase] = useState<'workspace' | 'source'>('workspace'), [scope, setScope] = useState<'global' | 'workspace'>('global');
  const [preview, setPreview] = useState<ImportPreview>(), [actions, setActions] = useState<Record<number, ImportAction>>({});
  const [report, setReport] = useState<ImportReport>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [rememberPasswords,setRememberPasswords]=useState(false);
  const [page, setPage] = useState(0); const pageSize = 100;
  const invalidate = () => { setPreview(undefined); setReport(undefined); setPage(0); setError(undefined); };
  const inspect = async () => {
    const value = await rpc<{ headers: string[]; mapping: Partial<Record<ImportField, number>> }>({ method: 'connections.import.inspect', params: { text, delimiter } });
    setHeaders(value.headers); setMapping(value.mapping); return value.mapping;
  };
  const chooseFile = async () => {
    setBusy(true); setError(undefined);
    try {
      const file = await rpc<{ filename: string; text: string; format: ImportFormat; sourceDirectory: string } | null>({ method: 'connections.import.pick', params: {} });
      if (!file) return; invalidate(); setText(file.text); setFormat(file.format); setFilename(file.filename); setSourceDirectory(file.sourceDirectory); setPathBase('source'); setHeaders(undefined); setMapping(undefined);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  const review = async () => {
    setBusy(true); setError(undefined); setReport(undefined);
    try {
      const fields = format === 'csv' ? mapping ?? await inspect() : undefined;
      const value = await rpc<ImportPreview>({ method: 'connections.import.preview', params: { text, format, delimiter, mapping: fields, pathBase } });
      setPreview(value); setHeaders(value.headers); setMapping(value.mapping); setActions(Object.fromEntries(value.rows.map(row => [row.index, row.action]))); setPage(0);
    } catch (reason) { setPreview(undefined); setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return; setBusy(true); setError(undefined);
    try { setReport(await rpc<ImportReport>({ method: 'connections.import.apply', params: { token: preview.token, scope, rememberPasswords,decisions: preview.rows.map(row => ({ index: row.index, action: actions[row.index] ?? 'skip' })) } })); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  const selected = preview?.rows.filter(row => row.profile && actions[row.index] !== 'skip').length ?? 0;
  const rows = report?.rows ?? preview?.rows; const totalPages = Math.max(1, Math.ceil((rows?.length ?? 0) / pageSize));
  return <main className="connections-import">
    <header className="import-heading"><span className="muted">Connections / Import</span><h1>Import connections</h1><p>Load JSON or map CSV fields, review every connection, then choose what to import.</p></header>
    <section className="import-source" aria-label="Connection import source"><div className="import-source-toolbar"><button className="secondary" disabled={busy} onClick={() => void chooseFile()}>Choose File…</button><span className="muted">{filename ?? 'Or paste connection settings below'}</span><span className="action-spacer"/><label>Format <select aria-label="Connection import format" disabled={busy} value={format} onChange={event => { setFormat(event.target.value as ImportFormat); setHeaders(undefined); setMapping(undefined); invalidate(); }}><option value="json">JSON</option><option value="csv">CSV</option></select></label>{format === 'csv' && <label>Delimiter <select aria-label="CSV delimiter" disabled={busy} value={delimiter} onChange={event => { setDelimiter(event.target.value as typeof delimiter); setHeaders(undefined); setMapping(undefined); invalidate(); }}><option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option></select></label>}</div>
      <textarea aria-label="Connection file contents" spellCheck={false} readOnly={busy} value={text} onChange={event => { setText(event.target.value); setHeaders(undefined); setMapping(undefined); invalidate(); }} placeholder={'{"connections": [{"name": "Local SQLite", "storage": "file", "path": "D:/data/example.db"}]}'} />
      <div className="import-locations"><label>Resolve relative paths from <select aria-label="Relative path base" value={pathBase} disabled={busy} onChange={event => { setPathBase(event.target.value as typeof pathBase); invalidate(); }}><option value="workspace">Workspace folder</option><option value="source" disabled={!sourceDirectory}>Source file folder</option></select></label><code>{pathBase === 'source' ? sourceDirectory : boot.transfer?.workspaceDirectory ?? 'No workspace — use absolute paths'}</code></div>
    </section>
    {format === 'csv' && <section className="import-mapping" aria-label="CSV field mapping"><div className="import-section-title"><h2>Map CSV fields</h2><button className="text-button" disabled={busy || !text.trim()} onClick={() => { invalidate(); setBusy(true); void inspect().catch(reason => setError(errorMessage(reason))).finally(() => setBusy(false)); }}>Read columns</button></div>{headers ? <div className="import-field-grid">{IMPORT_FIELDS.map(field => <label key={field}>{field}<select aria-label={`CSV column for ${field}`} disabled={busy} value={mapping?.[field] ?? -1} onChange={event => { const value = Number(event.target.value), next = { ...mapping }; if (value < 0) delete next[field]; else next[field] = value; setMapping(next); invalidate(); }}><option value={-1}>Not mapped</option>{headers.map((header, index) => <option key={index} value={index}>{index + 1}. {header || '(empty header)'}</option>)}</select></label>)}</div> : <p className="muted">Read the header to assign columns. Unmapped columns are reported in the preview.</p>}</section>}
    <div className="import-review-actions"><button className="secondary" disabled={busy || !text.trim()} onClick={() => void review()}>{busy && !preview ? 'Reading…' : 'Preview connections'}</button><label>Save selected profiles in <select aria-label="Imported connection scope" disabled={busy || Boolean(report)} value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="global">Global settings</option><option value="workspace" disabled={!boot.transfer?.workspaceAvailable}>Workspace settings</option></select></label><span className="muted">Preview does not connect to databases.</span></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {preview?.rows.some(row=>row.hasPassword)&&!report&&<label className="checkbox-line"><input type="checkbox" checked={rememberPasswords} disabled={busy} onChange={event=>setRememberPasswords(event.target.checked)}/>Remember imported passwords in VS Code secure storage<span className="muted">Unchecked: keep them only for this extension session.</span></label>}
    {preview && <section className="import-preview" aria-label="Connection import preview"><div className="import-section-title"><h2>{report ? 'Import report' : 'Review connections'}</h2><span className="muted">{preview.rows.length} records · {preview.rows.filter(row => row.errors.length).length} invalid</span><span className="action-spacer"/>{!report && <><button className="text-button" disabled={busy} onClick={() => setActions(Object.fromEntries(preview.rows.map(row => [row.index, 'skip'])))}>Skip all</button><button className="text-button" disabled={busy} onClick={() => setActions(Object.fromEntries(preview.rows.map(row => [row.index, row.action])))}>Select valid rows</button></>}</div>
      {report && <div className="notice success" role="status">{report.rows.filter(row => row.status === 'created').length} created · {report.rows.filter(row => row.status === 'replaced').length} replaced · {report.rows.filter(row => row.status === 'skipped' || row.status === 'invalid').length} skipped · {report.rows.filter(row => row.status === 'failed').length} failed</div>}
      <div className="import-table-scroll"><table><thead><tr><th>Row</th><th>Name</th><th>Database / details</th><th>{report ? 'Result' : 'Action'}</th></tr></thead><tbody>{preview.rows.slice(page * pageSize, (page + 1) * pageSize).map(row => {
        const result = report?.rows.find(result => result.index === row.index);
        return <tr key={row.index}><td>{row.index + 1}</td><td>{row.name}{row.exists && <small>Existing ID</small>}</td><td><code>{row.profile?.driver!=='sqlite'&&row.profile?.storage==='server'?`${row.profile.user}@${row.profile.host}:${row.profile.port??defaultPort(row.profile.driver)}/${row.profile.database??''}`:row.profile?.storage === 'memory' ? ':memory:' : row.profile?.path ?? 'Invalid connection'}</code>{row.hasPassword&&<small>Password included · value hidden</small>}{row.profile?.readOnly && <small>Read only</small>}{row.errors.map((message, index) => <p className="import-error" key={index}>{message}</p>)}{row.warnings.map((message, index) => <p className="warning" key={index}>{message}</p>)}{result?.message && <p className={result.status === 'failed' ? 'import-error' : 'muted'}>{result.message}</p>}</td><td>{report ? <strong>{result?.status}</strong> : <select aria-label={`Import action for row ${row.index + 1}`} disabled={busy || !row.profile} value={actions[row.index] ?? 'skip'} onChange={event => setActions({ ...actions, [row.index]: event.target.value as ImportAction })}>{!row.exists && <option value="create">Create</option>}<option value="copy">Create copy</option>{row.exists && <option value="replace">Replace existing</option>}<option value="skip">Skip</option></select>}</td></tr>;
      })}</tbody></table></div>
      <footer className="import-footer"><span className="muted">Page {page + 1} / {totalPages}</span><button disabled={busy || !page} onClick={() => setPage(page - 1)}>Previous</button><button disabled={busy || page + 1 >= totalPages} onClick={() => setPage(page + 1)}>Next</button><span className="action-spacer"/>{!report && <button className="primary" disabled={busy || !selected} onClick={() => void apply()}>{busy ? 'Importing…' : `Import ${selected} ${selected === 1 ? 'connection' : 'connections'}`}</button>}</footer>
    </section>}
  </main>;
}
