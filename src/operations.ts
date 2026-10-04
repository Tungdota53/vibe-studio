import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { durableJson, CheckpointStore } from './checkpoints.js';
import { safePath, isSensitivePath, redact } from './security.js';
import type { Task } from './types.js';
import type { TaskEvidence } from './team-artifacts.js';
import { staleEvidence, verificationEvidence } from './team-artifacts.js';
import { verifyCompletedSource } from './resume-sources.js';

export const operationModes = ['ask', 'plan', 'execute', 'verify', 'repair'] as const;
export type OperationMode = typeof operationModes[number];
export function operationMode(value: unknown): OperationMode {
  if (!operationModes.includes(value as OperationMode)) throw new Error('Chế độ làm việc không hợp lệ');
  return value as OperationMode;
}
export function operationPolicy(mode: OperationMode) {
  return {
    role: ({ ask: 'general', plan: 'planner', execute: 'coder', verify: 'tester', repair: 'coder' } as const)[mode],
    readOnly: mode === 'ask',
    instruction: ({ ask: 'Answer and inspect only. Do not change source or run shell commands.', plan: 'Inspect and propose a concrete plan. Do not implement source changes.', execute: 'Implement the request and record actual validation.', verify: 'Run existing project checks and report observed results. Do not modify source.', repair: 'Diagnose the root cause, make a scoped fix and rerun the failing checks. Never weaken checks to claim success.' })[mode]
  };
}
const hash = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
function fingerprint(root: string, file: string): string | null {
  if (isSensitivePath(file) || file.split(/[\\/]/).some(p => ['.vibe','.git','node_modules'].includes(p))) throw new Error('Nguồn ghi nhớ được bảo vệ');
  const target = safePath(root, file, true);
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Nguồn ghi nhớ phải là tệp <= 2 MiB');
  return hash(fs.readFileSync(target));
}
export interface ProjectMemory { id: string; kind: 'decision' | 'verified-fix'; text: string; createdAt: string; sources: Record<string,string|null>; sessionId?: string; checks?: {command:string;exitCode:number}[] }
/** Local evidence, bounded and invalidated by source changes; never an authority to bypass checks. */
export class Operations {
  private root: string;
  constructor(private workspace: string) { this.root = path.join(workspace,'.vibe','operations'); }
  private session(id: string) { if (!/^session-[a-f0-9]{8}$/.test(id)) throw new Error('Chọn phiên Teamwork'); return safePath(this.workspace, `.vibe/sessions/${id}`); }
  private memories(): ProjectMemory[] { try {
    const file=safePath(this.workspace,path.relative(this.workspace,path.join(this.root,'memory.json')));if(fs.statSync(file).size>2*1024*1024)return [];
    const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(parsed))return [];
    return parsed.slice(-100).filter(item=>item&&typeof item.id==='string'&&typeof item.text==='string'&&item.text.length<=8000&&item.sources&&typeof item.sources==='object'&&!Array.isArray(item.sources)&&Object.keys(item.sources).length<=200&&['decision','verified-fix'].includes(item.kind));
  } catch { return []; } }
  private saveMemory(items:ProjectMemory[]){let bounded=items.slice(-100);while(bounded.length>1&&Buffer.byteLength(JSON.stringify(bounded))>1024*1024)bounded=bounded.slice(1);durableJson(path.join(this.root,'memory.json'),bounded);}
  listMemory() { return this.memories().map(item => ({...item, stale:Object.entries(item.sources).some(([file,expected]) => { try { return fingerprint(this.workspace,file)!==expected; } catch { return true; } })})); }
  remember(text: string, files: string[]) {
    if (!text.trim() || text.length > 8000 || !Array.isArray(files) || !files.length || files.length > 40 || files.some(file => typeof file !== 'string')) throw new Error('Nhập ghi nhớ và 1–40 tệp nguồn');
    const sources = Object.fromEntries(files.map(file => [file,fingerprint(this.workspace,file)]));
    const item: ProjectMemory = {id:crypto.randomUUID(),kind:'decision',text:redact(text.trim()),createdAt:new Date().toISOString(),sources};
    this.saveMemory([...this.memories(),item]);return item;
  }
  forget(id: string) { this.saveMemory(this.memories().filter(item=>item.id!==id)); }
  recall() { return this.listMemory().filter(item=>!item.stale).slice(-12).map(item=>`[${item.kind}; source hashes current; still requires verification] ${item.text}`).join('\n').slice(0,16000); }
  learn(sessionId: string,tasks: Task[],evidence: Map<string,TaskEvidence>,gate: {verdict:string}) {
    if(gate.verdict!=='PASS')return;
    const repairs=tasks.filter(task=>task.id.startsWith('repair-')&&task.role==='coder'&&task.status==='completed');
    if(!repairs.length)return;
    const sources:Record<string,string|null>={};
    for(const task of repairs)for(const file of task.expectedFiles||[]) {
      // Only learn changes visible in the user's project. Isolated worktrees need integration first.
      if(task.worktreePath && path.resolve(task.worktreePath)!==path.resolve(this.workspace))return;
      sources[file]=fingerprint(this.workspace,file);
    }
    if(!Object.keys(sources).length||Object.keys(sources).length>200)return;
    const checks=tasks.filter(task=>task.role!=='coder').flatMap(task=>{const proof=evidence.get(task.id);return proof&&!staleEvidence(proof)?(proof.checks||[]).filter(check=>check.exitCode===0).map(({command,exitCode})=>({command,exitCode})):[];});
    if(!checks.length)return;
    const items=this.memories().filter(item=>!(item.kind==='verified-fix'&&item.sessionId===sessionId));
    items.push({id:crypto.randomUUID(),kind:'verified-fix',text:redact(repairs.map(task=>`${task.title}: ${task.resultSummary||''}`).join('\n').slice(0,8000)),createdAt:new Date().toISOString(),sources,sessionId,checks:checks.slice(0,40).map(check=>({...check,command:check.command.slice(0,2000)}))});this.saveMemory(items);
  }
  inspect(sessionId: string) {
    const root=this.session(sessionId);let saved:any={};try{saved=JSON.parse(fs.readFileSync(path.join(root,'resume.json'),'utf8'));}catch{}
    const tasks:Task[]=saved.tasks||[], evidence=new Map<string,TaskEvidence>(saved.evidence||[]);
    const eventsFile=path.join(root,'events.jsonl');let events:any[]=[];
    if(fs.existsSync(eventsFile)){const fd=fs.openSync(eventsFile,'r');try{const size=fs.fstatSync(fd).size,start=Math.max(0,size-2*1024*1024),buffer=Buffer.alloc(size-start);fs.readSync(fd,buffer,0,buffer.length,start);const lines=buffer.toString('utf8').split('\n');if(start)lines.shift();events=lines.flatMap(line=>{try{return [JSON.parse(redact(line))]}catch{return []}}).slice(-500);}finally{fs.closeSync(fd)}}
    let pipeline:any=null;try{pipeline=JSON.parse(fs.readFileSync(path.join(root,'pipeline.json'),'utf8'));}catch{}
    let estimate:any=null;try{estimate=JSON.parse(fs.readFileSync(path.join(root,'estimate.json'),'utf8'));}catch{}
    let adjustments:unknown[]=[];try{adjustments=JSON.parse(fs.readFileSync(path.join(root,'adjustments.json'),'utf8'));}catch{}
    return {sessionId,status:saved.status||'unknown',pipeline,estimate,adjustments,tasks,events,memory:this.listMemory(),
      recovery:tasks.filter(task=>task.status==='failed'||task.status==='blocked'||task.id.startsWith('repair-')).map(task=>({id:task.id,title:task.title,status:task.status,reason:redact(task.error||task.description).slice(0,4000),step:task.step,checks:verificationEvidence(task,evidence.get(task.id)),retry:saved.runtimeRetries?.[task.id]||0,waitingOn:task.dependencies.filter(id=>tasks.find(item=>item.id===id)?.status!=='completed')})),
      checkpoints:new CheckpointStore(this.workspace).list().filter(item=>item.sessionId?.startsWith(sessionId+':'))};
  }
  export(sessionId: string) {
    const state=this.inspect(sessionId), root=this.session(sessionId);
    const checkpointStore=new CheckpointStore(this.workspace);
    const previewRoot=path.join(this.root,'previews');const previews=fs.existsSync(previewRoot)?fs.readdirSync(previewRoot).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).slice(-30).flatMap(name=>{try{const record=JSON.parse(fs.readFileSync(safePath(this.workspace,path.relative(this.workspace,path.join(previewRoot,name))),'utf8'));return record.sessionId===sessionId?[record]:[];}catch{return []}}):[];
    const bundle={version:1,exportedAt:new Date().toISOString(),...state,previews,diffs:state.checkpoints.slice(0,30).map(item=>checkpointStore.diff(item.id,40,2000)),note:'Recorded evidence, not a new test run. Check source freshness before reuse. Export includes latest 500 events and 30 checkpoints, up to 40 changed files and 2000 characters per side; complete checkpoints remain local.'};
    const file=path.join(root,'delivery.json');durableJson(file,JSON.parse(redact(JSON.stringify(bundle))));
    const report=path.join(root,'DELIVERY.md');fs.writeFileSync(report,redact(`# Delivery ${sessionId}\n\nStatus: ${state.status}\nGate: ${state.pipeline?.gate?.verdict||'UNVERIFIED'}\n\n${state.tasks.map(task=>`- ${task.id} · ${task.status}: ${task.title}\n  ${task.error||task.resultSummary||''}`).join('\n')}\n\nEvidence: delivery.json (tool events, check outcomes, source hashes and checkpoint diffs).\nChecks are historical; run the project checks again after source changes.\n`));
    return {file:path.relative(this.workspace,file),report:path.relative(this.workspace,report),bundle};
  }
  recordPreview(sessionId: string,entry: string,observation: unknown) {
    if(!/^(chat-[a-zA-Z0-9-]{1,80}|session-[a-f0-9]{8})$/.test(sessionId)||path.extname(entry)!=='.html')throw new Error('Phiên/preview không hợp lệ');
    if(Buffer.byteLength(JSON.stringify(observation))>32000)throw new Error('Preview evidence quá lớn');
    const sourceHash=fingerprint(this.workspace,entry),id=crypto.randomUUID();
    const record={id,sessionId,entry,sourceHash,recordedAt:new Date().toISOString(),kind:'preview-observation',verdict:'UNVERIFIED',observation,note:'Renderer observations, not a complete browser test suite. Source hash covers entry HTML only.'};
    durableJson(path.join(this.root,'previews',id+'.json'),JSON.parse(redact(JSON.stringify(record))));return record;
  }
  integrate(sessionId: string) {
    const state=this.inspect(sessionId),root=this.session(sessionId);
    if(state.status!=='completed'||state.pipeline?.gate?.verdict!=='PASS')throw new Error('Chỉ tích hợp phiên hoàn tất và nghiệm thu PASS');
    const saved=JSON.parse(fs.readFileSync(path.join(root,'resume.json'),'utf8'));
    if((saved.evidence||[]).some(([,proof]:[string,TaskEvidence])=>staleEvidence(proof)))throw new Error('Bằng chứng đã cũ; kiểm tra lại worktree trước khi tích hợp');
    const baseline=JSON.parse(fs.readFileSync(path.join(root,'integration-base.json'),'utf8')) as Record<string,string|null>;
    const scopes=new Set(state.tasks.filter(task=>task.role==='coder').map(task=>task.worktreePath));
    if(scopes.size!==1||!scopes.values().next().value)throw new Error('Phiên không có worktree cách ly thống nhất');
    const scope=String(scopes.values().next().value),relative=path.relative(path.join(this.workspace,'.vibe','worktrees'),scope);
    if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw new Error('Worktree ngoài workspace');
    for(const task of state.tasks.filter(task=>task.role==='coder'&&task.status==='completed'))verifyCompletedSource(task,state.tasks,saved.fingerprints||{},scope);
    const files=[...new Set(state.tasks.filter(task=>task.role==='coder').flatMap(task=>task.expectedFiles||[]))];
    if(!files.length)throw new Error('Chưa có phạm vi tệp để tích hợp');
    const images=files.map(file=>{
      if(!(file in baseline)||fingerprint(this.workspace,file)!==baseline[file])throw new Error(`Integration conflict: ${file} đã đổi trong dự án; giữ thay đổi của bạn`);
      const source=safePath(scope,file,true);if(!fs.existsSync(source))return {file,data:null};
      const stat=fs.statSync(source);if(!stat.isFile()||stat.size>2*1024*1024||stat.nlink>1)throw new Error('Chỉ tích hợp tệp thường <= 2 MiB');
      return {file,data:fs.readFileSync(source)};
    });
    const checkpoints=new CheckpointStore(this.workspace),cp=checkpoints.begin({tool:'integrate_worktree',sessionId,files});
    try{for(const {file,data} of images){const target=safePath(this.workspace,file,true);if(data===null){if(fs.existsSync(target))fs.unlinkSync(target);}else{fs.mkdirSync(path.dirname(target),{recursive:true});const temp=target+'.vibe-integrate-'+crypto.randomUUID();fs.writeFileSync(temp,data);fs.renameSync(temp,target);}}}
    finally{checkpoints.finish(cp);}
    durableJson(path.join(root,'integrated.json'),{at:new Date().toISOString(),checkpointId:cp,files});return {checkpointId:cp,files,message:'Đã tích hợp các tệp đã nghiệm thu. Checkpoint cho phép hoàn tác từng tệp.'};
  }
  estimate(tasks: Task[],maxAgents: number,rates?:{inputPerMillion:number;outputPerMillion:number},sample?:{tokens:number;durationMs:number;modelCalls:number}) {
    const ready=tasks.filter(task=>!task.dependencies.length).length;
    const perTask=sample&&sample.modelCalls>0?sample.tokens/sample.modelCalls:undefined;
    return {tasks:tasks.length,maxAgents,initialParallelism:Math.min(ready,maxAgents),ownedFiles:new Set(tasks.flatMap(task=>task.expectedFiles||[])).size,
      tokenRange:perTask?[Math.round(perTask*tasks.length),Math.round(perTask*tasks.length*5)]:null,
      costUSDRange:perTask&&rates?[perTask*tasks.length*Math.min(rates.inputPerMillion,rates.outputPerMillion)/1e6,perTask*tasks.length*5*Math.max(rates.inputPerMillion,rates.outputPerMillion)/1e6]:null,
      durationMsRange:sample&&sample.modelCalls>0?[Math.round(sample.durationMs/sample.modelCalls*tasks.length/maxAgents),Math.round(sample.durationMs/sample.modelCalls*tasks.length*5)]:null,
      note:perTask?'Ước lượng từ lượt gọi trước, có thể lệch lớn khi sửa lỗi hoặc chạy công cụ.':'Chưa có dữ liệu thực thi; chưa thể dự đoán thời gian/token/chi phí. Phạm vi được tính từ kế hoạch.'};
  }
}
