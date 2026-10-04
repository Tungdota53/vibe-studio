import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath, isSensitivePath } from '../security.js';

const mime: Record<string,string> = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp', '.gif':'image/gif', '.ico':'image/x-icon', '.woff2':'font/woff2', '.mp4':'video/mp4' };
const protectedPath=(value:string)=>isSensitivePath(value)||/(^|[\\/])(\.env|credentials?|secrets?|private[_-]?key|token|\.git|\.vibe|\.codex|\.agents|node_modules)(?=[\\/.]|$)/i.test(value);
const bridge = `<script>(()=>{const emit=(kind,args)=>parent.postMessage({vibePreview:true,kind,text:args.map(x=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}}).join(' ').slice(0,8000)},'*');for(const kind of ['log','warn','error']){const original=console[kind];console[kind]=(...args)=>{original.apply(console,args);emit(kind,args)}}addEventListener('error',e=>emit('error',[e.message,e.filename,e.lineno]));addEventListener('unhandledrejection',e=>emit('error',[String(e.reason)]));addEventListener('DOMContentLoaded',()=>emit('ready',[document.title||'Preview ready']));})();</script>`;
const inspectorBridge=`<script>addEventListener('message',event=>{if(event.source!==parent||event.data?.vibeInspect!==true)return;const images=[...document.images];const controls=[...document.querySelectorAll('button,input,select,textarea')];const observation={viewport:{width:innerWidth,height:innerHeight},horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,brokenImages:images.filter(image=>image.complete&&image.naturalWidth===0).slice(0,40).map(image=>image.getAttribute('src')),imagesWithoutAlt:images.filter(image=>!image.hasAttribute('alt')).length,controlsWithoutName:controls.filter(control=>!control.getAttribute('aria-label')&&!control.getAttribute('aria-labelledby')&&!control.labels?.length&&!control.textContent?.trim()&&!control.getAttribute('title')).length,scope:'DOM layout and naming candidates only; no user flow, screen-reader or browser engine coverage'};parent.postMessage({vibePreview:true,kind:'inspection',text:JSON.stringify(observation),observation},'*');});</script>`;
/** Isolated origin: no backend routes, no app credentials, only explicitly previewed web assets. */
export class WebPreview {
  private server?: http.Server;
  private watcher?: fs.FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private root = '';
  private nonce = '';
  async start(workspace: string, entry: string, onChange?:()=>void) {
    await this.close();
    const file = safePath(workspace, entry || 'index.html');
    if (path.extname(file).toLowerCase() !== '.html' || protectedPath(path.relative(workspace,file)) || protectedPath(path.relative(workspace,fs.realpathSync(file))) || !fs.statSync(file).isFile()) throw new Error('Chọn tệp HTML trong workspace.');
    this.root = path.dirname(file); this.nonce = crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req,res)=>{
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const prefix = '/' + this.nonce + '/';
        if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
        const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || path.basename(file);
        if (protectedPath(relative)) throw new Error('Protected file');
        const target = safePath(this.root, relative), ext = path.extname(target).toLowerCase();
        if(protectedPath(path.relative(this.root,fs.realpathSync(target))))throw new Error('Protected real path');
        if (!mime[ext] || !fs.statSync(target).isFile() || fs.statSync(target).size > 20*1024*1024) throw new Error('Unsupported asset');
        let body: Buffer|string = fs.readFileSync(target);
        if (ext === '.html') {
          const base = `<base href="${prefix}">`;
          body = body.toString().replace(/<base\b[^>]*>/gi,'').replace(/(src|href)=(['"])\/(?!\/)/gi,`$1=$2${prefix}`);
          body = body.includes('<head>') ? body.replace('<head>', '<head>'+base+bridge+inspectorBridge) : base+bridge+inspectorBridge+body;
        }
        res.writeHead(200, { 'Content-Type':mime[ext]+'; charset=utf-8', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'", 'Access-Control-Allow-Origin':'null' }); res.end(body);
      } catch { res.writeHead(404).end('Preview asset unavailable'); }
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    this.server=server;
    if(onChange)try{this.watcher=fs.watch(this.root,{recursive:true},(_event,filename)=>{if(!filename||protectedPath(String(filename))||!mime[path.extname(String(filename)).toLowerCase()])return;clearTimeout(this.timer);this.timer=setTimeout(()=>onChange(),300);});}catch{ /* Manual refresh remains available on unsupported filesystems. */ }
    return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}/${this.nonce}/${encodeURIComponent(path.basename(file))}`,entry:path.relative(workspace,file)};
  }
  async close() { this.watcher?.close();this.watcher=undefined;clearTimeout(this.timer);const server=this.server;this.server=undefined;if(server) await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()}); }
}
