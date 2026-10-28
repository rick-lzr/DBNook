import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { SqliteEngine } from '../../drivers/sqlite/engine.js';
import { errorMessage, RunnerEnvelopeSchema, type ConnectionProfile, type RpcResponse, type RunnerEvent } from '../../protocol/src/index.js';

const engines = new Map<string, SqliteEngine>();
const memoryName = randomUUID();
let profile: ConnectionProfile | undefined;
function closeAll(): void { for (const engine of engines.values()) engine.close(); engines.clear(); profile = undefined; }
const send = (response: RpcResponse | RunnerEvent): void => { process.stdout.write(JSON.stringify(response) + '\n'); };
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let id = '';
  let engine: SqliteEngine | undefined;
  try {
    const envelope = RunnerEnvelopeSchema.parse(JSON.parse(line)); id = envelope.id;
    const { request, sessionId } = envelope;
    let result: unknown;
    if (request.method === 'open') {
      if (engines.size || sessionId) throw new Error('A database is already open.');
      profile = request.params; engine = new SqliteEngine(profile, { memoryName }); engines.set('', engine); result = engine.info();
    } else if (request.method === 'session.create') {
      if (!profile || sessionId) throw new Error('Create document sessions through the root database connection.');
      if (engines.has(request.params.sessionId)) throw new Error('This document session already exists.');
      engine = new SqliteEngine(profile, { memoryName }); engines.set(request.params.sessionId, engine); result = engine.info();
    } else if (request.method === 'session.release') {
      if (sessionId) throw new Error('Release document sessions through the root database connection.');
      if(engines.get(request.params.sessionId)?.backupBusy)throw new Error('Wait for the backup to stop before releasing this session.');
      engines.get(request.params.sessionId)?.close(); engines.delete(request.params.sessionId); result = null;
    } else {
      engine = engines.get(sessionId ?? '');
      if (!engine) throw new Error('Database is not open.');
      if(engine.backupBusy&&request.method!=='backup.cancel')throw new Error('This session is backing up. Wait for it to finish.');
      switch (request.method) {
        case 'backup.to':result=await engine.backupFile(request.params.path,request.params.operation,progress=>send({version:1,id,event:'backup.progress',progress}));break;
        case 'backup.cancel':engine.cancelBackup(request.params.operation);result=null;break;
        case 'backup.inspect':result=engine.inspectFile();break;
        case 'cursor.open':result=engine.openCursor(request.params.sql);break;
        case 'cursor.next':result=engine.nextCursor(request.params.id,request.params.size);break;
        case 'cursor.close':engine.closeCursor(request.params.id);result=null;break;
        case 'schema': result = engine.schema(); break;
        case 'details': result = engine.details(request.params.table); break;
        case 'table': result = engine.table(request.params); break;
        case 'query': result = engine.query(request.params.sql, request.params.limit); break;
        case 'run': result = engine.run(request.params.sql, request.params.limit, request.params.runId, statement => send({ version: 1, id, event: 'run.statement', statement, session: { transaction: engine!.transactionState } })); break;
        case 'apply': result = engine.apply(request.params.table, request.params.keyColumns, request.params.changes, request.params.requireAutocommit,request.params.expected,request.params.verifyValues); break;
        case 'close': if (sessionId) { engine.close(); engines.delete(sessionId); } else closeAll(); engine = undefined; result = null; break;
      }
    }
    send({ version: 1, id, result, session: engine ? { transaction: engine.transactionState } : undefined });
  } catch (error) { send({ version: 1, id, error: { code: 'SQLITE_ERROR', message: errorMessage(error) }, session: engine ? { transaction: engine.transactionState } : undefined }); }
});
input.on('close', () => { closeAll(); process.exit(0); });
process.on('SIGTERM', () => { closeAll(); process.exit(0); });
