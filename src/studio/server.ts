import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, assertConfigured, type Config } from '../config.js';
import { Store } from '../db.js';
import { ModelClient } from '../model.js';
import { ModelRouter } from '../router.js';
import { Tools, toolDefinitions } from '../tools.js';
import { Agent } from '../agent.js';
import { Teamwork } from '../teamwork.js';
import { resolveTeamworkIntent } from './teamwork-intent.js';
import { taskPhase } from '../team-protocol.js';
import crypto from 'node:crypto';
import { ConversationContext, contextLimits, inspectContext, addContextPin, removeContextPin, attachContextFile, removeContextAttachment } from '../conversation.js';
import { CheckpointStore, durableJson } from '../checkpoints.js';
import { RunJournal } from '../run-journal.js';
import { runBudgetSchema, modelRatesSchema } from '../budgets.js';
import { WebPreview } from './preview.js';
import { ProjectIntegrations } from '../project-integrations.js';
import { systemPrompt } from '../prompts.js';
import { roleCatalog, roleProfile, roles, teamSchema, assignedAgent, defaultAgents } from '../roles.js';
import { SkillLibrary } from '../skills.js';
import { McpRegistry, mcpServersSchema } from '../mcp.js';
import { Operations, operationMode, operationPolicy } from '../operations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StudioOptions {
  /** Target port. Defaults to 3840. Set to 0 for automatic ephemeral port. */
  port?: number;
  /** Host to bind. Defaults to '127.0.0.1'. */
  host?: string;
  /** Whether to automatically open the browser on startup. Defaults to true on Windows (disabled in test/CI). */
  openBrowser?: boolean;
  /** Optional workspace override path. Defaults to config.workspace. */
  workspace?: string;
  /** Private desktop backend credential. */
  token?: string;
}

export interface StudioServerInstance {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
  requestApproval: (cmd: string, tool?: string, riskLevel?: string) => Promise<boolean>;
}

export function parseDiffStats(diff: string): { additions: number; deletions: number; files: number } {
  let additions = 0;
  let deletions = 0;
  const files = new Set<string>();
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      files.add(line.slice(6));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }
  return { additions, deletions, files: files.size };
}

export function sanitizeConfig(config: Config): Config {
  const sanitized = { ...config };
  if (sanitized.apiKey) {
    sanitized.apiKey = '[REDACTED]';
  }
  try { const endpoint=new URL(sanitized.baseUrl);endpoint.search='';endpoint.hash='';sanitized.baseUrl=endpoint.toString().replace(/\/$/,''); } catch { /* Legacy invalid endpoints remain editable. */ }
  // MCP connection details may carry credentials. Use get_mcp's safe status API.
  delete sanitized.mcpServers;
  return sanitized;
}

export async function startStudio(options?: number | StudioOptions): Promise<StudioServerInstance> {
  let targetPort = 3840;
  let host = '127.0.0.1';
  let openBrowser = process.platform === 'win32' && !process.env.CI && process.env.NODE_ENV !== 'test';
  let workspaceOverride: string | undefined;

  if (typeof options === 'number') {
    targetPort = options;
  } else if (options && typeof options === 'object') {
    if (typeof options.port === 'number') {
      targetPort = options.port;
    }
    if (options.host) {
      host = options.host;
    }
    if (typeof options.openBrowser === 'boolean') {
      openBrowser = options.openBrowser;
    }
    if (options.workspace) {
      workspaceOverride = options.workspace;
    }
  }

  let c = loadConfig(workspaceOverride);
  c.contextWindow = Number(process.env.VIBE_CONTEXT_WINDOW || c.contextWindow || 1000000);
  const preview = new WebPreview();
  c.maxOutputTokens = Number(process.env.VIBE_OUTPUT_TOKENS || c.maxOutputTokens || 4096);
  contextLimits(c);
  const db = new Store(path.join(c.workspace, '.vibe'));
  let client = new ModelClient(c);
  let router = new ModelRouter(c);
  let activeAbort: AbortController | undefined;
  let activeTeam: Teamwork | undefined;
  let teamworkState: any = null;
  let busy = false;
  const skills = new SkillLibrary(c.workspace);
  const operations=new Operations(c.workspace);
  const integrations=new ProjectIntegrations(c.workspace);
  let integrationFingerprint='';
  const integrationSignature=(plan:any)=>JSON.stringify({project:plan.project,skills:plan.skills.slice(0,3).map((item:any)=>item.id),mcp:plan.mcp.map((item:any)=>item.id)});
  let integrationBusy=false;
  let integrationAbort:AbortController|undefined;
  const teamConfig = () => ({ roles: roles.map(role => ({ id: role, ...roleCatalog[role], ...roleProfile(role, c) })), namedAgents: c.namedAgents || [], presets: defaultAgents, skills: skills.list().map(({ file, ...skill }) => skill), maxAgents: c.maxAgents, maxAgentIterations: c.maxAgentIterations ?? 0, maxAgentToolCalls: c.maxAgentToolCalls ?? 0 });
  const token = typeof options === 'object' ? options.token : undefined;

  const clients = new Set<WebSocket>();

  function broadcast(data: any) {
    const payload = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }

  function progress(sessionId: string, event: Record<string, unknown>) {
    const saved = db.progress(sessionId, event);
    broadcast({ ...saved, eventType: event.type, type: 'progress_event' });
  }
  async function effectiveContext(model = c.model) {
    const metadata = c.apiKey ? await client.modelLimits(model) : undefined;
    const provider = metadata?.contextWindow;
    const fallback = c.contextWindow ?? 1000000;
    const window = provider && provider >= 4096 ? c.contextMode === 'manual' ? Math.min(fallback, provider) : provider : fallback;
    const output = Math.min(c.maxOutputTokens ?? 4096, metadata?.maxOutputTokens ?? Infinity, Math.floor(window / 2));
    return { config: { ...c, contextWindow: window, maxOutputTokens: output }, limitSource: (c.contextMode === 'manual' ? 'manual' : provider ? 'provider' : 'fallback') as 'manual' | 'provider' | 'fallback' };
  }

  interface PendingApproval {
    id: string;
    command: string;
    tool: string;
    riskLevel: string;
    timer: NodeJS.Timeout;
    resolve: (val: boolean) => void;
  }

  const pendingApprovals = new Map<string, PendingApproval>();

  const requestApproval = async (
    cmd: string,
    tool = 'run_command',
    riskLevel = 'HIGH'
  ): Promise<boolean> => {
    const id = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (pendingApprovals.has(id)) {
          pendingApprovals.delete(id);
          broadcast({
            type: 'terminal_log',
            text: `[Approval Bridge] Thao tác ${id} bị từ chối do quá thời gian chờ (120s timeout).`,
          });
          resolve(false);
        }
      }, 120000);

      pendingApprovals.set(id, { id, command: cmd, tool, riskLevel, timer, resolve });

      broadcast({
        type: 'approval_request',
        id,
        command: cmd,
        tool,
        riskLevel,
        timeoutMs: 120000,
      });

      broadcast({
        type: 'terminal_log',
        text: `[Approval Bridge] Đang chờ người dùng phê duyệt [${riskLevel}]: ${cmd}`,
      });
    });
  };

  const approve = async (cmd: string): Promise<boolean> => {
    return requestApproval(cmd);
  };

  async function getDiffText(): Promise<string> {
    try {
      const tools = new Tools(c.workspace, approve);
      const res = await tools.run('git_diff', '{}');
      return res.output || '';
    } catch {
      return '';
    }
  }

  const htmlPath = path.join(__dirname, 'public', 'index.html');

  const requestListener: http.RequestListener = async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      if (token && parsedUrl.searchParams.get('token') !== token) {
        res.writeHead(401); res.end('Unauthorized'); return;
      }

      if (['/app.css', '/app.js', '/team-map.js', '/chat.css', '/chat-output.js', '/workbench.js', '/workbench.css', '/integrations.js'].includes(pathname)) {
        res.writeHead(200, { 'Content-Type': pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'public', pathname.slice(1))));
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        let content: string;
        try {
          content = fs.existsSync(htmlPath)
            ? fs.readFileSync(htmlPath, 'utf8')
            : '<!DOCTYPE html><html><body><h1>Vibe Studio UI</h1></body></html>';
        } catch {
          content = '<!DOCTYPE html><html><body><h1>Vibe Studio UI</h1></body></html>';
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
        return;
      }

      if (pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            config: sanitizeConfig(c),
            sessions: db.sessions(),
            cwd: process.cwd(),
            routerMetrics: router.status(),
          })
        );
        return;
      }

      if (pathname === '/api/diff') {
        try {
          const diff = await getDiffText();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, diff, stats: parseDiffStats(diff) }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal Server Error' }));
    }
  };

  const { server, boundPort } = await (async () => {
    if (targetPort === 0) {
      const srv = http.createServer(requestListener);
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, host, () => resolve());
      });
      const addr = srv.address() as AddressInfo;
      return { server: srv, boundPort: addr.port };
    }

    let candidatePort = targetPort;
    const maxAttempts = 51; // 3840..3890 (or targetPort..targetPort+50)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const srv = http.createServer(requestListener);
      const success = await new Promise<boolean>((resolve, reject) => {
        srv.once('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            try {
              srv.close();
            } catch {}
            resolve(false);
          } else {
            reject(err);
          }
        });
        srv.listen(candidatePort, host, () => {
          resolve(true);
        });
      });

      if (success) {
        const addr = srv.address() as AddressInfo;
        return { server: srv, boundPort: addr ? addr.port : candidatePort };
      }
      candidatePort++;
    }
    throw new Error(`Failed to bind port after ${maxAttempts} attempts starting at ${targetPort}`);
  })();

  const url =
    host === '127.0.0.1' || host === '0.0.0.0' || host === 'localhost'
      ? `http://localhost:${boundPort}`
      : `http://${host}:${boundPort}`;

  const wss = new WebSocketServer({ server, verifyClient: ({ req }: { req: http.IncomingMessage }) => {
    const origin = req.headers.origin;
    const expected = `http://${req.headers.host}`;
    if (origin && origin !== expected) return false;
    return !token || new URL(req.url || '/', expected).searchParams.get('token') === token;
  } });

  wss.on('connection', async (ws) => {
    clients.add(ws);

    const initialDiff = await getDiffText();
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'init',
        config: sanitizeConfig(c),
        diff: initialDiff,
        sessions: db.sessions(),
        routerMetrics: router.status(),
        busy,
        teamworkState,
      })
    );

    ws.on('message', async (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid payload' }));
        return;
      }

      try {
        if(integrationBusy&&['configure','configure_team','configure_mcp','configure_budget','configure_integrations','restore_checkpoint'].includes(msg.type))throw new Error('Đang thiết lập tích hợp; đợi hoặc dừng trước khi đổi cấu hình.');
        if(['get_integrations','sync_integrations','configure_integrations'].includes(msg.type)){
          if(msg.type==='get_integrations'){let report=null;try{report=JSON.parse(fs.readFileSync(path.join(c.workspace,'.vibe','integrations','report.json'),'utf8'))}catch{}ws.send(JSON.stringify({type:'integration_state',enabled:c.autoIntegrations!==false,plan:integrations.scan(String(msg.task || '')),report}));return;}
          if(busy||integrationBusy)throw new Error('Đợi tác vụ hiện tại hoàn tất trước khi thay tích hợp.');
          if(msg.type==='configure_integrations'){if(typeof msg.enabled!=='boolean')throw new Error('Thiết lập không hợp lệ');const file=path.join(c.workspace,'.vibe','config.json');let saved={};try{saved=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}durableJson(file,{...saved,autoIntegrations:msg.enabled});c={...c,autoIntegrations:msg.enabled};ws.send(JSON.stringify({type:'integration_state',enabled:msg.enabled,plan:integrations.scan()}));return;}
          integrationBusy=true;integrationAbort=new AbortController();
          try{const result=await integrations.sync(c,String(msg.task || ''),message=>ws.send(JSON.stringify({type:'integration_progress',message})),integrationAbort.signal);c=result.config;client=new ModelClient(c);router=new ModelRouter(c);integrationFingerprint=integrationSignature(result.report);ws.send(JSON.stringify({type:'integration_state',enabled:c.autoIntegrations!==false,plan:result.report,report:result.report}));broadcast({type:'team_config',...teamConfig()});broadcast({type:'mcp_status',servers:result.report.connections});}finally{integrationBusy=false;integrationAbort=undefined;}return;
        }
        if(['get_operations','remember_project','forget_project','export_delivery','integrate_worktree','team_control','configure_execution','record_preview'].includes(msg.type)) {
          const sessionId=String(msg.sessionId||'');
          if(msg.type==='record_preview'){ws.send(JSON.stringify({type:'preview_recorded',record:operations.recordPreview(sessionId,String(msg.entry||''),msg.observation)}));return;}
          if(msg.type==='configure_execution') {
            if(busy||integrationBusy)throw new Error('Đợi phiên hoàn tất trước khi đổi cách thực thi');
            if(typeof msg.isolated!=='boolean')throw new Error('Thiết lập không hợp lệ');
            const file=path.join(c.workspace,'.vibe','config.json');let saved={};try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
            c={...c,useWorktrees:msg.isolated};durableJson(file,{...saved,useWorktrees:msg.isolated});ws.send(JSON.stringify({type:'execution_config',isolated:c.useWorktrees}));return;
          }
          if(msg.type==='team_control'){if(!activeTeam)throw new Error('Chưa có Teamwork đang chạy');const result=activeTeam.control(sessionId,msg.action,msg.taskId,msg.text);ws.send(JSON.stringify({type:'team_control_result',sessionId,...result}));return;}
          if(msg.type==='remember_project'){operations.remember(String(msg.text||''),msg.files);}
          if(msg.type==='forget_project'){operations.forget(String(msg.id||''));}
          if(msg.type==='export_delivery'){const result=operations.export(sessionId);ws.send(JSON.stringify({type:'delivery_export',sessionId,...result}));return;}
          if(msg.type==='integrate_worktree'){if(busy||integrationBusy)throw new Error('Đợi phiên hoàn tất trước khi tích hợp');ws.send(JSON.stringify({type:'integration_result',sessionId,...operations.integrate(sessionId)}));return;}
          const state=sessionId.startsWith('session-')?operations.inspect(sessionId):{sessionId,memory:operations.listMemory(),tasks:[],events:[],recovery:[]};
          ws.send(JSON.stringify({type:'operations_state',...state,isolated:c.useWorktrees,skills:skills.list().map(({file,...skill})=>skill)}));return;
        }
        if (['get_workbench','pin_context','unpin_context','attach_context','detach_context','get_checkpoints','checkpoint_diff','restore_checkpoint','configure_budget','get_mcp_tools','start_preview','stop_preview'].includes(msg.type)) {
          const sessionId = String(msg.sessionId || '');
          if (msg.type === 'start_preview') { ws.send(JSON.stringify({type:'preview_ready',...await preview.start(c.workspace,String(msg.entry || 'index.html'),()=>broadcast({type:'preview_changed'}))})); return; }
          if (msg.type === 'stop_preview') { await preview.close(); return; }
          if (msg.type === 'get_mcp_tools') { const registry=McpRegistry.forWorkspace(c.workspace,c.mcpServers || {}); ws.send(JSON.stringify({type:'mcp_catalog',catalog:await registry.catalog({serverId:msg.serverId,query:String(msg.query || ''),limit:64})})); return; }
          if (msg.type === 'configure_budget') {
            if(busy) throw new Error('Dừng tác vụ trước khi đổi ngân sách.');
            const runBudget=runBudgetSchema.parse(msg.budget || {}),modelRates=modelRatesSchema.parse(msg.rates || {});
            const file=path.join(c.workspace,'.vibe','config.json'); let saved={};try{saved=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
            fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({...saved,runBudget,modelRates},null,2));c={...c,runBudget,modelRates};client=new ModelClient(c);router=new ModelRouter(c);
            ws.send(JSON.stringify({type:'budget_config',runBudget,modelRates}));return;
          }
          if (!/^(chat-[a-zA-Z0-9-]{1,80}|session-[a-f0-9]{8})$/.test(sessionId)) throw new Error('Chọn một phiên trước.');
          const checkpoints=new CheckpointStore(c.workspace);
          let sessionCheckpoints=checkpoints.list().filter(item=>item.sessionId===sessionId || item.sessionId?.startsWith(sessionId+':'));
          if(['checkpoint_diff','restore_checkpoint'].includes(msg.type)&&!sessionCheckpoints.some(item=>item.id===msg.id))throw new Error('Checkpoint không thuộc phiên đã chọn.');
          if(msg.type==='checkpoint_diff') { ws.send(JSON.stringify({type:'checkpoint_detail',sessionId,...checkpoints.diff(String(msg.id))}));return; }
          if(msg.type==='restore_checkpoint') { if(busy)throw new Error('Dừng tác vụ trước khi hoàn tác.');const result=checkpoints.restore(String(msg.id),msg.files);progress(sessionId,{type:'checkpoint_restored',status:'completed',message:`Đã hoàn tác ${result.restored.length} tệp.`}); }
          if(msg.type==='restore_checkpoint')sessionCheckpoints=checkpoints.list().filter(item=>item.sessionId===sessionId || item.sessionId?.startsWith(sessionId+':'));
          const memory=db.conversation(sessionId);
          if(['pin_context','unpin_context','attach_context','detach_context'].includes(msg.type)) {
            if(busy)throw new Error('Đợi tác vụ hoàn tất trước khi sửa context.');
            if(msg.type==='pin_context')addContextPin(memory,String(msg.content || ''),String(msg.label || 'Ghi nhớ'));
            if(msg.type==='unpin_context')removeContextPin(memory,String(msg.id));
            if(msg.type==='attach_context')attachContextFile(memory,c.workspace,String(msg.path || ''));
            if(msg.type==='detach_context')removeContextAttachment(memory,String(msg.id));
            db.saveConversation(sessionId,memory);
          }
          const limits=await effectiveContext(db.sessionInfo(sessionId)?.model || c.model);
          let resume: Record<string,unknown>=new RunJournal(c.workspace,sessionId).status();
          if(sessionId.startsWith('session-')) { try { const saved=JSON.parse(fs.readFileSync(path.join(c.workspace,'.vibe','sessions',sessionId,'resume.json'),'utf8'));resume={status:saved.status,resumable:saved.status!=='completed',uncertain:[]}; }catch{} }
          ws.send(JSON.stringify({type:'workbench_state',sessionId,context:inspectContext(limits.config,memory,systemPrompt('general',c.workspace),toolDefinitions),checkpoints:sessionCheckpoints,resume,runBudget:c.runBudget,modelRates:c.modelRates,telemetry:db.progressHistory(sessionId).filter(e=>e.type==='budget_update')}));return;
        } else if (msg.type === 'get_team') {
          ws.send(JSON.stringify({ type: 'team_config', ...teamConfig() }));
        } else if (msg.type === 'get_mcp' || msg.type === 'configure_mcp') {
          if (msg.type === 'configure_mcp') {
            if (busy) throw new Error('Hãy dừng tác vụ trước khi đổi MCP.');
            const incoming = msg.servers;
            if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('Cấu hình MCP không hợp lệ.');
            const merged = Object.fromEntries(Object.entries(incoming).map(([id, raw]) => {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [id, raw];
              const prior = c.mcpServers?.[id];
              const next = { ...(prior || {}), ...raw } as Record<string, unknown>;
              if (prior?.transport === 'http' && next.transport === 'http' && typeof next.url === 'string') {
                const safeUrl = new URL(prior.url); safeUrl.search = ''; safeUrl.hash = '';
                if (next.url === safeUrl.toString()) next.url = prior.url;
              }
              return [id, next];
            }));
            const servers = mcpServersSchema.parse(merged);
            const file = path.join(c.workspace, '.vibe', 'config.json');
            let saved: Record<string, unknown> = {}; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
            fs.writeFileSync(file, JSON.stringify({ ...saved, mcpServers: servers }, null, 2));
            c = { ...c, mcpServers: servers }; client = new ModelClient(c);
          }
          const registry = McpRegistry.forWorkspace(c.workspace, c.mcpServers || {});
          ws.send(JSON.stringify({ type: 'mcp_status', servers: await registry.discover(), saved: msg.type === 'configure_mcp' }));
        } else if (msg.type === 'configure_team') {
          if (busy) throw new Error('Hãy dừng tác vụ trước khi đổi phân vai.');
          const data = teamSchema.parse(msg);
          const next = { ...c, maxAgents: data.maxAgents ?? c.maxAgents, maxAgentIterations: data.maxAgentIterations ?? c.maxAgentIterations, maxAgentToolCalls: data.maxAgentToolCalls ?? c.maxAgentToolCalls, namedAgents: data.namedAgents ?? c.namedAgents, agentProfiles: { ...c.agentProfiles, ...data.profiles } };
            const available = skills.list();
            for (const role of roles) skills.select(role, '', next, [], available);
            for (const agent of next.namedAgents || []) skills.select(agent.role, '', next, agent.skills, available);
          const file = path.join(c.workspace, '.vibe', 'config.json');
          const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
          fs.writeFileSync(file, JSON.stringify({ ...saved, agentProfiles: next.agentProfiles, namedAgents: next.namedAgents, maxAgents: next.maxAgents, maxAgentIterations: next.maxAgentIterations, maxAgentToolCalls: next.maxAgentToolCalls }, null, 2));
          c = next; client = new ModelClient(c); router = new ModelRouter(c);
          broadcast({ type: 'team_config', saved: true, ...teamConfig() });
        } else if (msg.type === 'get_models') {
          assertConfigured(c);
          const capabilities = await client.modelCatalog();
          ws.send(JSON.stringify({ type: 'model_catalog', models: capabilities.map(item => item.id), capabilities }));
        } else if (msg.type === 'search_skills') {
          ws.send(JSON.stringify({ type: 'skill_results', skills: skills.search(String(msg.query || '')).map(({ file, ...skill }) => skill) }));
        } else if (msg.type === 'stop') {
          integrationAbort?.abort();
          activeAbort?.abort();
          activeTeam?.stop();
          for (const [id, pending] of pendingApprovals) {
            clearTimeout(pending.timer); pending.resolve(false); pendingApprovals.delete(id);
          }
        } else if (msg.type === 'configure') {
          if (busy) throw new Error('Hãy dừng tác vụ trước khi đổi cấu hình.');
          let endpoint = new URL(msg.baseUrl);
          if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('API URL không hợp lệ.');
          try { const prior=new URL(c.baseUrl);const visible=new URL(c.baseUrl);visible.search='';visible.hash='';if(endpoint.toString().replace(/\/$/,'')===visible.toString().replace(/\/$/,''))endpoint=prior; }catch{ /* Explicit new endpoint takes precedence. */ }
          if (typeof msg.model !== 'string' || !msg.model.trim()) throw new Error('Nhập tên model.');
          const model = msg.model.trim();
          const contextMode = msg.contextMode ?? c.contextMode ?? 'auto';
          if (!['auto', 'manual'].includes(contextMode)) throw new Error('Chế độ context không hợp lệ.');
          const limits = { contextWindow: msg.contextWindow ?? c.contextWindow, maxOutputTokens: msg.maxOutputTokens ?? c.maxOutputTokens };
          contextLimits(limits);
          c = { ...c, ...limits, contextMode, baseUrl: endpoint.toString().replace(/\/$/, ''), apiKey: typeof msg.apiKey === 'string' && msg.apiKey ? msg.apiKey : c.apiKey, model, models: {}, modelPool: [{ id: model, tags: ['coding', 'tools', 'reasoning'], priority: 100, maxContext: contextMode === 'manual' ? limits.contextWindow : undefined }] };
          client = new ModelClient(c); router = new ModelRouter(c);
          ws.send(JSON.stringify({ type: 'configured', config: sanitizeConfig(c) }));
        } else if (msg.type === 'init') {
          const diff = await getDiffText();
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'init',
              config: sanitizeConfig(c),
              diff,
              sessions: db.sessions(),
              routerMetrics: router.status(),
              busy,
            })
          );
        } else if (msg.type === 'get_diff') {
          const diff = await getDiffText();
          ws.send(JSON.stringify({ type: 'diff', diff }));
        } else if (msg.type === 'get_sessions') {
          ws.send(JSON.stringify({ type: 'sessions', sessions: db.sessions() }));
        } else if (msg.type === 'get_conversation') {
          const sessionId = String(msg.sessionId || '');
          const messages = db.transcript(sessionId);
          const tasks = db.tasks(sessionId).map(task => ({ ...task, phase: taskPhase(task) }));
          let gate = null;
          let pipeline = null;
          if (/^session-[a-f0-9]{8}$/.test(sessionId)) {
            try { const saved = JSON.parse(fs.readFileSync(path.join(c.workspace, '.vibe', 'sessions', sessionId, 'gate.json'), 'utf8')); gate = { verdict: saved.verdict, reasons: saved.reasons }; }
            catch { /* Interrupted or older sessions may have no persisted gate. */ }
            try { pipeline = JSON.parse(fs.readFileSync(path.join(c.workspace, '.vibe', 'sessions', sessionId, 'pipeline.json'), 'utf8')); }
            catch { /* Sessions created before pipeline reporting have no report. */ }
          }
          const memory = db.conversation(sessionId);
          let stats = db.context(sessionId);
          if (!stats) {
            const limits = await effectiveContext(db.sessionInfo(sessionId)?.model || c.model);
            stats = { ...new ConversationContext(limits.config, memory).stats(systemPrompt('general', c.workspace), toolDefinitions), limitSource: limits.limitSource };
          }
          ws.send(JSON.stringify({ type: 'conversation', sessionId, tasks, gate, pipeline, messages, progress: db.progressHistory(sessionId), summary: tasks.map(task => `${task.title}: ${task.status}\n${task.resultSummary || task.error || ''}`).join('\n\n'), context: stats, memorySummary: memory.summary }));
        } else if (msg.type === 'approval_response') {
          const p = pendingApprovals.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            pendingApprovals.delete(msg.id);
            const isApproved = Boolean(msg.approved);
            p.resolve(isApproved);
            broadcast({
              type: 'terminal_log',
              text: `[Approval Bridge] Thao tác ${msg.id} ${isApproved ? 'đã được phê duyệt' : 'đã bị từ chối'}.`,
            });
          }
        } else if (msg.type === 'command' || msg.type === 'chat' || msg.type === 'resume_chat') {
          let line = msg.type === 'resume_chat' ? /^session-[a-f0-9]{8}$/.test(String(msg.sessionId)) ? `/teamwork-resume ${msg.sessionId}` : 'Tiếp tục nhiệm vụ bị gián đoạn từ kết quả đã lưu. Kiểm tra trạng thái thao tác chưa rõ trước khi thay đổi tệp.' : (msg.prompt || msg.line || '').trim();
          if (!line) return;
          if (busy || integrationBusy) { ws.send(JSON.stringify({ type: 'error', message: 'Một tác vụ đang chạy.' })); return; }
          busy = true;
          activeAbort = new AbortController();
          broadcast({ type: 'run_start' });
          try {
          line = resolveTeamworkIntent(line, msg.sessionId);
          if(c.autoIntegrations!==false&&msg.type!=='resume_chat'&&(!line.startsWith('/')||line.startsWith('/teamwork '))){
            const fingerprint=integrationSignature(integrations.scan(line));
            if(fingerprint!==integrationFingerprint){
              broadcast({type:'integration_progress',message:'Đang chọn MCP và skill theo dự án…'});
              try{const result=await integrations.sync(c,line,message=>broadcast({type:'integration_progress',message}),activeAbort.signal);c=result.config;client=new ModelClient(c);router=new ModelRouter(c);integrationFingerprint=fingerprint;broadcast({type:'integration_state',enabled:true,plan:result.report,report:result.report});broadcast({type:'team_config',...teamConfig()});broadcast({type:'mcp_status',servers:result.report.connections});for(const entry of result.report.results)broadcast({type:'terminal_log',text:`[Tích hợp] ${entry.id}: ${entry.status} · ${entry.message}`});}catch(error){if(activeAbort.signal.aborted)throw error;broadcast({type:'terminal_log',text:'Không tải được tích hợp; tiếp tục bằng công cụ hiện có.'});}
            }
          }

          if (line.startsWith('/')) {
            const [cmd, ...parts] = line.slice(1).split(' ');
            const arg = parts.join(' ').trim();

            if (cmd === 'compact') {
              assertConfigured(c);
              const sessionId = String(msg.sessionId || '');
              if (!/^chat-[a-zA-Z0-9-]{1,80}$/.test(sessionId)) throw new Error('Chọn một cuộc trò chuyện để nén ngữ cảnh.');
              const memory = db.conversation(sessionId);
              const limits = await effectiveContext();
              const manager = new ConversationContext(limits.config, memory, event => {
                if (event.type === 'context_stats') { event.stats.limitSource = limits.limitSource; db.saveContext(sessionId, event.stats, c.model); }
                broadcast({ ...event, sessionId });
              }, state => db.saveConversation(sessionId, state));
              await manager.prepare(systemPrompt('general', c.workspace), toolDefinitions, client, c.model, activeAbort.signal, true);
              broadcast({ type: 'memory_summary', sessionId, summary: memory.summary });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'teamwork' || cmd === 'teamwork-resume') {
              assertConfigured(c);
              const tw = new Teamwork(c, db, client, router, approve);
              activeTeam = tw;
              broadcast({
                type: 'terminal_log',
                text: cmd === 'teamwork-resume' ? `[Teamwork] Khôi phục phiên ${arg}: giữ kế hoạch cũ, kiểm tra checkpoint và chạy phần còn lại.` : `[Teamwork] Khởi chạy tối đa ${c.maxAgents} agents cho mục tiêu: ${arg}`,
              });

              const onTeamEvent = (ev: any) => {
                if (typeof ev === 'string') {
                  broadcast({ type: 'terminal_log', text: ev });
                } else {
                  if (ev.type === 'session_start') {
                    teamworkState = { sessionId: ev.sessionId, goal: ev.goal, tasks: [], status: 'running' };
                    if(cmd !== 'teamwork-resume')db.message(ev.sessionId, 'user', arg);
                    broadcast({ type: 'chat_session', previousSessionId: msg.sessionId, sessionId: ev.sessionId });
                  }
                  if (ev.agentId && !ev.taskId && ev.role === 'planner') teamworkState = { ...teamworkState, planner: { ...teamworkState?.planner, ...ev } };
                  if (ev.type === 'task_snapshot' || ev.type === 'session_end') teamworkState = { ...teamworkState, ...ev };
                  if (ev.type === 'session_end' && ev.message && ['failed', 'cancelled'].includes(String(ev.status))) db.message(teamworkState.sessionId, 'assistant', `Teamwork ${ev.status}: ${ev.message}`);
                  if(ev.budget && teamworkState?.sessionId)progress(teamworkState.sessionId,{type:'budget_update',...ev.budget,agentId:ev.agentId,taskId:ev.taskId,message:ev.budget.warnings.join(' · ') || `Đã dùng ${ev.budget.tokens} token.`});
                  if (teamworkState?.sessionId && ev.type !== 'task_snapshot') progress(teamworkState.sessionId, { type: ev.type, agentId: ev.agentId, taskId: ev.taskId, tool: ev.step, model: ev.model, status: ev.status, message: ev.message || `${ev.type}${ev.taskId ? ': ' + ev.taskId : ''}` });
                  broadcast({ type: 'teamwork_event', event: ev });
                }
              };
              const result = cmd==='teamwork-resume' ? await tw.resume(arg,onTeamEvent) : await tw.run(arg,onTeamEvent);

              const teamworkAnswer = `**Kết quả Teamwork**\n\nNghiệm thu: ${result.gate.verdict}\n${result.gate.reasons.join('\n')}\n\n${tw.tasks.map(task => `• ${task.title}: ${task.status}\n${task.resultSummary || task.error || ''}`).join('\n\n') || 'Chưa có tác vụ được hoàn thành.'}`;
              if (teamworkState?.sessionId) db.message(teamworkState.sessionId, 'assistant', teamworkAnswer);
              broadcast({ type: 'stream_chunk', token: teamworkAnswer });

              const diff = await getDiffText();
              broadcast({ type: 'diff', diff });
              broadcast({ type: 'sessions', sessions: db.sessions() });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'diff') {
              const diff = await getDiffText();
              broadcast({ type: 'diff', diff });
              broadcast({
                type: 'stream_chunk',
                token: diff ? `\`\`\`diff\n${diff}\n\`\`\`` : 'Workspace sạch (Không có git diff).',
              });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'test') {
              broadcast({ type: 'terminal_log', text: '[Test] Running test suites...' });
              const tools = new Tools(c.workspace, approve);
              const res = await tools.run('run_tests', '{}', activeAbort.signal);
              broadcast({ type: 'terminal_log', text: res.output || '' });
              broadcast({
                type: 'stream_chunk',
                token: `**Kết quả kiểm thử:**\n\`\`\`text\n${res.output}\n\`\`\``,
              });
              broadcast({ type: 'command_result', command: 'test', ok: res.ok, output: res.output });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'models') {
              const list = await client.models();
              broadcast({
                type: 'stream_chunk',
                token: `**Danh sách Models khả dụng:**\n- ` + list.join('\n- '),
              });
              broadcast({ type: 'command_result', command: 'models', ok: true, output: list.join('\n') });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'model' && arg) {
              c = { ...c, model: arg };
              c.modelPool = [{ id: arg, tags: ['coding', 'tools', 'reasoning'], priority: 100 }];
              c.models = {};
              client = new ModelClient(c); router = new ModelRouter(c);
              broadcast({ type: 'stream_chunk', token: `Đã đổi model thành **${arg}**` });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'quality' && ['fast', 'balanced', 'high', 'max'].includes(arg)) {
              c = { ...c, quality: arg as any };
              broadcast({ type: 'stream_chunk', token: `Đã đổi quality policy thành **${arg}**` });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'status') {
              broadcast({
                type: 'stream_chunk',
                token: `**Trạng thái hệ thống:**\n- Workspace: \`${c.workspace}\`\n- Model: \`${c.model}\`\n- Quality: \`${c.quality}\`\n- Max Agents: \`${c.maxAgents}\``,
              });
              broadcast({ type: 'command_result', command: 'status', ok: true });
              broadcast({ type: 'stream_end' });
            } else if (cmd === 'sessions') {
              const sessions = db.sessions();
              broadcast({ type: 'sessions', sessions });
              broadcast({ type: 'stream_chunk', token: `**Đã tải ${sessions.length} phiên làm việc.**` });
              broadcast({ type: 'stream_end' });
            } else {
              broadcast({ type: 'stream_chunk', token: `Lệnh \`/${cmd}\` chưa được hỗ trợ trong Studio.` });
              broadcast({ type: 'stream_end' });
            }
          } else {
            // General Agent Chat with streaming tokens & thinking
            assertConfigured(c);
            const selected = msg.agentId ? c.namedAgents?.find(agent => agent.id === msg.agentId) : undefined;
            if (msg.agentId && !selected) throw new Error('Agent không tồn tại');
            assignedAgent(c, selected?.id, selected?.role || 'general');
            const mode=msg.mode?operationMode(msg.mode):undefined,policy=mode?operationPolicy(mode):undefined;
            const chatRole = policy?.role || selected?.role || 'general';
            const sessionId = typeof msg.sessionId === 'string' && /^chat-[a-zA-Z0-9-]{1,80}$/.test(msg.sessionId) ? msg.sessionId : `chat-${crypto.randomUUID()}`;
            const memory = db.conversation(sessionId);
            db.session(sessionId, 'running', c.model, line.slice(0, 100));
            const saveMessage = (role: 'user' | 'assistant', content: string) => db.message(sessionId, role, content);
            if(msg.type !== 'resume_chat')saveMessage('user', line);
            broadcast({ type: 'chat_session', previousSessionId: msg.sessionId, sessionId });
            progress(sessionId, { type: 'run_start', status: 'running', message: 'Đang xử lý yêu cầu.' });
            const agent = new Agent(
              'agent-general',
              chatRole,
              c.workspace,
              client,
              router,
              new Tools(c.workspace, approve, chatRole)
            );

            let isThinking = false;
            let fullResponse = '';
            let activeModel = c.model;
            const pendingTools = new Map<string, string>();
            try {
            const result = await agent.run(line, activeAbort.signal, (token) => {
              fullResponse += token;
              if (token.includes('<think>')) {
                isThinking = true;
              }
              if (isThinking) {
                broadcast({ type: 'thinking', text: token });
                if (token.includes('</think>')) {
                  isThinking = false;
                }
              } else {
                broadcast({ type: 'stream_chunk', token });
              }
            }, [], {
              state: memory,
              readOnlyTask:policy?.readOnly,
              agentConfig:policy?{...c,agentProfiles:{...c.agentProfiles,[chatRole]:{...c.agentProfiles?.[chatRole],instructions:`${c.agentProfiles?.[chatRole]?.instructions||''}\n${policy.instruction}`}}}:undefined,
              journal: new RunJournal(c.workspace,sessionId),
              resume: msg.type === 'resume_chat',
              onBudget: stats => progress(sessionId,{type:'budget_update',...stats,message:stats.warnings.join(' · ') || `Đã dùng ${stats.tokens} token.`}),
              recall: (query, limit, beforeId) => db.recall(sessionId, query, limit, beforeId),
              namedAgentId:mode?undefined:selected?.id,
              onModel: model => { activeModel = model; progress(sessionId, { type: 'model_selected', model, agentId: selected?.id || 'agent-general', status: 'running', message: `Đang dùng ${model}.` }); },
              onContext: event => {
                if (event.type === 'context_stats') { event.stats.limitSource = 'runtime'; db.saveContext(sessionId, event.stats, activeModel); }
                broadcast({ ...event, sessionId });
              },
              checkpoint: state => db.saveConversation(sessionId, state),
              onItem: item => {
                db.archiveItem(sessionId, item);
                for (const call of item.tool_calls || []) { pendingTools.set(call.id, call.function.name); progress(sessionId, { type: 'tool_start', tool: call.function.name, agentId: selected?.id || 'agent-general', status: 'running', message: `Đang chạy ${call.function.name}.` }); }
                if (item.role === 'tool') {
                  const tool = pendingTools.get(item.tool_call_id || '') || 'tool'; let ok: boolean | undefined;
                  try { const value = JSON.parse(item.content || '{}'); if (typeof value.ok === 'boolean') ok = value.ok; } catch {}
                  progress(sessionId, { type: 'tool_end', tool, agentId: selected?.id || 'agent-general', status: ok === false ? 'failed' : 'completed', message: `${tool}: ${ok === false ? 'lỗi' : 'đã trả kết quả'}.` });
                  pendingTools.delete(item.tool_call_id || '');
                }
              }
            });
            broadcast({ type: 'memory_summary', sessionId, summary: memory.summary });
            saveMessage('assistant', fullResponse || result);
            db.session(sessionId, 'completed', activeModel);
            progress(sessionId, { type: 'run_end', status: 'completed', message: 'Đã hoàn thành yêu cầu.' });
            } catch (error) {
              if (db.db.open && msg.type !== 'resume_chat') db.saveConversation(sessionId, memory);
              saveMessage('assistant', `${fullResponse}${fullResponse ? '\n\n' : ''}**Lỗi:** ${error instanceof Error ? error.message : String(error)}`);
              const status = activeAbort.signal.aborted ? 'cancelled' : 'failed';
              db.session(sessionId, status, activeModel);
              progress(sessionId, { type: 'run_end', status, message: status === 'cancelled' ? 'Đã dừng theo yêu cầu.' : 'Phiên gặp lỗi; xem thông báo chi tiết.' });
              throw error;
            }

            broadcast({ type: 'stream_end' });
          }
          } finally {
            if (activeTeam && teamworkState?.status === 'running') {
              const interruptedStatus = activeAbort?.signal.aborted ? 'cancelled' : 'failed';
              teamworkState = { ...teamworkState, status: interruptedStatus, tasks: activeTeam.tasks.map(task => ({ ...task, phase: taskPhase(task), status: ['running', 'ready', 'pending'].includes(task.status) ? interruptedStatus : task.status })) };
              broadcast({ type: 'teamwork_event', event: { type: 'task_snapshot', ...teamworkState } });
              broadcast({ type: 'teamwork_event', event: { type: 'session_end', sessionId: teamworkState.sessionId, status: interruptedStatus, message: interruptedStatus === 'cancelled' ? 'Phiên đã dừng.' : 'Phiên dừng do lỗi; xem nhật ký để biết nguyên nhân.' } });
            }
            busy = false; activeAbort = undefined; activeTeam = undefined;
            broadcast({ type: 'sessions', sessions: db.sessions() });
            broadcast({ type: 'run_end' });
          }
        }
      } catch (err: any) {
        if (!['chat','command','resume_chat'].includes(msg.type)) {
          ws.send(JSON.stringify({ type: 'error', message: err?.message || String(err) }));
          return;
        }
        broadcast({ type: 'stream_chunk', token: `\n\n**Lỗi:** ${err?.message || err}` });
        broadcast({ type: 'stream_end' });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  if (openBrowser && !process.env.CI && process.env.NODE_ENV !== 'test') {
    try {
      if (process.platform === 'win32') {
        exec(`cmd.exe /c start "" "${url}"`);
      } else if (process.platform === 'darwin') {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`);
      }
    } catch {
      // Best-effort
    }
  }

  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    activeAbort?.abort(); activeTeam?.stop();

    for (const [, pending] of pendingApprovals.entries()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    pendingApprovals.clear();

    for (const ws of clients) {
      try {
        ws.terminate();
      } catch {}
    }
    clients.clear();

    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    await preview.close();
    db.close();
  };

  return {
    server,
    wss,
    port: boundPort,
    host,
    url,
    close,
    requestApproval,
  };
}

// Auto start if executed directly via node or tsx
if (
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))
) {
  const portArgIndex = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
  const portArg = portArgIndex !== -1 ? process.argv[portArgIndex + 1] : undefined;
  const port = portArg ? parseInt(portArg, 10) : parseInt(process.env.PORT || '3840', 10);

  startStudio({ port })
    .then((instance) => {
      console.log(`\n======================================================`);
      console.log(`🚀 VIBE STUDIO (Codex & Antigravity Style)`);
      console.log(`🌐 Server running at: ${instance.url}`);
      console.log(`======================================================\n`);

      const shutdown = async () => {
        console.log('\nĐang dừng Vibe Studio server...');
        await instance.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((e) => {
      console.error('Lỗi khởi động Vibe Studio:', e);
      process.exit(1);
    });
}
