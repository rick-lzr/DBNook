import { PROTOCOL_VERSION, type GridEditorState, type QueryRun, type QuerySessionState, type RpcResponse, type WebRequestSchema } from '../../protocol/src/index.js';
import './browser-dialog.css';
import type { z } from 'zod';

type VsCodeApi={postMessage(message:unknown):void;getState():unknown;setState(state:unknown):void};
declare global { interface Window { acquireVsCodeApi?: () => VsCodeApi;__dbwBoot?:{api?:VsCodeApi;ready():void;report(stage:string,message:string,stack?:string,fatal?:boolean):void}; } }
const vscode = window.__dbwBoot?.api??(typeof window.acquireVsCodeApi === 'function' ? window.acquireVsCodeApi() : undefined);
export function reportFrontend(stage:string,error:unknown,fatal=false){window.__dbwBoot?.report(stage,error instanceof Error?error.message:String(error),error instanceof Error?error.stack:undefined,fatal);}
let nextId = 0;
const pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void;initialize?:boolean }>();
const listeners = new Set<(result: unknown) => void>();
const editorListeners = new Set<(state: GridEditorState) => void>();
const flushListeners = new Set<(token: string) => void>();
const queryListeners = new Set<(state: QuerySessionState) => void>();
const runListeners = new Set<(run: QueryRun) => void>();
const transferListeners=new Set<(progress:import('../../core/src/data-transfers.js').TransferProgress)=>void>();
const backupListeners=new Set<(progress:import('../../core/src/sqlite-backups.js').BackupProgress)=>void>();
const nativeToolListeners=new Set<(tools:{dump:string;restore:string})=>void>();
export function onNativeTools(listener:(tools:{dump:string;restore:string})=>void){nativeToolListeners.add(listener);return ()=>{nativeToolListeners.delete(listener);};}
export function onBackupProgress(listener:(progress:import('../../core/src/sqlite-backups.js').BackupProgress)=>void){backupListeners.add(listener);return ()=>{backupListeners.delete(listener);};}
export function onTransferProgress(listener:(progress:import('../../core/src/data-transfers.js').TransferProgress)=>void){transferListeners.add(listener);return ()=>{transferListeners.delete(listener);};}
let lastQueryState: QuerySessionState | undefined, lastRun: QueryRun | undefined, lastEditorState: GridEditorState | undefined;
window.addEventListener('message', event => {
  if(event.data?.event==='native-tools'){nativeToolListeners.forEach(listener=>listener(event.data.tools));return;}
  if(event.data?.event==='backup-progress'){backupListeners.forEach(listener=>listener(event.data.progress));return;}
  if(event.data?.event==='transfer-progress'){transferListeners.forEach(listener=>listener(event.data.progress));return;}
  // VS Code dispatches host messages into the webview; event.source is not
  // guaranteed to be window. Correlate versioned request IDs instead.
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.event === 'query-state') { lastQueryState = event.data.state; queryListeners.forEach(listener => listener(event.data.state)); return; }
  if (event.data.event === 'query-run') { lastRun = event.data.run; runListeners.forEach(listener => listener(event.data.run)); return; }
  if (event.data.event === 'editor-state') { lastEditorState = event.data.state; editorListeners.forEach(listener => listener(event.data.state)); return; }
  if (event.data.event === 'editor-flush') { flushListeners.forEach(listener => listener(event.data.token)); return; }
  if (event.data?.event === 'result') { listeners.forEach(listener => listener(event.data.result)); return; }
  const response = event.data as RpcResponse;
  if (response?.version !== PROTOCOL_VERSION) return;
  const request = pending.get(response.id); if (!request) return;
  if(request.initialize)window.__dbwBoot?.ready();
  pending.delete(response.id);
  response.error ? request.reject(new Error(response.error.message)) : request.resolve(response.result);
});
/** Browser previews have no VS Code revert dialog; keep the discard decision explicit and accessible. */
function confirmBrowserDiscard():Promise<boolean>{
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='discard-confirmation';
    dialog.setAttribute('aria-labelledby','discard-confirmation-title');
    dialog.innerHTML='<h2 id="discard-confirmation-title">Discard unsaved changes?</h2><p>Your saved database rows will not change.</p><div><button type="button" data-keep>Keep editing</button><button type="button" data-discard>Discard changes</button></div>';
    dialog.addEventListener('close',()=>{const discard=dialog.returnValue==='discard';dialog.remove();resolve(discard);},{once:true});
    dialog.querySelector<HTMLButtonElement>('[data-keep]')!.addEventListener('click',()=>dialog.close('keep'));
    dialog.querySelector<HTMLButtonElement>('[data-discard]')!.addEventListener('click',()=>dialog.close('discard'));
    document.body.append(dialog);dialog.showModal();dialog.querySelector<HTMLButtonElement>('[data-keep]')!.focus();
  });
}
export async function rpc<T>(request: z.infer<typeof WebRequestSchema>): Promise<T> {
  if (!vscode) {
    if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') throw new Error('Open this view in VS Code.');
    if(request.method==='clipboard.write'){await navigator.clipboard.writeText(request.params.text);return null as T;}
    if(request.method==='clipboard.read')return await navigator.clipboard.readText() as T;
    if(request.method==='confirm.discard'&&!await confirmBrowserDiscard())return false as T;
    const response = await fetch(`/api${location.search}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    const data = await response.json() as RpcResponse & { editorState?: GridEditorState; queryState?: QuerySessionState };
    if (data.queryState) { lastQueryState = data.queryState; queryListeners.forEach(listener => listener(data.queryState!)); }
    if (data.error) throw new Error(data.error.message);
    if (data.editorState) { lastEditorState = data.editorState; editorListeners.forEach(listener => listener(data.editorState!)); }
    return data.result as T;
  }
  const id = String(++nextId);
  return new Promise<T>((resolve, reject) => { pending.set(id, { resolve: value => resolve(value as T), reject,initialize:request.method==='initialize' }); vscode.postMessage({ version: PROTOCOL_VERSION, id, request }); });
}
export function onResult(listener: (result: unknown) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function onEditorState(listener: (state: GridEditorState) => void): () => void { editorListeners.add(listener); if (lastEditorState) listener(lastEditorState); return () => { editorListeners.delete(listener); }; }
export function onEditorFlush(listener: (token: string) => void): () => void { flushListeners.add(listener); return () => { flushListeners.delete(listener); }; }
export function onQueryState(listener: (state: QuerySessionState) => void): () => void { queryListeners.add(listener); if (lastQueryState) listener(lastQueryState); return () => { queryListeners.delete(listener); }; }
export function onQueryRun(listener: (run: QueryRun) => void): () => void { runListeners.add(listener); if (lastRun) listener(lastRun); return () => { runListeners.delete(listener); }; }
export function getState<T>(): T | undefined { return vscode?.getState() as T | undefined; }
export function setState(state: unknown): void { vscode?.setState(state); }
