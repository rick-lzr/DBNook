import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { connectionString, parseConnectionString } from '../packages/core/src/connection-strings.js';
import { ConnectionTransfers, exportConnections, parseConnectionCsv, previewConnections } from '../packages/core/src/connection-transfer.js';
import { ConnectionManager } from '../packages/core/src/connections.js';
import { ProfileSchema, type ConnectionProfile } from '../packages/protocol/src/index.js';

const windows = { platform: 'win32' as const, baseDirectory: 'D:\\workspace\\project' }, linux = { platform: 'linux' as const, baseDirectory: '/workspace/project' };
const profile = (id = 'one') => ProfileSchema.parse({ id, driver: 'sqlite', name: 'A connection', storage: 'memory' });
const managers: ConnectionManager[] = []; afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); });
function service(initial: ConnectionProfile[] = [], beforeReplace?: (value: ConnectionProfile) => Promise<boolean>) {
  const rows = [...initial]; let writes = 0;
  const manager = new ConnectionManager({ list: () => rows.map(row => ({ ...row })), save: async value => { writes++; const index = rows.findIndex(row => row.id === value.id); if (index < 0) rows.push(value); else rows[index] = value; }, remove: async id => { const index = rows.findIndex(row => row.id === id); if (index >= 0) rows.splice(index, 1); } }, { runnerPath: resolve('dist/sqlite-runner.cjs') });
  managers.push(manager); return { manager, rows, writes: () => writes, transfer: new ConnectionTransfers(manager, beforeReplace) };
}
test('SQLite file URIs preserve Unicode, reserved characters, flags and platform paths', () => {
  for (const readOnly of [false, true]) for (const createIfMissing of [false, true]) {
    const value = ProfileSchema.parse({ ...profile(), storage: 'file', path: 'D:\\data\\中文 + % # ?.db', readOnly, createIfMissing });
    const text = connectionString(value, 'win32'), parsed = parseConnectionString(text, windows);
    assert.equal(parsed.path, value.path); assert.equal(parsed.readOnly, readOnly); assert.equal(parsed.createIfMissing, readOnly ? false : createIfMissing);
    assert.match(text, /%25/); assert.match(text, /%23/); assert.match(text, /%3F/);
  }
  assert.equal(parseConnectionString('file:///var/data/example.db?mode=rw', linux).path, '/var/data/example.db');
});
test('SQLite JDBC and SQLAlchemy paths resolve relative to the chosen source without executing text', () => {
  assert.equal(parseConnectionString('jdbc:sqlite:../data/example.db', linux).path, '/workspace/data/example.db');
  assert.equal(parseConnectionString('sqlite:////var/data/example.db', linux).path, '/var/data/example.db');
  assert.equal(parseConnectionString('sqlite:///D:/data/example.db', windows).path, 'D:\\data\\example.db');
  assert.equal(parseConnectionString('sqlite:///file:D:/data/example.db?mode=ro&uri=true', windows).readOnly, true);
  assert.equal(parseConnectionString('jdbc:sqlite:literal%20name.db', linux).path, '/workspace/project/literal%20name.db');
  assert.throws(() => parseConnectionString('jdbc:sqlite:relative.db', { platform: 'linux' }), /workspace|absolute/);
});
test('SQLite memory and read-only memory strings round-trip without creating files', () => {
  for (const text of [':memory:', 'jdbc:sqlite::memory:', 'sqlite://', 'sqlite:///:memory:', 'file::memory:?cache=shared']) assert.equal(parseConnectionString(text, windows).storage, 'memory');
  const value = { ...profile(), readOnly: true }; assert.equal(parseConnectionString(connectionString(value, 'win32'), windows).readOnly, true);
  assert.throws(() => parseConnectionString('file:named?mode=memory&cache=shared', windows), /Named memory/);
});
test('UNC paths round-trip using an empty file URI authority', () => {
  const value = { ...profile(), storage: 'file' as const, path: '\\\\server\\share\\a b.db' };
  const text = connectionString(value, 'win32'); assert.match(text, /^file:\/\/\/\/server\/share/); assert.equal(parseConnectionString(text, windows).path, value.path);
  assert.throws(() => parseConnectionString('file://server/share/a.db', windows), /UNC/);
});
test('unsupported options, duplicate options, foreign paths and unsupported network drivers are not silently imported', () => {
  assert.throws(() => parseConnectionString('file:///D:/data/x.db?immutable=1', windows), /Unsupported SQLite connection option/);
  assert.throws(() => parseConnectionString('file:///D:/data/x.db?mode=rw&mode=ro', windows), /Duplicate/);
  assert.throws(() => parseConnectionString('file:///D:/data/x.db?mode=wrong', windows), /mode/);
  assert.throws(() => parseConnectionString('D:relative.db', windows), /SQLite connection strings|Drive-relative/);
  assert.throws(() => parseConnectionString('D:\\data\\x.db', linux), /Windows database path/);
  assert.throws(() => parseConnectionString('sqlserver://user:secret123@example/db', linux), error => error instanceof Error && !error.message.includes('secret123'));
});
test('CSV reader handles BOM, CRLF, multiline fields and escaped quotation marks', () => {
  assert.deepEqual(parseConnectionCsv('\uFEFFname,path\r\n"A, ""quoted""","line1\nline2"\r\n'), [['name', 'path'], ['A, "quoted"', 'line1\nline2']]);
  assert.deepEqual(parseConnectionCsv('name;path\nLocal;/data.db\n', ';'), [['name', 'path'], ['Local', '/data.db']]);
  assert.throws(() => parseConnectionCsv('name,path\n"unclosed'), /quoted field/);
  assert.throws(() => parseConnectionCsv('name,path\n"quoted"garbage,x'), /Unexpected/);
});
test('JSON and CSV exports retain all supported configuration fields', () => {
  const values = [{ ...profile(), name: 'A, "quoted"\nconnection', group: 'A group', readOnly: true }, ProfileSchema.parse({ ...profile('two'), name: 'File', storage: 'file', path: '/data/test.db', scope: 'workspace', color: '#123456', createIfMissing: true })];
  for (const format of ['json', 'csv'] as const) {
    const preview = previewConnections(exportConnections(values, format), format, [], linux);
    assert.ok(preview.rows.every(row => !row.errors.length), JSON.stringify(preview.rows)); assert.deepEqual(preview.rows.map(row => row.profile), values);
  }
});
test('manual CSV mapping reports unsupported records and unmapped columns individually', () => {
  const preview = previewConnections('Display,Location,Flag,Ignored\nLocal,../data/local.db,yes,extra\nInvalid,/tmp/test.db,maybe,extra\n', 'csv', [], { ...linux, mapping: { name: 0, path: 1, readOnly: 2 } });
  assert.equal(preview.rows[0]?.profile?.path, '/workspace/data/local.db'); assert.equal(preview.rows[0]?.profile?.readOnly, true); assert.ok(preview.rows[0]?.warnings.some(message => /Unmapped/.test(message)));
  assert.match(preview.rows[1]?.errors[0] ?? '', /readOnly/);
  assert.throws(() => previewConnections('a,b\nx,y', 'csv', [], { ...linux, mapping: { name: 0, path: 0 } }), /more than one/);
});
test('connection string columns fill paths and readonly flags without requiring duplicate CSV fields', () => {
  const preview = previewConnections('name,connectionString,path\nImported,file:///D:/data/imported.db?mode=ro,\n', 'csv', [], windows);
  assert.equal(preview.rows[0]?.profile?.path, 'D:\\data\\imported.db'); assert.equal(preview.rows[0]?.profile?.readOnly, true); assert.equal(preview.rows[0]?.errors.length, 0);
});
test('preview never mutates settings and preserves invalid records for review', () => {
  const { transfer, writes } = service([profile()]);
  const plan = transfer.preview(JSON.stringify([profile(), { name: 'Unsupported', driver: 'postgresql', storage: 'memory' }, null]), 'json');
  assert.equal(writes(), 0); assert.equal(plan.rows.length, 3); assert.equal(plan.rows[0]?.action, 'copy'); assert.ok(plan.rows[1]?.errors.length); assert.ok(plan.rows[2]?.errors.length);
});
test('import choices create copies, skip invalid rows and prevent accidental token replay', async () => {
  const { transfer, manager } = service([profile()]);
  const plan = transfer.preview(JSON.stringify([profile(), { ...profile('new'), name: 'New' }, { name: 'bad' }]), 'json');
  const report = await transfer.apply(plan.token, [{ index: 0, action: 'copy' }, { index: 1, action: 'create' }], 'global');
  assert.deepEqual(report.rows.map(row => row.status), ['created', 'created', 'invalid']); assert.notEqual(report.rows[0]?.id, 'one'); assert.equal(manager.profiles().length, 3);
  await assert.rejects(transfer.apply(plan.token, [], 'global'), /Preview/);
});
test('duplicate selected IDs and invalid selections are rejected before any writes', async () => {
  const { transfer, writes } = service(); const plan = transfer.preview(JSON.stringify([profile(), profile()]), 'json');
  await assert.rejects(transfer.apply(plan.token, [{ index: 0, action: 'create' }, { index: 1, action: 'create' }], 'global'), /same connection ID/); assert.equal(writes(), 0);
  await assert.rejects(transfer.apply(plan.token, [{ index: 99, action: 'create' }], 'global'), /selection is invalid/); assert.equal(writes(), 0);
});
test('stale preview cannot overwrite settings changed after review', async () => {
  const { transfer, manager, writes } = service([profile()]); const plan = transfer.preview(JSON.stringify([{ ...profile(), name: 'Imported' }]), 'json');
  await manager.save({ ...profile(), name: 'Changed since preview' });
  await assert.rejects(transfer.apply(plan.token, [{ index: 0, action: 'replace' }], 'global'), /changed after preview/); assert.equal(writes(), 1);
});
test('replacement cancellation and individual save failures produce an explicit partial report', async () => {
  const { manager, rows } = service([profile()]);
  const transfer = new ConnectionTransfers(manager, async () => false); const plan = transfer.preview(JSON.stringify([{ ...profile(), name: 'Replace' }, profile('new')]), 'json');
  const report = await transfer.apply(plan.token, [{ index: 0, action: 'replace' }, { index: 1, action: 'create' }], 'global'); assert.deepEqual(report.rows.map(row => row.status), ['skipped', 'created']); assert.equal(rows[0]?.name, 'A connection');
  const originalSave = manager.store.save; manager.store.save = async value => { if (value.id === 'fail') throw new Error('Write failed'); await originalSave(value); };
  const next = transfer.preview(JSON.stringify([profile('fail'), profile('ok')]), 'json'); const partial = await transfer.apply(next.token, [{ index: 0, action: 'create' }, { index: 1, action: 'create' }], 'global');
  assert.deepEqual(partial.rows.map(row => row.status), ['failed', 'created']); assert.match(partial.rows[0]?.message ?? '', /Write failed/);
});
