import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { execa } from 'execa';
import { safePath, redact } from './security.js';

interface Entry {
 id:string; owner:string; sessionId:string; cwd:string; command:string; label:string;
 status:'running'|'exited'|'failed'|'stopped'; pid?:number; exitCode:number|null;
 startedAt:string; endedAt?:string; reason?:string; output:string;
 child:ChildProcess; timer?:ReturnType<typeof setTimeout>; stop?:Promise<void>; detach?:()=>void;
}
const registries=new Map<string,BackgroundProcesses>();
export class BackgroundProcesses {
 private entries=new Map<string,Entry>();
 private listeners=new Set<()=>void>();
 static forWorkspace(workspace:string){const key=fs.realpathSync(workspace);let registry=registries.get(key);if(!registry){registry=new BackgroundProcesses(key);registries.set(key,registry);}return registry;}
 static async closeAll(){await Promise.all([...registries.values()].map(registry=>registry.close()));registries.clear();}
 constructor(private workspace:string){}
 subscribe(callback:()=>void){this.listeners.add(callback);return()=>this.listeners.delete(callback);}
 private changed(){for(const callback of this.listeners)try{callback();}catch{}}
 private view(entry:Entry){return {id:entry.id,owner:entry.owner,sessionId:entry.sessionId,cwd:entry.cwd,command:redact(entry.command),label:redact(entry.label),status:entry.status,pid:entry.pid,exitCode:entry.exitCode,startedAt:entry.startedAt,endedAt:entry.endedAt,reason:entry.reason,log:redact(entry.output).slice(-16000)};}
 list(sessionId?:string){return [...this.entries.values()].filter(entry=>!sessionId||entry.sessionId===sessionId).map(entry=>this.view(entry));}
 private owned(id:string,sessionId?:string){const entry=this.entries.get(id);if(!entry||sessionId&&entry.sessionId!==sessionId)throw new Error('Process không thuộc phiên hoặc đã bị loại khỏi lịch sử');return entry;}
 inspect(id:string,sessionId?:string){return this.view(this.owned(id,sessionId));}
 async start(input:{command:string;cwd:string;owner:string;label?:string;ttlMs?:number},signal?:AbortSignal){
  signal?.throwIfAborted();const command=input.command.trim();
  if(!command||command.length>8000)throw new Error('Command phải dài 1–8000 ký tự');
  if(/\b(?:Start-Process|nohup|setsid)\b|(?:^|[;&|])\s*(?:cmd(?:\.exe)?\s+(?:\/d\s+)?\/c\s+["']?)?start(?:\s|$)|&\s*$|\b(?:taskkill|killall)\b/i.test(command))throw new Error('Không dùng lệnh tách process hoặc hủy process bên ngoài; gọi công cụ quản lý nền trực tiếp');
  const cwd=safePath(this.workspace,input.cwd),sessionId=input.owner.split(':')[0];
  if(!sessionId||!fs.statSync(cwd).isDirectory())throw new Error('Thiếu phiên hoặc thư mục chạy');
  if([...this.entries.values()].filter(entry=>entry.status==='running').length>=8)throw new Error('Workspace đang có 8 tác vụ nền; dừng tác vụ không cần thiết trước');
  const existing=[...this.entries.values()].find(entry=>entry.status==='running'&&entry.sessionId===sessionId&&entry.cwd===cwd&&entry.command===command);if(existing)return this.view(existing);
  const ttl=input.ttlMs??600000;if(!Number.isInteger(ttl)||ttl<1000||ttl>1800000)throw new Error('Thời hạn process phải từ 1 giây đến 30 phút');
  while(this.entries.size>=100){const old=[...this.entries.values()].find(entry=>entry.status!=='running');if(!old)break;this.entries.delete(old.id);}
  const child=spawn(command,{cwd,shell:true,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  const entry:Entry={id:crypto.randomUUID(),owner:input.owner,sessionId,cwd,command,label:(input.label||'Tác vụ nền').slice(0,200),status:'running',pid:child.pid,exitCode:null,startedAt:new Date().toISOString(),output:'',child};this.entries.set(entry.id,entry);
  let lastNotify=0;const append=(chunk:Buffer)=>{entry.output=(entry.output+chunk.toString('utf8')).slice(-65536);if(Date.now()-lastNotify>500){lastNotify=Date.now();this.changed();}};
  child.stdout?.on('data',append);child.stderr?.on('data',append);
  const finish=(status:Entry['status'],code:number|null)=>{if(entry.status==='running')entry.status=status;entry.exitCode=code;entry.endedAt=new Date().toISOString();clearTimeout(entry.timer);entry.detach?.();this.changed();};
  child.once('error',error=>{entry.output+=(error.message);finish('failed',null);});child.once('close',code=>finish(code===0?'exited':'failed',code));
  const abort=()=>{void this.stop(entry.id,sessionId,'Phiên bị hủy');};signal?.addEventListener('abort',abort,{once:true});entry.detach=()=>signal?.removeEventListener('abort',abort);
  entry.timer=setTimeout(()=>{void this.stop(entry.id,sessionId,'Hết thời hạn tác vụ nền');},ttl);entry.timer.unref();
  if(signal?.aborted)abort();this.changed();return this.view(entry);
 }
 async stop(id:string,sessionId?:string,reason='Đã dừng theo yêu cầu'){
  const entry=this.owned(id,sessionId);if(entry.stop){await entry.stop;return this.view(entry);}if(entry.status!=='running')return this.view(entry);
  entry.stop=(async()=>{entry.reason=reason;clearTimeout(entry.timer);entry.detach?.();
   if(entry.pid&&entry.child.exitCode===null){
    if(process.platform==='win32')await execa('taskkill.exe',['/PID',String(entry.pid),'/T','/F'],{windowsHide:true,reject:false,timeout:3000}).catch(()=>{});
    else try{process.kill(-entry.pid,'SIGKILL');}catch{}
    entry.child.kill('SIGKILL');
   }
   if(entry.child.exitCode===null&&entry.child.signalCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,4000);entry.child.once('close',()=>{clearTimeout(timer);resolve();});});
   entry.status='stopped';entry.endedAt=new Date().toISOString();this.changed();})();await entry.stop;return this.view(entry);
 }
 async stopSession(sessionId:string){await Promise.all([...this.entries.values()].filter(entry=>entry.sessionId===sessionId&&entry.status==='running').map(entry=>this.stop(entry.id,sessionId,'Phiên đã kết thúc')));}
 async close(){await Promise.all([...this.entries.values()].filter(entry=>entry.status==='running').map(entry=>this.stop(entry.id,undefined,'App đã đóng')));this.listeners.clear();}
 async health(id:string,url:string,sessionId?:string){
  const entry=this.owned(id,sessionId);if(entry.status!=='running')throw new Error('Process không còn chạy');
  const target=new URL(url);if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password)throw new Error('Chỉ kiểm tra HTTP server loopback của tác vụ nền');
  try{const response=await fetch(target,{signal:AbortSignal.timeout(3000),redirect:'manual'});await response.body?.cancel();return {id,ready:response.status>=200&&response.status<300,statusCode:response.status};}catch{return{id,ready:false,message:'Server chưa trả HTTP thành công; kiểm tra log, port và lệnh chạy.'};}
 }
}
