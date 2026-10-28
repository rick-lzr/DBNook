import {portableStructureChecks} from './portable-structures.js';
import {connectionEditorEntryChecks} from './daily-connections.js';
import {queryPlanChecks} from './query-plans.js';
import {sqlParameterChecks} from './sql-parameters.js';
import {structureComparisonChecks} from './structure-comparisons.js';
import * as vscode from 'vscode';
import {sqlEditingChecks} from './sql-editing.js';
import {structureChecks} from './structure.js';
import {dataChecks} from './data.js';
import {backupChecks} from './backup.js';
import {diagnosticChecks} from './diagnostics.js';
import {comparisonChecks} from './comparison.js';
import {combinationChecks} from './combination.js';
import {definitionChecks} from './definitions.js';
import {tableDefinitionChecks} from './table-definitions.js';
import {AuthenticationSchema,TunnelSchema} from '../../packages/protocol/src/index.js';
import {sshFixture} from '../fixtures/ssh-server.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionManager } from '../../packages/core/src/connections.js';
import type { ConnectionsTree } from '../../packages/extension/src/tree.js';
import type { TableEditorProvider } from '../../packages/extension/src/table-editor.js';
import { ProfileSchema, type GridEditState } from '../../packages/protocol/src/index.js';
import type { SqlDocuments } from '../../packages/core/src/sql-documents.js';
import type { ConnectionTransfers } from '../../packages/core/src/connection-transfer.js';
import type { ConnectionOrganization } from '../../packages/core/src/connection-organization.js';
import type { VscodeProfileStore } from '../../packages/extension/src/store.js';

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(predicate(), description);
}
async function replaceSql(document: vscode.TextDocument, value: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), value);
  assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(await document.save(), true);
  const editor = await vscode.window.showTextDocument(document, { preview: false }); editor.selection = new vscode.Selection(0, 0, 0, 0);
}

export async function run(): Promise<void> {
  const evidence = { vscode: vscode.version, node: process.versions.node, extensionVersion: '', extensionPath:'', testedAt: new Date().toISOString(), checks: [] as string[], passed: false, error: '' };
  const output = process.env.DBW_TEST_OUTPUT!;
  const cancellation = new vscode.CancellationTokenSource();
  const check = (text: string) => { evidence.checks.push(text); console.log(`PASS ${text}`); };
  try {
    const extension = vscode.extensions.getExtension(process.env.DBW_TEST_EXTENSION_ID ?? 'local-db-workbench.dbnook'); assert.ok(extension, 'Development extension registered');
    evidence.extensionVersion = extension.packageJSON.version;
    evidence.extensionPath=extension.extensionPath;
    const api = await extension.activate() as { manager: ConnectionManager; resources:import('../../packages/core/src/resources.js').ConnectionResources;tunnels:import('../../packages/core/src/tunnels.js').SshTunnels;sshConfigs:import('../../packages/extension/src/ssh-config.js').SshConfigDiscovery;authTree:import('../../packages/extension/src/resources.js').ResourceTree;tunnelTree:import('../../packages/extension/src/resources.js').ResourceTree; credentials: import('../../packages/core/src/connections.js').CredentialStore; tree: ConnectionsTree; sqlDocuments: SqlDocuments; organization: ConnectionOrganization; transfers: ConnectionTransfers; profileStore: VscodeProfileStore; tableEditors: TableEditorProvider; initializedViews(): number };
    assert.ok(api?.manager); check('Extension activates in a real VS Code host');
    if(process.env.DBW_DIAGNOSTICS_ONLY==='1'){await diagnosticChecks(api as typeof api & {diagnosticService:import('../../packages/extension/src/diagnostics.js').Diagnostics;extensionContext:vscode.ExtensionContext;configureTestWebview(panel:vscode.WebviewPanel):void},output,check);evidence.passed=true;return;}
    const commands = await vscode.commands.getCommands(true); assert.ok(commands.includes('dbWorkbench.sample')); check('Commands are registered');
    await connectionEditorEntryChecks(api,check);
    await sqlEditingChecks(api as typeof api & {history:import('../../packages/core/src/query-history.js').QueryHistory},check);
    await queryPlanChecks(api as typeof api & {queryPlans:import('../../packages/core/src/query-plans.js').QueryPlans;queryPlanPanels:import('../../packages/extension/src/query-plan-panels.js').QueryPlanPanels},check);
    await sqlParameterChecks(api as typeof api & {parameterPanels:import('../../packages/extension/src/sql-parameter-panels.js').SqlParameterPanels},check);
    await structureChecks(api as typeof api & {schemaChanges:import('../../packages/core/src/schema-changes.js').SchemaChanges},check);
    await definitionChecks(api as typeof api & {databaseDefinitions:import('../../packages/core/src/database-definitions.js').DatabaseDefinitions;definitionDocuments:import('../../packages/extension/src/definition-documents.js').DefinitionDocuments},check);
    await tableDefinitionChecks(api as typeof api & {definitionDocuments:import('../../packages/extension/src/definition-documents.js').DefinitionDocuments},check);
    await structureComparisonChecks(api as typeof api & {definitionDocuments:import('../../packages/extension/src/definition-documents.js').DefinitionDocuments;structureComparisonDocuments:import('../../packages/extension/src/structure-comparison-documents.js').StructureComparisonDocuments;structureComparisons:import('../../packages/core/src/structure-comparisons.js').StructureComparisons},check);
    await portableStructureChecks(api as typeof api & {definitionDocuments:import('../../packages/extension/src/definition-documents.js').DefinitionDocuments;structureComparisonDocuments:import('../../packages/extension/src/structure-comparison-documents.js').StructureComparisonDocuments},check);
    await dataChecks(api as typeof api & {dataTransfers:import('../../packages/core/src/data-transfers.js').DataTransfers},output,check);
    await backupChecks(api as typeof api & {sqliteBackups:import('../../packages/core/src/sqlite-backups.js').SqliteBackups},output,check);
    await comparisonChecks(api as typeof api & {comparisons:import('../../packages/core/src/comparisons.js').Comparisons;comparisonPanels:import('../../packages/extension/src/comparison-panels.js').ComparisonPanels},check);
    await combinationChecks(api as typeof api & {comparisons:import('../../packages/core/src/comparisons.js').Comparisons;combinations:import('../../packages/core/src/combinations.js').Combinations},check);
    if(process.env.DBW_BACKUP_ONLY==='1'){evidence.passed=true;return;}
    if(process.env.DBW_DATA_ONLY==='1'){evidence.passed=true;return;}
    if(process.env.DBW_STRUCTURE_ONLY==='1'){evidence.passed=true;return;}
    if(process.env.DBW_SQL_ONLY==='1'){evidence.passed=true;return;}
    if(process.env.DBW_MYSQL_ONLY!=='1'){
    await vscode.commands.executeCommand('dbWorkbench.sample');
    const profiles = api.manager.profiles(); const profile = profiles.find(p => p.name === 'Sample · SQLite'); assert.ok(profile); check('Sample command persists an actual connection profile');
    const session = await api.manager.connect(profile.id); const row = (await session.query('SELECT count(*) AS count FROM teams')).rows[0]; assert.equal(row?.c0, 4); check('Isolated SQLite runner executes inside VS Code');
    await connectionEditorEntryChecks(api,check,profile.id);
    const roots = await api.tree.getChildren(); const connection = roots.find(node => node.profileId === profile.id); assert.ok(connection);
    const databases = await api.tree.getChildren(connection); assert.equal(databases[0]?.label, 'main');
    const folders = await api.tree.getChildren(databases[0]); const tables = await api.tree.getChildren(folders.find(node => node.section === 'table')); assert.ok(tables.some(node => node.object?.name === 'teams')); check('Native tree discovers database tables');
    const limit = Date.now() + 15000;
    while (!api.initializedViews() && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(api.initializedViews() > 0, 'Bundled Webview calls initialize under its actual CSP'); check('React Webview loads in VS Code and completes its initialization RPC');
    const document = api.tableEditors.getDocuments().find(doc => doc.model.profile.id === profile.id); assert.ok(document);
    const tab = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === document.uri.toString());
    assert.ok(tab()); check('Database table opens as a native custom editor resource');
    const edit = (name: string): GridEditState => ({ keyColumns: ['id'], added: [], edits: { r0: { kind: 'update', original: document.model.state().result.rows[0], values: { name } } } });
    const originalName = document.model.state().result.rows[0]?.name;
    const undoTrace:string[]=[];
    const traceEdits=process.env.DBW_UNDO_TRACE==='1'?api.tableEditors.onDidChangeCustomDocument(event=>{
      if(event.document!==document)return;
      undoTrace.push(`edit revision=${document.model.state().revision}`);
      const undo=event.undo,redo=event.redo;
      event.undo=()=>{undoTrace.push(`undo before=${document.model.state().revision}`);const result=undo();undoTrace.push(`undo after=${document.model.state().revision} dirty=${document.model.dirty}`);return result;};
      event.redo=()=>{undoTrace.push(`redo before=${document.model.state().revision}`);return redo();};
    }):undefined;
    api.tableEditors.update(document, document.model.state().revision, edit('Native save verification'));
    await until(() => tab()?.isDirty === true, 'Native tab reflects staged edits');
    assert.equal((await session.query('SELECT name FROM teams WHERE id=1')).rows[0]?.c0, originalName); check('Dirty native document does not prematurely write SQLite');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const activeInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(activeInput instanceof vscode.TabInputCustom && activeInput.uri.toString() === document.uri.toString(), 'Native Undo targets the active table editor');
    await vscode.commands.executeCommand('undo'); try{await until(() => !document.model.dirty, 'Native Undo reverts staged rows');}finally{if(traceEdits)console.log('UNDO TRACE',JSON.stringify({events:undoTrace,revision:document.model.state().revision,dirty:document.model.dirty,active:vscode.window.tabGroups.activeTabGroup.activeTab?.label,panels:[...document.panels].map(p=>({active:p.active,visible:p.visible}))}));traceEdits?.dispose();}
    await vscode.commands.executeCommand('redo'); await until(() => document.model.dirty, 'Native Redo restores staged rows'); check('VS Code Undo and Redo call the database document edit transitions');
    await vscode.commands.executeCommand('workbench.action.files.save');
    await until(() => !document.model.dirty && tab()?.isDirty === false, 'Native Save clears dirty document');
    assert.equal((await session.query('SELECT name FROM teams WHERE id=1')).rows[0]?.c0, 'Native save verification'); check('Native Save flushes the actual Webview and commits staged changes');
    api.tableEditors.update(document, document.model.state().revision, edit('Must remain staged'));
    await until(() => tab()?.isDirty === true, 'Transaction protection starts with dirty document');
    await session.query('BEGIN');
    await assert.rejects(api.tableEditors.saveCustomDocument(document, cancellation.token), /open SQL transaction/);
    assert.equal(document.model.dirty, true); assert.equal(tab()?.isDirty, true);
    assert.equal((await session.query('SELECT name FROM teams WHERE id=1')).rows[0]?.c0, 'Native save verification');
    await session.query('ROLLBACK'); await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => !document.model.dirty && tab()?.isDirty === false, 'Protected edits can be reverted'); check('Open SQL transactions cannot masquerade as successful grid saves');
    api.tableEditors.update(document, document.model.state().revision, edit('Recovered draft'));
    await until(() => tab()?.isDirty === true, 'Backup starts with dirty native document');
    const backup = await api.tableEditors.backupCustomDocument(document, { destination: vscode.Uri.file(join(output, 'draft', 'table.backup')) }, cancellation.token);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => tab()?.isDirty === false, 'Native Revert clears staged edits');
    assert.equal((await session.query('SELECT name FROM teams WHERE id=1')).rows[0]?.c0, 'Native save verification'); check('Native Revert discards staged edits without changing the database');
    assert.equal(await api.tableEditors.closeForConnection(profile.id), true);
    const recovered = await api.tableEditors.openCustomDocument(document.uri, { backupId: backup.id, untitledDocumentData: undefined }, cancellation.token);
    assert.equal(recovered.model.dirty, true); assert.equal(recovered.model.state().edits.edits.r0?.values.name, 'Recovered draft');
    assert.equal((await session.query('SELECT name FROM teams WHERE id=1')).rows[0]?.c0, 'Native save verification');
    recovered.dispose(); backup.delete(); check('VS Code filesystem backup restores unsaved rows without database writes');
    await vscode.commands.executeCommand('dbWorkbench.newQuery', { profileId: profile.id });
    const firstSql = vscode.window.activeTextEditor!.document; const firstOwner = firstSql.uri.toString();
    assert.equal(firstSql.languageId, 'sql'); assert.ok((await vscode.workspace.fs.stat(firstSql.uri)).size > 0); assert.match(firstSql.uri.path, /scratch\/query-.*\.sql$/); check('New SQL Query creates a persistent scratch file bound to its connection');
    await replaceSql(firstSql, "SELECT 'semicolon;中文';\r\nSELECT count(*) AS count FROM teams;\r\nSELECT 42;");
    await vscode.commands.executeCommand('dbWorkbench.execute');
    const successfulRun = api.sqlDocuments.lastRun(firstOwner); assert.equal(successfulRun?.status, 'succeeded'); assert.equal(successfulRun.statements.length, 3);
    assert.equal(successfulRun.statements[0]?.result?.rows[0]?.c0, 'semicolon;中文'); assert.equal(successfulRun.statements[1]?.result?.rows[0]?.c0, 4); assert.equal(successfulRun.statements[2]?.result?.rows[0]?.c0, 42); check('Native Execute runs a full SQL script with independent result sets');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), firstOwner, 'Results preserve the native SQL editor focus');
    const firstSession = api.manager.documentSession(firstOwner); assert.ok(firstSession?.connected); assert.notEqual(firstSession.id, session.id);
    await replaceSql(firstSql, "-- source mapping\nSELECT 'kept';\nSELECT missing_column FROM teams;\nSELECT 'must not execute';");
    await vscode.commands.executeCommand('dbWorkbench.execute');
    const failedRun = api.sqlDocuments.lastRun(firstOwner); assert.equal(failedRun?.status, 'failed'); assert.equal(failedRun.statements.length, 2);
    const diagnostic = vscode.languages.getDiagnostics(firstSql.uri).find(item => item.source === undefined || item.source === 'DBNook'); assert.ok(diagnostic); assert.equal(diagnostic.range.start.line, 2); check('Failed runs retain earlier results and map the failed statement into native diagnostics');
    await replaceSql(firstSql, 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5000000) SELECT sum(x) FROM n; SELECT missing_column FROM teams;');
    const changingRun = vscode.commands.executeCommand('dbWorkbench.execute'); await until(() => api.sqlDocuments.state(firstOwner).busy, 'Source snapshot run begins');
    await replaceSql(firstSql, 'SELECT 123;'); await changingRun;
    assert.equal(api.sqlDocuments.lastRun(firstOwner)?.status, 'failed'); assert.equal(vscode.languages.getDiagnostics(firstSql.uri).length, 0); check('Editing SQL during a run prevents stale diagnostics from highlighting new text');
    await vscode.commands.executeCommand('dbWorkbench.beginTransaction'); assert.equal(api.sqlDocuments.state(firstOwner).transaction, 'active');
    await firstSession.query("UPDATE teams SET name='Uncommitted SQL name' WHERE id=1");
    await vscode.commands.executeCommand('dbWorkbench.newQuery', { profileId: profile.id });
    const secondSql = vscode.window.activeTextEditor!.document, secondOwner = secondSql.uri.toString();
    await vscode.commands.executeCommand('dbWorkbench.execute'); const secondSession = api.manager.documentSession(secondOwner); assert.ok(secondSession?.connected);
    assert.notEqual(firstSession.id, secondSession.id); assert.equal(api.sqlDocuments.state(firstOwner).transaction, 'active'); assert.equal(api.sqlDocuments.state(secondOwner).transaction, 'idle');
    assert.equal((await secondSession.query('SELECT name FROM teams WHERE id=1')).rows[0]?.c0, 'Native save verification'); check('Native SQL commands keep document transactions isolated and results preserve editor focus');
    const firstTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === firstOwner); assert.ok(firstTab);
    assert.equal(await vscode.window.tabGroups.close(firstTab), true); await until(() => !firstSession.connected, 'Closing a SQL tab releases its physical session');
    assert.equal((await secondSession.query('SELECT name FROM teams WHERE id=1')).rows[0]?.c0, 'Native save verification'); check('Closing a native SQL document rolls back only its own uncommitted work');
    await vscode.window.showTextDocument(secondSql, { preview: false });
    await vscode.commands.executeCommand('dbWorkbench.beginTransaction'); assert.equal(api.sqlDocuments.state(secondOwner).transaction, 'active');
    await vscode.commands.executeCommand('dbWorkbench.commitTransaction'); assert.equal(api.sqlDocuments.state(secondOwner).transaction, 'idle');
    await vscode.commands.executeCommand('dbWorkbench.beginTransaction'); await vscode.commands.executeCommand('dbWorkbench.rollbackTransaction'); assert.equal(api.sqlDocuments.state(secondOwner).transaction, 'idle');
    check('Native Begin, Commit and Roll Back commands use the owning document session');
    const memoryProfile = ProfileSchema.parse({ id: 'host-memory', name: 'Host memory verification', driver: 'sqlite', storage: 'memory' }); await api.manager.save(memoryProfile);
    const memoryBase = await api.manager.connect(memoryProfile.id); await memoryBase.query('CREATE TABLE memory_rows(v TEXT)'); await memoryBase.query("INSERT INTO memory_rows VALUES('original')");
    assert.equal((await memoryBase.query('PRAGMA database_list')).rows.find(row => row.c1 === 'main')?.c2, '');
    const memoryFirst = await api.manager.lease(memoryProfile.id, 'host-memory:a'), memorySecond = await api.manager.lease(memoryProfile.id, 'host-memory:b');
    assert.equal(memoryFirst.info?.path, ':memory:'); assert.equal((await memorySecond.query('SELECT v FROM memory_rows')).rows[0]?.c0, 'original');
    await memoryFirst.query('BEGIN'); await memoryFirst.query("UPDATE memory_rows SET v='pending'"); assert.equal(memoryFirst.transactionState, 'active'); assert.equal(memorySecond.transactionState, 'idle');
    await api.manager.save({ ...memoryProfile, name: 'Renamed host memory', group: 'Host verification' }); assert.equal(memoryFirst.connected, true); assert.equal(memoryFirst.transactionState, 'active');
    await assert.rejects(memorySecond.query('SELECT v FROM memory_rows'), /locked/); await api.manager.releaseLease('host-memory:a');
    assert.equal((await memorySecond.query('SELECT v FROM memory_rows')).rows[0]?.c0, 'original'); await api.manager.disconnect(memoryProfile.id); check('Actual VS Code runtime shares memory data across independent SQL transaction connections');
    const importedMemory = ProfileSchema.parse({ id: 'host-import-memory', name: 'Imported memory', driver: 'sqlite', storage: 'memory', group: 'Imported' });
    const importPlan = api.transfers.preview(JSON.stringify([profile, importedMemory, { id: 'unsupported', driver: 'postgresql', name: 'Unsupported', storage: 'memory' }]), 'json');
    assert.equal(importPlan.rows[0]?.action, 'copy'); assert.ok(importPlan.rows[2]?.errors.length);
    const importReport = await api.transfers.apply(importPlan.token, [{ index: 0, action: 'copy' }, { index: 1, action: 'create' }], 'workspace');
    assert.deepEqual(importReport.rows.map(row => row.status), ['created', 'created', 'invalid']); assert.notEqual(importReport.rows[0]?.id, profile.id);
    assert.equal(api.manager.profile('host-import-memory').scope, 'workspace'); assert.equal(api.manager.isConnected('host-import-memory'), false); assert.equal(api.manager.profile(profile.id).scope, 'global');
    check('Connection import previews invalid rows, copies conflicting IDs and writes selected profiles to workspace settings without connecting');
    await api.organization.group([profile.id], 'Host group');
    let organizedRoots = await api.tree.getChildren(); const hostGroup = organizedRoots.find(node => node.kind === 'group' && node.section === 'Host group'); assert.ok(hostGroup); assert.ok((await api.tree.getChildren(hostGroup)).some(node => node.profileId === profile.id));
    await api.organization.renameGroup('Host group', 'Renamed host group'); const renamed = (await api.tree.getChildren()).find(node => node.kind === 'group' && node.section === 'Renamed host group'); assert.ok(renamed);
    await vscode.commands.executeCommand('dbWorkbench.removeGroup', renamed); assert.equal(api.manager.profile(profile.id).group, ''); assert.equal(session.connected, true); check('Native groups rename and remove while retaining connections and live database sessions');
    api.organization.setFilter('__no_matching_connection__'); assert.equal((await api.tree.getChildren()).length, 0); await vscode.commands.executeCommand('dbWorkbench.clearConnectionFilter');
    const sampleConnection = (await api.tree.getChildren()).find(node => node.profileId === profile.id); assert.ok(sampleConnection);
    const mainNode = (await api.tree.getChildren(sampleConnection))[0]!;
    api.organization.setObjectFilter(profile.id, 'NOT LIKE \'teams\''); const hiddenTables = (await api.tree.getChildren(mainNode)).find(node => node.section === 'table'); assert.ok(hiddenTables); assert.equal((await api.tree.getChildren(hiddenTables)).length, 0);
    await vscode.commands.executeCommand('dbWorkbench.clearObjectFilter', sampleConnection);
    const visibleTables = (await api.tree.getChildren(mainNode)).find(node => node.section === 'table'); assert.ok(visibleTables); const teamsNode = (await api.tree.getChildren(visibleTables)).find(node => node.object?.name === 'teams'); assert.ok(teamsNode);
    await vscode.commands.executeCommand('dbWorkbench.addFavorite', teamsNode); const favoritesRoot = (await api.tree.getChildren()).find(node => node.id === 'favorites'); assert.ok(favoritesRoot);
    const favorite = (await api.tree.getChildren(favoritesRoot)).find(node => node.profileId === profile.id && node.object?.name === 'teams'); assert.ok(favorite);
    await vscode.commands.executeCommand('dbWorkbench.removeFavorite', favorite); assert.ok(!(await api.tree.getChildren()).some(node => node.id === 'favorites')); check('Native connection filters, LIKE object filters and persistent object favorite commands update the tree');
    await vscode.commands.executeCommand('dbWorkbench.defaultConnection', sampleConnection); const defaultItem = (await api.tree.getChildren()).find(node => node.profileId === profile.id); assert.match(String(defaultItem?.description), /Default/); check('Workspace default connection is visible in the native tree');
    const configuration = vscode.workspace.getConfiguration('dbWorkbench'), previousWorkspace = configuration.inspect<unknown[]>('connections')?.workspaceValue;
    const duplicate = ProfileSchema.parse({ id: 'host-duplicate', name: 'Duplicate diagnostic', driver: 'sqlite', storage: 'memory', scope: 'workspace' });
    try {
      await configuration.update('connections', [...(previousWorkspace ?? []), duplicate, duplicate, null], vscode.ConfigurationTarget.Workspace);
      assert.ok(!api.manager.profiles().some(profile => profile.id === duplicate.id)); assert.ok(api.profileStore.diagnostics().some(issue => issue.code === 'duplicate-id'));
      await assert.rejects(api.manager.save(duplicate), /duplicate or invalid/);
      await api.manager.save({ ...duplicate, id: 'host-valid-with-corruption', name: 'Valid alongside invalid rows' }); assert.equal(api.manager.profile('host-valid-with-corruption').name, 'Valid alongside invalid rows');
    } finally { await configuration.update('connections', previousWorkspace, vscode.ConfigurationTarget.Workspace); }
    check('Malformed and duplicate settings are diagnosed without silently activating or overwriting ambiguous profiles');
    const parallelProfiles=['host-parallel-a','host-parallel-b'].map(id=>ProfileSchema.parse({id,name:id,driver:'sqlite',storage:'memory',scope:'workspace'}));
    await Promise.all(parallelProfiles.map(profile=>api.manager.save(profile)));for(const item of parallelProfiles)assert.ok(api.manager.profiles().some(profile=>profile.id===item.id));
    const staleRevision=api.manager.editorRevision(parallelProfiles[0]!.id);await api.manager.save({...parallelProfiles[0]!,name:'Changed outside form'});await assert.rejects(api.manager.save({...parallelProfiles[0]!,name:'Stale replacement'},{revision:staleRevision}),/changed after this form/);
    for(const item of parallelProfiles)await api.manager.remove(item.id);check('Concurrent profile saves retain both workspace records and stale editor revisions cannot overwrite newer settings');
    const collisionProfile = ProfileSchema.parse({ id: 'group', name: 'Tree identity verification', driver: 'sqlite', storage: 'memory', group: 'main' }); await api.manager.save(collisionProfile);
    const collisionGroup = (await api.tree.getChildren()).find(node => node.kind === 'group' && node.section === 'main'); assert.ok(collisionGroup);
    const collisionConnection = (await api.tree.getChildren(collisionGroup)).find(node => node.profileId === collisionProfile.id); assert.ok(collisionConnection);
    const collisionDatabase = (await api.tree.getChildren(collisionConnection))[0]!; assert.notEqual(collisionGroup.id, collisionDatabase.id); await api.manager.remove(collisionProfile.id); check('Tree identities stay distinct when connection IDs and group/database names contain colliding text');
    const previousViews = api.initializedViews(); await vscode.commands.executeCommand('dbWorkbench.importConnections'); await until(() => api.initializedViews() > previousViews, 'Import view completes its actual Webview initialization'); check('Connections import React view initializes under the real VS Code CSP');
    const beforeAuthViews=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.auth.add');await until(()=>api.initializedViews()>beforeAuthViews,'Authentication editor initializes under native CSP');const beforeTunnelViews=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.tunnel.add');await until(()=>api.initializedViews()>beforeTunnelViews,'SSH tunnel editor initializes under native CSP');check('Authentication Profile and SSH tunnel React editors initialize in actual VS Code Webviews');
    await api.manager.disconnect(profile.id); assert.equal(api.manager.isConnected(profile.id), false); check('Disconnect waits for runner exit');
    }
    if(process.env.DBW_MYSQL_TEST==='1'){
      const engine=process.env.DBW_TEST_ENGINE==='mariadb'?'mariadb':'mysql',label=engine==='mariadb'?'MariaDB':'MySQL';
      const mysql=ProfileSchema.parse({id:'native-mysql',name:`${label} host verification`,driver:engine,storage:'server',host:'localhost',port:Number(process.env.DBW_MYSQL_PORT),database:undefined,user:'dbw',sslMode:'verify-full',caPath:process.env.DBW_MYSQL_CA,scope:'workspace'});
      await api.manager.save(mysql,{password:process.env.DBW_MYSQL_PASSWORD,rememberPassword:true});assert.equal(await api.credentials.get(mysql.id),process.env.DBW_MYSQL_PASSWORD);assert(!JSON.stringify(vscode.workspace.getConfiguration('dbWorkbench').get('connections')).includes(process.env.DBW_MYSQL_PASSWORD!));
      const s=await api.manager.connect(mysql.id);assert.equal(s.info?.tls,'verify-full');check(`${label} connects with verified TLS and keeps its password in native SecretStorage`);
      await s.query('CREATE TABLE dbworkbench.native_mysql_items(id BIGINT PRIMARY KEY,v VARCHAR(100),n DECIMAL(30,10))');await s.query("INSERT INTO dbworkbench.native_mysql_items VALUES(1,'before',1.2345678901)");
      const connection=(await api.tree.getChildren()).find(node=>node.profileId===mysql.id)!;await connectionEditorEntryChecks(api,check,mysql.id);const databases=await api.tree.getChildren(connection);const database=databases.find(node=>node.label==='dbworkbench');assert(database);const folders=await api.tree.getChildren(database),folder=folders.find(node=>node.section==='table')!,table=(await api.tree.getChildren(folder)).find(node=>node.object?.label==='native_mysql_items')!;assert(table);assert.equal((await api.tree.getChildren(table)).find(n=>n.section==='Columns')?.description,'3');
      await vscode.commands.executeCommand('dbWorkbench.openTable',table);await until(()=>api.tableEditors.getDocuments().some(doc=>doc.model.profile.id===mysql.id&&doc.initialized.size>0),'MySQL native grid initializes');const document=api.tableEditors.getDocuments().find(doc=>doc.model.profile.id===mysql.id)!;assert.equal(document.model.state().result.rows[0]?.n,'1.2345678901');check(`${label} database/table/column tree opens the real table Webview under native CSP`);
      api.tableEditors.update(document,document.model.state().revision,{keyColumns:['id'],added:[],edits:{r0:{kind:'update',original:document.model.state().result.rows[0],values:{v:'native mysql saved'}}}});await vscode.commands.executeCommand('workbench.action.files.save');await until(()=>!document.model.dirty,'MySQL native grid saves');assert.equal((await s.query('SELECT v FROM dbworkbench.native_mysql_items')).rows[0]?.c0,'native mysql saved');check(`${label} native Ctrl+S flushes the Webview and commits actual InnoDB rows`);
      const before=new Set(vscode.workspace.textDocuments.map(doc=>doc.uri.toString()));await vscode.commands.executeCommand('dbWorkbench.newQuery',connection);const sql=vscode.workspace.textDocuments.find(doc=>!before.has(doc.uri.toString())&&doc.languageId==='sql')!;assert(sql);assert.match(sql.getText(),/SELECT version/);const owner=sql.uri.toString();const run=await api.sqlDocuments.run(owner,"BEGIN;UPDATE dbworkbench.native_mysql_items SET v='pending';SELECT v FROM dbworkbench.native_mysql_items;");assert.equal(run.status,'succeeded');assert.equal(api.sqlDocuments.state(owner).transaction,'active');assert.equal((await s.query('SELECT v FROM dbworkbench.native_mysql_items')).rows[0]?.c0,'native mysql saved');await api.sqlDocuments.transaction(owner,'rollback');assert.equal(api.sqlDocuments.state(owner).transaction,'idle');check(`${label} SQL document sessions preserve independent transactions and Roll Back`);
      const nativeProfile={...mysql,id:'native-backup-ui',name:'Native backup editor',database:'dbworkbench'};await api.manager.save(nativeProfile,{password:process.env.DBW_MYSQL_PASSWORD,rememberPassword:false});
      const nativeViews=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.serverBackup',{profileId:nativeProfile.id});await until(()=>api.initializedViews()>nativeViews,'Server backup React editor initializes under native CSP');
      const backupApi=api as typeof api & {serverBackups:import('../../packages/core/src/server-backups.js').ServerBackups};const missing=await backupApi.serverBackups.backup(nativeProfile.id,join(output,'native-missing-tool.sql'));assert.equal(missing.status,'failed');assert.match(missing.error!,/absolute.*executable path/);assert(missing.reportPath);await api.manager.remove(nativeProfile.id);check(`${label} native backup command opens a CSP-initialized review editor and missing native tools produce a local failure report`);
      const noDatabase={...mysql,id:'native-mysql-no-default',name:'No default database',database:undefined};await api.manager.save(noDatabase,{password:process.env.DBW_MYSQL_PASSWORD,rememberPassword:false});
      try{const definition=await vscode.commands.executeCommand<vscode.Uri>('dbWorkbench.openDefinition',{profileId:noDatabase.id,object:table.object});assert(definition);const document=await vscode.workspace.openTextDocument(definition);assert.match(document.getText(),/CREATE TABLE `dbworkbench`\.`native_mysql_items`/);assert.equal(api.sqlDocuments.connection(definition.toString()),noDatabase.id);check(`${label} table definition opens from a database node without a profile default database and retains the qualified target`);}finally{await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(noDatabase.id);}
      await api.manager.remove(mysql.id);assert.equal(await api.credentials.get(mysql.id),undefined);check(`Removing a ${label} connection deletes the native secure credential`);
    }
    if (process.env.DBW_PG_TEST === '1') {
      const pg = ProfileSchema.parse({ id: 'native-pg', name: 'PostgreSQL host verification', driver: 'postgresql', storage: 'server', host: '127.0.0.1', port: Number(process.env.DBW_PG_PORT), database: 'dbworkbench', user: 'dbw', sslMode: 'verify-full', caPath: process.env.DBW_PG_CA, scope: 'workspace' });
      await api.manager.save(pg); await api.manager.setPassword(pg.id, process.env.DBW_PG_PASSWORD!, 'remember');
      assert.equal(await api.credentials.get(pg.id),process.env.DBW_PG_PASSWORD);assert.ok(!JSON.stringify(vscode.workspace.getConfiguration('dbWorkbench').get('connections')).includes(process.env.DBW_PG_PASSWORD!));
      const fresh = new (await import('../../packages/core/src/connections.js')).ConnectionManager(api.profileStore,{runnerPath:'unused',credentials:api.credentials});
      try { assert.match((await fresh.connect(pg.id)).info?.serverVersion ?? '',/^17\./); } finally { await fresh.close(); }
      check('PostgreSQL authenticates with verified TLS and a fresh manager retrieves its password from real VS Code SecretStorage');
      await connectionEditorEntryChecks(api,check,pg.id);
      const draftLease=await api.manager.lease(pg.id,'native-draft-credential-test');await draftLease.query('BEGIN');
      await assert.rejects(api.manager.test(pg,'invalid-draft-password'),/password authentication/);assert.equal(draftLease.transactionState,'active');assert.equal(draftLease.connected,true);assert.equal(await api.credentials.get(pg.id),process.env.DBW_PG_PASSWORD);await draftLease.query('ROLLBACK');await api.manager.releaseLease('native-draft-credential-test');check('Testing a draft PostgreSQL password does not alter the real secure credential or an existing document transaction');
      const pgSession=await api.manager.connect(pg.id); await pgSession.query('CREATE TABLE public.native_items(id int PRIMARY KEY,v text,n numeric(30,10))');await pgSession.query("INSERT INTO public.native_items VALUES(1,'before',1.2345678901)");
      const pgConnection=(await api.tree.getChildren()).find(node=>node.profileId===pg.id);assert.ok(pgConnection);const pgDatabase=(await api.tree.getChildren(pgConnection))[0]!;assert.equal(pgDatabase.label,'dbworkbench');
      const pgSchema=(await api.tree.getChildren(pgDatabase)).find(node=>node.section==='schema:public');assert.ok(pgSchema);const pgTables=(await api.tree.getChildren(pgSchema)).find(node=>node.section==='table');assert.ok(pgTables);const pgTable=(await api.tree.getChildren(pgTables)).find(node=>node.object?.name==='public.native_items');assert.ok(pgTable);assert.equal(pgTable.label,'native_items');
      await vscode.commands.executeCommand('dbWorkbench.openTable',pgTable);await until(()=>api.tableEditors.getDocuments().some(doc=>doc.model.profile.id===pg.id && doc.initialized.size>0),'PostgreSQL table Webview initializes');
      const pgDocument=api.tableEditors.getDocuments().find(doc=>doc.model.profile.id===pg.id)!;assert.equal(pgDocument.model.state().result.rows[0]?.n,'1.2345678901');
      api.tableEditors.update(pgDocument,pgDocument.model.state().revision,{keyColumns:['id'],added:[],edits:{r0:{kind:'update',original:pgDocument.model.state().result.rows[0],values:{v:'native saved'}}}});
      await vscode.commands.executeCommand('workbench.action.files.save');await until(()=>!pgDocument.model.dirty,'PostgreSQL native grid save');assert.equal((await pgSession.query('SELECT v FROM public.native_items')).rows[0]?.c0,'native saved');check('PostgreSQL schema tree opens a native editable table and Ctrl+S commits actual database rows');
      const pgBefore = new Set(vscode.workspace.textDocuments.map(doc=>doc.uri.toString()));await vscode.commands.executeCommand('dbWorkbench.newQuery',pgConnection);const pgSql=vscode.workspace.textDocuments.find(doc=>!pgBefore.has(doc.uri.toString())&&doc.languageId==='sql');assert.ok(pgSql);assert.match(pgSql.getText(),/SELECT version\(\)/);
      const pgOwner=pgSql.uri.toString();const pgRun=await api.sqlDocuments.run(pgOwner,"BEGIN; UPDATE public.native_items SET v='pending'; SELECT v FROM public.native_items;");assert.equal(pgRun.status,'succeeded');assert.equal(api.sqlDocuments.state(pgOwner).transaction,'active');assert.equal((await pgSession.query('SELECT v FROM public.native_items')).rows[0]?.c0,'native saved');await api.sqlDocuments.transaction(pgOwner,'rollback');assert.equal(api.sqlDocuments.state(pgOwner).transaction,'idle');check('Native PostgreSQL SQL documents use independent transactions and server-specific query templates');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');await api.manager.remove(pg.id);assert.equal(await api.credentials.get(pg.id),undefined);check('Deleting a PostgreSQL connection removes its secure credential');
      const ssh=await sshFixture({allowedPort:Number(process.env.DBW_PG_PORT),mapHost:()=> '127.0.0.1'});
      try{
        const authentication=AuthenticationSchema.parse({id:'native-auth',name:'Native shared credentials',kind:'password',user:'dbw',scope:'workspace'}),tunnel=TunnelSchema.parse({id:'native-ssh',name:'Native SSH tunnel',kind:'ssh',host:'127.0.0.1',port:ssh.port,user:'ssh-user',auth:'password',fingerprint:ssh.fingerprint,scope:'workspace'});
        await api.resources.save('authentication',authentication,{secret:process.env.DBW_PG_PASSWORD,remember:true,revision:api.resources.revision('authentication',authentication.id)});await api.resources.save('tunnel',tunnel,{secret:'ssh-test-password',remember:true,revision:api.resources.revision('tunnel',tunnel.id)});
        const shared=ProfileSchema.parse({...pg,id:'native-shared',name:'Shared authentication and SSH',host:'localhost',user:undefined,authRef:authentication.id,tunnelRef:tunnel.id});await api.manager.save(shared);
        const sharedSession=await api.manager.connect(shared.id);assert.equal(sharedSession.info?.tls,'verify-full');assert.equal((await sharedSession.query('SELECT current_user')).rows[0]?.c0,'dbw');assert.equal(api.tunnels.status()[0]?.references,1);assert(api.authTree.getChildren().some(node=>node.value.id===authentication.id));assert(api.tunnelTree.getChildren().some(node=>node.value.id===tunnel.id));
        await assert.rejects(api.resources.remove('authentication',authentication.id),/Shared authentication and SSH/);await assert.rejects(api.resources.remove('tunnel',tunnel.id),/Shared authentication and SSH/);assert(!JSON.stringify(vscode.workspace.getConfiguration('dbWorkbench').get('authenticationProfiles')).includes(process.env.DBW_PG_PASSWORD!));check('Native Authentication Profiles and Tunnels persist metadata, use SecretStorage and connect PostgreSQL through verified SSH/TLS');
        const lease=await api.manager.lease(shared.id,'native-shared-sql');await lease.query('BEGIN');const before=lease.id;await api.resources.save('authentication',{...authentication,name:'Renamed shared credentials'},{remember:true,revision:api.resources.revision('authentication',authentication.id)});assert.equal((await api.manager.lease(shared.id,'native-shared-sql')).id,before);assert.equal(lease.transactionState,'active');await lease.query('ROLLBACK');
        await api.manager.remove(shared.id);assert.equal(api.tunnels.status().length,0);await api.resources.remove('authentication',authentication.id);await api.resources.remove('tunnel',tunnel.id);check('Shared profile rename preserves SQL transactions; occupied profile deletion is blocked and final disconnect releases the SSH listener');
      }finally{await ssh.close();}
      const commandProfile=AuthenticationSchema.parse({id:'native-command',name:'Native credential command',kind:'command',user:'dbw',executable:process.env.DBW_TEST_NODE!,args:['-e','process.stdout.write(JSON.stringify({user:process.env.DBW_AUTH_USER,password:process.env.DBW_PG_PASSWORD,expires:(Date.now()+60000)/1000}))'],output:'json',userPath:'user',expiresAtPath:'expires',cacheTtl:60,scope:'workspace'});
      await api.resources.save('authentication',commandProfile,{remember:false,revision:api.resources.revision('authentication',commandProfile.id)});const external=ProfileSchema.parse({...pg,id:'native-external',authRef:commandProfile.id,user:undefined});await api.manager.save(external);const externalSession=await api.manager.lease(external.id,'native-external');assert.equal((await externalSession.query('SELECT current_user')).rows[0]?.c0,'dbw');await externalSession.query('BEGIN');api.resources.clearCredentials(commandProfile.id);assert.equal((await api.manager.test(external)).tls,'verify-full');assert.equal(externalSession.transactionState,'active');await externalSession.query('ROLLBACK');assert(!JSON.stringify(vscode.workspace.getConfiguration('dbWorkbench').get('authenticationProfiles')).includes(process.env.DBW_PG_PASSWORD!));check('Native credential command resolves JSON output, expires in memory and clears cache without interrupting a SQL transaction');
      await api.manager.remove(external.id);await api.resources.remove('authentication',commandProfile.id);
      const passfile=join(output,'native-test.pgpass');try{
        await writeFile(passfile,`127.0.0.1:${pg.port}:dbworkbench:dbw:${process.env.DBW_PG_PASSWORD}\n`,{mode:0o600});const fileProfile=AuthenticationSchema.parse({id:'native-pgpass',name:'Native pgpass',kind:'pgpass',path:passfile,user:'dbw',scope:'workspace'});await api.resources.save('authentication',fileProfile,{remember:false,revision:api.resources.revision('authentication',fileProfile.id)});const fileConnection=ProfileSchema.parse({...pg,id:'native-file-auth',user:undefined,authRef:fileProfile.id});await api.manager.save(fileConnection);assert.equal((await api.manager.test(fileConnection)).tls,'verify-full');await writeFile(passfile,'*:*:*:*:invalid-password');await assert.rejects(api.manager.test(fileConnection),/password authentication/);await api.manager.remove(fileConnection.id);await api.resources.remove('authentication',fileProfile.id);check('Native pgpass provider authenticates verified PostgreSQL TLS and rereads rotated passwords');
      }finally{await unlink(passfile);}
      const config=join(output,'ssh_config'),known=join(output,'known_hosts'),configuration=vscode.workspace.getConfiguration('dbWorkbench'),beforePaths=configuration.inspect<string[]>('sshConfigPaths')?.workspaceValue,configSsh=await sshFixture({allowedPort:Number(process.env.DBW_PG_PORT),mapHost:()=> '127.0.0.1'});
      try{
        await writeFile(known,`[127.0.0.1]:${configSsh.port} ${configSsh.publicHostKey}`);const text=`Host native-config\n HostName 127.0.0.1\n Port ${configSsh.port}\n User ssh-user\n PubkeyAuthentication no\n UserKnownHostsFile "${known}"\n GlobalKnownHostsFile none\n`;await writeFile(config,text);await configuration.update('sshConfigPaths',[config],vscode.ConfigurationTarget.Workspace);await api.sshConfigs.refresh();const discovered=api.resources.list().tunnels.find(v=>v.name==='native-config')!;assert(discovered?.source);assert.equal(discovered.source.issues.length,0);const node=api.tunnelTree.getChildren().find(node=>node.value.id===discovered.id)!;assert.equal(node.contextValue,'sshConfigTunnel');
        await api.resources.saveTunnelCredentials(discovered.id,{password:'ssh-test-password',remember:true,revision:api.resources.revision('tunnel',discovered.id)});assert(!JSON.stringify(configuration.get('tunnels')).includes(discovered.id));const sourceConnection=ProfileSchema.parse({...pg,id:'native-source',host:'localhost',tunnelRef:discovered.id});await api.manager.save(sourceConnection);await api.manager.setPassword(sourceConnection.id,process.env.DBW_PG_PASSWORD!,'session');const sourceLease=await api.manager.lease(sourceConnection.id,'native-source');assert.equal(sourceLease.info?.tls,'verify-full');await sourceLease.query('BEGIN');
        const views=api.initializedViews();await vscode.commands.executeCommand('dbWorkbench.tunnel.edit',node);await until(()=>api.initializedViews()>views,'Read-only SSH Config Webview initializes');await vscode.commands.executeCommand('dbWorkbench.tunnel.source',node);const actualSource=vscode.window.activeTextEditor?.document.uri.fsPath;assert.equal(process.platform==='win32'?actualSource?.toLowerCase():actualSource,process.platform==='win32'?config.toLowerCase():config);await vscode.commands.executeCommand('dbWorkbench.tunnel.delete',node);assert.equal(vscode.window.activeTextEditor?.document.getText(),text);await assert.rejects(api.resources.remove('tunnel',discovered.id),/read-only/);check('SSH Config discovery creates a source-labelled read-only native editor, stores credentials separately and connects PostgreSQL through known_hosts-verified SSH');
        await writeFile(config,'# source line moved\n'+text);await until(()=>api.resources.list().tunnels.find(v=>v.id===discovered.id)?.source?.line===2,'Filesystem watcher refreshes SSH Config automatically');assert.equal(await api.manager.lease(sourceConnection.id,'native-source'),sourceLease);assert.equal(sourceLease.transactionState,'active');await writeFile(config,text.replace(`Port ${configSsh.port}`,`Port ${configSsh.port+1}`));await until(()=>api.resources.list().tunnels.find(v=>v.id===discovered.id)?.port===configSsh.port+1,'Watcher refreshes changed endpoint');await assert.rejects(api.manager.lease(sourceConnection.id,'native-source'),/settings changed/);await api.manager.remove(sourceConnection.id);assert.equal(api.tunnels.status().length,0);await writeFile(config,'# Host removed\n');await until(()=>!api.resources.list().tunnels.some(v=>v.id===discovered.id),'Removing the Host entry removes the discovered tunnel');check('SSH Config directory watcher preserves transactions for source-only changes and rejects changed endpoints or removed aliases without replay');
      }finally{await configuration.update('sshConfigPaths',beforePaths,vscode.ConfigurationTarget.Workspace);await api.sshConfigs.refresh();await configSsh.close();}
    }
    await diagnosticChecks(api as typeof api & {diagnosticService:import('../../packages/extension/src/diagnostics.js').Diagnostics;extensionContext:vscode.ExtensionContext;configureTestWebview(panel:vscode.WebviewPanel):void},output,check);
    evidence.passed = true;
  } catch (error) { evidence.error = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
  finally { cancellation.dispose(); await mkdir(output, { recursive: true }); await writeFile(join(output, 'extension-integration.json'), JSON.stringify(evidence, null, 2)); }
}

