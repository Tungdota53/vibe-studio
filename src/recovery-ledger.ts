import type { Task } from './types.js';
import { advisoryCheck, latestChecks, type TaskEvidence } from './team-artifacts.js';

export interface RecoveryUsage { tokens:number; actualTokens:number; estimatedTokens:number; costUSD:number|null; modelCalls:number; unreportedModelCalls:number }
export interface RecoveryObservation {
 round:number; timestamp:string; strategy?:string; unresolved:string[]; passed:string[];
 resolved:string[]; introduced:string[]; regressions:string[]; progressed:boolean;
 tokens:number; actualTokens:number; estimatedTokens:number; costUSD:number|null;
 modelCalls:number; unreportedModelCalls:number; message:string;
}
/** Only actual failed-to-passed transitions establish progress. A renamed test,
 * new source fingerprint or smaller agent report cannot establish a fix. */
export function recoveryObservation(previous:RecoveryObservation|undefined,tasks:Task[],evidence:Map<string,TaskEvidence>,usage:RecoveryUsage,priorUsage?:RecoveryUsage):RecoveryObservation{
 const unresolved=new Set<string>(),passed=new Set<string>();
 for(const task of tasks){
  const proof=evidence.get(task.id);if(!proof)continue;
  for(const check of latestChecks(proof))if(!advisoryCheck(check,task.verificationCommands)){
   const key=`${task.id}: ${check.command.trim()}`;
   (check.exitCode===0?passed:unresolved).add(key);
  }
  for(const error of proof.executionErrors||[])if(!advisoryCheck({command:error.command,exitCode:1},task.verificationCommands)&&!latestChecks(proof).some(check=>check.command.trim()===error.command.trim()&&check.sequence!==undefined&&error.sequence!==undefined&&check.sequence>error.sequence))unresolved.add(`${task.id}: ${error.command.trim()}`);
  if(task.status==='failed')try{const report=JSON.parse((task.resultSummary||'').replace(/^```(?:json)?\s*|\s*```$/g,''));for(const finding of report.findings||[])unresolved.add(`${task.id}: finding ${finding.id||finding.title||finding.summary||'unresolved'}`);}catch{}
 }
 const old=new Set(previous?.unresolved||[]),resolved=[...old].filter(key=>passed.has(key)),introduced=[...unresolved].filter(key=>!old.has(key));
 const regressions=(previous?.passed||[]).filter(key=>unresolved.has(key));
 const delta=(key:'tokens'|'actualTokens'|'estimatedTokens'|'modelCalls'|'unreportedModelCalls')=>Math.max(0,usage[key]-(priorUsage?.[key]||0));
 const costUSD=usage.costUSD===null||priorUsage?.costUSD===null?null:Math.max(0,usage.costUSD-(priorUsage?.costUSD||0));
 return {round:(previous?.round||0)+1,timestamp:new Date().toISOString(),unresolved:[...unresolved].sort(),passed:[...passed].sort(),resolved,introduced,regressions,progressed:resolved.length>0&&regressions.length===0,tokens:delta('tokens'),actualTokens:delta('actualTokens'),estimatedTokens:delta('estimatedTokens'),costUSD,modelCalls:delta('modelCalls'),unreportedModelCalls:delta('unreportedModelCalls'),message:`${resolved.length} kiểm tra lỗi → đạt · ${regressions.length} hồi quy · ${introduced.length} lỗi mới · ${delta('tokens')} token${costUSD===null?' · chi phí chưa xác định':` · $${costUSD.toFixed(4)}`}`};
}
