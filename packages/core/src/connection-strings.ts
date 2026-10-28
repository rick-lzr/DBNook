import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMysqlFamily, type ConnectionProfile } from '../../protocol/src/index.js';
import { parsePostgresString } from './postgresql-strings.js';
import { parseMysqlString } from './mysql-strings.js';

export interface ParsedConnectionString extends Partial<Pick<ConnectionProfile,'driver'|'host'|'port'|'database'|'user'|'sslMode'|'caPath'|'certPath'|'keyPath'|'connectTimeout'|'applicationName'>> {
  storage: ConnectionProfile['storage']; path: string; readOnly: boolean; createIfMissing: boolean; suggestedName: string;
  password?: string;
}
export interface PathContext { platform?: NodeJS.Platform; baseDirectory?: string; }
function absolutePath(value: string, context: PathContext): string {
  const windows = (context.platform ?? process.platform) === 'win32', paths = windows ? path.win32 : path.posix;
  if (!value || value.includes('\0')) throw new Error('The connection string needs a valid database path.');
  if (!windows && (/^[a-z]:/i.test(value) || value.startsWith('\\\\'))) throw new Error('This Windows database path cannot be opened on this platform.');
  if (windows && /^[\\/](?![\\/])/.test(value)) throw new Error('Use a Windows path with a drive letter or a UNC share.');
  if (paths.isAbsolute(value)) return paths.normalize(value);
  if (windows && /^[a-z]:/i.test(value)) throw new Error('Drive-relative database paths are ambiguous. Use an absolute path.');
  if (!context.baseDirectory || !paths.isAbsolute(context.baseDirectory)) throw new Error('Open a workspace or provide an absolute database path.');
  return paths.resolve(context.baseDirectory, value);
}
export function parseConnectionString(input: string, context: PathContext = {}): ParsedConnectionString {
  let value = input.trim(); if (!value || value.length > 100000 || value.includes('\0')) throw new Error('Enter a valid database connection string.');
  if(/^(?:jdbc:)?(?:mysql|mariadb):/i.test(value))return parseMysqlString(value);
  if (/^(?:jdbc:)?postgres(?:ql)?:/i.test(value)||/^[A-Za-z_][\w]*\s*=/.test(value)) return parsePostgresString(value,context);
  const windows = (context.platform ?? process.platform) === 'win32', paths = windows ? path.win32 : path.posix;
  let uri = false, query = '', database = value;
  if (/^jdbc:sqlite:/i.test(value)) value = value.slice('jdbc:sqlite:'.length);
  else if (/^sqlite(?:\+pysqlite)?:\/\//i.test(value)) {
    value = value.replace(/^sqlite(?:\+pysqlite)?:\/\//i, '');
    if (value === '' || value === '/') value = ':memory:';
    else if (!value.startsWith('/')) throw new Error('SQLite connection strings do not use a hostname.');
    else value = value.slice(1);
    uri = true;
  } else if (/^[a-z][\w+.-]*:/i.test(value) && !/^file:/i.test(value) && !/^[a-z]:[\\/]/i.test(value) && value !== ':memory:') throw new Error('This build can import SQLite connection strings. Select a supported SQLite format.');
  if (/^file:/i.test(value)) { value = value.slice(5); uri = true; }
  if (uri) {
    const question = value.indexOf('?'), fragment = value.indexOf('#');
    const pathEnd = Math.min(question < 0 ? value.length : question, fragment < 0 ? value.length : fragment);
    database = value.slice(0, pathEnd); if (question >= 0 && (fragment < 0 || question < fragment)) query = value.slice(question + 1, fragment < 0 ? undefined : fragment);
  } else database = value;
  const options = new URLSearchParams(query); const seen = new Set<string>();
  for (const [key] of options) {
    if (seen.has(key)) throw new Error('Duplicate connection string options are ambiguous.'); seen.add(key);
    if (!['mode', 'cache', 'uri'].includes(key)) throw new Error(`Unsupported SQLite connection option: ${key}. Configure supported fields explicitly.`);
  }
  if (options.has('uri') && options.get('uri') !== 'true' && options.get('uri') !== '1') throw new Error('Only uri=true is supported.');
  const mode = options.get('mode') ?? 'rwc'; if (!['ro', 'rw', 'rwc', 'memory'].includes(mode)) throw new Error('SQLite mode must be ro, rw, rwc or memory.');
  if (database === ':memory:' || database === '/:memory:' || mode === 'memory') {
    if (database !== ':memory:' && database !== '/:memory:') throw new Error('Named memory databases shared across connection profiles are not supported yet. Use :memory:.');
    if (options.has('cache') && options.get('cache') !== 'shared') throw new Error('Memory document sessions use shared cache. Only cache=shared is supported for memory connection strings.');
    return { storage: 'memory', path: '', readOnly: mode === 'ro', createIfMissing: false, suggestedName: 'In-memory SQLite' };
  }
  if (options.has('cache') && options.get('cache') !== 'private') throw new Error('Only cache=private is supported for file connections.');
  if (uri) {
    try {
      if (database.startsWith('//') || database.startsWith('/')) {
        const url = new URL(`file:${database}`);
        if (url.hostname && url.hostname !== 'localhost') throw new Error('Use a UNC path or a file URI with an empty authority.');
        database = windows && url.pathname.startsWith('//') ? decodeURIComponent(url.pathname).replaceAll('/', '\\') : fileURLToPath(url, { windows });
      } else database = decodeURIComponent(database);
    } catch (error) { throw new Error(error instanceof Error && /UNC path/.test(error.message) ? error.message : 'The database file URI is malformed or belongs to another platform.'); }
  }
  const file = absolutePath(database, context);
  return { storage: 'file', path: file, readOnly: mode === 'ro', createIfMissing: mode === 'rwc', suggestedName: paths.basename(file) };
}
export function connectionString(profile: ConnectionProfile, platform: NodeJS.Platform = process.platform): string {
  if(isMysqlFamily(profile.driver)){
    const host=profile.host!.includes(':')?`[${profile.host}]`:profile.host,query=new URLSearchParams({sslMode:profile.sslMode??'disable'});
    for(const key of ['caPath','certPath','keyPath','connectTimeout','applicationName']as const)if(profile[key]!==undefined&&profile[key]!=='')query.set(key,String(profile[key]));
    return `${profile.driver}://${profile.user?encodeURIComponent(profile.user)+'@':''}${host}:${profile.port??3306}/${encodeURIComponent(profile.database??'')}?${query.toString().replaceAll('+','%20')}`;
  }
  if (profile.driver === 'postgresql') {
    const host = profile.host!.includes(':') && !profile.host!.startsWith('[') ? `[${profile.host}]` : profile.host;
    const query=new URLSearchParams({sslmode:profile.sslMode??'disable'});
    for(const [key,value]of [['sslrootcert',profile.caPath],['sslcert',profile.certPath],['sslkey',profile.keyPath],['application_name',profile.applicationName],['connect_timeout',profile.connectTimeout===undefined?undefined:String(Math.ceil(profile.connectTimeout/1000))]])if(value!==undefined&&value!=='')query.set(key!,value);
    const endpoint=profile.host!.startsWith('/')?encodeURIComponent(profile.host!):host;
    return `postgresql://${profile.user?encodeURIComponent(profile.user)+'@':''}${endpoint}:${profile.port ?? 5432}/${encodeURIComponent(profile.database!)}?${query.toString().replaceAll('+','%20')}`;
  }
  if (profile.storage === 'memory') return profile.readOnly ? 'file::memory:?mode=ro' : ':memory:';
  const windows = platform === 'win32'; const file = absolutePath(profile.path, { platform });
  const url = pathToFileURL(file, { windows });
  const prefix = url.hostname ? `file:////${url.hostname}${url.pathname}` : url.href;
  return `${prefix}?mode=${profile.readOnly ? 'ro' : profile.createIfMissing ? 'rwc' : 'rw'}`;
}
