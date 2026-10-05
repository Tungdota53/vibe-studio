import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand,withCommandLease } from '../src/command-runner.js';
import { Tools } from '../src/tools.js';
const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-command-')); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })));
describe('Owned command deadlines', () => {
  it('runs standalone PowerShell diagnostics in PowerShell on Windows',async()=>{
    if(process.platform!=='win32')return;const cwd=root();fs.writeFileSync(path.join(cwd,'source.txt'),'actual content');const result=await runCommand('Get-Content source.txt | Select-String -Pattern actual',cwd,10000);expect(result.exitCode).toBe(0);expect(result.stdout).toContain('actual content');
  });
  it('serializes shared-workspace commands and a cancelled waiter cannot release the active lease',async()=>{
    const cwd=root(),controller=new AbortController(),events:string[]=[];let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve),held=new Promise<void>(resolve=>release=resolve);
    const first=withCommandLease(cwd,undefined,async()=>{events.push('first-start');started();await held;events.push('first-end');});await ready;
    const second=withCommandLease(cwd,controller.signal,async()=>{events.push('cancelled-executed');});controller.abort();await expect(second).rejects.toThrow();
    const third=withCommandLease(cwd,undefined,async()=>{events.push('third');});await new Promise(resolve=>setTimeout(resolve,10));expect(events).toEqual(['first-start']);release();await Promise.all([first,third]);expect(events).toEqual(['first-start','first-end','third']);
  });
  it('terminates the Node grandchild holding a shell pipe open', async () => {
    const cwd = root();
    fs.writeFileSync(path.join(cwd, 'hang.cjs'), `require('fs').writeFileSync('pid.txt',String(process.pid));console.log('browser handle still open');setInterval(()=>{},1000);`);
    const started = Date.now();
    await expect(runCommand('node hang.cjs', cwd, 1500)).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(6000);
    const pid = Number(fs.readFileSync(path.join(cwd, 'pid.txt'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10000);
  it('cancellation also terminates the owned child tree', async () => {
    const cwd = root(), controller = new AbortController();
    fs.writeFileSync(path.join(cwd, 'hang.cjs'), `require('fs').writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},1000);`);
    const running = runCommand('node hang.cjs', cwd, 30000, controller.signal);
    const timer = setTimeout(() => controller.abort(), 1500);
    await expect(running).rejects.toThrow('cancelled'); clearTimeout(timer);
    expect(() => process.kill(Number(fs.readFileSync(path.join(cwd, 'pid.txt'), 'utf8')), 0)).toThrow();
  }, 10000);
  it('returns command output and reports a nonzero exit as failed tool evidence', async () => {
    const cwd = root();
    fs.writeFileSync(path.join(cwd, 'fail.cjs'), "console.log('check failed');process.exitCode=7;");
    const tools = new Tools(cwd, undefined, 'coder');
    const result = await tools.run('run_command', JSON.stringify({ command: 'node fail.cjs' }));
    expect(result.ok).toBe(false); expect(result.output).toContain('exit=7'); expect(result.output).toContain('check failed');
  });
});
