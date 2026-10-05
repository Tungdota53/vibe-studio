import crypto from 'node:crypto';
import type { Task } from './types.js';
import { isAdvisoryCommand, verificationEvidence, type TaskEvidence } from './team-artifacts.js';
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
 const checks=failures.map(({task,reason})=>{ const failed=(evidence.get(task.id)?.checks||[]).filter(check=>check.exitCode!==0&&!isAdvisoryCommand(check.command,task.verificationCommands)).map(check=>[check.command,check.exitCode]); return {id:task.id,checks:failed,report:failed.length ? undefined : task.resultSummary||reason.slice(0,300)}; });
 return crypto.createHash('sha256').update(JSON.stringify({checks,sources:Object.entries(sources).sort(([a],[b])=>a.localeCompare(b))})).digest('hex');
}
