import {describe,expect,it} from 'vitest';
import {canRetryTask,repairSignature,observeRepairProgress,isDependencyAudit,chooseRecovery,recoveryDiagnosis,type RecoveryCampaign,type RepairProgress} from '../src/team-recovery.js';
import {parseTeamPlan} from '../src/teamwork.js';
describe('Automatic recovery policy',()=>{
 it('migrates old resume counters so an eleven-round session cannot silently restart direct repair',()=>{
  const [task]=parseTeamPlan('{"tasks":[{"id":"T9","role":"tester","title":"Verify"}]}');
  const result=chooseRecovery(undefined,[{task,reason:'legacy changing failures'}],new Map(),'different-source',11);
  expect(result.strategy).toBeUndefined();expect(result.campaign.attempts).toEqual({direct:2,root_cause:2,reproduce:2,alternate:2});
 });
 it('does not reset recovery when errors rotate between validators or commands',()=>{
  const tasks=parseTeamPlan('{"tasks":[{"id":"T7","title":"Browser","role":"tester"},{"id":"T9","title":"Security","role":"tester"}]}');
  let state:RecoveryCampaign|undefined;const selected=[];
  for(let round=0;round<12;round++){
   const task=tasks[round%2],evidence=new Map([[task.id,{inspected:true,successfulChecks:0,failedChecks:1,toolErrors:0,checks:[{command:`node check-${round}.mjs`,exitCode:1,excerpt:'unresolved'}]}]]);
   const result=chooseRecovery(state,[{task,reason:'rotating failure'}],evidence,`source-${round}`);state=JSON.parse(JSON.stringify(result.campaign));selected.push(result.strategy);
  }
  expect(selected.filter(Boolean)).toHaveLength(8);expect(selected.slice(8)).toEqual([undefined,undefined,undefined,undefined]);expect(state?.transitions).toBe(11);
 });
 it('changes strategies for the same unresolved checks and preserves failed approaches through resume',()=>{
  const [task]=parseTeamPlan('{"tasks":[{"id":"test","title":"Test","role":"tester"}]}');const proof={inspected:true,successfulChecks:0,failedChecks:1,toolErrors:0,checks:[{command:'npm test',exitCode:1,excerpt:'failed'}]};const evidence=new Map([[task.id,proof]]);let state:RecoveryCampaign|undefined;const strategies=[];
  for(let i=0;i<9;i++){task.resultSummary='new wording '+i;const choice=chooseRecovery(state,[{task,reason:'changed source '+i}],evidence,'hash-'+i);state=JSON.parse(JSON.stringify(choice.campaign));strategies.push(choice.strategy);}
  expect(strategies).toEqual(['direct','direct','root_cause','root_cause','reproduce','reproduce','alternate','alternate',undefined]);expect(state?.history).toHaveLength(8);
  proof.checks=[{command:'npm run browser',exitCode:1,excerpt:'new unresolved check'}];expect(chooseRecovery(state,[{task,reason:'new problem'}],evidence,'fresh').strategy).toBeUndefined();
 });
 it('requires actual inspection and usable diagnostic evidence before handing a diagnosis to repair',()=>{
  const report=JSON.stringify({rootCause:'test uses stale generated output',evidence:['read config'],nextAction:'use the current source entry'});expect(recoveryDiagnosis(report,{inspected:true,successfulChecks:0,failedChecks:0,toolErrors:0})).toBeTruthy();expect(recoveryDiagnosis(report)).toBeUndefined();expect(recoveryDiagnosis('{"rootCause":"guessed","evidence":[],"nextAction":"rewrite"}',{inspected:true,successfulChecks:0,failedChecks:0,toolErrors:0})).toBeUndefined();
 });
 it('stops source churn and reworded reports without improved validation, and persists the counter',()=>{
   const [task]=parseTeamPlan('{"tasks":[{"id":"test","title":"Test","role":"tester"}]}');const evidence=new Map([[task.id,{inspected:true,successfulChecks:0,failedChecks:1,toolErrors:0,checks:[{command:'npm test',exitCode:1,excerpt:'same unresolved test'}]}]]);let state:RepairProgress|undefined,result;
   for(let round=0;round<5;round++){task.resultSummary=JSON.stringify({verdict:'FAIL',findings:[{title:'wording '+round}]});result=observeRepairProgress(state,[{task,reason:'source version '+round}],evidence);state=JSON.parse(JSON.stringify(result.state));}
   expect(result?.stop).toBe(true);expect(state?.stagnant).toBe(4);
   evidence.get(task.id)!.checks=[];evidence.get(task.id)!.failedChecks=0;expect(observeRepairProgress(state,[{task,reason:'remaining finding'}],evidence).state.stagnant).toBe(0);
   expect(isDependencyAudit('npm audit --omit=dev')).toBe(true);expect(isDependencyAudit('npm audit --json --omit=dev')).toBe(true);expect(isDependencyAudit('npm audit fix --force')).toBe(false);expect(isDependencyAudit('npm audit && node other.js')).toBe(false);
 });
 it('retries transient transport faults but not authorization, integrity, budget or ambiguous effects',()=>{
  for(const error of ['ModelStreamInterruptedError: terminated','Error: fetch failed','HTTP 429','HTTP 503','ECONNRESET'])expect(canRetryTask(error)).toBe(true);
  for(const error of ['HTTP 401','HTTP 403','Integrity veto T1: source changed','BudgetExceededError','Resume blocked replay','Workspace dirty','Agent không tiến triển','ordinary implementation failure'])expect(canRetryTask(error)).toBe(false);
  expect(canRetryTask('ECONNRESET',[{tool:'write_file'}])).toBe(false);
 });
 it('detects repeated identical failure/source state and recognizes source progress',()=>{
  const [task]=parseTeamPlan(JSON.stringify({tasks:[{id:'test',role:'tester',title:'Verify'}]}));
  const failures=[{task,reason:'same failure'}],evidence=new Map();
  expect(repairSignature(failures,evidence,{'a.ts':'old'})).toBe(repairSignature(failures,evidence,{'a.ts':'old'}));
  task.resultSummary='First wording'; const actual=new Map([[task.id,{inspected:true,successfulChecks:0,failedChecks:1,toolErrors:0,checks:[{command:'npm test',exitCode:1,excerpt:'failed'}]}]]);
  const first=repairSignature(failures,actual,{'a.ts':'old'}); task.resultSummary='Different wording'; expect(repairSignature(failures,actual,{'a.ts':'old'})).toBe(first);
  expect(repairSignature(failures,evidence,{'a.ts':'new'})).not.toBe(repairSignature(failures,evidence,{'a.ts':'old'}));
 });
});
