import { z } from 'zod';
import { CellSchema, GridEditStateSchema, TableRequestSchema, type ApplyReport, type ConnectionProfile, type GridEditState, type GridEditorState, type QueryResult, type RowChange, type TableDetails, type TableRequest } from '../../protocol/src/index.js';
import type { DriverSession } from '../../driver-sdk/src/index.js';
import { profileTarget } from './profile-target.js';

const ColumnSchema = z.object({ key: z.string(), name: z.string(), dataType: z.string(), nullable: z.boolean(), primaryKey: z.number(), generated: z.boolean(), defaultValue: z.string().nullable().optional(), sourceColumn: z.string().optional(), sourceTable: z.string().optional() }).strict();
const ResultSchema = z.object({ columns: z.array(ColumnSchema), rows: z.array(z.record(CellSchema)), durationMs: z.number(), affectedRows: z.number(), truncated: z.boolean(), sql: z.string(), sourceTable: z.string().optional(), readOnly: z.boolean() }).strict();
const DetailsSchema = z.object({ name: z.string(), type: z.enum(['table', 'view']), sql: z.string().nullable(), columns: z.array(ColumnSchema), indexes: z.array(z.object({ name: z.string(), unique: z.boolean(), columns: z.array(z.string()) })), foreignKeys: z.array(z.object({ id: z.number(), table: z.string(), from: z.string(), to: z.string(), onUpdate: z.string(), onDelete: z.string() })) }).strict();
const BackupSchema = z.object({
  version: z.literal(1), profileId: z.string(), target: z.union([
    z.object({ driver: z.literal('sqlite'), storage: z.enum(['file', 'memory']), path: z.string() }).strict(),
    z.object({ driver: z.enum(['postgresql','mysql','mariadb']), storage: z.literal('server'), path: z.string(), host: z.string(), port: z.number(), database: z.string(), user: z.string(), sslMode: z.string(), caPath: z.string(), certPath: z.string(), keyPath: z.string(),authRef:z.string().default(''),tunnelRef:z.string().default('') }).strict(),
  ]),
  binding:z.string().optional(),
  request: TableRequestSchema, details: DetailsSchema, result: ResultSchema, edits: GridEditStateSchema,
}).strict();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export interface GridEditTransition { label: string; undo(): void; redo(): void; }

/** Authoritative staged changes; editing and backing up never write the DB. */
export class GridDocumentModel {
  private draft: GridEditState;
  private revision = 0;
  private epoch = 0;
  private undoCount = 0;
  private redoCount = 0;
  private saving?: Promise<ApplyReport>;
  private loading = false;
  private structureBusy = false;
  freezeStructure(value:boolean):void { this.structureBusy=value; }
  private message?: string;
  private error?: string;
  constructor(readonly profile: ConnectionProfile, public details: TableDetails, private result: QueryResult, private request: TableRequest,readonly binding?:string) {
    this.draft = this.empty();
  }
  private empty(): GridEditState { return { edits: {}, added: [], keyColumns: this.details.columns.filter(column => column.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey).map(column => column.name) }; }
  get dirty(): boolean { return Boolean(Object.keys(this.draft.edits).length || this.draft.added.length); }
  get isSaving(): boolean { return Boolean(this.saving); }
  state(): GridEditorState { return structuredClone({ revision: this.revision, edits: this.draft, dirty: this.dirty, busy: Boolean(this.saving || this.loading || this.structureBusy), canUndo: this.undoCount > 0, canRedo: this.redoCount > 0, result: this.result, request: this.request, message: this.message, error: this.error }); }
  private ensureEditable(): void {
    if (this.saving || this.loading || this.structureBusy) throw new Error('Wait for the current database or structure operation to finish.');
    if (this.result.readOnly || this.profile.readOnly || this.details.type !== 'table') throw new Error('This result is read-only.');
  }
  private validateKeys(keys: string[]): void {
    if (new Set(keys).size !== keys.length || keys.some(key => !this.details.columns.some(column => column.name === key))) throw new Error('Select valid key columns.');
  }
  private validateDraft(value: unknown): GridEditState {
    const state = GridEditStateSchema.parse(value); this.validateKeys(state.keyColumns);
    const writable = new Set(this.details.columns.filter(column => !column.generated).map(column => column.name));
    const validateValues = (values: Record<string, unknown>) => { if (Object.keys(values).some(key => !writable.has(key))) throw new Error('A changed column is generated or no longer exists.'); };
    for (const [id, change] of Object.entries(state.edits)) {
      if (!/^r\d+$/.test(id) || change.kind === 'insert') throw new Error('Invalid staged row identity.');
      const original = this.result.rows[Number(id.slice(1))];
      if (!original || !same(original, change.original)) throw new Error('The editor snapshot no longer matches the loaded rows.');
      validateValues(change.values);
    }
    if (new Set(state.added.map(row => row.id)).size !== state.added.length) throw new Error('Duplicate staged row identity.');
    for (const row of state.added) validateValues(row.values);
    return state;
  }
  update(revision: number, value: unknown): GridEditTransition | undefined {
    this.ensureEditable();
    if (revision !== this.revision) throw new Error('The editor changed while this edit was pending. Retry the edit.');
    const next = this.validateDraft(value);
    if (same(next, this.draft)) return;
    const before = structuredClone(this.draft), after = structuredClone(next), epoch = this.epoch;
    this.draft = after; this.revision++; this.undoCount++; this.redoCount = 0; this.message = undefined; this.error = undefined;
    const restore = (state: GridEditState) => {
      this.ensureEditable();
      if (this.epoch !== epoch) throw new Error('This edit belongs to an earlier saved result. Committed database changes cannot be undone from this edit history.');
      this.draft = structuredClone(state); this.revision++;
    };
    return { label: 'Edit database rows', undo: () => { restore(before); this.undoCount--; this.redoCount++; }, redo: () => { restore(after); this.undoCount++; this.redoCount--; } };
  }
  keys(keys: string[]): void { this.ensureEditable(); this.validateKeys(keys); this.draft.keyColumns = [...keys]; }
  private clear(): void { this.draft = { ...this.empty(), keyColumns: this.draft.keyColumns.filter(key => this.details.columns.some(column => column.name === key)) }; this.revision++; this.epoch++; this.undoCount = 0; this.redoCount = 0; }
  async load(session: DriverSession, request: TableRequest): Promise<QueryResult> {
    if (this.dirty) throw new Error('Save or discard staged changes before loading other rows.');
    if (this.saving || this.loading || this.structureBusy) throw new Error('Wait for the current database or structure operation to finish.');
    if (request.table !== this.request.table) throw new Error('Table identity mismatch.');
    this.loading = true;
    try {
      const details = await session.details(request.table), result = await session.table(request);
      this.details = details; this.result = result; this.request = structuredClone(request); this.clear(); this.message = undefined; this.error = undefined; return result;
    } finally { this.loading = false; }
  }
  save(session: DriverSession): Promise<ApplyReport> {
    if (this.saving) return this.saving;
    this.ensureEditable();
    if (!this.dirty) return Promise.resolve({ affectedRows: 0 });
    if (!this.draft.keyColumns.length && Object.keys(this.draft.edits).length) throw new Error('Choose columns that uniquely identify each existing row before saving.');
    const changes: RowChange[] = [...Object.values(this.draft.edits), ...this.draft.added.map(row => ({ kind: 'insert' as const, values: row.values }))];
    const keys = [...this.draft.keyColumns];
    this.saving = (async () => {
      let report: ApplyReport;
      try { report = await session.apply(this.request.table, keys, changes, { requireAutocommit: true }); }
      catch (error) { this.error = `Changes were not saved: ${error instanceof Error ? error.message : String(error)}`; throw error; }
      // The write has committed. A failed refresh must never leave that write
      // staged for an accidental second insertion when the user retries Save.
      this.clear(); this.message = `${report.affectedRows} row${report.affectedRows === 1 ? '' : 's'} saved to the database.`;
      try { this.details = await session.details(this.request.table); this.result = await session.table(this.request); this.error = undefined; }
      catch (error) { this.result = { ...this.result, readOnly: true }; this.error = `Changes were saved, but reloading failed: ${error instanceof Error ? error.message : String(error)}. Refresh before editing again.`; }
      return report;
    })();
    return this.saving.finally(() => { this.saving = undefined; });
  }
  revert(): void {
    if (this.saving || this.loading || this.structureBusy) throw new Error('Wait for the current database or structure operation to finish.');
    this.clear(); this.message = 'Staged changes discarded. The database was not modified.'; this.error = undefined;
  }
  backup(): string { return JSON.stringify({ version: 1, profileId: this.profile.id, target: profileTarget(this.profile), binding:this.binding,request: this.request, details: this.details, result: this.result, edits: this.draft }); }
  static restore(profile: ConnectionProfile, table: string, text: string,binding?:string): GridDocumentModel {
    const backup = BackupSchema.parse(JSON.parse(text));
    if (backup.profileId !== profile.id || backup.request.table !== table || !same(backup.target, profileTarget(profile))) throw new Error('The saved draft belongs to another database connection. Its backup has been preserved.');
    if(backup.binding!==binding)throw new Error('The Authentication Profile or tunnel identity changed. Preserve the backup and review the target before recovering edits.');
    const model = new GridDocumentModel(profile, backup.details, { ...backup.result, readOnly: backup.result.readOnly || profile.readOnly }, backup.request,binding);
    model.draft = model.validateDraft(backup.edits); model.message = 'Recovered unsaved edits. Review them before saving; the database may have changed.';
    return model;
  }
}
