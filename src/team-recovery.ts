import crypto from 'node:crypto';
import type { Task } from './types.js';
import { isAdvisoryCommand, advisoryCheck, latestChecks, verificationEvidence, type TaskEvidence } from './team-artifacts.js';
export const recoveryStrategies=['direct','root_cause','reproduce','alternate'] as const;
export type RecoveryStrategy=typeof recoveryStrategies[number];
export interface RecoveryCampaign {key:string; attempts:Partial<Record<RecoveryStrategy,number>>; history:{strategy:RecoveryStrategy;signature:string;failures:string[]}[]; transitions?:number}
/** A session retains failed strategies even when commands or validator subsets change. */
export function chooseRecovery(previous:RecoveryCampaign|undefined,failures:{task:Task;reason:string}[],evidence:Map<string,TaskEvidence>,signature:string,completedRounds=0){
 const problems=failures.map(({task})=>({task:task.id,checks:latestChecks(evidence.get(task.id)||{inspected:false,successfulChecks:0,failedChecks:0,toolErrors:0}).filter(check=>check.exitCode!==0&&!advisoryCheck(check,task.verificationCommands)).map(check=>check.command.trim()).sort(),errors:[...new Set((evidence.get(task.id)?.executionErrors||[]).map(error=>error.command.trim()))].sort()})).sort((a,b)=>a.task.localeCompare(b.task));
 const key=crypto.createHash('sha256').update(JSON.stringify(problems)).digest('hex');
 const campaign:RecoveryCampaign=previous?JSON.parse(JSON.stringify(previous)):{key,attempts:{},history:[]};
 // Migrate old checkpoints whose campaign counters reset on changing failures.
 // The persisted session round number cannot be discarded by resume.
 for(let index=0;index<recoveryStrategies.length;index++){
  const used=Math.max(0,Math.min(2,completedRounds-index*2));
  campaign.attempts[recoveryStrategies[index]]=Math.max(campaign.attempts[recoveryStrategies[index]]||0,used);
 }
 if(campaign.key!==key){campaign.transitions=(campaign.transitions||0)+1;campaign.key=key;}
 const strategy=recoveryStrategies.find(strategy=>(campaign.attempts[strategy]||0)<2);
 if(!strategy)return {campaign,strategy:undefined,instructions:'Các chiến lược phục hồi trong phiên đã được thử; đổi tên lệnh hoặc nhóm lỗi không tạo vòng sửa mới. '+recoveryHelp(failures,evidence)+' Giữ kế hoạch và checkpoint; tiếp tục sau khi có bằng chứng hoặc môi trường bổ sung.'};
 campaign.attempts[strategy]=(campaign.attempts[strategy]||0)+1;
 campaign.history.push({strategy,signature,failures:failures.map(({task,reason})=>`${task.id}: ${reason.slice(0,1800)}`)});campaign.history=campaign.history.slice(-8);
 const instructions={direct:'Inspect the failing command output and relevant source before making the smallest justified fix.',root_cause:'Trace the failure to its root cause using source and project/runtime evidence. Distinguish application bugs from toolchain, environment and test-harness failures. Fix the cause rather than symptoms.',reproduce:'Create the smallest reproduction of the remaining failure using existing permitted tools and assigned files. Compare expected/actual behavior, test one hypothesis at a time, then fix only the proven cause.',alternate:'The previous approaches failed. Choose a materially different implementation or execution approach inside the existing scope. Preserve behavior and acceptance criteria; verify compatibility before replacing code.'}[strategy];
 return {campaign,strategy,instructions:instructions+' Never introduce fixture/path/call-stack exceptions, one-shot global state bypasses, or weaken security validation to make tests pass. Missing browser/server infrastructure requires fixing the execution environment, not rewriting application behavior.'};
}
export function recoveryHelp(failures:{task:Task;reason:string}[],evidence:Map<string,TaskEvidence>){
 const details=failures.map(({task,reason})=>reason+' '+(task.resultSummary||'')+' '+JSON.stringify(evidence.get(task.id)?.checks||[])).join('\n');
 if(/(?:missing|thiếu|không (?:có|tìm thấy)).{0,80}(?:browser|playwright|chromium)|browser.{0,80}(?:runtime|not found)/i.test(details))return 'Cần xác minh browser runtime và URL/port server thật bằng một lần khởi chạy và đóng browser thành công; kiểm thử browser còn UNVERIFIED.';
 if(/(?:401|403|credential|api.?key|token).{0,60}(?:missing|invalid|thiếu|unauthorized)/i.test(details))return 'Cần cấu hình quyền truy cập hoặc token cho công cụ đang lỗi; không gửi bí mật vào chat.';
 if(/timed out|timeout|ECONNREFUSED/.test(details))return 'Cần kiểm tra lệnh khởi chạy server, URL/port và vòng đời process; không chạy dev server dài hạn như một lệnh kiểm thử đồng bộ.';
 return 'Cần đầu ra đầy đủ của kiểm thử lỗi còn lại và một tái hiện tối thiểu trên nguồn hiện tại để chọn cách sửa tiếp theo.';
}
export function recoveryDiagnosis(report:string,proof?:TaskEvidence){
 try{const value=JSON.parse(report.replace(/^```(?:json)?\s*|\s*```$/g,''));if(!proof?.inspected||typeof value.rootCause!=='string'||!value.rootCause.trim()||!Array.isArray(value.evidence)||!value.evidence.length||typeof value.nextAction!=='string'||!value.nextAction.trim())return;return value;}catch{return;}
}
export function isDependencyAudit(command:string){return /^npm audit(?: --(?:json|omit=dev|production))*$/.test(command.trim());}
export interface RepairProgress {bestTasks:number;bestChecks:number;bestFindings:number;stagnant:number;observations:number}
/** Code churn, reworded reports and extra diagnostic commands do not count as recovery. */
export function observeRepairProgress(state:RepairProgress|undefined,failures:{task:Task;reason:string}[],evidence:Map<string,TaskEvidence>){
  const tasks=new Set(failures.map(failure=>failure.task.id)).size;
  const checks=failures.reduce((sum,failure)=>sum+verificationEvidence(failure.task,evidence.get(failure.task.id)).failedChecks,0);
  const findings=failures.reduce((sum,{task})=>{try{const report=JSON.parse((task.resultSummary||'').replace(/^```(?:json)?\s*|\s*```$/g,''));return sum+(Array.isArray(report.findings)?report.findings.length:0);}catch{return sum;}},0);
  const improved=!state||tasks<state.bestTasks||checks<state.bestChecks||findings<state.bestFindings;
  const next:RepairProgress={bestTasks:Math.min(tasks,state?.bestTasks??Infinity),bestChecks:Math.min(checks,state?.bestChecks??Infinity),bestFindings:Math.min(findings,state?.bestFindings??Infinity),stagnant:improved?0:(state?.stagnant||0)+1,observations:(state?.observations||0)+1};
  return {state:next,stop:next.stagnant>=4,message:`${tasks} task lỗi · ${checks} kiểm tra lỗi · ${findings} finding · ${next.stagnant}/4 lần kiểm tra không giảm lỗi`};
}
/** Retries never bypass source integrity, resource limits or ambiguous side effects. */
export function canRetryTask(error: unknown, uncertain: readonly unknown[] = []) {
  const message=String(error);
  if(uncertain.length || /validation veto|integrity veto|resume blocked|source verification|workspace dirty|budget|ngân sách|không tiến triển|lượt công cụ|iterations|unauthorized|forbidden|invalid api.?key|(?:HTTP|status)\s*[:=]?\s*(?:401|403|404)\b/i.test(message))return false;
  return /ModelStreamInterruptedError|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket hang up|stream.*(?:interrupt|ngắt)|luồng.*ngắt|(?:HTTP|status)\s*[:=]?\s*(?:408|429|5\d\d)\b/i.test(message);
}
export function repairSignature(failures:{task:Task;reason:string}[],evidence:Map<string,TaskEvidence>,sources:Record<string,string|null>){
 const checks=failures.map(({task,reason})=>{ const failed=latestChecks(evidence.get(task.id)||{inspected:false,successfulChecks:0,failedChecks:0,toolErrors:0}).filter(check=>check.exitCode!==0&&!advisoryCheck(check,task.verificationCommands)).map(check=>[check.command,check.exitCode]); return {id:task.id,checks:failed,report:failed.length ? undefined : task.resultSummary||reason.slice(0,300)}; });
 return crypto.createHash('sha256').update(JSON.stringify({checks,sources:Object.entries(sources).sort(([a],[b])=>a.localeCompare(b))})).digest('hex');
}
