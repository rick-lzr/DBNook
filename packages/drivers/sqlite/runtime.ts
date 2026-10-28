/** Check APIs, not only sqlite_version(): older Electron/Node can open a DB but cannot read our row format. */
export function assertSqliteFeatures(database:object,statement:object,backup:unknown,nodeVersion=process.versions.node):void {
  const db=database as Record<string,unknown>,s=statement as Record<string,unknown>,missing:string[]=[];
  for(const name of ['columns','setReturnArrays','setReadBigInts','iterate','get','run'])if(typeof s[name]!=='function')missing.push('StatementSync.'+name);
  if(typeof s.sourceSQL!=='string')missing.push('StatementSync.sourceSQL');if(typeof db.isTransaction!=='boolean')missing.push('DatabaseSync.isTransaction');if(typeof backup!=='function')missing.push('sqlite.backup');
  if(missing.length)throw new Error(`Unsupported SQLite runtime: Node.js ${nodeVersion} is missing ${missing.join(', ')}. DBNook requires Node.js 22.16+ with these SQLite APIs. Install the Windows x64 offline VSIX with its bundled runtime, or set DBNook: Node Path to a compatible node.exe and reload VS Code.`);
}
