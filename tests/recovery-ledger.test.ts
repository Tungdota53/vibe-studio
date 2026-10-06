import { describe,it,expect } from 'vitest';
import { recoveryObservation } from '../src/recovery-ledger.js';
import { parseTeamPlan } from '../src/teamwork.js';
import type { TaskEvidence } from '../src/team-artifacts.js';
describe('Recovery progress evidence',()=>{
 it('counts only failed-to-passed transitions and exposes regressions, cost and usage gaps',()=>{
  const tasks=parseTeamPlan('{"tasks":[{"id":"T7","role":"tester","title":"Verify"}]}');
  const evidence=new Map<string,TaskEvidence>([['T7',{inspected:true,successfulChecks:0,failedChecks:1,toolErrors:0,checks:[{command:'npm test',exitCode:1,excerpt:'fail'},{command:'npm run build',exitCode:0,excerpt:'pass'}]}]]);
  const usage={tokens:100,actualTokens:80,estimatedTokens:20,costUSD:null,modelCalls:2,unreportedModelCalls:1};
  const first=recoveryObservation(undefined,tasks,evidence,usage);expect(first.progressed).toBe(false);expect(first.costUSD).toBeNull();
  evidence.get('T7')!.checks!.push({command:'npm test',exitCode:0,excerpt:'fixed'});
  const second=recoveryObservation(first,tasks,evidence,{...usage,tokens:150,actualTokens:130},usage);
  expect(second.resolved).toEqual(['T7: npm test']);expect(second.progressed).toBe(true);expect(second.tokens).toBe(50);expect(second.costUSD).toBeNull();
  evidence.get('T7')!.checks!.push({command:'npm run build',exitCode:1,excerpt:'regression'});
  expect(recoveryObservation(second,tasks,evidence,usage,usage).regressions).toEqual(['T7: npm run build']);
 });
 it('does not treat renamed checks or fewer findings as progress',()=>{
  const tasks=parseTeamPlan('{"tasks":[{"id":"T9","role":"tester","title":"Verify"}]}'),usage={tokens:0,actualTokens:0,estimatedTokens:0,costUSD:0,modelCalls:0,unreportedModelCalls:0};
  const proof:TaskEvidence={inspected:true,successfulChecks:0,failedChecks:1,toolErrors:0,checks:[{command:'node test.mjs',exitCode:1,excerpt:'failure'}]},evidence=new Map([['T9',proof]]);
  const first=recoveryObservation(undefined,tasks,evidence,usage);proof.checks=[{command:'node test.mjs --quiet',exitCode:1,excerpt:'reworded failure'}];
  const second=recoveryObservation(first,tasks,evidence,usage,usage);expect(second.resolved).toEqual([]);expect(second.progressed).toBe(false);
 });
});
