import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach,describe,it,expect } from 'vitest';
import { BackgroundProcesses } from '../src/background-processes.js';
import { Tools } from '../src/tools.js';
import { canUseTool } from '../src/roles.js';
const roots:string[]=[],managers:BackgroundProcesses[]=[];
afterEach(async()=>{await Promise.all(managers.splice(0).map(manager=>manager.close()));for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-background-'));roots.push(root);const manager=BackgroundProcesses.forWorkspace(root);managers.push(manager);return {root,manager};}
async function until(check:()=>boolean){for(let i=0;i<80;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Process did not reach expected state');}
describe('Owned background processes',()=>{
 it('runs a real HTTP server without blocking, probes readiness and stops only its own process tree',async()=>{
  const {root,manager}=setup();fs.writeFileSync(path.join(root,'server.cjs'),"const http=require('node:http');const server=http.createServer((q,s)=>s.end('ok'));server.listen(0,'127.0.0.1',()=>console.log('PORT='+server.address().port));console.log('api_key=private-value');");
  const task=await manager.start({command:'node server.cjs',cwd:root,owner:'chat-one:coder'});
  expect(task.status).toBe('running');await until(()=>manager.inspect(task.id).log.includes('PORT='));
  const log=manager.inspect(task.id).log;expect(log).not.toContain('private-value');
  const port=log.match(/PORT=(\d+)/)![1];expect(await manager.health(task.id,`http://127.0.0.1:${port}`,'chat-one')).toMatchObject({ready:true,statusCode:200});
  await expect(manager.stop(task.id,'chat-two')).rejects.toThrow('không thuộc phiên');
  await expect(manager.health(task.id,'https://example.com')).rejects.toThrow('loopback');
  const duplicate=await manager.start({command:'node server.cjs',cwd:root,owner:'chat-one:tester'});expect(duplicate.id).toBe(task.id);
  await manager.stopSession('chat-two');expect(manager.inspect(task.id).status).toBe('running');
  await manager.stopSession('chat-one');expect(manager.inspect(task.id).status).toBe('stopped');
  await expect(fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(1000)})).rejects.toThrow();
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{start:'node server.cjs'}}));
  const npmTask=await manager.start({command:'npm run start -- --port=3100',cwd:root,owner:'chat-one'});
  await until(()=>manager.inspect(npmTask.id).log.includes('PORT='));expect(manager.inspect(npmTask.id).status).toBe('running');await manager.stop(npmTask.id);
 },15000);
 it('cleans up on abort and deadline, captures nonzero exits and blocks unmanaged detachment',async()=>{
  const {root,manager}=setup();fs.writeFileSync(path.join(root,'wait.cjs'),'setInterval(()=>{},1000)');const controller=new AbortController();
  const task=await manager.start({command:'node wait.cjs',cwd:root,owner:'chat-one'},controller.signal);controller.abort();await until(()=>manager.inspect(task.id).status==='stopped');
  const deadline=await manager.start({command:'node wait.cjs',cwd:root,owner:'chat-two',ttlMs:1000});await until(()=>manager.inspect(deadline.id).status==='stopped');expect(manager.inspect(deadline.id).reason).toContain('thời hạn');
  const failed=await manager.start({command:'node -e "process.exit(7)"',cwd:root,owner:'chat-three'});await until(()=>manager.inspect(failed.id).status==='failed');expect(manager.inspect(failed.id).exitCode).toBe(7);
  for(const command of ['Start-Process node','cmd /c start node','nohup node x &','taskkill /IM node.exe /F'])await expect(manager.start({command,cwd:root,owner:'chat-one'})).rejects.toThrow('tách process');
 },15000);
 it('binds agent tools to the current session and preserves read-only permissions',async()=>{
  const {root}=setup();const tools=new Tools(root,async()=>false,'general').setCheckpointContext(root,'chat-one');
  fs.writeFileSync(path.join(root,'wait.cjs'),'setInterval(()=>{},1000)');const result=await tools.run('start_background','{"command":"node wait.cjs"}');expect(result.ok).toBe(true);
  const other=new Tools(root,async()=>false,'tester').setCheckpointContext(root,'chat-two');expect((await other.run('stop_background',JSON.stringify({id:result.process.id}))).ok).toBe(false);
  for(const role of ['planner','reviewer','judge','orchestrator'] as const)expect(canUseTool(role,'start_background')).toBe(false);
  expect(canUseTool('general','start_background',true)).toBe(false);expect((await tools.run('stop_background',JSON.stringify({id:result.process.id}))).ok).toBe(true);
 });
});
