import {parentPort} from 'node:worker_threads';
import {currentSql} from '../../core/src/sql-editing.js';
import {currentParameterizedSql} from '../../core/src/sql-parameters.js';
import {sqlCompletions} from '../../core/src/sql-completion.js';
import {formatSql} from '../../core/src/sql-formatting.js';
parentPort!.on('message',({id,method,params})=>{try{const result=method==='current'?(params.parameters?currentParameterizedSql:currentSql)(params.text,params.offset,params.driver,params.mode):method==='completion'?sqlCompletions(params.text,params.offset,params.driver,params.objects,params.mode,params.parameters):method==='format'?formatSql(params.text,params.driver,params.options,params.eol,{parameters:params.parameters,mode:params.mode,selection:params.selection}):(()=>{throw new Error('Unknown SQL worker operation.');})();parentPort!.postMessage({id,result});}catch(error){parentPort!.postMessage({id,error:error instanceof Error?error.message:String(error)});}});
