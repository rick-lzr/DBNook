import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {statSync} from 'node:fs';
import {diagnosticsFor} from './diagnostics.js';
import {webviewBootstrap} from '../../core/src/webview-bootstrap.js';
export const isWebviewDiagnostic=(raw:unknown):raw is {diagnostic:'db-workbench';event:string;stage?:string;message?:string;stack?:string}=>Boolean(raw&&typeof raw==='object'&&(raw as {diagnostic?:unknown}).diagnostic==='db-workbench');
export function configureWebview(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
  const root = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const diagnostics=diagnosticsFor(context);diagnostics?.info('webview.configured');
  panel.webview.options = { enableScripts: true, localResourceRoots: [root],enableCommandUris:['dbWorkbench.collectDiagnostics','dbWorkbench.showOutput'] };
  if(root.scheme==='file')for(const name of ['app.js','app.css']){try{const s=statSync(vscode.Uri.joinPath(root,name).fsPath);if(!s.isFile()||!s.size)throw new Error('The bundled asset is empty or not a file.');diagnostics?.info('webview.asset',{asset:name,bytes:s.size});}catch(e){diagnostics?.error('webview.asset',e,{asset:name});}}
  const timer=setTimeout(()=>diagnostics?.error('webview.handshake.timeout',new Error('No Webview initialization acknowledgement after 25 seconds. Open DBNook: Collect Diagnostic Report.')),25000);
  const listener=panel.webview.onDidReceiveMessage(raw=>{if(!isWebviewDiagnostic(raw))return;
    if(raw.event==='ready'){clearTimeout(timer);diagnostics?.info('webview.ready');}
    else if(raw.event==='boot')diagnostics?.info('webview.bootstrap');
    else if(raw.event==='error'){const stage=typeof raw.stage==='string'?raw.stage.slice(0,80):'webview.error',message=typeof raw.message==='string'?raw.message.slice(0,3000):'Frontend error',stack=typeof raw.stack==='string'?raw.stack.slice(0,6000):'';diagnostics?.error(stage,new Error(message+(stack?'\n'+stack:'')));}
  });panel.onDidDispose(()=>{clearTimeout(timer);listener.dispose();});
  const nonce = randomBytes(24).toString('base64');
  const resource = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, file));
  panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:;"><link rel="stylesheet" href="${resource('app.css')}"><style>#dbw-startup{position:absolute;inset:0;padding:32px;box-sizing:border-box;overflow:auto;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:13px/1.6 var(--vscode-font-family)}#dbw-startup[hidden]{display:none!important}#dbw-startup a{color:var(--vscode-textLink-foreground);margin-right:18px}#dbw-startup-status{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><div id="dbw-startup"><h2>DBNook</h2><p id="dbw-startup-status">正在加载本地页面 / Loading local application…</p><p><a href="command:dbWorkbench.collectDiagnostics">打开诊断报告 / Open diagnostic report</a><a href="command:dbWorkbench.showOutput">显示日志 / Show output</a></p></div><div id="root"></div><script nonce="${nonce}">${webviewBootstrap}</script><script type="module" nonce="${nonce}" src="${resource('app.js')}"></script></body></html>`;
}
