import {describe,it,expect} from 'vitest';
import {parseTeamPlan} from '../src/teamwork.js';
import {applyManagerDecision,newManagerState,managerSignature} from '../src/team-manager.js';
import {loadConfig} from '../src/config.js';
const plan=()=>parseTeamPlan(JSON.stringify({tasks:[{id:'code',title:'Implement',role:'coder',expectedFiles:['src/app.ts'],acceptanceCriteria:['keep behavior']}]}));
describe('Team manager boundaries',()=>{
 it('rejects a whole invalid proposal without partial delegation or scope changes',()=>{
  const tasks=plan(),state=newManagerState(),before=structuredClone(tasks);expect(()=>applyManagerDecision(JSON.stringify({summary:'Delegate',delegate:[{purpose:'testing',title:'Test',description:'Execute actual tests',targets:['code']}],assign:[{taskId:'unknown',agentId:'frontend'}]}),tasks,loadConfig(),state)).toThrow();expect(tasks).toEqual(before);expect(state.revision).toBe(0);
 });
 it('cannot repeat delegation by targeting a new validator for the same original implementation',()=>{
  const tasks=plan(),state=newManagerState(),config=loadConfig();applyManagerDecision(JSON.stringify({summary:'Test',delegate:[{purpose:'testing',title:'Test',description:'Run checks',targets:['code']}]}),tasks,config,state);expect(()=>applyManagerDecision(JSON.stringify({summary:'Test again',delegate:[{purpose:'testing',title:'Duplicate',description:'Duplicate checks',targets:[tasks[1].id]}]}),tasks,config,state)).toThrow('already delegated');expect(tasks).toHaveLength(2);
 });
 it('cannot give reviewer shell commands or reassign a completed worker',()=>{
  const tasks=plan(),state=newManagerState(),config=loadConfig();expect(()=>applyManagerDecision(JSON.stringify({summary:'Review',delegate:[{purpose:'review',title:'Review',description:'Review source',targets:['code'],verificationCommands:['npm test']}]}),tasks,config,state)).toThrow('read-only');tasks[0].status='completed';expect(()=>applyManagerDecision(JSON.stringify({summary:'Replace',assign:[{taskId:'code',agentId:'frontend'}]}),tasks,config,state)).toThrow('undispatched');expect(tasks[0].expectedFiles).toEqual(['src/app.ts']);
 });
 it('scheduling signals change for real outcomes, not heartbeat timestamps',()=>{
  const tasks=plan(),evidence=new Map(),first=managerSignature(tasks,evidence);tasks[0].lastProgressAt=new Date().toISOString();expect(managerSignature(tasks,evidence)).toBe(first);tasks[0].status='completed';expect(managerSignature(tasks,evidence)).not.toBe(first);
 });
});
