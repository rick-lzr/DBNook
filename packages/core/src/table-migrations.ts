import type {ConnectionManager} from './connections.js';
import type {DriverSession} from '../../driver-sdk/src/index.js';
import type {DdlIntent,TableStructure} from '../../protocol/src/ddl.js';
import {sqliteTableMigration} from './sqlite-table-migration.js';
import {serverTableMigration} from './server-table-migration.js';
export async function tableMigration(manager:ConnectionManager,session:DriverSession,structure:TableStructure,intent:Extract<DdlIntent,{action:'editDefinition'}>){
 if(!structure.editable||structure.type!=='table')throw new Error('This table needs a dedicated schema migration. Definition viewing remains available.');
 return session.profile.driver==='sqlite'?sqliteTableMigration(manager,structure,intent):serverTableMigration(session.profile.driver,structure,intent);
}
