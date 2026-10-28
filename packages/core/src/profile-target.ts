import { defaultPort, type ConnectionProfile } from '../../protocol/src/index.js';
export const profileTarget = (p: ConnectionProfile) => p.driver === 'sqlite'
  ? { driver: p.driver, storage: p.storage, path: p.path }
  : { driver: p.driver, storage: p.storage, path: p.path, host: p.host, port: p.port ?? defaultPort(p.driver), database: p.database??'', user: p.user??'', sslMode: p.sslMode ?? 'disable', caPath: p.caPath ?? '', certPath: p.certPath ?? '', keyPath: p.keyPath ?? '',authRef:p.authRef??'',tunnelRef:p.tunnelRef??'' };
