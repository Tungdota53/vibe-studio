import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { ModelRouter } from '../src/router.js';
import { Tools } from '../src/tools.js';
import { newConversation } from '../src/conversation.js';
import type { ModelClient } from '../src/model.js';
import type { Message } from '../src/types.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
function setup(reply:(messages:Message[])=>any) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-agent-progress-'));roots.push(root);
  const config={...loadConfig(root),namedAgents:[],maxAgentIterations:64,maxAgentToolCalls:192};
  const client={config,chat:async(messages:Message[])=>reply(messages)} as unknown as ModelClient;
  const agent=new Agent('progress','coder',root,client,new ModelRouter(config),new Tools(root,undefined,'coder'));
  return {root,agent,state:newConversation()};
}
const read=(name:string)=>({content:'',toolCalls:[{id:'read-'+name,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:name})}}]});
describe('Agent progress budgets',()=>{
  it('stops alternating unchanged reads instead of resetting on each different file',async()=>{
    let turns=0;const {root,agent}=setup(()=>read(turns++%2?'b.txt':'a.txt'));for(const file of ['a.txt','b.txt'])fs.writeFileSync(path.join(root,file),'same');
    await expect(agent.run('Implement')).rejects.toThrow('xen kẽ');expect(turns).toBe(11);
  });
  it('does not reset failing-tool protection when the agent writes another report',async()=>{
    let turns=0;const {agent}=setup(()=>turns++%2?{content:'',toolCalls:[{id:'report-'+turns,type:'function',function:{name:'write_report',arguments:JSON.stringify({path:'reports/attempt.json',content:JSON.stringify({attempt:turns})})}}]}:{content:'',toolCalls:[{id:'bad-'+turns,type:'function',function:{name:'missing_tool',arguments:'{}'}}]});
    await expect(agent.run('Verify')).rejects.toThrow('lặp cùng thao tác lỗi 4 lần');expect(turns).toBe(7);
  });
  it('stops a repeated failing action even when interleaved with successful reads',async()=>{
    let turns=0; const {root,agent,state}=setup(()=> turns++ % 2 ? read('input.txt') : {content:'',toolCalls:[{id:'bad-'+turns,type:'function',function:{name:'missing_tool',arguments:'{}'}}]});
    fs.writeFileSync(path.join(root,'input.txt'),'same');
    await expect(agent.run('Implement',undefined,undefined,[],{state})).rejects.toThrow('lặp cùng thao tác lỗi 4 lần');
    expect(state.messages.filter(item=>item.role==='tool'&&item.content?.includes('không tồn tại'))).toHaveLength(4);
  });
  it('finishes useful work exceeding the old twenty-round limit',async()=>{
    let turns=0;const {root,agent}=setup(()=>turns<24?read(`f${turns++}.txt`):{content:'finished',toolCalls:[]});
    for(let i=0;i<24;i++)fs.writeFileSync(path.join(root,`f${i}.txt`),String(i));
    expect(await agent.run('Inspect 24 files')).toBe('finished');expect(turns).toBe(24);
  });
  it('nudges repeated reads into implementation and retains the real tool results',async()=>{
    let wrote=false;const {root,agent,state}=setup(messages=>{
      if(messages.some(item=>item.content?.startsWith('Progress check:'))) {
        if(!wrote){wrote=true;return {content:'',toolCalls:[{id:'write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'result.txt',content:'implemented'})}}]};}
        return {content:'done',toolCalls:[]};
      }
      return read('input.txt');
    });
    fs.writeFileSync(path.join(root,'input.txt'),'spec');
    await agent.run('Implement the spec',undefined,undefined,[],{state});
    expect(fs.readFileSync(path.join(root,'result.txt'),'utf8')).toBe('implemented');
    expect(state.messages.filter(item=>item.role==='tool'&&item.content?.includes('spec'))).toHaveLength(4);
  });
  it('stops unchanged read loops with an actionable reason and a retained checkpoint',async()=>{
    const {root,agent,state}=setup(()=>read('input.txt'));fs.writeFileSync(path.join(root,'input.txt'),'same');
    let checkpoint=0;
    await expect(agent.run('Implement',undefined,undefined,[],{state,checkpoint:()=>checkpoint++})).rejects.toThrow('không tiến triển');
    expect(state.messages.filter(item=>item.role==='tool')).toHaveLength(6);expect(checkpoint).toBeGreaterThan(0);
  });
});
