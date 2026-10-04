export type Role = 'orchestrator'|'planner'|'coder'|'tester'|'reviewer'|'judge'|'general';
export type TaskStatus = 'pending'|'ready'|'running'|'blocked'|'completed'|'failed'|'cancelled';
export interface Task { changedFiles?: string[] }
export type Quality = 'fast'|'balanced'|'high'|'max';
export interface Task { id:string; title:string; description:string; role:Role; phase?:import('./team-protocol.js').Phase; acceptanceCriteria?:string[]; verificationCommands?:string[]; agentId?:string; agentName?:string; model?:string; skills?:string[]; loadedSkills?:string[]; status:TaskStatus; dependencies:string[]; expectedFiles?:string[]; assignedAgentId?:string; worktreePath?:string; createdAt:string; startedAt?:string; lastProgressAt?:string; step?:string; stalled?:boolean; completedAt?:string; resultSummary?:string; error?:string; retries?:number; }
export interface AgentState { id:string; role:Role; status:'idle'|'running'|'waiting'|'failed'|'stopped'|'cancelled'; model:string; currentTaskId?:string; worktreePath?:string; startedAt?:string; lastActivityAt?:string; tokenUsage?:TokenUsage; }
export interface TokenUsage { prompt:number; completion:number; total:number; cached?:number; estimated?:boolean }
export interface ToolCall { id:string; type:'function'; function:{name:string;arguments:string} }
export interface Message { role:'system'|'user'|'assistant'|'tool'; content:string|null; tool_call_id?:string; tool_calls?:ToolCall[] }
export interface Requirement { id:string; text:string; status:'unverified'|'implemented'|'verified'|'blocked'; evidence:string[] }
export interface ReviewFinding { severity:'blocker'|'high'|'medium'|'low'; file?:string; line?:number; title:string; detail:string; suggestedFix?:string }

export type TeamworkEventType =
  | 'session_start'
  | 'planner_start'
  | 'planner_done'
  | 'task_start'
  | 'task_complete'
  | 'task_failed'
  | 'task_snapshot'
  | 'session_end'
  | 'agent_status';

export interface TeamworkEvent {
  type: TeamworkEventType;
  agentId?: string;
  role?: Role | string;
  status?: TaskStatus | string;
  message?: string;
  taskId?: string;
  model?: string;
  timestamp?: string;
  [key: string]: any;
}

