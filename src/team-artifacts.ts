import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath } from './security.js';
import type { Message, Task } from './types.js';
import { taskPhase } from './team-protocol.js';

export interface TaskEvidence { inspected: boolean; successfulChecks: number; failedChecks: number; toolErrors: number; sequence?:number; commands?: Record<string, string>; checks?: { command: string; exitCode: number; excerpt: string; sequence?:number; kind?: 'probe' | 'artifact' | 'search' | 'verification' }[]; executionErrors?: { command: string; error: string; sequence?:number }[]; files?: Record<string, string | null>; stale?: boolean }
function standalone(command:string){if(command.includes('$(')||command.includes('`'))return false;let quote='';for(const character of command){if(quote){if(character===quote)quote='';continue;}if(character==='"'||character==="'"){quote=character;continue;}if(/[;&|<>^\r\n]/.test(character))return false;}return !quote;}
export function isSearchCommand(command:string,required:readonly string[]=[]){return !required.some(item=>item.trim()===command.trim())&&standalone(command)&&/^(?:rg|findstr)(?:\.exe)?\s+/.test(command.trim());}
export function advisoryCheck(check:{command:string;exitCode:number},required:readonly string[]=[]){return isAdvisoryCommand(check.command,required)||(check.exitCode<=1&&isSearchCommand(check.command,required));}
/** Full attempt history remains local; the latest result of each exact command gates acceptance. */
export function latestChecks(proof:TaskEvidence){const latest=new Map<string,NonNullable<TaskEvidence['checks']>[number]>();for(const check of proof.checks||[])latest.set(check.command.trim(),check);return [...latest.values()];}
/** Only exact, standalone runtime version probes are advisory. Compound commands,
 * test runners and explicitly required probes remain acceptance evidence. */
export function isEnvironmentProbe(command: string, required: readonly string[] = []) {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (required.some(item => item.trim().replace(/\s+/g, ' ') === normalized)) return false;
  if (/^(?:python(?:3)?|py|node|npm|npx|git|ruby|go|cargo|rustc|java)(?:\.exe)? (?:--version|-V)$/i.test(normalized)) return true;
  if(standalone(command)&&/^npm ls (?:playwright|playwright-core|@playwright\/test)(?: (?:playwright|playwright-core|@playwright\/test))* --depth=0$/.test(normalized))return true;
  // A narrowly recognized import-only availability check. Tests, assertions,
  // additional statements and shell chains never receive this exemption.
  const python = command.trim().match(/^(?:python(?:3)?|py)(?:\.exe)? -c (["'])([\s\S]+)\1$/i);
  return !!python && /^import [a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*\s*;\s*print\((['"])[^'"\r\n]*\1\)\s*;?$/.test(python[2]);
}
export function isReportCommand(command: string, required: readonly string[] = []) {
  if (required.some(item => item.trim() === command.trim())) return false;
  const match = command.trim().match(/^@'\r?\n([\s\S]*)\r?\n'@\s*\|\s*Set-Content\s+-Path\s+(['"])((?:test-results|reports)\/[a-zA-Z0-9_./-]+\.json)\2\s+-Encoding\s+utf8\s*$/i);
  if (!match || match[3].split('/').some(part => part === '..' || part === '.' || !part)) return false;
  try { const value = JSON.parse(match[1]); return !!value && typeof value === 'object' && !Array.isArray(value); } catch { return false; }
}
export function isAdvisoryCommand(command: string, required: readonly string[] = []) { return isEnvironmentProbe(command, required) || isReportCommand(command, required); }
export function verificationEvidence(task: Pick<Task, 'verificationCommands'>, proof?: TaskEvidence) {
  if (!proof) return { successfulChecks: 0, failedChecks: 0, warnings: 0, failures: [] as string[] };
  if (!proof.checks && !proof.executionErrors) return { successfulChecks: proof.successfulChecks, failedChecks: proof.failedChecks, warnings: 0, failures: [] as string[] };
  const checks = latestChecks(proof).filter(check => !advisoryCheck(check, task.verificationCommands));
  const errors = (proof.executionErrors || []).filter(error => !isAdvisoryCommand(error.command, task.verificationCommands)&&!checks.some(check=>check.command.trim()===error.command.trim()&&check.sequence!==undefined&&error.sequence!==undefined&&check.sequence>error.sequence));
  return { successfulChecks: checks.filter(check => check.exitCode === 0).length,
    failedChecks: checks.filter(check => check.exitCode !== 0).length + errors.length,
    warnings: (proof.checks || []).filter(check => check.exitCode !== 0 && advisoryCheck(check, task.verificationCommands)).length + (proof.executionErrors || []).filter(error => isAdvisoryCommand(error.command, task.verificationCommands)).length,
    failures: [...checks.filter(check => check.exitCode !== 0).map(check => `${check.command.slice(0, 200)} · exit=${check.exitCode}`), ...errors.map(error => `${error.command.slice(0, 200)} · ${error.error.slice(0, 300)}`)] };
}
/** Development experiments remain in the log. A coder is accepted only through
 * its required commands and fresh dependent testing/review of the final source. */
export function gateEvidence(task: Pick<Task, 'role' | 'verificationCommands'>, proof?: TaskEvidence) {
  const summary = verificationEvidence(task, proof);
  if (task.role !== 'coder' || !proof?.checks) return summary;
  const required = task.verificationCommands || [];
  const failures = required.flatMap(command => {
    const last = proof.checks!.filter(check => check.command.trim() === command.trim()).at(-1);
    const errors = (proof.executionErrors || []).filter(error => error.command.trim() === command.trim()&&!(last?.sequence!==undefined&&error.sequence!==undefined&&last.sequence>error.sequence));
    return [...(last && last.exitCode !== 0 ? [`${command.slice(0,200)} · exit=${last.exitCode}`] : []), ...errors.map(error => `${command.slice(0,200)} · ${error.error.slice(0,300)}`)];
  });
  return { ...summary, failedChecks: failures.length, failures };
}
export function dependencyFingerprints(task: Task, tasks: Task[], scope: string) {
  const seen = new Set<string>(), files: Record<string, string | null> = {};
  const visit = (task: Task) => {
    if (seen.has(task.id)) return; seen.add(task.id);
    if (task.role === 'coder') for (const file of task.expectedFiles || []) {
      const key = path.resolve(scope, file);
      try { files[key] = crypto.createHash('sha256').update(fs.readFileSync(safePath(scope, file))).digest('hex'); } catch { files[key] = null; }
    }
    for (const id of task.dependencies) { const parent = tasks.find(candidate => candidate.id === id); if (parent) visit(parent); }
  };
  visit(task); return files;
}
export function staleEvidence(proof: TaskEvidence) {
  return Object.entries(proof.files || {}).some(([file, expected]) => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected; } catch { return expected !== null; }
  });
}
export function recordEvidence(evidence: TaskEvidence, item: Message, calls: Map<string, string>, required: readonly string[] = []) {
  for (const call of item.tool_calls || []) {
    calls.set(call.id, call.function.name);
    try { const command = JSON.parse(call.function.arguments)?.command; (evidence.commands ||= {})[call.id] = typeof command === 'string' ? command : ''; } catch { /* Invalid arguments cannot execute. */ }
  }
  if (item.role !== 'tool') return;
  let result: { ok?: boolean; output?: string; error?: string };
  try { result = JSON.parse(item.content || '{}'); } catch { evidence.toolErrors++; return; }
  if (!result || typeof result !== 'object') { evidence.toolErrors++; return; }
  const tool = calls.get(item.tool_call_id || '');
  if (result.ok !== true) {
    evidence.toolErrors++;
    if (!['run_tests', 'run_command'].includes(tool || '')) return;
  }
  if (['inspect_project', 'read_file', 'git_diff', 'search_files'].includes(tool || '')) evidence.inspected = true;
  if (!['run_tests', 'run_command'].includes(tool || '')) return;
  // Only the runner header is evidence. A string printed by the command body
  // (for example after an undefined exit code) cannot manufacture a passing run.
  const output = typeof result.output === 'string' ? result.output : '';
  const exit = output.match(/^(?:command=[^\r\n]*\r?\n)?exit=(\d+)(?:\r?\n|$)/);
  if (!exit) {
    if (result.ok === false) {
      const command = evidence.commands?.[item.tool_call_id || ''] || (tool === 'run_tests' ? 'run_tests' : '');
      evidence.sequence=(evidence.sequence||0)+1;
      (evidence.executionErrors ||= []).push({ command, error: typeof result.error === 'string' ? result.error : 'Command did not produce a completed execution result',sequence:evidence.sequence });
      if (!isAdvisoryCommand(command, required)) evidence.failedChecks++;
    }
    return;
  }
  if (result.ok !== true && exit[1] === '0') return;
  const command = output.match(/^command=([^\r\n]+)/)?.[1] || evidence.commands?.[item.tool_call_id || ''] || '';
  const kind = isEnvironmentProbe(command, required) ? 'probe' : isReportCommand(command, required) ? 'artifact' : Number(exit[1])<=1&&isSearchCommand(command,required)?'search':'verification';
  evidence.sequence=(evidence.sequence||0)+1;
  (evidence.checks ||= []).push({ command, exitCode: Number(exit[1]), excerpt: output.slice(0, 3000), kind,sequence:evidence.sequence });
  if (kind === 'verification') { if (exit[1] === '0') evidence.successfulChecks++; else evidence.failedChecks++; }
}

/** Separate execution failures from validators that never had a chance to run. */
export function executionDiagnosis(tasks: Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const roots = (task: Task, seen = new Set<string>()): string[] => {
    if (seen.has(task.id)) return []; seen.add(task.id);
    if (task.status === 'failed' || task.status === 'cancelled') return [task.id];
    return task.dependencies.flatMap(id => {
      const parent = byId.get(id); return parent ? roots(parent, seen) : [];
    });
  };
  return {
    failures: tasks.filter(task => task.status === 'failed' || task.status === 'cancelled').map(task => ({
      taskId: task.id, status: task.status, error: task.error || task.resultSummary || 'Không có chi tiết lỗi.',
    })),
    blocked: tasks.filter(task => task.status === 'blocked').map(task => ({
      taskId: task.id, blockedBy: [...new Set(roots(task))],
      dependencies: task.dependencies.filter(id => byId.get(id)?.status !== 'completed'),
    })),
  };
}

export function reviewVerdict(task: Task): 'PASS' | 'FAIL' | 'UNVERIFIED' {
  try {
    const report = JSON.parse((task.resultSummary || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (report.verdict === 'PASS' && Array.isArray(report.findings) && report.findings.length === 0) return 'PASS';
    if (report.verdict === 'UNVERIFIED') return 'UNVERIFIED';
    if (report.verdict === 'FAIL' || report.findings?.length) return 'FAIL';
  } catch { /* Free-form claims are not a structured review verdict. */ }
  return 'UNVERIFIED';
}

export function qualityGate(tasks: Task[], evidence: Map<string, TaskEvidence>) {
  const implementation = tasks.filter(task => task.role === 'coder');
  const diagnosis = executionDiagnosis(tasks);
  const reasons: string[] = diagnosis.failures.map(failure => `${failure.taskId}: ${failure.error}`);
  for (const blocked of diagnosis.blocked) reasons.push(`${blocked.taskId}: chưa thực thi, bị chặn bởi ${blocked.blockedBy.length ? blocked.blockedBy.join(', ') : blocked.dependencies.join(', ') || 'phụ thuộc chưa sẵn sàng'}.`);
  if (!implementation.length && !tasks.some(task => ['tester', 'reviewer', 'judge'].includes(task.role))) return { verdict: tasks.every(t => t.status === 'completed') ? 'PASS' : 'FAIL', reasons: reasons.length ? reasons : ['Không có thay đổi mã nguồn trong kế hoạch.'], diagnosis };
  const dependsOn = (task: Task, id: string, visited = new Set<string>()): boolean => {
    if (visited.has(task.id)) return false; visited.add(task.id);
    return task.dependencies.includes(id) || task.dependencies.some(dep => {
      const parent = tasks.find(candidate => candidate.id === dep); return Boolean(parent && dependsOn(parent, id, visited));
    });
  };
  for (const coder of implementation) {
    if (coder.status !== 'completed') continue;
    const testers = tasks.filter(t => t.role === 'tester' && dependsOn(t, coder.id));
    const reviews = tasks.filter(t => t.role === 'reviewer' && dependsOn(t, coder.id));
    if (!testers.some(t => t.status === 'completed' && !evidence.get(t.id)?.stale && verificationEvidence(t, evidence.get(t.id)).successfulChecks > 0) && !testers.some(t => ['failed', 'blocked', 'cancelled'].includes(t.status))) reasons.push(`${coder.id}: chưa có kiểm tra thực thi thành công từ tester phụ thuộc.`);
    if ((!reviews.length || !reviews.every(t => t.status === 'completed' && !evidence.get(t.id)?.stale && evidence.get(t.id)?.inspected && reviewVerdict(t) === 'PASS')) && !reviews.some(t => ['failed', 'blocked', 'cancelled'].includes(t.status))) reasons.push(`${coder.id}: cần tất cả reviewer phụ thuộc đọc mã và trả PASS không có finding.`);
  }
  for (const task of tasks.filter(t => ['challenge', 'audit', 'acceptance'].includes(taskPhase(t)))) {
    if (task.status !== 'completed') continue;
    const proof = evidence.get(task.id);
    if (proof?.stale || reviewVerdict(task) !== 'PASS' || !proof?.inspected || (task.role !== 'judge' && !verificationEvidence(task, proof).successfulChecks)) reasons.push(`${task.id}: chưa có kết luận PASS độc lập và bằng chứng cho phase ${taskPhase(task)}.`);
    if (['audit', 'acceptance'].includes(taskPhase(task)) && implementation.some(coder => !dependsOn(task, coder.id))) reasons.push(`${task.id}: audit/nghiệm thu chưa phụ thuộc vào toàn bộ phần triển khai.`);
    if (taskPhase(task) === 'acceptance' && tasks.some(audit => taskPhase(audit) === 'audit' && !dependsOn(task, audit.id))) reasons.push(`${task.id}: nghiệm thu chưa phụ thuộc vào toàn bộ audit.`);
  }
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (gateEvidence(task, evidence.get(task.id)).failedChecks > 0) reasons.push(`${task.id}: có kiểm tra bắt buộc/thẩm định thất bại: ${gateEvidence(task, evidence.get(task.id)).failures.join('; ') || 'xem bằng chứng thực thi'}.`);
    if (evidence.get(task.id)?.stale) reasons.push(`${task.id}: bằng chứng mất hiệu lực vì mã nguồn đã thay đổi sau kiểm tra.`);
    if (taskPhase(task) === 'verification' && !verificationEvidence(task, evidence.get(task.id)).successfulChecks) reasons.push(`${task.id}: thiếu kiểm tra được thực thi thành công.`);
    if (task.role === 'reviewer' && (!evidence.get(task.id)?.inspected || reviewVerdict(task) !== 'PASS')) reasons.push(`${task.id}: thiếu review PASS với inspection độc lập.`);
    for (const command of task.verificationCommands || []) {
      if (!evidence.get(task.id)?.checks?.some(check => check.exitCode === 0 && check.command.trim() === command.trim())) reasons.push(`${task.id}: chưa chạy thành công lệnh yêu cầu ${command}`);
    }
  }
  const failed = tasks.some(t => t.status !== 'completed' || gateEvidence(t, evidence.get(t.id)).failedChecks > 0 || (['review', 'challenge', 'audit', 'acceptance'].includes(taskPhase(t)) && reviewVerdict(t) === 'FAIL'));
  return { verdict: failed ? 'FAIL' : reasons.length ? 'UNVERIFIED' : 'PASS', reasons, diagnosis };
}

export function structuredHandoff(task: Task, proof?: TaskEvidence) {
  let report: Record<string, unknown> = {};
  try { const parsed = JSON.parse((task.resultSummary || '').replace(/^```(?:json)?\s*|\s*```$/g, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) report = parsed; } catch { /* Preserve original report separately. */ }
  return {
    taskId: task.id, phase: taskPhase(task), status: task.status, attempt: task.retries || 0, workspace: task.worktreePath || null,
    observation: report.observation || task.resultSummary || task.error || 'No observation',
    logicChain: report.logicChain || 'See original agent report; no structured decision rationale provided.',
    caveats: report.caveats || ['Agent statements require independent verification.'], conclusion: report.conclusion || task.status,
    verificationMethod: proof?.checks || [], invalidationConditions: report.invalidationConditions || ['Any change to assigned or dependency files after this attempt invalidates its verification.'],
    acceptanceCriteria: task.acceptanceCriteria || [], verdict: reviewVerdict(task), findings: report.findings || [], toolEvidence: proof || null
  };
}

export function writeAgentArtifact(root: string, aid: string, file: string, content: string) {
  const folder = path.join(root, 'agents', aid);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, file), content);
}
