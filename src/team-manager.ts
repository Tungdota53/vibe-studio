import crypto from 'node:crypto';
import { z } from 'zod';
import type { Task } from './types.js';
import type { Config } from './config.js';
import { assertDag } from './dag.js';
import { assignedAgent } from './roles.js';
import { validateProtocol } from './team-protocol.js';
import { verificationEvidence, type TaskEvidence } from './team-artifacts.js';
import { taskPhase } from './team-protocol.js';
const purposeRole={survey:'planner',testing:'tester',review:'reviewer',security:'reviewer',audit:'tester',acceptance:'judge'} as const;
const purposePhase={survey:'survey',testing:'verification',review:'review',security:'review',audit:'audit',acceptance:'acceptance'} as const;
export interface ManagerState {signature?:string;revision:number;delegated:string[];summary?:string;error?:string;model?:string;status?:'running'|'idle'|'failed';decisions:{revision:number;summary:string;added:string[];assigned:string[];prioritized:string[]}[]}
export const newManagerState=():ManagerState=>({revision:0,delegated:[],decisions:[]});
export function managerSignature(tasks:Task[],evidence:Map<string,TaskEvidence>){return crypto.createHash('sha256').update(JSON.stringify(tasks.map(task=>({id:task.id,status:task.status,attempt:task.retries||0,agent:task.agentId,proof:verificationEvidence(task,evidence.get(task.id))})))).digest('hex');}
const decisionSchema=z.object({summary:z.string().min(1).max(2000),delegate:z.array(z.object({purpose:z.enum(['survey','testing','review','security','audit','acceptance']),title:z.string().min(1).max(300),description:z.string().min(1).max(8000),targets:z.array(z.string().max(64)).min(1).max(40),agentId:z.string().max(64).optional(),verificationCommands:z.array(z.string().max(2000)).max(12).default([]),skills:z.array(z.string().max(120)).max(8).default([])})).max(6).default([]),assign:z.array(z.object({taskId:z.string().max(64),agentId:z.string().max(64)})).max(16).default([]),prioritize:z.array(z.string().max(64)).max(16).default([])});
/** Validate the whole proposal before mutation. Supervisor cannot rewrite contracts or source ownership. */
export function applyManagerDecision(raw:string,tasks:Task[],config:Config,state:ManagerState){
 const decision=decisionSchema.parse(JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,''))),draft=structuredClone(tasks),known=new Map(draft.map(task=>[task.id,task])),keys=new Set(state.delegated),added:Task[]=[];
 const roots=(ids:string[],seen=new Set<string>()):string[]=>[...new Set(ids.flatMap(id=>{if(seen.has(id))return [];seen.add(id);const task=known.get(id);if(!task)throw new Error(`Unknown manager target: ${id}`);if(task.role==='coder'&&!id.startsWith('repair-'))return [id];return task.dependencies.length?roots(task.dependencies,seen):[id];}))].sort();
 for(const request of decision.delegate){
  for(const id of request.targets){const target=known.get(id);if(!target||['failed','blocked','cancelled'].includes(target.status))throw new Error(`Manager must use recovery for failed target ${id}, not create a replacement chain`);}
  const key=JSON.stringify([request.purpose,roots(request.targets)]);if(keys.has(key))throw new Error('Manager purpose/implementation scope already delegated; reuse the existing task');keys.add(key);
  const requestedRoots=roots(request.targets);
  if(draft.some(task=>{const purpose=task.agentId==='security-review'?'security':taskPhase(task)==='verification'?'testing':taskPhase(task)==='review'?'review':taskPhase(task)==='audit'?'audit':taskPhase(task)==='acceptance'?'acceptance':taskPhase(task)==='survey'?'survey':undefined;return purpose===request.purpose&&task.dependencies.length>0&&requestedRoots.every(root=>roots(task.dependencies).includes(root));}))throw new Error('Coverage task already exists for this scope; use its evidence or recovery');
  const role=purposeRole[request.purpose];assignedAgent(config,request.agentId,role);
  const task:Task={id:`managed-${state.revision+1}-${added.length+1}`,title:request.title,description:request.description,role,phase:purposePhase[request.purpose],dependencies:[...new Set(request.targets)],agentId:request.agentId,verificationCommands:request.verificationCommands,skills:request.skills,expectedFiles:[],acceptanceCriteria:['Inspect the actual dependency artifact and report evidence; preserve the original acceptance criteria.'],status:'pending',createdAt:new Date().toISOString(),retries:0};
  added.push(task);draft.push(task);known.set(task.id,task);
 }
 for(const request of decision.assign){const task=known.get(request.taskId);if(!task||!['pending','ready'].includes(task.status))throw new Error('Manager can assign only unfinished, undispatched tasks');assignedAgent(config,request.agentId,task.role);task.agentId=request.agentId;}
 for(const id of decision.prioritize)if(!known.has(id)||!['pending','ready'].includes(known.get(id)!.status))throw new Error('Manager priority must target an undispatched task');
 if(draft.length>48)throw new Error('Manager task capacity reached');assertDag(draft);validateProtocol(draft.filter(task=>!task.id.startsWith('diagnosis-')));
 for(const task of added)if(task.verificationCommands?.length&&task.role!=='tester')throw new Error('Manager cannot assign shell checks to a read-only role');
 // Preserve worker object identity; executeTask holds these references.
 for(const request of decision.assign)tasks.find(task=>task.id===request.taskId)!.agentId=request.agentId;
 tasks.push(...added);state.revision++;state.delegated=[...keys];state.summary=decision.summary;delete state.error;
 state.decisions.push({revision:state.revision,summary:decision.summary,added:added.map(task=>task.id),assigned:decision.assign.map(item=>item.taskId),prioritized:decision.prioritize});state.decisions=state.decisions.slice(-48);
 return {added,priorities:decision.prioritize,summary:decision.summary};
}
