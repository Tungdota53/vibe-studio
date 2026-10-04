import {afterEach,describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Operations,operationPolicy,operationMode} from '../src/operations.js';
import {Tools} from '../src/tools.js';
import {executionBatch} from '../src/team-protocol.js';
import {parseTeamPlan} from '../src/teamwork.js';
import {canUseTool} from '../src/roles.js';

const roots:string[]=[];
function root(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-operations-'));roots.push(dir);return dir;}
const digest=(text:string)=>crypto.createHash('sha256').update(text).digest('hex');
afterEach(()=>{for(const dir of roots.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
describe('Evidence-backed operations',()=>{
  it('invalidates project memory when files change and excludes it from recall',()=>{
    const dir=root(),ops=new Operations(dir);fs.writeFileSync(path.join(dir,'source.txt'),'before');
    const memory=ops.remember('Use source.txt',['source.txt']);expect(ops.recall()).toContain('Use source');
    fs.writeFileSync(path.join(dir,'source.txt'),'user edit');expect(ops.listMemory()[0].stale).toBe(true);expect(ops.recall()).toBe('');
    ops.forget(memory.id);expect(ops.listMemory()).toEqual([]);
    expect(()=>ops.remember('secret',['.env'])).toThrow();expect(()=>ops.remember('escape',['../outside'])).toThrow();
  });
  it('detects user edits before writing and requires reading the edited source to reconcile',async()=>{
    const dir=root();fs.writeFileSync(path.join(dir,'a.txt'),'start');const tools=new Tools(dir,async()=>false,'coder',undefined,['a.txt']).setWriteBaseline();
    fs.writeFileSync(path.join(dir,'a.txt'),'user edit');expect((await tools.run('write_file','{"path":"a.txt","content":"overwrite"}')).error).toContain('Source conflict');expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('user edit');
    expect((await tools.run('read_file','{"path":"a.txt"}')).ok).toBe(true);
    expect((await tools.run('write_file','{"path":"a.txt","content":"reconciled"}')).ok).toBe(true);
    expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('reconciled');
  });
  it('applies priority while retaining ownership locks and rejecting Windows path aliases',()=>{
    const tasks=parseTeamPlan(JSON.stringify({tasks:[{id:'a',title:'A',role:'coder',expectedFiles:['a.ts']},{id:'b',title:'B',role:'coder',expectedFiles:['a.ts']},{id:'c',title:'C',role:'coder',expectedFiles:['c.ts']}]}));
    expect(executionBatch(tasks,2,new Map([['b',1]])).map(t=>t.id)).toEqual(['b','c']);
    tasks[0].status='running';expect(executionBatch(tasks,2,new Map([['b',2]])).map(t=>t.id)).toEqual(['c']);
    for(const file of ['a.ts.','a.ts ','src/./a.ts','.vibe/config.json','CON.txt','src//a.ts'])expect(()=>parseTeamPlan(JSON.stringify({tasks:[{title:'Unsafe',role:'coder',expectedFiles:[file]}]}))).toThrow();
  });
  it('enforces modes through role permissions instead of labels only',()=>{
    for(const mode of ['ask','plan','verify'] as const){const policy=operationPolicy(mode);expect(canUseTool(policy.role,'write_file',policy.readOnly)).toBe(false);}
    const verify=operationPolicy('verify');expect(canUseTool(verify.role,'run_tests',verify.readOnly)).toBe(true);
    expect(canUseTool('coder','write_file',false)).toBe(true);expect(()=>operationMode('unknown')).toThrow();
  });
  it('does not invent estimates without data or prices',()=>{
    const ops=new Operations(root()),tasks=parseTeamPlan('{"tasks":[{"title":"One","role":"general"}]}');
    expect(ops.estimate(tasks,4).tokenRange).toBeNull();expect(ops.estimate(tasks,4).costUSDRange).toBeNull();
    const estimate=ops.estimate(tasks,4,undefined,{tokens:1000,durationMs:2000,modelCalls:2});expect(estimate.tokenRange).toEqual([500,2500]);expect(estimate.costUSDRange).toBeNull();
  });
  it('exports historical outcomes and diffs without fabricating a successful gate',()=>{
    const dir=root(),id='session-abcdef12',session=path.join(dir,'.vibe','sessions',id);fs.mkdirSync(session,{recursive:true});
    fs.writeFileSync(path.join(session,'resume.json'),JSON.stringify({tasks:[],status:'failed',evidence:[]}));
    fs.writeFileSync(path.join(session,'events.jsonl'),'invalid\n'+JSON.stringify({type:'tool_end',ok:false,outcome:'token=privatevalue'})+'\n');
    const result=new Operations(dir).export(id);expect(result.bundle.status).toBe('failed');expect(result.bundle.events[0].ok).toBe(false);expect(JSON.stringify(result.bundle)).not.toContain('privatevalue');expect(fs.readFileSync(path.join(dir,result.report),'utf8')).toContain('UNVERIFIED');
  });
  it('integrates only fresh passed worktrees and preflights every user file before writing',()=>{
    const dir=root(),id='session-abcdef12',session=path.join(dir,'.vibe','sessions',id),scope=path.join(dir,'.vibe','worktrees',id,'implementation');fs.mkdirSync(session,{recursive:true});fs.mkdirSync(scope,{recursive:true});
    fs.writeFileSync(path.join(dir,'a.txt'),'original');fs.writeFileSync(path.join(scope,'a.txt'),'verified');fs.writeFileSync(path.join(scope,'b.txt'),'new');
    const tasks=parseTeamPlan('{"tasks":[{"id":"code","title":"Code","role":"coder","expectedFiles":["a.txt","b.txt"]}]}');tasks[0].status='completed';tasks[0].worktreePath=scope;
    fs.writeFileSync(path.join(session,'resume.json'),JSON.stringify({tasks,status:'completed',evidence:[],fingerprints:{code:{[path.join(scope,'a.txt')]:digest('verified'),[path.join(scope,'b.txt')]:digest('new')}}}));
    fs.writeFileSync(path.join(session,'pipeline.json'),JSON.stringify({gate:{verdict:'PASS'}}));fs.writeFileSync(path.join(session,'integration-base.json'),JSON.stringify({'a.txt':digest('original'),'b.txt':null}));
    const ops=new Operations(dir);fs.writeFileSync(path.join(dir,'b.txt'),'user content');expect(()=>ops.integrate(id)).toThrow('Integration conflict');expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('original');
    fs.unlinkSync(path.join(dir,'b.txt'));const result=ops.integrate(id);expect(result.files).toEqual(['a.txt','b.txt']);expect(fs.readFileSync(path.join(dir,'a.txt'),'utf8')).toBe('verified');expect(fs.existsSync(path.join(dir,'.vibe','checkpoints',result.checkpointId+'.json'))).toBe(true);
  });
  it('learns repairs only after a passed gate and actual fresh checks',()=>{
    const dir=root();fs.writeFileSync(path.join(dir,'a.txt'),'fixed');const ops=new Operations(dir),tasks=parseTeamPlan('{"tasks":[{"id":"repair-1","title":"Fix","role":"coder","expectedFiles":["a.txt"]},{"id":"test","title":"Verify","role":"tester","dependencies":["repair-1"]}]}');tasks.forEach(t=>t.status='completed');tasks[0].resultSummary='fixed cause';
    const evidence=new Map([['test',{inspected:true,successfulChecks:1,failedChecks:0,toolErrors:0,files:{[path.join(dir,'a.txt')]:digest('fixed')},checks:[{command:'npm test',exitCode:0,excerpt:'passed'}]}]]);
    ops.learn('session-abcdef12',tasks,evidence,{verdict:'FAIL'});expect(ops.listMemory()).toEqual([]);
    ops.learn('session-abcdef12',tasks,evidence,{verdict:'PASS'});expect(ops.listMemory()[0].kind).toBe('verified-fix');fs.writeFileSync(path.join(dir,'a.txt'),'changed');expect(ops.recall()).toBe('');
  });
});
