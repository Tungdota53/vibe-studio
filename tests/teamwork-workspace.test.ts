import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Teamwork } from '../src/teamwork.js';
import { Worktrees } from '../src/worktree.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { ModelRouter } from '../src/router.js';
import { Tools } from '../src/tools.js';
import type { ModelClient } from '../src/model.js';
import { ModelStreamInterruptedError } from '../src/model.js';
import type { Message } from '../src/types.js';

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-workspace-')); roots.push(value); return value; }
async function git(root: string, ...args: string[]) { return execa('git', args, { cwd: root }); }
async function repository(root: string) {
  await git(root, 'init'); fs.writeFileSync(path.join(root, 'existing.txt'), 'user source'); await git(root, 'add', 'existing.txt');
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial');
}
function runner(root: string, plan: any[], reply: (messages: Message[]) => Promise<any>) {
  const config = { ...loadConfig(root), namedAgents: [], maxAgents: 4, useWorktrees: true };
  const store = new Store(path.join(root, '.vibe')); stores.push(store); let first = true;
  const client = { config, chat: async (messages: Message[]) => {
    if (first) { first = false; return { content: JSON.stringify({ tasks: plan }), toolCalls: [] }; }
    return reply(messages);
  } } as unknown as ModelClient;
  return { team: new Teamwork(config, store, client, new ModelRouter(config), async () => false), store };
}
describe('Teamwork workspace mode', () => {
  it('tries distinct recovery strategies before requesting help for an unresolved campaign',async()=>{
    const dir=root();let fixes=0;const command='node -e "process.exit(1)"';
    const {team}=runner(dir,[{id:'code',role:'coder',title:'Code',description:'create',expectedFiles:['a.txt']},{id:'test',role:'tester',title:'Verify',description:'verify',dependencies:['code'],verificationCommands:[command]}],async messages=>{
      const request=messages.findLast(message=>message.role==='user')?.content||'';
      if(!messages.some(message=>message.role==='tool')){if(request.startsWith('[REPAIR]'))fixes++;return {content:'',toolCalls:[{id:'call',type:'function',function:{name:request==='verify'?'run_command':request.startsWith('[REPAIR]')||request==='create'?'write_file':'read_file',arguments:JSON.stringify(request==='verify'?{command}:request.startsWith('[REPAIR]')||request==='create'?{path:'a.txt',content:'different source '+fixes}:{path:'a.txt'})}}]};}
      return {content:request.startsWith('[RECOVERY DIAGNOSIS]')?'{"rootCause":"the recorded command always exits 1","evidence":["read a.txt and recorded command"],"nextAction":"try the assigned alternative without weakening required checks"}':request==='verify'?'failed wording '+fixes:request.startsWith('[REPAIR]')||request==='create'?'done':'{"verdict":"PASS","findings":[]}',toolCalls:[]};
    });
    const result=await team.run('Avoid unproductive repair loop',()=>{});expect(result.gate.verdict).toBe('FAIL');expect(fixes).toBe(8);expect(result.tasks.find(task=>task.id==='test')?.error).toContain('Phục hồi cần hỗ trợ');
    const saved=JSON.parse(fs.readFileSync(path.join(dir,'.vibe','sessions',result.id,'resume.json'),'utf8'));expect(saved.repairProgress.stagnant).toBe(8);expect(saved.recoveryCampaign.history).toHaveLength(8);
    expect(result.tasks.some(task=>task.id==='repair-9')).toBe(false);expect(result.tasks.filter(task=>task.id.startsWith('diagnosis-')&&task.status==='completed')).toHaveLength(6);
  },20000);
  it('recovers after the old four-round stop by using an inspected diagnosis and minimal reproduction',async()=>{
    const dir=root();let fixes=0,diagnoses=0,sawDiagnosis=false;const command=`node -e "process.exit(require('fs').readFileSync('a.txt','utf8')==='good'?0:1)"`;
    const {team}=runner(dir,[{id:'code',role:'coder',title:'Code',description:'create',expectedFiles:['a.txt']},{id:'test',role:'tester',title:'Verify',description:'verify',dependencies:['code'],verificationCommands:[command]}],async messages=>{
      const request=messages.findLast(message=>message.role==='user')?.content||'',repair=request.startsWith('[REPAIR]'),diagnosis=request.startsWith('[RECOVERY DIAGNOSIS]');
      if(!messages.some(message=>message.role==='tool')){if(repair){fixes++;if(request.includes('Recovery strategy: reproduce'))sawDiagnosis=messages.some(message=>message.role==='assistant'&&message.content?.includes('cause-from-current-source'));}if(diagnosis)diagnoses++;
        return {content:'',toolCalls:[{id:'call',type:'function',function:{name:request==='verify'?'run_command':repair||request==='create'?'write_file':'read_file',arguments:JSON.stringify(request==='verify'?{command}:repair||request==='create'?{path:'a.txt',content:fixes>=5?'good':'bad'}:{path:'a.txt'})}}]};}
      return {content:diagnosis?'{"rootCause":"cause-from-current-source","evidence":["read a.txt"],"nextAction":"reproduce value mismatch and correct assigned file"}':request==='verify'?'verified execution':repair||request==='create'?'done':'{"verdict":"PASS","findings":[]}',toolCalls:[]};
    });
    const result=await team.run('Adaptive recovery',()=>{});expect(result.gate.verdict).toBe('PASS');expect(fixes).toBe(5);expect(diagnoses).toBe(3);expect(sawDiagnosis).toBe(true);expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('good');expect(result.tasks.find(task=>task.id==='test')?.status).toBe('completed');
  },20000);
  it('accepts an adjustment during the final model response without creating another plan',async()=>{
    const dir=root();let release!:()=>void,started!:()=>void,calls=0;const waiting=new Promise<void>(resolve=>started=resolve),hold=new Promise<void>(resolve=>release=resolve);
    const {team}=runner(dir,[{id:'answer',title:'Answer',description:'original',role:'general'}],async messages=>{
      calls++;if(calls===1){started();await hold;return {content:'old response',toolCalls:[]};}
      expect(messages.some(message=>message.content?.includes('new constraint'))).toBe(true);return {content:'updated response',toolCalls:[]};
    });
    let session='';const events:any[]=[];const run=team.run('Goal',event=>{if(typeof event!=='string'){events.push(event);if(event.type==='session_start')session=event.sessionId;}});await waiting;
    expect(()=>team.control('session-00000000','adjust',undefined,'wrong session')).toThrow();
    team.control(session,'adjust','answer','new constraint');release();const result=await run;
    expect(result.tasks[0].resultSummary).toBe('updated response');expect(calls).toBe(2);expect(events.filter(event=>event.type==='planner_start')).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir,'.vibe','sessions',session,'adjustments.json'),'utf8')).toContain('new constraint');
  });
  it('pauses dispatch without losing tasks and resumes the same saved plan',async()=>{
    const dir=root();let paused!:()=>void,calls=0,session='';const waiting=new Promise<void>(resolve=>paused=resolve);
    const {team}=runner(dir,[{id:'answer',title:'Answer',description:'original',role:'general'}],async()=>{calls++;return {content:'done',toolCalls:[]};});
    const run=team.run('Goal',event=>{if(typeof event==='string')return;if(event.type==='session_start')session=event.sessionId;if(event.type==='planner_done'){team.control(session,'pause');paused();}});
    await waiting;await new Promise(resolve=>setTimeout(resolve,50));expect(calls).toBe(0);expect(team.tasks[0].status).toBe('ready');
    team.control(session,'resume');const result=await run;expect(result.tasks[0].status).toBe('completed');expect(calls).toBe(1);expect(()=>team.control(session,'pause')).toThrow();
  });
  it('automatically repairs an audit-only plan in manifest scope and obtains independent review',async()=>{
    const dir=root();fs.writeFileSync(path.join(dir,'package.json'),'{"private":true}');let fixed=false;const original=Tools.prototype.execute;
    vi.spyOn(Tools.prototype,'execute').mockImplementation(async function(this:Tools,name,raw,signal){if(name==='run_command'&&JSON.parse(raw).command==='npm audit --json')return {ok:fixed,output:fixed?'exit=0\n0 vulnerabilities':'exit=1\nhigh vulnerability',...(fixed?{}:{error:'audit failed'})};if(name==='write_file')fixed=true;return original.call(this,name,raw,signal);});
    try{
      const {team}=runner(dir,[{id:'audit',role:'tester',title:'Audit',description:'audit',verificationCommands:['npm audit --json']}],async messages=>{
        const request=messages.findLast(m=>m.role==='user')?.content||'';
        if(!messages.some(m=>m.role==='tool'))return {content:'',toolCalls:[{id:'call',type:'function',function:{name:request==='audit'?'run_command':request.startsWith('[REPAIR]')?'write_file':'read_file',arguments:JSON.stringify(request==='audit'?{command:'npm audit --json'}:request.startsWith('[REPAIR]')?{path:'package.json',content:'{"private":true,"description":"fixed"}'}:{path:'package.json'})}}]};
        return {content:request==='audit'||request.startsWith('[REPAIR]')?'done':'{"verdict":"PASS","findings":[]}',toolCalls:[]};
      });
      const result=await team.run('Fix audited dependency',()=>{});expect(result.gate.verdict).toBe('PASS');expect(result.tasks.find(t=>t.id==='repair-1')?.expectedFiles).toEqual(['package.json']);expect(result.tasks.find(t=>t.id==='repair-review-1')?.status).toBe('completed');
    }finally{vi.restoreAllMocks();}
  });

  it('automatically recovers transport interruption without replanning or replaying completed writes',async()=>{
    const dir=root();let writes=0,failures=0;const original=Tools.prototype.execute;
    vi.spyOn(Tools.prototype,'execute').mockImplementation(async function(this:Tools,name,raw,signal){if(name==='write_file')writes++;return original.call(this,name,raw,signal);});
    try{
      const {team}=runner(dir,[{id:'code',role:'coder',title:'Create',description:'create',expectedFiles:['a.txt']}],async messages=>{
        if(!messages.some(m=>m.role==='tool'))return {content:'',toolCalls:[{id:'write',type:'function',function:{name:'write_file',arguments:'{"path":"a.txt","content":"saved"}'}}]};
        if(failures++<3)throw new ModelStreamInterruptedError('terminated','',true);
        return {content:'done',toolCalls:[]};
      });
      const events:any[]=[],result=await team.run('Create',event=>events.push(event));
      expect(result.tasks[0].status).toBe('completed');expect(writes).toBe(1);expect(events.filter(e=>e.type==='planner_start')).toHaveLength(1);expect(events.some(e=>e.step==='recovery')).toBe(true);
    }finally{vi.restoreAllMocks();}
  });
  it('continues beyond two repair rounds while source changes, and rechecks the final source',async()=>{
    const dir=root();let fixes=0;const command='node -e "process.exit(0)"',original=Tools.prototype.execute;
    vi.spyOn(Tools.prototype,'execute').mockImplementation(async function(this:Tools,name,raw,signal){if(name==='run_command'&&JSON.parse(raw).command===command)return {ok:fixes>=3,output:fixes>=3?'exit=0\npassed':'exit=1\nnot fixed',...(fixes>=3?{}:{error:'failed'})};return original.call(this,name,raw,signal);});
    try{
      const {team}=runner(dir,[{id:'code',role:'coder',title:'Code',description:'create',expectedFiles:['a.txt']},{id:'test',role:'tester',title:'Verify',description:'verify',dependencies:['code'],verificationCommands:[command]},{id:'review',role:'reviewer',title:'Review',description:'review',dependencies:['test']}],async messages=>{
        const request=messages.findLast(m=>m.role==='user')?.content||'';
        if(!messages.some(m=>m.role==='tool')){
          if(request==='create'||request.startsWith('[REPAIR]')){if(request.startsWith('[REPAIR]'))fixes++;return {content:'',toolCalls:[{id:'write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'a.txt',content:'progress '+fixes})}}]};}
          return {content:'',toolCalls:[{id:'check',type:'function',function:{name:request==='verify'?'run_command':'read_file',arguments:JSON.stringify(request==='verify'?{command}:{path:'a.txt'})}}]};
        }
        return {content:request.startsWith('[RECOVERY DIAGNOSIS]')?'{"rootCause":"read source differs from test expectation","evidence":["read a.txt"],"nextAction":"correct current source"}':request==='review'?'{"verdict":"PASS","findings":[]}':'done',toolCalls:[]};
      });
      const result=await team.run('Repair until correct',()=>{});expect(result.gate.verdict).toBe('PASS');expect(fixes).toBe(3);expect(result.tasks.find(t=>t.id==='repair-3')?.status).toBe('completed');
    }finally{vi.restoreAllMocks();}
  });
  it('requires an inspected diagnosis before another repair rather than accepting a bare report',async()=>{
    const dir=root(),command='node -e "process.exit(1)"';
    const {team}=runner(dir,[{id:'code',role:'coder',title:'Code',description:'create',expectedFiles:['a.txt']},{id:'test',role:'tester',title:'Verify',description:'verify',dependencies:['code'],verificationCommands:[command]}],async messages=>{
      const request=messages.findLast(m=>m.role==='user')?.content||'';
      if(!messages.some(m=>m.role==='tool'))return {content:'',toolCalls:[{id:'call',type:'function',function:{name:request==='verify'?'run_command':'write_file',arguments:JSON.stringify(request==='verify'?{command}:{path:'a.txt',content:'unchanged'})}}]};
      return {content:'done',toolCalls:[]};
    });
    const result=await team.run('Try to repair',()=>{});expect(result.gate.verdict).toBe('FAIL');expect(result.tasks.filter(t=>/^repair-\d+$/.test(t.id))).toHaveLength(3);expect(result.tasks.find(t=>t.id.startsWith('diagnosis-'))?.error).toContain('Recovery diagnosis incomplete');
  });

  it('resumes a finished failed validator with fresh evidence while archiving the old attempt',async()=>{
    const dir=root(),command='node -e "process.exit(0)"';let healed=false,executions=0;
    const original=Tools.prototype.execute;
    vi.spyOn(Tools.prototype,'execute').mockImplementation(async function(this:Tools,name,raw,signal){if(name==='run_command'&&JSON.parse(raw).command===command){executions++;return {ok:healed,output:healed?'exit=0\npassed':'exit=1\nfailed',...(healed?{}:{error:'failed'})};}return original.call(this,name,raw,signal);});
    try{
      const {team}=runner(dir,[{id:'test',role:'tester',title:'Verify',description:'verify',verificationCommands:[command]}],async messages=>{
        if(!messages.some(m=>m.role==='tool'))return {content:'',toolCalls:[{id:'check',type:'function',function:{name:'run_command',arguments:JSON.stringify({command})}}]};
        return {content:'done',toolCalls:[]};
      });
      const first=await team.run('Verify existing project',event=>{if(typeof event!=='string'&&event.type==='task_failed')team.stop();});
      expect(first.tasks[0].status).toBe('failed');healed=true;
      const events:any[]=[],second=await team.resume(first.id,event=>events.push(event));
      expect(second.gate.verdict).toBe('PASS');expect(executions).toBe(2);expect(second.tasks[0].retries).toBe(1);expect(events.some(e=>e.type==='planner_start')).toBe(false);
      const history=path.join(dir,'.vibe','sessions',first.id,'evidence-history');const records=fs.readdirSync(history).map(file=>JSON.parse(fs.readFileSync(path.join(history,file),'utf8')));
      expect(records[0].evidence.checks[0].exitCode).toBe(1);
    }finally{vi.restoreAllMocks();}
  });

  it('continues dependent review when required execution passes despite an optional Python probe failure', async () => {
    const dir=root(), command='node -e "process.exit(0)"';
    const original=Tools.prototype.execute;
    vi.spyOn(Tools.prototype,'execute').mockImplementation(async function(this:Tools,name,raw,signal){
      if(name==='run_command'&&JSON.parse(raw).command==='python --version')return {ok:false,output:'exit=9009\nstdout:\n\nstderr:\nPython unavailable',error:'Command failed'};
      return original.call(this,name,raw,signal);
    });
    try {
      const {team}=runner(dir,[{id:'code',role:'coder',title:'Code',description:'code',expectedFiles:['a.txt']},{id:'test',role:'tester',title:'Test',description:'test',dependencies:['code'],verificationCommands:[command]},{id:'review',role:'reviewer',title:'Review',description:'review',dependencies:['test']}],async messages=>{
        const request=messages.findLast(item=>item.role==='user')?.content;
        if(!messages.some(item=>item.role==='tool')) {
          const call=(id:string,name:string,args:any)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
          return {content:'',toolCalls:request==='code'?[call('write','write_file',{path:'a.txt',content:'source'})]:request==='test'?[call('probe','run_command',{command:'python --version'}),call('check','run_command',{command})]:[call('read','read_file',{path:'a.txt'})]};
        }
        return {content:request==='review'?'{"verdict":"PASS","findings":[]}':'PASS: required check succeeded; Python optional',toolCalls:[]};
      });
      const result=await team.run('Verify project',()=>{});
      expect(result.gate.verdict).toBe('PASS');expect(result.tasks.find(task=>task.id==='review')?.status).toBe('completed');expect(result.tasks.some(task=>task.id.startsWith('repair-'))).toBe(false);
    } finally { vi.restoreAllMocks(); }
  });
  it('resumes an interrupted DAG without replanning or rewriting a completed producer', async () => {
    const dir = root(); let writes = 0, checks = 0;
    const { team } = runner(dir, [
      { id: 'code', role: 'coder', title: 'Produce once', description: 'produce-once', expectedFiles: ['a.txt'] },
      { id: 'check', role: 'tester', title: 'Check later', description: 'verify-once', dependencies: ['code'] }
    ], async messages => {
      const task = messages.findLast(message => message.role === 'user')?.content;
      const outcomes = messages.filter(message => message.role === 'tool');
      if (!outcomes.length) {
        if (task === 'produce-once') { writes++; return { content: '', toolCalls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"produced"}' } }] }; }
        checks++; return { content: '', toolCalls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] };
      }
      return { content: 'done', toolCalls: [] };
    });
    const first = await team.run('Resume completed producer safely', event => { if (typeof event !== 'string' && event.type === 'task_complete' && event.taskId === 'code') team.stop(); });
    expect(first.status).toBe('cancelled'); expect(checks).toBe(0);
    const events: any[] = [], second = await team.resume(first.id, event => events.push(event));
    expect(second.id).toBe(first.id); expect(second.status).toBe('completed'); expect(writes).toBe(1); expect(checks).toBe(1);
    expect(events.some(event => event.type === 'planner_start')).toBe(false);
    expect(second.tasks.every(task => task.status === 'completed')).toBe(true);
  });
  it('keeps an independent branch running after a producer exhausts stream recovery', async () => {
    const dir = root(); let failedAttempts = 0;
    const { team } = runner(dir, [
      { id: 'failed', role: 'coder', title: 'Interrupted producer', description: 'unstable-work', expectedFiles: ['failed.txt'] },
      { id: 'blocked', role: 'tester', title: 'Needs producer', description: 'blocked-work', dependencies: ['failed'] },
      { id: 'independent', role: 'coder', title: 'Independent producer', description: 'independent-work', expectedFiles: ['independent.txt'] },
      { id: 'next', role: 'planner', title: 'Independent consumer', description: 'independent-consumer', dependencies: ['independent'] }
    ], async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content;
      if (request === 'unstable-work') { failedAttempts++; throw new ModelStreamInterruptedError('terminated', '', true); }
      if (request === 'blocked-work') throw new Error('Dependent must never run');
      return { content: 'completed independent work', toolCalls: [] };
    });
    const result = await team.run('Continue independent work after transient transport failure', () => {});
    expect(failedAttempts).toBe(9);
    expect(result.tasks.find(task => task.id === 'failed')?.status).toBe('failed');
    expect(result.tasks.find(task => task.id === 'blocked')?.status).toBe('blocked');
    expect(result.tasks.filter(task => ['independent', 'next'].includes(task.id)).every(task => task.status === 'completed')).toBe(true);
    expect(result.gate.verdict).toBe('FAIL');
  });
  it('rejects overlapping runs and allows a fresh run after cancellation', async () => {
    const dir=root(); let release!:()=>void, entered!:()=>void;
    const started=new Promise<void>(resolve=>entered=resolve), blocked=new Promise<void>(resolve=>release=resolve);
    let firstWorker=true;
    const {team,store}=runner(dir,[{title:'Answer',role:'general',description:'answer-now'}],async messages=>{
      const request=messages.findLast(message=>message.role==='user')?.content || '';
      if(request.startsWith('Workspace mode:')) return {content:JSON.stringify({tasks:[{title:'Again',role:'general',description:'answer-now'}]}),toolCalls:[]};
      if(firstWorker){firstWorker=false;entered();await blocked;}
      return {content:'answer',toolCalls:[]};
    });
    const first=team.run('First',()=>{});
    await started;
    try { await expect(team.run('Overlap')).rejects.toThrow('đang chạy'); team.stop(); }
    finally {release();}
    expect((await first).status).toBe('cancelled');
    expect((store.sessions()[0] as any).status).toBe('cancelled');
    const second=await team.run('Second',()=>{});
    expect(second.status).toBe('completed'); expect(second.tasks).toHaveLength(1);
  });
  it('repairs a malformed plan with prior context before starting workers', async () => {
    const dir=root(); let workers=0, sawPriorOutput=false;
    const {team}=runner(dir,[{title:'Answer',role:'general',acceptanceCriteria:23}],async messages=>{
      const request=messages.findLast(message=>message.role==='user')?.content || '';
      if(request.startsWith('Repair the previous plan')) {
        sawPriorOutput=messages.some(message=>message.role==='assistant' && message.content?.includes('acceptanceCriteria'));
        return {content:JSON.stringify({tasks:[{title:'Answer',role:'general',description:'answer-now'}]}),toolCalls:[]};
      }
      workers++; return {content:'answer',toolCalls:[]};
    });
    const events:any[]=[];
    const result=await team.run('Question',event=>events.push(event));
    expect(result.status).toBe('completed'); expect(sawPriorOutput).toBe(true); expect(workers).toBe(1);
    expect(events.filter(event=>event.step==='plan_repair')).toHaveLength(1);
    expect(fs.existsSync(path.join(dir,'.vibe','sessions',result.id,'agents','agent-plan-01','plan-attempt-2.json'))).toBe(true);
  });
  it('ends the durable session and emits a terminal event when planning cannot recover',async()=>{
    const dir=root(); const {team,store}=runner(dir,[],async()=>({content:'{"tasks":[]}',toolCalls:[]}));
    const events:any[]=[];
    await expect(team.run('Question',event=>events.push(event))).rejects.toThrow('sau 3 lần');
    expect((store.sessions()[0] as any).status).toBe('failed');
    expect(events.filter(event=>event.type==='session_end')).toHaveLength(1);
    expect(team.tasks).toHaveLength(0);
  });
  it('repairs impossible read-only verification requirements before dispatch', async () => {
    const dir = root(); let repaired = false, workers = 0;
    const { team } = runner(dir, [{ id: 'survey', title: 'Survey', role: 'planner', verificationCommands: ['node -v'] }], async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content || '';
      if (request.startsWith('Repair the previous plan')) {
        repaired = request.includes('cannot execute verificationCommands');
        // A model can choose to answer a question without inventing shell checks.
        return { content: JSON.stringify({ tasks: [{ title: 'Answer question', role: 'general' }] }), toolCalls: [] };
      }
      workers++; return { content: 'answer', toolCalls: [] };
    });
    const result = await team.run('Answer a question', () => {});
    expect(repaired).toBe(true); expect(workers).toBe(1);
    expect(result.status).toBe('completed');
  });
  it('reports a failed durable checkpoint even after the last task completed',async()=>{
    const dir=root(); const {team,store}=runner(dir,[{id:'task',role:'general',title:'Answer'}],async()=>({content:'answer',toolCalls:[]}));
    const original=fs.writeFileSync;
    const write=vi.spyOn(fs,'writeFileSync').mockImplementation(((file:any,data:any,...args:any[])=>{
      if(String(file).includes('agent-general-01')&&String(file).endsWith('progress.md')&&String(data).startsWith('COMPLETED'))throw new Error('checkpoint unavailable');
      return (original as any)(file,data,...args);
    }) as any);
    try{await expect(team.run('Question')).rejects.toThrow('checkpoint unavailable');}finally{write.mockRestore();}
    expect((store.sessions()[0] as any).status).toBe('failed');
  });
  it('starts a dependent task while another independent worker is still running', async () => {
    const dir=root(); let releaseSlow!:()=>void, observedOverlap=false;
    const slow = new Promise<void>(resolve => releaseSlow=resolve);
    const timeout=setTimeout(releaseSlow,2500);
    const {team}=runner(dir,[
      {id:'fast',role:'coder',title:'Fast',description:'fast',expectedFiles:['fast.txt']},
      {id:'slow',role:'coder',title:'Slow',description:'slow',expectedFiles:['slow.txt']},
      {id:'next',role:'planner',title:'Next',description:'next',dependencies:['fast']}
    ],async messages=>{
      const request=messages.findLast(message=>message.role==='user')?.content;
      if(request==='slow') await slow;
      if(request==='next') { observedOverlap=team.tasks.find(task=>task.id==='slow')?.status==='running'; releaseSlow(); }
      return {content:'done',toolCalls:[]};
    });
    try { const result=await team.run('Parallel branches'); expect(result.status).toBe('completed'); expect(observedOverlap).toBe(true); }
    finally {clearTimeout(timeout);releaseSlow();}
  });
  it('runs sibling verification and review concurrently rather than one role at a time', async () => {
    const dir=root(); let release!:()=>void; const barrier=new Promise<void>(resolve=>release=resolve), starts=new Set<string>();
    const timeout=setTimeout(release,2500); let overlapping=false;
    const {team}=runner(dir,[{id:'code',role:'coder',title:'Code',description:'code',expectedFiles:['a.txt']},...['test','review'].map(id=>({id,role:id==='test'?'tester':'reviewer',title:id,description:id,dependencies:['code']}))],async messages=>{
      const request=messages.findLast(message=>message.role==='user')?.content || '';
      if(request!=='code') {starts.add(request); if(starts.size===2) {overlapping=true;release();} await barrier;}
      return {content:'done',toolCalls:[]};
    });
    try { await team.run('Parallel gates'); expect(overlapping).toBe(true); }
    finally {clearTimeout(timeout);release();}
  });
  it('creates a page and lets tester/reviewer inspect the same files in an ordinary folder', async () => {
    const dir = root(); let wrote = false; const checked: string[] = [];
    const plan = [{ id: 'T1', role: 'coder', title: 'Create page', description: 'create-page', dependencies: [] }, { id: 'T2', role: 'tester', title: 'Check page', description: 'check-page', dependencies: ['T1'] }, { id: 'T3', role: 'reviewer', title: 'Review page', description: 'review-page', dependencies: ['T2'] }];
    const { team, store } = runner(dir, plan, async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content;
      if (request === 'create-page' && !wrote) { wrote = true; return { content: '', toolCalls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: '<h1>alo alo</h1>' }) } }] }; }
      if (request !== 'create-page') { expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('alo alo'); checked.push(request!); }
      return { content: 'Verified page evidence', toolCalls: [] };
    });
    const events: any[] = [];
    const result = await team.run('Tạo trang alo alo', event => { if (typeof event !== 'string') events.push(structuredClone(event)); });
    const initial = events.find(event => event.type === 'task_snapshot');
    expect(initial.sessionId).toBe(result.id);
    expect(initial.tasks.find((task: any) => task.id === 'T3').dependencies).toEqual(['T2']);
    expect(events.filter(event => event.type === 'task_snapshot').at(-1).tasks.every((task: any) => task.status === 'completed')).toBe(true);
    expect(events.find(event => event.type === 'session_end').gate.verdict).toBe('UNVERIFIED');
    expect(events.some(event => event.type === 'agent_status' && event.step === 'write_file')).toBe(true);
    expect(result.status).toBe('completed'); expect(result.workspaceMode).toBe('shared-folder'); expect(checked).toEqual(['check-page', 'review-page']);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(store.tasks(result.id).map(task => task.status)).toEqual(['completed', 'completed', 'completed']);
    expect(result.verified).toBe(false); // Free-form model claims are not execution evidence.
    const session = path.join(dir, '.vibe', 'sessions', result.id);
    expect(fs.readFileSync(path.join(session, 'GATE_STATUS.md'), 'utf8')).toContain('UNVERIFIED');
    expect(fs.readFileSync(path.join(session, 'agents', 'agent-coder-01', 'DISPATCH.md'), 'utf8')).toContain('Workspace:');
    expect(fs.readFileSync(path.join(session, 'agents', 'agent-reviewer-03', 'handoff.md'), 'utf8')).toContain('Tool evidence:');
  });
  it('serializes independent writers when no worktree isolation is available', async () => {
    const dir = root(); let active = 0, peak = 0;
    const { team } = runner(dir, ['T1', 'T2'].map(id => ({ id, role: 'coder', title: id, dependencies: [] })), async () => {
      peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return { content: 'Done', toolCalls: [] };
    });
    expect((await team.run('Two changes')).status).toBe('completed'); expect(peak).toBe(1);
  });
  it('uses shared-folder mode for a repository without an initial commit', async () => {
    const dir = root(); await git(dir, 'init');
    const worktrees = new Worktrees(dir, path.join(dir, '.vibe')); expect(await worktrees.inspect()).toEqual({ worktrees: false, reason: 'no-commit' });
    const { team } = runner(dir, [{ id: 'T1', role: 'coder', title: 'Code', dependencies: [] }], async () => ({ content: 'Done', toolCalls: [] }));
    expect((await team.run('Code')).status).toBe('completed');
  });
  it('ignores app state but still blocks real source changes in Git repositories', async () => {
    const dir = root(); await repository(dir);
    fs.mkdirSync(path.join(dir, '.vibe')); fs.writeFileSync(path.join(dir, '.vibe', 'runtime.txt'), 'app state');
    const worktrees = new Worktrees(dir, path.join(dir, '.vibe'));
    expect((await worktrees.inspect()).worktrees).toBe(true); expect(await worktrees.status()).toBe('');
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'uncommitted user edit');
    const { team } = runner(dir, [{ id: 'T1', role: 'coder', title: 'Code', dependencies: [] }], async () => { throw new Error('Must not execute coder'); });
    const result = await team.run('Code'); expect(result.tasks[0].error).toContain('Workspace dirty');
    expect(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf8')).toBe('uncommitted user edit');
  });
  it('creates a real isolated worktree when Git and a clean committed source are available', async () => {
    const dir = root(); await repository(dir);
    const { team } = runner(dir, [{ id: 'T1', role: 'coder', title: 'Code', dependencies: [] }], async messages => {
      expect(messages[0].content).toContain(path.join(dir, '.vibe', 'worktrees'));
      return { content: 'Checked workspace', toolCalls: [] };
    });
    const result = await team.run('Code'); expect(result.status).toBe('completed'); expect(result.workspaceMode).toBe('git-worktree');
    expect(fs.readFileSync(path.join(result.tasks[0].worktreePath!, 'existing.txt'), 'utf8')).toBe('user source');
  });
  it('persists blocked dependencies with a concrete cause after a genuine task failure', async () => {
    const dir = root(); const { team, store } = runner(dir, [{ id: 'T1', title: 'Fail', role: 'coder', dependencies: [] }, { id: 'T2', title: 'Dependent', role: 'tester', dependencies: ['T1'] }], async () => { throw new Error('API unavailable'); });
    const result = await team.run('Code'); expect(store.tasks(result.id).find(task => task.id === 'T2')).toMatchObject({ status: 'blocked', error: expect.stringContaining('T1') });
  });
  it('shares one implementation worktree across parallel workers and downstream verification', async () => {
    const dir = root(); await repository(dir);
    const seen: string[] = [];
    const tasks = ['a', 'b'].map(id => ({ id, role: 'coder', title: id, description: id, dependencies: [], expectedFiles: [id + '.txt'] }));
    const { team } = runner(dir, [...tasks, { id: 'test', role: 'tester', title: 'Check', description: 'test', dependencies: ['a', 'b'] }], async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content;
      const scope = messages.find(message => message.role === 'user' && message.content?.includes('Assigned write files:'))!.content!.match(/^Workspace: ([^\n]+)/m)![1]; seen.push(scope);
      if (request === 'test') { expect(fs.readFileSync(path.join(scope, 'a.txt'), 'utf8')).toBe('a'); expect(fs.readFileSync(path.join(scope, 'b.txt'), 'utf8')).toBe('b'); }
      else if (!messages.some(message => message.role === 'tool')) return { content: '', toolCalls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: request + '.txt', content: request }) } }] };
      return { content: 'done', toolCalls: [] };
    });
    const result = await team.run('Two features'); expect(result.status).toBe('completed'); expect(new Set(seen).size).toBe(1);
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false);
  });
  it('repairs a real failed check with fresh agents and reruns verification', async () => {
    const dir = root();
    const command = `node -e "process.exit(require('fs').readFileSync('answer.txt','utf8')==='good'?0:1)"`;
    const plan = [{ id: 'code', role: 'coder', title: 'Code', description: 'initial-code', expectedFiles: ['answer.txt'] }, { id: 'test', role: 'tester', title: 'Test', description: 'verify-value', dependencies: ['code'], verificationCommands: [command] }, { id: 'review', role: 'reviewer', title: 'Review', description: 'review-value', dependencies: ['test'] }];
    const { team, store } = runner(dir, plan, async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content || '', tools = messages.filter(message => message.role === 'tool');
      if (!tools.length) {
        const coder = request === 'initial-code' || request.startsWith('[REPAIR]');
        const name = coder ? 'write_file' : request === 'verify-value' ? 'run_command' : 'read_file';
        const args = coder ? { path: 'answer.txt', content: request === 'initial-code' ? 'bad' : 'good' } : name === 'run_command' ? { command } : { path: 'answer.txt' };
        return { content: '', toolCalls: [{ id: 'call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
      return { content: request === 'review-value' ? '{"verdict":"PASS","findings":[]}' : 'done', toolCalls: [] };
    });
    const result = await team.run('Fix value');
    expect(result.gate.verdict).toBe('PASS'); expect(fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8')).toBe('good');
    expect(result.tasks.find(task => task.id === 'test')?.assignedAgentId).toContain('-r1');
    expect(store.tasks(result.id).find(task => task.id === 'repair-1')?.status).toBe('completed');
    const attempts = fs.readdirSync(path.join(dir, '.vibe', 'sessions', result.id, 'agents'));
    expect(attempts).toContain('agent-tester-02'); expect(attempts).toContain('agent-tester-02-r1');
  });
  it('vetoes a validator that changes assigned source while claiming success', async () => {
    const dir = root();
    const plan = [{ id: 'code', role: 'coder', title: 'Code', description: 'make-source', expectedFiles: ['source.txt'] }, { id: 'test', role: 'tester', title: 'Verify', description: 'tamper-source', dependencies: ['code'] }];
    const { team } = runner(dir, plan, async messages => {
      const request = messages.findLast(message => message.role === 'user')?.content;
      if (!messages.some(message => message.role === 'tool')) {
        const name = request === 'make-source' ? 'write_file' : 'run_command';
        const args = name === 'write_file' ? { path: 'source.txt', content: 'real' } : { command: `node -e "require('fs').writeFileSync('source.txt','tampered')"` };
        return { content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
      return { content: '{"verdict":"PASS","findings":[]}', toolCalls: [] };
    });
    const result = await team.run('Verify source');
    expect(result.gate.verdict).toBe('FAIL');
    expect(result.tasks.find(task => task.id === 'test')?.error).toContain('Integrity veto');
    expect(result.tasks.some(task => task.id.startsWith('repair-'))).toBe(false);
  });
  it('drains concurrent validators before repair and invalidates the completed sibling review',async()=>{
    const dir=root(); let release!:()=>void, slowCompleted=false, repairedAfterDrain=false;
    const barrier=new Promise<void>(resolve=>release=resolve), timeout=setTimeout(release,2500);
    const command=`node -e "process.exit(require('fs').readFileSync('a.txt','utf8')==='good'?0:1)"`;
    const {team}=runner(dir,[{id:'code',role:'coder',title:'Code',description:'code',expectedFiles:['a.txt']},{id:'test',role:'tester',title:'Test',description:'test',dependencies:['code']},{id:'review',role:'reviewer',title:'Review',description:'review',dependencies:['code']}],async messages=>{
      const request=messages.findLast(message=>message.role==='user')?.content || '',tools=messages.filter(message=>message.role==='tool');
      if(!tools.length){
        const repair=request.startsWith('[REPAIR]');if(repair) repairedAfterDrain=slowCompleted;
        const name=request==='code'||repair?'write_file':request==='test'?'run_command':'read_file';
        const args=name==='write_file'?{path:'a.txt',content:repair?'good':'bad'}:name==='run_command'?{command}:{path:'a.txt'};
        return {content:'',toolCalls:[{id:'call',type:'function',function:{name,arguments:JSON.stringify(args)}}]};
      }
      if(request==='review') await barrier;
      return {content:request.startsWith('[RECOVERY DIAGNOSIS]')?'{"rootCause":"read source differs from test expectation","evidence":["read a.txt"],"nextAction":"correct current source"}':request==='review'?'{"verdict":"PASS","findings":[]}':'done',toolCalls:[]};
    });
    try{
      const result=await team.run('Repair concurrent verification',event=>{
        if(typeof event==='string')return;
        if(event.type==='task_failed'&&event.taskId==='test')release();
        if(event.type==='task_complete'&&event.taskId==='review')slowCompleted=true;
      });
      expect(repairedAfterDrain).toBe(true);expect(result.gate.verdict).toBe('PASS');
      expect(result.tasks.find(task=>task.id==='review')?.retries).toBe(1);
    }finally{clearTimeout(timeout);release();}
  });
});
