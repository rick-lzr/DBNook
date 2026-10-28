import {Worker} from 'node:worker_threads';
export class SqlWorkerClient{
  private worker?:Worker;private next=0;private closed=false;
  private pending=new Map<number,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private path:string){}
  request<T>(method:string,params:unknown):Promise<T>{
    if(this.closed)return Promise.reject(new Error('SQL language worker is closed.'));
    if(this.pending.size>=32)return Promise.reject(new Error('SQL language worker is busy. Retry shortly.'));
    if(!this.worker){const worker=new Worker(this.path);this.worker=worker;worker.on('message',message=>{const request=this.pending.get(message.id);if(!request)return;this.pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(new Error(message.error)):request.resolve(message.result);});worker.on('error',error=>{if(this.worker===worker)this.fail(error);});worker.on('exit',code=>{if(this.worker===worker){this.worker=undefined;this.fail(new Error(`SQL language worker exited (${code}).`));}});}
    const id=++this.next;return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>this.fail(new Error('SQL language request timed out.')),10000);this.pending.set(id,{resolve:value=>resolve(value as T),reject,timer});this.worker!.postMessage({id,method,params});});
  }
  private fail(error:Error){const worker=this.worker;this.worker=undefined;void worker?.terminate();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  dispose(){this.closed=true;this.fail(new Error('SQL language worker closed.'));}
}
