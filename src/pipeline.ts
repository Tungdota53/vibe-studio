import fs from 'node:fs';
import path from 'node:path';
import type { Task } from './types.js';
import { executionDiagnosis, verificationEvidence, isEnvironmentProbe, isReportCommand, latestChecks, staleEvidence, type TaskEvidence } from './team-artifacts.js';
import { taskPhase } from './team-protocol.js';
import { redact } from './security.js';

export interface PlanDiagnostic { taskId: string; code: string; message: string }
export function inspectPlan(tasks: Task[]): PlanDiagnostic[] {
  const issues: PlanDiagnostic[] = [], byId = new Map(tasks.map(task => [task.id, task]));
  const dependsOn = (task: Task, id: string, seen = new Set<string>()): boolean => {
    if (seen.has(task.id)) return false; seen.add(task.id);
    return task.dependencies.some(dep => dep === id || (byId.has(dep) && dependsOn(byId.get(dep)!, id, seen)));
  };
  for (const task of tasks.filter(task => task.role === 'coder' && !task.id.startsWith('repair-'))) {
    const add = (code: string, message: string) => issues.push({ taskId: task.id, code, message });
    if (!task.expectedFiles?.length) add('ownership', 'Chưa khai báo tệp: worker này phải chạy riêng để tránh ghi đè.');
    if (!task.acceptanceCriteria?.length) add('criteria', 'Chưa khai báo tiêu chí nghiệm thu cụ thể.');
    if (!tasks.some(candidate => candidate.role === 'tester' && dependsOn(candidate, task.id))) add('testing', 'Thiếu tester phụ thuộc; phần triển khai này chưa thể đạt nghiệm thu.');
    if (!tasks.some(candidate => candidate.role === 'reviewer' && dependsOn(candidate, task.id))) add('review', 'Thiếu reviewer độc lập phụ thuộc vào phần triển khai.');
  }
  return issues;
}

/** Per-run observability. Checkpoints describe state, never imply automatic replay. */
export class Pipeline {
  private recovery:unknown[]=[];
  setRecovery(recovery:unknown[]){this.recovery=recovery;}
  private manager?:unknown;
  setManager(manager:unknown){this.manager=manager;}
  private started = Date.now();
  private sequence = 0;
  private peak = 0;
  private attempts = 0;
  private tools = 0;
  private repairs: { round: number; taskId: string; findings: string[] }[] = [];
  constructor(private root: string, private sessionId: string, private maxAgents: number) {}
  dispatch(tasks: Task[]) { this.attempts++; this.peak = Math.max(this.peak, tasks.filter(task => task.status === 'running').length); }
  tool() { this.tools++; }
  repair(round: number, taskId: string, findings: string[]) { this.repairs.push({ round, taskId, findings }); }
  snapshot(tasks: Task[], evidence: Map<string, TaskEvidence>, status = 'running', gate?: unknown) {
    const summaries = tasks.map(task => verificationEvidence(task, evidence.get(task.id)));
    const report = {
      version: 1, sessionId: this.sessionId, sequence: ++this.sequence, status,
      updatedAt: new Date().toISOString(), elapsedMs: Date.now() - this.started, maxAgents: this.maxAgents,
      peakConcurrency: this.peak, attempts: this.attempts, toolCalls: this.tools,
      completed: tasks.filter(task => task.status === 'completed').length, total: tasks.length,
      successfulChecks: summaries.reduce((sum, proof) => sum + proof.successfulChecks, 0),
      failedChecks: summaries.reduce((sum, proof) => sum + proof.failedChecks, 0),
      environmentWarnings: summaries.reduce((sum, proof) => sum + proof.warnings, 0),
      repairs: this.repairs, recovery:this.recovery, diagnostics: inspectPlan(tasks), execution: executionDiagnosis(tasks), gate, manager:this.manager,
      tasks: tasks.map(task => {
        const proof = evidence.get(task.id);
        return {
          id: task.id, title: task.title, phase: taskPhase(task), status: task.status, model: task.model,
          dependencies: task.dependencies, attempt: task.retries || 0, error: task.error || null,
          changedFiles: task.changedFiles || [],
          criteria: task.acceptanceCriteria || [], requiredCommands: task.verificationCommands || [],
          evidence: proof ? { requiredPassed: (task.verificationCommands || []).filter(command => !proof.stale && !staleEvidence(proof) && latestChecks(proof).some(check => check.exitCode === 0 && check.command.trim() === command.trim())).length, executionErrors: proof.executionErrors || [], inspected: proof.inspected, stale: proof.stale || staleEvidence(proof), checks: (proof.checks || []).map(check => ({ command: check.command, exitCode: check.exitCode, excerpt: check.excerpt.slice(0, 800), kind: isEnvironmentProbe(check.command, task.verificationCommands) ? 'probe' : isReportCommand(check.command, task.verificationCommands) ? 'artifact' : 'verification' })) } : null
        };
      })
    };
    const safeReport = JSON.parse(redact(JSON.stringify(report))) as typeof report;
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, 'pipeline.json'), temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(safeReport, null, 2));
    try { fs.renameSync(temp, file); }
    catch (error) {
      // Windows may refuse replacing an existing destination; replace it only
      // after the fully written temporary checkpoint is ready.
      if (!fs.existsSync(file)) throw error;
      fs.rmSync(file, { force: true }); fs.renameSync(temp, file);
    }
    return safeReport;
  }
}
