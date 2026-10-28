import {defaultPort,driverNames,isMysqlFamily} from '../../protocol/src/index.js';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/src/connections.js';
import type { SchemaObject } from '../../protocol/src/index.js';
import { ConnectionOrganization, matchesObject, orderedGroups } from '../../core/src/connection-organization.js';

export class DbNode extends vscode.TreeItem {
  constructor(label: string, readonly kind: 'group' | 'connection' | 'database' | 'folder' | 'object' | 'leaf', readonly profileId: string, readonly object?: SchemaObject, readonly section?: string, readonly items?: DbNode[]) {
    super(label, kind === 'leaf' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = kind;
  }
}
export class ConnectionsTree implements vscode.TreeDataProvider<DbNode>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<DbNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private manager: ConnectionManager, private log: (error: unknown) => void, private organization: ConnectionOrganization, private defaultConnection: () => string) {}
  refresh(): void { this.emitter.fire(undefined); void vscode.commands.executeCommand('setContext', 'dbWorkbench.empty', !this.manager.profiles().length); void vscode.commands.executeCommand('setContext', 'dbWorkbench.filtered', Boolean(this.organization.filter)); }
  getTreeItem(node: DbNode): DbNode { return node; }
  async getChildren(node?: DbNode): Promise<DbNode[]> {
    if (!node) {
      const profiles = this.organization.profiles();
      const groups = new Map<string, DbNode[]>();
      for (const profile of profiles) {
        const item = new DbNode(profile.name, 'connection', profile.id);
        const connected = this.manager.isConnected(profile.id);
        item.id = JSON.stringify(['connection', profile.id]); item.contextValue = connected ? 'connection-connected' : 'connection';
        const info = this.manager.runtimeInfo(profile.id);
        item.description = [this.defaultConnection() === profile.id ? 'Default' : '', connected ? `Connected · ${info?.driver && info.driver !== 'sqlite' ? `${driverNames[info.driver]} ${info.serverVersion}` : info?.sqlite ?? 'SQLite'}` : profile.storage === 'memory' ? 'In memory' : profile.driver !== 'sqlite' ? driverNames[profile.driver] : ''].filter(Boolean).join(' · ');
        item.tooltip = `${profile.name}\n${profile.driver !== 'sqlite' ? `${this.manager.connectionUser(profile)}@${profile.host}:${profile.port ?? defaultPort(profile.driver)}/${profile.database??''}${profile.tunnelRef?'\nSSH tunnel enabled':''}` : profile.storage === 'memory' ? 'In memory' : profile.path}${profile.readOnly ? '\nRead only' : ''}`;
        item.iconPath = vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${profile.color}" stroke-width="1.8"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>`)}`);
        const group = groups.get(profile.group) ?? []; group.push(item); groups.set(profile.group, group);
      }
      const favorites = this.organization.favorites().filter(favorite => profiles.some(profile => profile.id === favorite.profileId)).map(favorite => {
        const item = this.objectNode(favorite.profileId, { name: favorite.name, type: favorite.type, sql: null }, true); item.description = profiles.find(profile => profile.id === favorite.profileId)?.name; return item;
      });
      const favoriteFolder = new DbNode('Favorites', 'folder', '', undefined, 'favorites', favorites); favoriteFolder.id = 'favorites'; favoriteFolder.iconPath = new vscode.ThemeIcon('star-full');
      return [...(favorites.length ? [favoriteFolder] : []), ...(groups.get('') ?? []), ...orderedGroups([...groups.keys()], this.organization.groups()).map(name => {
        const group = new DbNode(name, 'group', '', undefined, name, groups.get(name)); group.id = JSON.stringify(['group', name]); group.iconPath = new vscode.ThemeIcon('folder'); return group;
      })];
    }
    if (node.items) return node.items;
    try {
      if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before connecting to a database.');
      const session = await this.manager.connect(node.profileId);
      if (node.kind === 'connection') {
        if(session.databases)return (await session.databases()).map(name=>{const item=new DbNode(name,'database',node.profileId,undefined,name);item.id=JSON.stringify(['database',node.profileId,name]);item.iconPath=new vscode.ThemeIcon('database');return item;});
        const name = this.manager.profile(node.profileId).database ?? 'main';
        const item = new DbNode(name, 'database', node.profileId); item.id = JSON.stringify(['database', node.profileId, name]); item.iconPath = new vscode.ThemeIcon('database'); return [item];
      }
      if (node.kind === 'database') {
        const schema = await session.schema();
        const folders = (items: SchemaObject[]) => (['table', 'view'] as const).map(type => {
          const filter = this.organization.objectFilter(node.profileId);
          const objects = items.filter(item => item.type === type && matchesObject(item.label ?? item.name, filter)).map(object => this.objectNode(node.profileId, object));
          const folder = new DbNode(type === 'table' ? 'Tables' : 'Views', 'folder', node.profileId, undefined, type, objects);
          folder.contextValue = 'folder-filterable'; folder.description = `${objects.length}${filter ? ' · filtered' : ''}`; folder.tooltip = filter ? `LIKE filter: ${filter}` : undefined; folder.iconPath = new vscode.ThemeIcon(type === 'table' ? 'table' : 'preview'); return folder;
        });
        if (this.manager.profile(node.profileId).driver !== 'postgresql') return folders(isMysqlFamily(this.manager.profile(node.profileId).driver)?schema.filter(item=>item.schema===(node.section??this.manager.profile(node.profileId).database)):schema);
        return [...new Set(schema.map(object=>object.schema ?? 'public'))].map(name=>{
          const item = new DbNode(name,'folder',node.profileId,undefined,`schema:${name}`,folders(schema.filter(object=>object.schema===name)));
          item.id = JSON.stringify(['schema',node.profileId,name]);item.contextValue='schema';item.iconPath=new vscode.ThemeIcon('symbol-namespace');return item;
        });
      }
      if (node.kind === 'object' && node.object) {
        const details = await session.details(node.object.name);
        const leaves = (labels: { label: string; description?: string; tooltip?: string }[], icon: string) => labels.map(value => {
          const item = new DbNode(value.label, 'leaf', node.profileId); item.description = value.description; item.tooltip = value.tooltip; item.iconPath = new vscode.ThemeIcon(icon); return item;
        });
        const groups: [string, string, DbNode[]][] = [
          ['Columns', 'symbol-field', leaves(details.columns.map(c => ({ label: c.name, description: c.dataType, tooltip: `${c.name} ${c.dataType}${c.primaryKey ? ' PRIMARY KEY' : ''}${c.nullable ? '' : ' NOT NULL'}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}${c.generated ? ' GENERATED' : ''}` })), 'symbol-field')],
          ['Primary Key', 'key', leaves(details.columns.filter(c => c.primaryKey).sort((a, b) => a.primaryKey - b.primaryKey).map(c => ({ label: c.name })), 'key')],
          ['Indexes', 'list-tree', leaves(details.indexes.map(i => ({ label: i.name, description: i.unique ? 'UNIQUE' : undefined, tooltip: i.columns.join(', ') })), 'list-tree')],
          ['Foreign Keys', 'references', leaves(details.foreignKeys.map(f => ({ label: `${f.from} → ${f.table}.${f.to}`, tooltip: `ON UPDATE ${f.onUpdate}, ON DELETE ${f.onDelete}` })), 'references')],
        ];
        return groups.map(([name, icon, items]) => { const item = new DbNode(name, 'folder', node.profileId, undefined, name, items); item.description = String(items.length); item.iconPath = new vscode.ThemeIcon(icon); return item; });
      }
      return [];
    } catch (error) { this.log(error); throw error; }
  }
  private objectNode(profileId: string, object: SchemaObject, favorite = false): DbNode {
    const item = new DbNode(object.label ?? object.name, 'object', profileId, object); item.id = JSON.stringify([favorite ? 'favorite' : 'object', profileId, object.type, object.name]);
    item.contextValue = this.organization.isFavorite(profileId, object) ? 'object-favorite' : 'object'; item.iconPath = new vscode.ThemeIcon(object.type === 'table' ? 'table' : 'preview');
    item.command = { command: 'dbWorkbench.openTable', title: 'Open Table', arguments: [item] }; item.tooltip = object.sql ?? object.name; return item;
  }
  dispose(): void { this.emitter.dispose(); }
}
