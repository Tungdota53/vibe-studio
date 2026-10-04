import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startStudio, type StudioServerInstance } from '../src/studio/server.js';
import { Store } from '../src/db.js';
import { CheckpointStore } from '../src/checkpoints.js';
import { McpRegistry } from '../src/mcp.js';
import { ProjectIntegrations } from '../src/project-integrations.js';
import { ModelClient } from '../src/model.js';
import { parseTeamPlan } from '../src/teamwork.js';
import crypto from 'node:crypto';

const roots: string[] = [], studios: StudioServerInstance[] = [], sockets: Socket[] = [], servers: http.Server[] = [];
class Socket {
  private pending: any[] = [];
  private listeners = new Set<(message: any) => void>();
  constructor(readonly ws: WebSocket) {
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      this.pending.push(message);
      for (const listener of this.listeners) listener(message);
    });
  }
  async wait(type: string) {
    const take = () => { const index = this.pending.findIndex(message => message.type === type); return index >= 0 ? this.pending.splice(index, 1)[0] : undefined; };
    const existing = take(); if (existing) return existing;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error(`Missing workbench message: ${type}`)); }, 5000);
      const listener = (message: any) => { if (message.type === type) { clearTimeout(timer); this.listeners.delete(listener); resolve(take()); } };
      this.listeners.add(listener);
    });
  }
  async request(payload: Record<string, unknown>, response: string) { this.ws.send(JSON.stringify(payload)); return this.wait(response); }
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CI', 'true'); vi.stubEnv('VIBE_API_KEY', '');
  vi.stubEnv('VIBE_MODEL', 'test-model'); vi.stubEnv('VIBE_BASE_URL', 'http://127.0.0.1:9/v1');
  vi.stubEnv('VIBE_CONTEXT_WINDOW', '8192'); vi.stubEnv('VIBE_OUTPUT_TOKENS', '1024');
});
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.ws.terminate());
  await Promise.all(studios.splice(0).map(studio => studio.close()));
  await McpRegistry.closeAll();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function harness(configuration: Record<string, unknown> = {}, prepare?: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-workbench-')); roots.push(root);
  fs.mkdirSync(path.join(root, '.vibe'));
  fs.writeFileSync(path.join(root, '.vibe', 'config.json'), JSON.stringify({ namedAgents: [], contextMode: 'manual', ...configuration }));
  const store = new Store(path.join(root, '.vibe'));
  store.session('chat-one', 'completed', 'test-model', 'Original task');
  store.session('chat-two', 'completed', 'test-model', 'Other task');
  store.close(); prepare?.(root);
  const studio = await startStudio({ port: 0, host: '127.0.0.1', workspace: root, openBrowser: false }); studios.push(studio);
  const ws = new WebSocket(studio.url.replace(/^http/, 'ws') + '/ws');
  const socket = new Socket(ws); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await socket.wait('init');
  return { root, studio, socket };
}

describe('Studio workbench WebSocket APIs', () => {
  it('exposes project memory and execution settings, and rejects controls for inactive sessions',async()=>{
    const {root,socket}=await harness({autoIntegrations:false},root=>fs.writeFileSync(path.join(root,'source.txt'),'v1'));
    const memory=await socket.request({type:'remember_project',sessionId:'chat-one',text:'Project fact',files:['source.txt']},'operations_state');expect(memory.memory[0].stale).toBe(false);
    fs.writeFileSync(path.join(root,'source.txt'),'v2');const stale=await socket.request({type:'get_operations',sessionId:'chat-one'},'operations_state');expect(stale.memory[0].stale).toBe(true);
    expect((await socket.request({type:'configure_execution',isolated:false},'execution_config')).isolated).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root,'.vibe','config.json'),'utf8')).useWorktrees).toBe(false);
    expect((await socket.request({type:'team_control',sessionId:'session-abcdef12',action:'pause'},'error')).message).toContain('Teamwork');
  });
  it('enforces verify mode source restrictions even when a writable agent is selected',async()=>{
    vi.stubEnv('VIBE_API_KEY','fixture-only-key');vi.spyOn(ModelClient.prototype,'modelLimits').mockResolvedValue(undefined);let calls=0;
    vi.spyOn(ModelClient.prototype,'chat').mockImplementation(async messages=>{calls++;if(calls===1)return {content:'',model:'test-model',toolCalls:[{id:'write',type:'function',function:{name:'write_file',arguments:'{"path":"a.txt","content":"should not write"}'}}]};expect(messages.findLast(item=>item.role==='tool')?.content).toContain('không được');return {content:'blocked as expected',model:'test-model',toolCalls:[]};});
    const {root,socket}=await harness({autoIntegrations:false,namedAgents:[{id:'coder',name:'Coder',role:'coder',enabled:true,model:'',instructions:'',skills:[]}]});
    await socket.request({type:'chat',prompt:'Verify',mode:'verify',agentId:'coder',sessionId:'chat-one'},'run_end');expect(fs.existsSync(path.join(root,'a.txt'))).toBe(false);
  });
  it('resumes past an older repair snapshot superseded by repair-2 without rerunning coders or planning', async () => {
    vi.stubEnv('VIBE_API_KEY','fixture-only-key');vi.spyOn(ModelClient.prototype,'modelLimits').mockResolvedValue(undefined);
    const chat=vi.spyOn(ModelClient.prototype,'chat').mockResolvedValue({content:'continued',toolCalls:[],model:'test-model'}),id='session-aabbccdd';
    const {root,socket}=await harness({autoIntegrations:false,useWorktrees:false},root=>{
      const file=path.join(root,'style.css');fs.writeFileSync(file,'latest');const hash=(text:string)=>crypto.createHash('sha256').update(text).digest('hex');
      const tasks=parseTeamPlan(JSON.stringify({tasks:[{id:'code',title:'Code',role:'coder',expectedFiles:['style.css']},{id:'repair-1',title:'Repair 1',role:'coder',dependencies:['code'],expectedFiles:['style.css']},{id:'repair-2',title:'Repair 2',role:'coder',dependencies:['code'],expectedFiles:['style.css']},{id:'pending',title:'Continue',role:'general',description:'finish-pending',dependencies:['repair-2']}]}));
      tasks.slice(0,3).forEach((task,index)=>{task.status='completed';task.completedAt=`2026-10-03T0${index+1}:00:00Z`;task.resultSummary='completed source';});
      const fingerprints={code:{[file]:hash('latest')},'repair-1':{[file]:hash('older')},'repair-2':{[file]:hash('latest')}};
      const directory=path.join(root,'.vibe','sessions',id);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'resume.json'),JSON.stringify({goal:'Original goal',planRaw:'{"tasks":[]}',tasks,fingerprints,evidence:[],repairRounds:2,status:'failed'}));
    });
    await socket.request({type:'chat',prompt:'/teamwork tiếp tục tiến độ',sessionId:id},'run_end');
    expect(chat).toHaveBeenCalledTimes(1);expect(chat.mock.calls[0][0].findLast(item=>item.role==='user')?.content).toBe('finish-pending');
    const saved=JSON.parse(fs.readFileSync(path.join(root,'.vibe','sessions',id,'resume.json'),'utf8'));
    expect(saved.tasks.find((task:any)=>task.id==='pending').status).toBe('completed');expect(saved.tasks.filter((task:any)=>task.role==='coder').every((task:any)=>task.resultSummary==='completed source')).toBe(true);
  });
  it('releases the busy state when continuation has no selected Teamwork session', async () => {
    const chat = vi.spyOn(ModelClient.prototype, 'chat');
    const { socket } = await harness();
    await socket.request({ type: 'chat', prompt: '/teamwork tiếp tục', sessionId: 'chat-one' }, 'run_end');
    const error = await socket.wait('stream_chunk');
    expect(error.token).toContain('không lập kế hoạch mới'); expect(chat).not.toHaveBeenCalled();
    await socket.request({ type: 'chat', prompt: '/teamwork tiếp tục', sessionId: 'chat-one' }, 'run_end');
  });
  it('resumes the selected old DAG when chat sends /teamwork tiếp tục without invoking the planner', async () => {
    vi.stubEnv('VIBE_API_KEY', 'fixture-only-key');
    vi.spyOn(ModelClient.prototype, 'modelLimits').mockResolvedValue(undefined);
    const chat = vi.spyOn(ModelClient.prototype, 'chat').mockResolvedValue({ content: 'continued pending task', toolCalls: [], model: 'test-model' });
    const id = 'session-aabbccdd';
    const { root, socket } = await harness({ autoIntegrations: false, useWorktrees: false }, root => {
      const tasks = parseTeamPlan(JSON.stringify({ tasks: [{ id: 'done', role: 'general', title: 'Done', description: 'do-not-repeat' }, { id: 'pending', role: 'general', title: 'Remaining', description: 'finish-pending', dependencies: ['done'] }] }));
      tasks[0].status = 'completed'; tasks[0].resultSummary = 'already completed';
      const directory = path.join(root, '.vibe', 'sessions', id); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'resume.json'), JSON.stringify({ goal: 'Original goal', planRaw: '{"tasks":[]}', tasks, evidence: [], fingerprints: {}, repairRounds: 0, status: 'cancelled' }));
    });
    await socket.request({ type: 'chat', prompt: '/teamwork tiếp tục', sessionId: id }, 'run_end');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0].findLast(item => item.role === 'user')?.content).toBe('finish-pending');
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.vibe', 'sessions', id, 'resume.json'), 'utf8'));
    expect(saved.tasks.find((task: any) => task.id === 'done').resultSummary).toBe('already completed');
    expect(saved.tasks.find((task: any) => task.id === 'pending').status).toBe('completed');
    expect(fs.readdirSync(path.join(root, '.vibe', 'sessions'))).toEqual([id]);
  });
  it('runs setup before work and reuses the project signature on the next request',async()=>{
    const sync=vi.spyOn(ProjectIntegrations.prototype,'sync').mockImplementation(async(c)=>({config:c,report:{project:{},skills:[],mcp:[],results:[],connections:[]}}));
    const {socket}=await harness();await socket.request({type:'configure_integrations',enabled:true},'integration_state');
    await socket.request({type:'chat',prompt:'First task',sessionId:'chat-one'},'run_end');expect(sync).toHaveBeenCalledTimes(1);
    await socket.request({type:'chat',prompt:'Second task',sessionId:'chat-one'},'run_end');expect(sync).toHaveBeenCalledTimes(1);
  });
  it('reports detected stack and persists the automatic integration switch',async()=>{
    const {root,socket}=await harness({},root=>fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{react:'1'}})));
    const initial=await socket.request({type:'get_integrations'},'integration_state');expect(initial.plan.project.web).toBe(true);expect(initial.plan.mcp.some((x:any)=>x.id==='auto-playwright')).toBe(true);
    const changed=await socket.request({type:'configure_integrations',enabled:true},'integration_state');expect(changed.enabled).toBe(true);expect(JSON.parse(fs.readFileSync(path.join(root,'.vibe','config.json'),'utf8')).autoIntegrations).toBe(true);
    const rejected=await socket.request({type:'configure_integrations',enabled:'yes'},'error');expect(rejected.message).toContain('không hợp lệ');
  });
  it('persists pinned instructions and redacted attachment snapshots independently of live files', async () => {
    const { root, socket } = await harness({}, root => fs.writeFileSync(path.join(root, 'notes.txt'), 'Important design evidence\napi_key=attachment-private-secret'));
    const pinned = await socket.request({ type: 'pin_context', sessionId: 'chat-one', content: 'Use one model for every agent', label: 'Model choice' }, 'workbench_state');
    expect(pinned.context.pins[0]).toMatchObject({ content: 'Use one model for every agent', label: 'Model choice' });
    const attached = await socket.request({ type: 'attach_context', sessionId: 'chat-one', path: 'notes.txt' }, 'workbench_state');
    expect(attached.context.attachments[0]).toMatchObject({ path: 'notes.txt', redacted: true });
    expect(JSON.stringify(attached)).not.toContain('attachment-private-secret');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'Changed after attachment');
    const fetched = await socket.request({ type: 'get_workbench', sessionId: 'chat-one' }, 'workbench_state');
    expect(fetched.context.pins).toEqual(attached.context.pins);
    expect(fetched.context.attachments).toEqual(attached.context.attachments);
    expect(fetched.context.attachments[0].preview).toContain('Important design evidence');
    const store = new Store(path.join(root, '.vibe'));
    try {
      expect(store.conversation('chat-one').pins?.[0].content).toBe('Use one model for every agent');
      expect(store.conversation('chat-one').attachments?.[0].content).not.toContain('Changed after attachment');
      expect(store.conversation('chat-two').pins || []).toEqual([]);
    } finally { store.close(); }
    const removed = await socket.request({ type: 'unpin_context', sessionId: 'chat-one', id: fetched.context.pins[0].id }, 'workbench_state');
    expect(removed.context.pins).toEqual([]);
  });
  it('rejects protected and outside-workspace attachments without persisting them', async () => {
    const { root, socket } = await harness({}, root => fs.writeFileSync(path.join(root, '.env'), 'SECRET=must-not-enter-context'));
    const rejected = await socket.request({ type: 'attach_context', sessionId: 'chat-one', path: '.env' }, 'error');
    expect(rejected.message).toContain('bí mật');
    expect(JSON.stringify(rejected)).not.toContain('must-not-enter-context');
    const outside = await socket.request({ type: 'attach_context', sessionId: 'chat-one', path: '../outside.txt' }, 'error');
    expect(outside.message).toContain('workspace');
    const fetched = await socket.request({ type: 'get_workbench', sessionId: 'chat-one' }, 'workbench_state');
    expect(fetched.context.attachments).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('must-not-enter-context');
  });
  it('requires checkpoint ownership for both diff and restore and restores only explicitly selected files', async () => {
    let checkpointId = '';
    const { root, socket } = await harness({}, root => {
      fs.writeFileSync(path.join(root, 'app.js'), 'before');
      const store = new CheckpointStore(root);
      checkpointId = store.begin({ tool: 'write_file', sessionId: 'chat-one', files: ['app.js'], intendedContent: { 'app.js': 'after' } });
      fs.writeFileSync(path.join(root, 'app.js'), 'after'); store.finish(checkpointId);
    });
    for (const type of ['checkpoint_diff', 'restore_checkpoint']) {
      const response = await socket.request({ type, sessionId: 'chat-two', id: checkpointId, files: ['app.js'] }, 'error');
      expect(response.message).toContain('không thuộc phiên');
      expect(fs.readFileSync(path.join(root, 'app.js'), 'utf8')).toBe('after');
    }
    const detail = await socket.request({ type: 'checkpoint_diff', sessionId: 'chat-one', id: checkpointId }, 'checkpoint_detail');
    expect(detail.files[0]).toMatchObject({ path: 'app.js', before: 'before', after: 'after' });
    const restored = await socket.request({ type: 'restore_checkpoint', sessionId: 'chat-one', id: checkpointId, files: ['app.js'] }, 'workbench_state');
    expect(restored.checkpoints[0].status).toBe('restored');
    expect(fs.readFileSync(path.join(root, 'app.js'), 'utf8')).toBe('before');
  });
  it('validates and persists budgets and model rates without replacing unrelated configuration', async () => {
    const { root, socket } = await harness({ maxAgents: 3 });
    const budget = { maxTokens: 12000, maxCostUSD: 0.5 }, rates = { 'test-model': { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.2 } };
    const response = await socket.request({ type: 'configure_budget', budget, rates }, 'budget_config');
    expect(response).toMatchObject({ runBudget: budget, modelRates: rates });
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.vibe', 'config.json'), 'utf8'));
    expect(saved).toMatchObject({ runBudget: budget, modelRates: rates, maxAgents: 3 });
    const fetched = await socket.request({ type: 'get_workbench', sessionId: 'chat-one' }, 'workbench_state');
    expect(fetched).toMatchObject({ runBudget: budget, modelRates: rates });
    await socket.request({ type: 'configure_budget', budget: { maxTokens: -1 }, rates }, 'error');
    expect(JSON.parse(fs.readFileSync(path.join(root, '.vibe', 'config.json'), 'utf8')).runBudget).toEqual(budget);
  });
  it('returns bounded MCP catalog metadata with server/query filters and no configured secrets', async () => {
    const service = http.createServer(async (request, response) => {
      let body = ''; for await (const part of request) body += part;
      const payload = JSON.parse(body);
      if (payload.id === undefined) { response.writeHead(204).end(); return; }
      response.setHeader('Content-Type', 'application/json');
      const result = payload.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'workbench-fixture', version: '1' } }
        : { tools: [
          { name: 'inspect', title: 'Inspect catalog-secret-value', description: 'Read project metadata', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'mutate', description: 'Update project', inputSchema: { type: 'object' } }
        ] };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    }); servers.push(service);
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(service.address() as { port: number }).port}/mcp`;
    const { socket } = await harness({ mcpServers: { docs: { transport: 'http', url, headers: { Authorization: 'Bearer catalog-secret-value' } } } });
    const response = await socket.request({ type: 'get_mcp_tools', serverId: 'docs', query: 'inspect' }, 'mcp_catalog');
    expect(response.catalog).toHaveLength(1);
    expect(response.catalog[0]).toMatchObject({ serverId: 'docs', readOnly: true, name: 'inspect' });
    expect(response.catalog[0].inputSchema).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('catalog-secret-value');
  });
  it('starts an isolated preview serving selected HTML while withholding protected workspace assets', async () => {
    const { socket, studio } = await harness({}, root => {
      fs.writeFileSync(path.join(root, 'index.html'), '<head><title>Workbench Preview</title></head><body>Visible page</body>');
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=preview-secret');
    });
    const ready = await socket.request({ type: 'start_preview', entry: 'index.html' }, 'preview_ready');
    expect(new URL(ready.url).port).not.toBe(String(studio.port));
    const html = await fetch(ready.url);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('Visible page');
    expect(html.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect((await fetch(new URL('.env', ready.url))).status).toBe(404);
    const unavailable = await socket.request({ type: 'start_preview', entry: '.env' }, 'error');
    expect(JSON.stringify(unavailable)).not.toContain('preview-secret');
  });
});
