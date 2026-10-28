import {join} from 'node:path';
import {existsSync} from 'node:fs';
export function sqliteRuntimePath(extensionDirectory:string,configured?:string,platform=process.platform,arch=process.arch):{path?:string;source:'configured'|'bundled'|'vscode'}{
  if(configured)return {path:configured,source:'configured'};
  if(platform==='win32'&&arch==='x64'){const path=join(extensionDirectory,'runtime','win32-x64','node.exe');if(existsSync(path))return {path,source:'bundled'};}
  return {source:'vscode'};
}
