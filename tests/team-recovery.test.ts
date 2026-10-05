import {describe,expect,it} from 'vitest';
import {canRetryTask,repairSignature,observeRepairProgress,isDependencyAudit,type RepairProgress} from '../src/team-recovery.js';
import {parseTeamPlan} from '../src/teamwork.js';
describe('Automatic recovery policy',()=>{
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
