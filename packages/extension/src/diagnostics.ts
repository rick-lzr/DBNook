import * as vscode from 'vscode';
import {randomUUID,createHash} from 'node:crypto';
import {DiagnosticLog,redactDiagnostic,sanitizeDiagnostic} from '../../core/src/diagnostic-log.js';
import {SqliteSession} from '../../drivers/sqlite/session.js';
import {ProfileSchema,errorMessage} from '../../protocol/src/index.js';
import {sqliteRuntimePath} from '../../core/src/sqlite-runtime-path.js';

const services=new WeakMap<vscode.ExtensionContext,Diagnostics>();
export const diagnosticsFor=(context:vscode.ExtensionContext)=>services.get(context);
export class Diagnostics implements vscode.Disposable {
  readonly journal:DiagnosticLog;private reported=new WeakMap<Error,string>();
  constructor(private context:vscode.ExtensionContext,private output:vscode.OutputChannel){
    this.journal=new DiagnosticLog(context.logUri.fsPath,line=>output.appendLine(line));services.set(context,this);
    this.info('activation.started',this.environment());
  }
  environment(){const runtime=sqliteRuntimePath(this.context.extensionUri.fsPath,vscode.workspace.getConfiguration('dbWorkbench').get<string>('nodePath'));return {extensionVersion:this.context.extension.packageJSON.version,vscode:vscode.version,node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch,remote:vscode.env.remoteName??null,trusted:vscode.workspace.isTrusted,nodePath:runtime.path||'(VS Code runtime)',sqliteRuntimeSource:runtime.source};}
  info(stage:string,details?:Record<string,unknown>){this.journal.record('info',stage,'',details);}
  error(stage:string,error:unknown,details?:Record<string,unknown>,notify=false){
    if(error instanceof vscode.CancellationError){this.info(stage+'.cancelled');return '';}
    if(error instanceof Error&&this.reported.has(error))return this.reported.get(error)!;
    const message=error instanceof Error?error.stack??error.message:errorMessage(error),id=this.journal.record('error',stage,message,details);if(error instanceof Error)this.reported.set(error,id);
    if(notify)void vscode.window.showErrorMessage(`DBNook: ${redactDiagnostic(errorMessage(error)).slice(0,500)} [${stage}; ${id.slice(0,8)}]`,'Open diagnostic report','Show output').then(action=>{if(action==='Show output')this.output.show(true);if(action==='Open diagnostic report')void this.openReport().catch(e=>this.error('diagnostics.report',e));});return id;
  }
  show(){this.output.show(true);}
  async report(){
    const assets:Record<string,unknown>={};for(const path of ['dist/extension.cjs','dist/sqlite-runner.cjs','dist/sql-worker.cjs','dist/webview/app.js','dist/webview/app.css']){
      try{const bytes=await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.context.extensionUri,path));assets[path]={present:true,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}catch(e){assets[path]={present:false,error:redactDiagnostic(errorMessage(e))};}
    }
    const nodePath=sqliteRuntimePath(this.context.extensionUri.fsPath,vscode.workspace.getConfiguration('dbWorkbench').get<string>('nodePath')).path,session=new SqliteSession(ProfileSchema.parse({id:randomUUID(),name:'Offline SQLite diagnostic probe',driver:'sqlite',storage:'memory'}),{runnerPath:vscode.Uri.joinPath(this.context.extensionUri,'dist','sqlite-runner.cjs').fsPath,nodePath});let sqliteProbe:unknown;
    try{const runtime=await session.open(),result=await session.query('SELECT 1 AS runtime_probe',1);if(result.columns.length!==1||result.rows[0]?.c0!==1)throw new Error('SQLite query probe returned an unexpected result.');sqliteProbe={ok:true,runtime,queryValidated:true};}catch(e){sqliteProbe={ok:false,error:redactDiagnostic(errorMessage(e))};}finally{await session.close();}
    await this.journal.flush();return sanitizeDiagnostic({format:'db-workbench.diagnostics',version:1,createdAt:new Date().toISOString(),environment:this.environment(),assets,sqliteProbe,logFile:this.journal.path,notes:['Local report; no database rows, SQL documents, saved connection settings or SecretStorage are collected.','The SQLite probe uses a separate in-memory database and does not access your database file.','Recent error text and paths are included; common credential fields are redacted. Review before sharing.'],recent:this.journal.entries()});
  }
  async openReport(){
    const report=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'DBNook: collecting offline diagnostics'},()=>this.report());
    const path=vscode.Uri.joinPath(this.context.logUri,`diagnostic-report-${Date.now()}-${randomUUID()}.json`);let document:vscode.TextDocument;
    try{await vscode.workspace.fs.createDirectory(this.context.logUri);await vscode.workspace.fs.writeFile(path,Buffer.from(JSON.stringify(report,null,2)+'\n'));document=await vscode.workspace.openTextDocument(path);}
    catch(error){this.error('diagnostics.report.save',error);document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify({...report,localSaveError:redactDiagnostic(errorMessage(error)),note:'The report could not be saved to the log directory. Copy this document or use Save As.'},null,2)+'\n'});}
    await vscode.window.showTextDocument(document,{preview:false});return report;
  }
  dispose(){services.delete(this.context);void this.journal.flush();}
}
