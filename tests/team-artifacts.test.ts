import { describe, expect, it } from 'vitest';
import { executionDiagnosis, qualityGate, recordEvidence, verificationEvidence, gateEvidence, isEnvironmentProbe,isSearchCommand,reviewVerdict, type TaskEvidence } from '../src/team-artifacts.js';
import { parseTeamPlan } from '../src/teamwork.js';

describe('Independent teamwork evidence', () => {
  it('uses the latest completed check without deleting earlier failures; required checks and real audit still block',()=>{
    const proof:TaskEvidence={inspected:true,successfulChecks:1,failedChecks:3,toolErrors:0,checks:[{command:'npm run build',exitCode:1,excerpt:'ENOENT'},{command:'npm run build',exitCode:0,excerpt:'built'},{command:'npm ls playwright @playwright/test --depth=0',exitCode:1,excerpt:'missing runtime'},{command:'rg -n "secret|token" src',exitCode:1,excerpt:'no matches'}]};
    expect(verificationEvidence({},proof)).toMatchObject({successfulChecks:1,failedChecks:0,warnings:2});expect(proof.checks).toHaveLength(4);
    expect(verificationEvidence({verificationCommands:['npm ls playwright @playwright/test --depth=0']},proof).failedChecks).toBe(1);
    proof.checks!.push({command:'npm audit --omit=dev',exitCode:1,excerpt:'unresolved high vulnerability'});expect(verificationEvidence({},proof).failedChecks).toBe(1);
    for(const command of ['rg token src & npm test','rg token src ; npm test','rg token src \\& npm test','rg "$(npm test)" src','findstr token src > proof.txt'])expect(isSearchCommand(command)).toBe(false);
    expect(isSearchCommand('rg -n "secret|token" src')).toBe(true);
    const [task]=parseTeamPlan('{"tasks":[{"title":"Gate","role":"tester"}]}');task.resultSummary='{"verdict":"UNVERIFIED","findings":[{"title":"No browser runtime"}]}';expect(reviewVerdict(task)).toBe('UNVERIFIED');
  });
  it('replaces a recorded timeout with a later completed result but keeps a later timeout blocking',()=>{
    const proof:TaskEvidence={inspected:true,successfulChecks:0,failedChecks:0,toolErrors:0},calls=new Map<string,string>();
    recordEvidence(proof,{role:'assistant',content:'',tool_calls:[{id:'a',type:'function',function:{name:'run_command',arguments:'{"command":"npm test"}'}}]},calls);
    recordEvidence(proof,{role:'tool',tool_call_id:'a',content:'{"ok":false,"error":"timeout"}'},calls);recordEvidence(proof,{role:'tool',tool_call_id:'a',content:'{"ok":true,"output":"exit=0\\npassed"}'},calls);expect(verificationEvidence({},proof).failedChecks).toBe(0);
    recordEvidence(proof,{role:'tool',tool_call_id:'a',content:'{"ok":false,"error":"timeout again"}'},calls);expect(verificationEvidence({},proof).failedChecks).toBeGreaterThan(0);
  });
  it('keeps coder experiments but requires independent execution and blocks the latest failed required command', () => {
    const tasks=parseTeamPlan(JSON.stringify({tasks:[{id:'code',title:'Code',role:'coder',verificationCommands:['npm test']},{id:'test',title:'Test',role:'tester',dependencies:['code']},{id:'review',title:'Review',role:'reviewer',dependencies:['test']}]}));tasks.forEach(task=>task.status='completed');tasks[2].resultSummary='{"verdict":"PASS","findings":[]}';
    const proof:TaskEvidence={inspected:true,successfulChecks:1,failedChecks:2,toolErrors:0,checks:[{command:'npm test',exitCode:1,excerpt:'before fix'},{command:'node diagnostic.cjs',exitCode:1,excerpt:'experiment'},{command:'npm test',exitCode:0,excerpt:'after fix'}]};
    const evidence=new Map<string,TaskEvidence>([['code',proof],['test',{inspected:true,successfulChecks:1,failedChecks:0,toolErrors:0}],['review',{inspected:true,successfulChecks:0,failedChecks:0,toolErrors:0}]]);
    expect(qualityGate(tasks,evidence).verdict).toBe('PASS');expect(proof.failedChecks).toBe(2);
    evidence.delete('test');expect(qualityGate(tasks,evidence).verdict).toBe('UNVERIFIED');
    proof.checks!.push({command:'npm test',exitCode:1,excerpt:'latest failure'});expect(gateEvidence(tasks[0],proof).failedChecks).toBe(1);expect(qualityGate(tasks,evidence).verdict).toBe('FAIL');
  });
  it('does not veto successful required suites because optional Python version detection fails, including old checkpoints', () => {
    const [task] = parseTeamPlan(JSON.stringify({tasks:[{id:'test',title:'Verify',role:'tester',verificationCommands:['npm test','npm run test:browser']}]})); task.status='completed';
    const proof: TaskEvidence = {inspected:true,successfulChecks:2,failedChecks:1,toolErrors:1,checks:[
      {command:'python --version',exitCode:9009,excerpt:'Python missing'},
      {command:'npm test',exitCode:0,excerpt:'4 passed'},
      {command:'npm run test:browser',exitCode:0,excerpt:'11 passed'}
    ]};
    expect(verificationEvidence(task,proof)).toMatchObject({successfulChecks:2,failedChecks:0,warnings:1});
    expect(qualityGate([task],new Map([[task.id,proof]])).verdict).toBe('PASS');
    expect(proof.failedChecks).toBe(1); // Historical records are preserved.
    proof.checks!.push({command:'npm test',exitCode:1,excerpt:'real failure'});
    expect(qualityGate([task],new Map([[task.id,proof]])).verdict).toBe('FAIL');
  });
  it('cannot use version probes as successful test evidence and cannot exempt an explicitly required probe', () => {
    const [task] = parseTeamPlan(JSON.stringify({tasks:[{id:'test',title:'Verify',role:'tester'}]}));task.status='completed';
    const proof:TaskEvidence={inspected:true,successfulChecks:1,failedChecks:0,toolErrors:0,checks:[{command:'node --version',exitCode:0,excerpt:'version'}]};
    expect(qualityGate([task],new Map([[task.id,proof]])).verdict).toBe('UNVERIFIED');
    task.verificationCommands=['python --version'];proof.checks=[{command:'python --version',exitCode:9009,excerpt:'missing'}];
    expect(qualityGate([task],new Map([[task.id,proof]])).verdict).toBe('FAIL');
    expect(isEnvironmentProbe('python --version && npm test')).toBe(false);
    expect(isEnvironmentProbe('node -e "process.exit(1)"')).toBe(false);
  });
  it('records a timed-out verification as a blocking failure with its actual command', () => {
    const proof:TaskEvidence={inspected:false,successfulChecks:0,failedChecks:0,toolErrors:0};const calls=new Map<string,string>();
    recordEvidence(proof,{role:'assistant',content:'',tool_calls:[{id:'test',type:'function',function:{name:'run_command',arguments:JSON.stringify({command:'npm test'})}}]},calls);
    recordEvidence(proof,{role:'tool',tool_call_id:'test',content:JSON.stringify({ok:false,error:'Command timed out after 120000 ms'})},calls);
    expect(verificationEvidence({},proof)).toMatchObject({failedChecks:1,failures:['npm test · Command timed out after 120000 ms']});
  });
  it('keeps failed command evidence when the runner reports ok=false', () => {
    const evidence = { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
    const calls = new Map([['check', 'run_command']]);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: false, output: 'exit=7\nfailed' }) }, calls);
    expect(evidence.failedChecks).toBe(1); expect(evidence.successfulChecks).toBe(0);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: false, output: 'exit=0\nuntrusted completion' }) }, calls);
    expect(evidence.successfulChecks).toBe(0);
  });
  it('does not equate completed claims with verified implementation', () => {
    const tasks = parseTeamPlan(JSON.stringify({ tasks: [{ id: 'code', role: 'coder', title: 'Code' }, { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'] }, { id: 'review', role: 'reviewer', title: 'Review', dependencies: ['test'] }] }));
    for (const task of tasks) task.status = 'completed';
    expect(qualityGate(tasks, new Map()).verdict).toBe('UNVERIFIED');
    const evidence = new Map<string, TaskEvidence>([['test', { inspected: true, successfulChecks: 1, failedChecks: 0, toolErrors: 0 }], ['review', { inspected: true, successfulChecks: 0, failedChecks: 0, toolErrors: 0 }]]);
    tasks[2].resultSummary = JSON.stringify({ verdict: 'PASS', findings: [] });
    expect(qualityGate(tasks, evidence).verdict).toBe('PASS');
    evidence.get('test')!.failedChecks++;
    expect(qualityGate(tasks, evidence).verdict).toBe('FAIL');
  });
  it('records actual tool results and rejects free-form claims as execution evidence', () => {
    const evidence = { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
    const calls = new Map([['check', 'run_tests'], ['read', 'read_file']]);
    recordEvidence(evidence, { role: 'assistant', content: 'Tests passed exit=0' }, calls);
    expect(evidence.successfulChecks).toBe(0);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: true, output: 'command=npm test\nexit=0\n3 passed' }) }, calls);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'read', content: JSON.stringify({ ok: true, output: 'source' }) }, calls);
    recordEvidence(evidence, { role: 'tool', tool_call_id: 'check', content: JSON.stringify({ ok: true, output: 'exit=1\nfailed' }) }, calls);
    expect(evidence).toMatchObject({ inspected: true, successfulChecks: 1, failedChecks: 1 });
  });
  it('reports context failures before downstream blocked checks without weakening acceptance', () => {
    const tasks = parseTeamPlan(JSON.stringify({ tasks: [
      { id: 'code', role: 'coder', title: 'Code' },
      { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'], verificationCommands: ['npm test'] },
      { id: 'review', role: 'reviewer', title: 'Review', dependencies: ['test'] },
    ] }));
    tasks[0].status = 'failed'; tasks[0].error = 'Context budget exhausted';
    tasks[1].status = tasks[2].status = 'blocked';
    const gate = qualityGate(tasks, new Map());
    expect(gate.verdict).toBe('FAIL');
    expect(gate.reasons[0]).toBe('code: Context budget exhausted');
    expect(gate.reasons).toHaveLength(3);
    expect(gate.diagnosis.blocked).toEqual([
      { taskId: 'test', blockedBy: ['code'], dependencies: ['code'] },
      { taskId: 'review', blockedBy: ['code'], dependencies: ['test'] },
    ]);
    tasks.forEach(task => { task.status = 'completed'; });
    expect(qualityGate(tasks, new Map()).verdict).toBe('UNVERIFIED');
  });
  it('handles dependency cycles and cancellation when identifying blocked roots', () => {
    const tasks = parseTeamPlan(JSON.stringify({ tasks: [
      { id: 'code', role: 'coder', title: 'Code' },
      { id: 'test', role: 'tester', title: 'Test', dependencies: ['code'] },
    ] }));
    tasks[0].status = 'cancelled'; tasks[1].status = 'blocked';
    expect(executionDiagnosis(tasks).blocked[0].blockedBy).toEqual(['code']);
    tasks[0].status = 'blocked'; tasks[0].dependencies = ['test'];
    expect(executionDiagnosis(tasks).blocked[0].blockedBy).toEqual([]);
  });
  it('accepts Windows execution headers but never output-body exit claims or malformed payloads', () => {
    const proof: TaskEvidence = { inspected: false, successfulChecks: 0, failedChecks: 0, toolErrors: 0 };
    const calls = new Map([['check', 'run_tests']]);
    const tool = (content: string) => recordEvidence(proof, { role: 'tool', tool_call_id: 'check', content }, calls);
    tool(JSON.stringify({ ok: true, output: 'command=npm test\r\nexit=0\r\npassed' }));
    expect(proof.checks?.[0].command).toBe('npm test');
    tool(JSON.stringify({ ok: true, output: 'exit=undefined\nstdout:\nexit=0\n' }));
    tool(JSON.stringify({ ok: true, output: 42 }));
    tool('null');
    expect(proof.successfulChecks).toBe(1);
    expect(proof.toolErrors).toBe(1);
  });
});
