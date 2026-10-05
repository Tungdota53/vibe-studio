import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startStudio, type StudioServerInstance } from '../src/studio/server.js';

const servers: StudioServerInstance[] = [];
const roots: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.terminate());
  await Promise.all(servers.splice(0).map(server => server.close()));
  roots.splice(0).forEach(root => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} });
});
async function studio(token?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-desktop-')); roots.push(root);
  const instance = await startStudio({ port: 0, openBrowser: false, workspace: root, token }); servers.push(instance); return instance;
}
function connect(url: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:')); sockets.push(socket);
  const messages: any[] = [];
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  return { socket, messages, async wait(type: string) {
    const start = Date.now(), timeout = process.platform === 'win32' ? 10000 : 4000;
    while (Date.now() - start < timeout) { const index = messages.findIndex(msg => msg.type === type); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`No ${type} event`);
  } };
}
describe('Desktop backend', () => {
  it('round-trips unlimited budgets and provider context mode through configuration', async () => {
    const server = await studio(); const client = connect(server.url); await client.wait('init');
    client.socket.send(JSON.stringify({ type: 'configure_team', maxAgentIterations: 0, maxAgentToolCalls: 0 }));
    const team = await client.wait('team_config');
    expect(team.maxAgentIterations).toBe(0); expect(team.maxAgentToolCalls).toBe(0);
    const saved = JSON.parse(fs.readFileSync(path.join(roots.at(-1)!, '.vibe', 'config.json'), 'utf8'));
    expect(saved.maxAgentIterations).toBe(0); expect(saved.maxAgentToolCalls).toBe(0);
    client.socket.send(JSON.stringify({ type: 'configure', baseUrl: 'http://127.0.0.1:1234/v1', model: 'huge-window', apiKey: '', contextMode: 'auto', contextWindow: 4_194_304, maxOutputTokens: 131_072 }));
    const configured = await client.wait('configured');
    expect(configured.config).toMatchObject({ contextMode: 'auto', contextWindow: 4_194_304, maxOutputTokens: 131_072 });
    expect(configured.config.modelPool[0].maxContext).toBeUndefined();
  });
  it('persists role profiles without credentials and rejects invalid assignments', async () => {
    const server = await studio(); const client = connect(server.url); await client.wait('init');
    client.socket.send(JSON.stringify({ type: 'get_team' }));
    const catalog = await client.wait('team_config'); expect(catalog.roles).toHaveLength(7);
    expect(catalog.skills.find((skill: any) => skill.id === 'builtin:code-review')).toBeTruthy();
    client.socket.send(JSON.stringify({ type: 'configure_team', profiles: { reviewer: { skills: ['missing'] } } }));
    expect((await client.wait('error')).message).toContain('Không tìm');
    client.socket.send(JSON.stringify({ type: 'configure_team', maxAgents: 3, profiles: { reviewer: { instructions: 'Check auth', skills: ['builtin:code-review'], model: 'review-model', autoSkills: false } } }));
    const saved = await client.wait('team_config'); expect(saved.saved).toBe(true);
    expect(saved.roles.find((role: any) => role.id === 'reviewer')).toMatchObject({ model: 'review-model', instructions: 'Check auth', autoSkills: false });
    const config = JSON.parse(fs.readFileSync(path.join(roots.at(-1)!, '.vibe', 'config.json'), 'utf8'));
    expect(config.agentProfiles.reviewer.skills).toEqual(['builtin:code-review']); expect(config.apiKey).toBeUndefined();
    client.socket.send(JSON.stringify({ type: 'search_skills', query: 'review' }));
    expect((await client.wait('skill_results')).skills.some((skill: any) => skill.id === 'builtin:code-review')).toBe(true);
  });
  it('protects HTML, assets and API with the desktop token', async () => {
    const server = await studio('private-token');
    for (const route of ['/', '/app.css', '/app.js', '/api/status']) {
      expect((await fetch(server.url + route)).status).toBe(401);
      expect((await fetch(server.url + route + '?token=private-token')).status).toBe(200);
    }
  });
  it('rejects unauthorized websocket upgrades', async () => {
    const server = await studio('private-token');
    const socket = new WebSocket(server.url.replace('http:', 'ws:')); sockets.push(socket);
    const error = await new Promise<Error>(resolve => socket.once('error', resolve));
    expect(error.message).toContain('401');
  });
  it('rejects invalid configuration and redacts configured API keys', async () => {
    const server = await studio(); const client = connect(server.url); await client.wait('init');
    client.socket.send(JSON.stringify({ type: 'configure', baseUrl: 'file:///secret', model: 'test', apiKey: 'private-key' }));
    expect((await client.wait('error')).message).toContain('không hợp lệ');
    client.socket.send(JSON.stringify({ type: 'configure', baseUrl: 'http://127.0.0.1:1234/v1', model: 'new-model', apiKey: 'private-key' }));
    const result = await client.wait('configured');
    expect(result.config.model).toBe('new-model'); expect(result.config.apiKey).toBe('[REDACTED]');
    expect(result.config.modelPool[0].id).toBe('new-model');
    expect(JSON.stringify(await (await fetch(server.url + '/api/status')).json())).not.toContain('private-key');
  });
  it('persists conversations and sends previous turns to the configured model', async () => {
    const requests: any[] = [];
    const model = http.createServer((req, res) => {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-alpha', context_length: 65536 }, { id: 'model-beta', context_length: 65536 }] })); return; }
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
        requests.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"Hello from model"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    try {
      const server = await studio(); const client = connect(server.url); await client.wait('init');
      const port = (model.address() as import('node:net').AddressInfo).port;
      client.socket.send(JSON.stringify({ type: 'configure', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', apiKey: 'fake-key' })); await client.wait('configured');
      client.socket.send(JSON.stringify({ type: 'configure_integrations', enabled: false })); await client.wait('integration_state');
      const namedAgents = ['alpha', 'beta'].map(id => ({ id, name: id, role: 'general', model: 'model-' + id, skills: [], instructions: 'Agent ' + id, enabled: true }));
      client.socket.send(JSON.stringify({ type: 'configure_team', namedAgents })); await client.wait('team_config');
      let turn = 0;
      for (const prompt of ['First question', 'Follow-up question']) {
        client.socket.send(JSON.stringify({ type: 'chat', prompt, agentId: namedAgents[turn++].id, sessionId: 'chat-test-conversation' })); await client.wait('run_end');
      }
      expect(requests, JSON.stringify(client.messages)).toHaveLength(2);
      expect(requests[0].model).toBe('model-alpha'); expect(requests[1].model).toBe('model-beta');
      expect(requests[1].messages.map((msg: any) => msg.content)).toContain('First question');
      expect(requests[1].messages.map((msg: any) => msg.content)).toContain('Hello from model');
      client.socket.send(JSON.stringify({ type: 'get_conversation', sessionId: 'chat-test-conversation' }));
      expect((await client.wait('conversation')).messages).toHaveLength(4);
      const status = await (await fetch(server.url + '/api/status')).json();
      expect(status.sessions[0].status).toBe('completed');
    } finally { await new Promise<void>(resolve => model.close(() => resolve())); }
  });
  it('stop denies pending approvals', async () => {
    const server = await studio(); const client = connect(server.url); await client.wait('init');
    const pending = server.requestApproval('delete important file'); await client.wait('approval_request');
    client.socket.send(JSON.stringify({ type: 'stop' })); expect(await pending).toBe(false);
  });
});
