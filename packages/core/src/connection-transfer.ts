import { createHash, randomUUID } from 'node:crypto';
import { IMPORT_FIELDS, ProfileSchema, type ConnectionProfile, type ImportAction, type ImportField, type ImportFormat, type ImportPreview, type ImportReport, type ImportRow } from '../../protocol/src/index.js';
import type { ConnectionManager } from './connections.js';
import { parseConnectionString, type PathContext } from './connection-strings.js';

export interface ImportOptions extends PathContext { delimiter?: ',' | ';' | '\t'; mapping?: Partial<Record<ImportField, number>>; }
const MAX_ROWS = 10000, MAX_BYTES = 5_000_000;
const fingerprint = (profiles: ConnectionProfile[]) => createHash('sha256').update(JSON.stringify([...profiles].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
function csvCell(value: unknown): string { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function exportConnections(profiles: ConnectionProfile[], format: ImportFormat): string {
  const values = profiles.map(profile => ProfileSchema.parse(profile));
  if (format === 'json') return JSON.stringify({ format: 'db-workbench.connections', version: 1, connections: values }, null, 2) + '\n';
  const fields = IMPORT_FIELDS.filter(field => field !== 'connectionString'&&field!=='password');
  return '\uFEFF' + [fields.join(','), ...values.map(profile => fields.map(field => csvCell(profile[field as keyof ConnectionProfile])).join(','))].join('\r\n') + '\r\n';
}
export function parseConnectionCsv(text: string, delimiter: ',' | ';' | '\t' = ','): string[][] {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Connection imports are limited to 5 MB.');
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, afterQuote = false;
  const endRow = () => { row.push(field); if (row.some(value => value.length)) rows.push(row); row = []; field = ''; afterQuote = false; if (rows.length > MAX_ROWS + 1) throw new Error('Import at most 10,000 connections at a time.'); };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') { if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; afterQuote = true; } }
      else field += character;
      continue;
    }
    if (afterQuote && character !== delimiter && character !== '\r' && character !== '\n') throw new Error('Unexpected text after a quoted CSV field.');
    if (character === '"') { if (field) throw new Error('Quote CSV fields that contain quotation marks.'); quoted = true; }
    else if (character === delimiter) { row.push(field); field = ''; afterQuote = false; }
    else if (character === '\r' || character === '\n') { if (character === '\r' && text[index + 1] === '\n') index++; endRow(); }
    else field += character;
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.');
  if (field || row.length || afterQuote) endRow();
  if (!rows.length) throw new Error('The connection file is empty.');
  return rows;
}
const normalized = (value: string) => value.toLowerCase().replace(/[\s_-]/g, '');
export function mapConnectionHeaders(headers: string[]): Partial<Record<ImportField, number>> {
  const aliases: Partial<Record<ImportField, string[]>> = { name: ['name', 'connectionname'], driver: ['driver', 'type'], storage: ['storage', 'storagetype'], path: ['path', 'file', 'filename', 'databasefile'], connectionString: ['connectionstring', 'url', 'uri'], readOnly: ['readonly'], createIfMissing: ['createifmissing'], group: ['group'], color: ['color'], scope: ['scope'], id: ['id'] };
  return Object.fromEntries(IMPORT_FIELDS.flatMap(field => { const index = headers.findIndex(header => (aliases[field] ?? [normalized(field)]).includes(normalized(header))); return index < 0 ? [] : [[field, index]]; }));
}
function booleanValue(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (['true', '1', 'yes'].includes(String(value).toLowerCase())) return true;
  if (['false', '0', 'no'].includes(String(value).toLowerCase())) return false;
  throw new Error(`${field} must be true/false, yes/no or 1/0.`);
}
function jsonRows(text: string): unknown[] {
  let value: unknown; try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('The connection file is not valid JSON.'); }
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object' || !value) throw new Error('Use a connection array or a connections export object.');
  const object = value as Record<string, unknown>;
  if (object.format && (object.format !== 'db-workbench.connections' || object.version !== 1)) throw new Error('This connection export format or version is not supported.');
  const rows = object.connections ?? object['dbWorkbench.connections'];
  if (!Array.isArray(rows)) throw new Error('The JSON needs a connections array.'); return rows;
}
export function previewConnections(text: string, format: ImportFormat, existing: ConnectionProfile[], options: ImportOptions = {}, capturePassword?: (index:number,password:string)=>void): Omit<ImportPreview, 'token'> {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Connection imports are limited to 5 MB.');
  let headers: string[] | undefined, mapping: Partial<Record<ImportField, number>> | undefined, rawRows: unknown[];
  if (format === 'json') rawRows = jsonRows(text);
  else {
    const rows = parseConnectionCsv(text, options.delimiter); headers = rows[0]!; mapping = options.mapping ?? mapConnectionHeaders(headers);
    const columns = Object.entries(mapping);
    if (columns.some(([field, index]) => !IMPORT_FIELDS.includes(field as ImportField) || !Number.isInteger(index) || index! < 0 || index! >= headers!.length)) throw new Error('Choose valid CSV columns for the field mapping.');
    if (new Set(columns.map(([, index]) => index)).size !== columns.length) throw new Error('A CSV column cannot be mapped to more than one connection field.');
    if (!columns.some(([field]) => ['path','connectionString','storage','host'].includes(field))) throw new Error('Map a path, connection string, host or storage column before importing.');
    rawRows = rows.slice(1).map(row => row.length !== headers!.length ? { __csvError: 'The CSV row has a different number of columns than its header.' } : Object.fromEntries(columns.map(([field, index]) => [field, row[index!]!])));
  }
  if (rawRows.length > MAX_ROWS) throw new Error('Import at most 10,000 connections at a time.');
  if (!rawRows.length) throw new Error('The file has no connection records.');
  const seen = new Set<string>(), existingIds = new Set(existing.map(profile => profile.id));
  const rows: ImportRow[] = rawRows.map((raw, index) => {
    const row: ImportRow = { index, name: `Row ${index + 1}`, errors: [], warnings: [], exists: false, action: 'skip' };
    try {
      if (typeof raw !== 'object' || !raw || Array.isArray(raw)) throw new Error('Each connection must be an object.');
      const object = { ...raw } as Record<string, unknown>;
      if (typeof object.__csvError === 'string') throw new Error(object.__csvError);
      if (typeof object.name === 'string' && object.name.trim()) row.name = object.name;
      let parsed: ReturnType<typeof parseConnectionString> | undefined;
      if (typeof object.connectionString === 'string' && object.connectionString.trim()) parsed = parseConnectionString(object.connectionString, options);
      const password=Object.prototype.hasOwnProperty.call(object,'password')?object.password:parsed?.password;
      if(password!==undefined&&(typeof password!=='string'||password.length>10000))throw new Error('The password field must contain at most 10,000 characters.');
      delete object.password;
      if(parsed)delete parsed.password;
      delete object.connectionString;
      if (parsed && object.path === '') delete object.path;
      if (format === 'csv') for (const key of ['driver', 'storage', 'scope']) if (typeof object[key] === 'string') object[key] = object[key].toLowerCase().trim();
      const profile = { ...parsed, ...object, id: object.id || randomUUID(), driver: object.driver || parsed?.driver || 'sqlite', name: object.name || parsed?.suggestedName, storage: object.storage || parsed?.storage || (['postgresql','mysql','mariadb'].includes(String(object.driver)) ? 'server' : 'file') };
      for (const key of ['host','database','user','authRef','tunnelRef','sslMode','caPath','certPath','keyPath','port','connectTimeout','applicationName']) {
        const record = profile as Record<string,unknown>;
        if (record[key] === '') delete record[key];
        else if (format === 'csv' && ['port','connectTimeout'].includes(key) && record[key] !== undefined) record[key] = Number(record[key]);
      }
      // Parser-only display hints do not belong in saved connection settings.
      delete (profile as Record<string, unknown>).suggestedName;
      for (const key of ['readOnly', 'createIfMissing']) { const value = booleanValue(object[key], key); if (value !== undefined) (profile as Record<string, unknown>)[key] = value; else if (parsed) (profile as Record<string, unknown>)[key] = parsed[key as 'readOnly' | 'createIfMissing']; else delete (profile as Record<string, unknown>)[key]; }
      for (const key of ['scope', 'color']) if ((profile as Record<string, unknown>)[key] === '') delete (profile as Record<string, unknown>)[key];
      if (profile.storage === 'file' && typeof profile.path === 'string') profile.path = parseConnectionString(`jdbc:sqlite:${profile.path}`, options).path;
      const validated = ProfileSchema.safeParse(profile);
      if (!validated.success) throw new Error(validated.error.issues.map(issue => `${issue.path.join('.') || 'connection'}: ${issue.message}`).join('; '));
      if(validated.data.authRef&&password!==undefined)throw new Error('A connection using an Authentication Profile cannot import a connection password. Edit that profile separately.');
      if(password!==undefined){if(validated.data.driver==='sqlite')throw new Error('This driver does not use a password.');row.hasPassword=true;capturePassword?.(index,password as string);}
      row.profile = validated.data; row.name = validated.data.name; row.exists = existingIds.has(validated.data.id);
      const duplicate = seen.has(validated.data.id); if (duplicate) row.warnings.push('This ID also occurs in another row. Create a copy or skip one of the rows.');
      row.action = row.exists || duplicate ? 'copy' : 'create'; seen.add(validated.data.id);
      if (format === 'csv' && headers && mapping && Object.keys(mapping).length < headers.length) row.warnings.push('Unmapped CSV columns are excluded from this connection.');
    } catch (error) { row.errors.push(error instanceof Error ? error.message : String(error)); }
    return row;
  });
  return { format, headers, mapping, rows };
}
export class ConnectionTransfers {
  private plans = new Map<string, { preview: ImportPreview; snapshot: string; passwords:Map<number,string>; revisions:Map<string,string> }>();
  private applying = false;
  constructor(private manager: ConnectionManager, private beforeReplace: (profile: ConnectionProfile,credentialChanged?:boolean) => Promise<boolean> = async () => true) {}
  preview(text: string, format: ImportFormat, options: ImportOptions = {}): ImportPreview {
    const existing = this.manager.profiles(),passwords=new Map<number,string>(); const preview: ImportPreview = { ...previewConnections(text, format, existing, options,(index,password)=>passwords.set(index,password)), token: randomUUID() };
    for(const row of preview.rows)if(row.profile)try{this.manager.validateProfile(row.profile);}catch(error){row.errors.push(error instanceof Error?error.message:String(error));row.profile=undefined;row.action='skip';passwords.delete(row.index);}
    const revisions=new Map(existing.map(profile=>[profile.id,this.manager.editorRevision(profile.id)]));
    this.plans.clear(); this.plans.set(preview.token, { preview, snapshot: fingerprint(existing), passwords, revisions }); return structuredClone(preview);
  }
  async apply(token: string, decisions: { index: number; action: ImportAction }[], scope: ConnectionProfile['scope'],rememberPasswords=false): Promise<ImportReport> {
    if (this.applying) throw new Error('An import is already running.');
    const plan = this.plans.get(token); if (!plan) throw new Error('Preview the connections again before importing.');
    if (fingerprint(this.manager.profiles()) !== plan.snapshot) throw new Error('Connection settings changed after preview. Preview again before importing.');
    if (new Set(decisions.map(decision => decision.index)).size !== decisions.length || decisions.some(decision => !plan.preview.rows[decision.index] || !['create', 'copy', 'replace', 'skip'].includes(decision.action))) throw new Error('The import selection is invalid.');
    const selected = new Map(decisions.map(decision => [decision.index, decision.action])); const targets = new Set<string>();
    const records = plan.preview.rows.map(row => {
      const action = selected.get(row.index) ?? 'skip';
      if (action !== 'skip' && !row.profile) throw new Error(`Row ${row.index + 1} is invalid. Fix it or skip it.`);
      const profile = row.profile ? { ...row.profile, scope, id: action === 'copy' ? randomUUID() : row.profile.id } : undefined;
      if (profile && action !== 'skip') {
        if (targets.has(profile.id)) throw new Error('Multiple selected rows target the same connection ID. Create copies or skip duplicates.'); targets.add(profile.id);
        const exists = this.manager.profiles().some(existing => existing.id === profile.id);
        if ((action === 'replace' && !exists) || (action === 'create' && exists)) throw new Error('A connection ID conflicts with the selected action. Preview again.');
      }
      return { row, action, profile };
    });
    this.applying = true; this.plans.delete(token); const report: ImportReport = { rows: [] };
    try {
      for (const { row, action, profile } of records) {
        if (action === 'skip' || !profile) { report.rows.push({ index: row.index, name: row.name, status: row.profile ? 'skipped' : 'invalid', message: row.errors.join('; ') || undefined }); continue; }
        try {
          const password=plan.passwords.get(row.index),revision=action==='replace'?plan.revisions.get(profile.id):this.manager.editorRevision(profile.id);
          if (action === 'replace') {
            const before = this.manager.profile(profile.id);
            if (!await this.beforeReplace(profile,password!==undefined&&await this.manager.passwordChanged(profile.id,password))) { report.rows.push({ index: row.index, name: row.name, status: 'skipped', message: 'Replacement cancelled.' }); continue; }
            if (JSON.stringify(this.manager.profile(profile.id)) !== JSON.stringify(before)) throw new Error('This connection changed during replacement review. Preview it again.');
          } else if (this.manager.profiles().some(existing => existing.id === profile.id)) throw new Error('This ID was added during import. Preview it again.');
          const saved = await this.manager.save(profile,{revision,password,rememberPassword:password===undefined?undefined:rememberPasswords}); report.rows.push({ index: row.index, name: saved.name, id: saved.id, status: action === 'replace' ? 'replaced' : 'created' });
        } catch (error) { report.rows.push({ index: row.index, name: row.name, status: 'failed', message: error instanceof Error ? error.message : String(error) }); }
      }
      return report;
    } finally { this.applying = false; }
  }
}
