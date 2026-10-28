/** Runs before the application bundle, including when app.js cannot load. No external assets. */
export const webviewBootstrap = `(()=>{
  const api=typeof acquireVsCodeApi==='function'?acquireVsCodeApi():undefined;
  const initial=document.getElementById('dbw-startup'),root=document.getElementById('root'),status=document.getElementById('dbw-startup-status');
  let ready=false;
  const post=(event,details={})=>{try{api?.postMessage({diagnostic:'db-workbench',event,...details});}catch{}};
  const fail=(stage,message,stack='',fatal=!ready)=>{
    post('error',{stage,message:String(message).slice(0,3000),stack:String(stack).slice(0,6000)});
    if(fatal){initial.hidden=false;root.style.display='none';status.textContent='页面启动失败 / View failed to start: '+String(message).slice(0,1500);}
  };
  const timer=setTimeout(()=>fail('webview.bootstrap.timeout','20 秒内未收到页面初始化确认。可能是本地脚本加载或 Webview 通信失败；请打开诊断报告。'),20000);
  window.__dbwBoot={api,ready(){ready=true;clearTimeout(timer);initial.hidden=true;root.style.display='';post('ready');},report:fail};
  window.addEventListener('error',event=>{if(event.target&&event.target.tagName==='SCRIPT')fail('webview.script.load','本地页面脚本加载失败 / Local application script failed to load.');else fail('webview.javascript',event.message||'JavaScript error',event.error?.stack||'');},true);
  window.addEventListener('unhandledrejection',event=>fail('webview.promise',event.reason?.message||String(event.reason),event.reason?.stack||''));
  post('boot');
})();`;
