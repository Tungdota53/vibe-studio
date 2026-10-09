import http from 'node:http';
import { afterEach,describe,it,expect } from 'vitest';
import { ModelClient } from '../src/model.js';
import type { Config } from '../src/config.js';
const servers:http.Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function setup(handler:http.RequestListener){const server=http.createServer(handler);servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;return new ModelClient({baseUrl:`http://127.0.0.1:${port}`,apiKey:'fixture',model:'same-model'} as Config);}
describe('Model stream liveness',()=>{
 it('finishes on DONE even when the provider keeps the connection open and ignores later fragments',async()=>{
  const model=await setup((request,response)=>{request.resume();response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: {"choices":[{"delta":{"content":"Complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"Injected"}}]}');});
  const activity:string[]=[];const began=Date.now();expect((await model.chat([],[],undefined,undefined,undefined,{timeoutMs:1000,retryAttempts:1,onActivity:kind=>activity.push(kind)})).content).toBe('Complete');expect(Date.now()-began).toBeLessThan(800);expect(activity).toEqual(['text']);
 });
 it('bounds all silent retries and backoff by one overall request deadline',async()=>{
  let attempts=0;const model=await setup((request,response)=>{attempts++;request.resume();response.writeHead(200,{'Content-Type':'text/event-stream'});response.flushHeaders();});
  const began=Date.now();await expect(model.chat([],[],undefined,undefined,undefined,{timeoutMs:1000,idleTimeoutMs:250,retryAttempts:4})).rejects.toThrow();expect(Date.now()-began).toBeLessThan(1600);expect(attempts).toBeLessThan(4);
 });
 it('retains partial text on idle failure without retrying or executing incomplete tool fragments',async()=>{
  let attempts=0;const model=await setup((request,response)=>{attempts++;request.resume();response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n');});
  await expect(model.chat([],[],undefined,undefined,undefined,{timeoutMs:1000,idleTimeoutMs:250})).rejects.toMatchObject({partialContent:'Partial',partialOutput:true});expect(attempts).toBe(1);
 });
});
