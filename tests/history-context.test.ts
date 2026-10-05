import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { Store } from '../src/db.js';
import { newConversation } from '../src/conversation.js';
import { startStudio, type StudioServerInstance } from '../src/studio/server.js';

const roots: string[] = [], stores: Store[] = [], studios: StudioServerInstance[] = [], sockets: WebSocket[] = [], providers: http.Server[] = [];
async function removeTemp(root: string) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.terminate());
  await Promise.all(studios.splice(0).map(server => server.close()));
  stores.splice(0).forEach(store => { if (store.db.open) store.close(); });
  await Promise.all(providers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) await removeTemp(root);
});
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-history-')); roots.push(value); return value; }
function connect(url: string) {
  const socket = new WebSocket(url.replace('http:', 'ws:')); sockets.push(socket); const messages: any[] = [];
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  return { socket, messages, async wait(type: string) { const end = Date.now() + (process.platform === 'win32' ? 15000 : 4000); while (Date.now() < end) { const index = messages.findIndex(item => item.type === type); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Missing ${type}`); } };
}
describe('Durable visible chat history and effective context', () => {
  it('keeps MCP secrets local and preserves omitted fields when saving safe status edits', async () => {
    const workspace = root();
    const studio = await startStudio({ workspace, port: 0, openBrowser: false }); studios.push(studio);
    const client = connect(studio.url); await client.wait('init');
    const servers = {
      remote: { transport: 'http', url: 'https://example.test/mcp?token=query-secret', headers: { Authorization: 'Bearer header-secret' }, enabled: false },
      local: { transport: 'stdio', command: 'node', args: ['server.js', '--token', 'arg-secret'], env: { ACCESS_TOKEN: 'env-secret' }, enabled: false }
    };
    client.socket.send(JSON.stringify({ type: 'configure_mcp', servers }));
    const configured = await client.wait('mcp_status');
    for (const secret of ['query-secret', 'header-secret', 'arg-secret', 'env-secret']) expect(JSON.stringify(configured)).not.toContain(secret);
    expect(configured.servers.find((item: any) => item.id === 'remote')).toMatchObject({ url: 'https://example.test/mcp', hasHeaders: true, hasUrlQuery: true });
    client.socket.send(JSON.stringify({ type: 'configure_mcp', servers: { remote: { transport: 'http', url: 'https://example.test/mcp', enabled: false, timeoutMs: 10000 }, local: { transport: 'stdio', command: 'node', enabled: false, timeoutMs: 10000 } } }));
    await client.wait('mcp_status');
    const saved = JSON.parse(fs.readFileSync(path.join(workspace, '.vibe', 'config.json'), 'utf8'));
    expect(saved.mcpServers.remote.url).toBe(servers.remote.url); expect(saved.mcpServers.remote.headers).toEqual(servers.remote.headers);
    expect(saved.mcpServers.local.args).toEqual(servers.local.args); expect(saved.mcpServers.local.env).toEqual(servers.local.env);
    const status = await (await fetch(studio.url + '/api/status')).text();
    for (const secret of ['query-secret', 'header-secret', 'arg-secret', 'env-secret']) expect(status).not.toContain(secret);
    client.socket.send(JSON.stringify({ type: 'get_mcp' })); expect((await client.wait('mcp_status')).servers).toHaveLength(2);
  });
  it('restores original archived turns without exposing tools as assistant messages', () => {
    const workspace = root(); let store = new Store(workspace); stores.push(store);
    store.session('chat-old', 'completed', 'model', 'User goal');
    store.archiveItem('chat-old', { role: 'user', content: 'Exact archived request' });
    store.archiveItem('chat-old', { role: 'assistant', content: 'Inspecting', tool_calls: [{ id: 'call', type: 'function', function: { name: 'list_files', arguments: '{}' } }] });
    store.archiveItem('chat-old', { role: 'tool', content: 'secret tool result', tool_call_id: 'call' });
    store.archiveItem('chat-old', { role: 'assistant', content: 'Actual answer' });
    store.progress('chat-old', { type: 'tool_end', tool: 'list_files', status: 'completed' });
    store.close(); store = new Store(workspace); stores.push(store);
    expect(store.transcript('chat-old').map(item => item.content)).toEqual(['Exact archived request', 'Actual answer']);
    store.db.prepare('INSERT INTO conversation_state VALUES(?,?)').run('chat-old', '{broken legacy snapshot');
    expect(store.conversation('chat-old').messages.map(item => item.content)).toEqual(['Exact archived request', 'Actual answer']);
    expect(store.progressHistory('chat-old')).toMatchObject([{ sessionId: 'chat-old', tool: 'list_files' }]);
  });
  it('restores conversation_state-only chats and legacy teamwork goal/results with durable ordering', () => {
    const store = new Store(root()); stores.push(store);
    store.session('chat-old', 'completed', 'model', 'Old');
    store.saveConversation('chat-old', newConversation([{ role: 'user', content: 'Old request' }, { role: 'assistant', content: 'Old answer' }]));
    store.session('session-12345678', 'completed', 'model', 'Build site');
    store.task('session-12345678', { id: 'T1', title: 'Implement UI', description: '', role: 'coder', status: 'completed', dependencies: [], createdAt: '', resultSummary: 'Created homepage' });
    expect(store.transcript('session-12345678').map(item => item.content)).toEqual(['Build site', 'Implement UI: completed\nCreated homepage']);
    expect(store.transcript('chat-old')).toHaveLength(2);
    store.session('chat-old', 'completed', 'model');
    expect((store.sessions()[0] as any).id).toBe('chat-old');
  });
  it('restores the runtime provider window and tool milestones after a different model configuration', async () => {
    const workspace = root(); let calls = 0;
    const provider = http.createServer((req, res) => {
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'large-model', context_length: 200000 }] })); return; }
      req.resume(); req.on('end', () => {
        res.setHeader('Content-Type', 'text/event-stream'); calls++;
        const delta = calls === 1 ? { tool_calls: [{ index: 0, id: 'list-call', type: 'function', function: { name: 'list_files', arguments: '{}' } }] } : { content: 'Finished listing' };
        res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      });
    }); providers.push(provider); await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const studio = await startStudio({ workspace, port: 0, openBrowser: false }); studios.push(studio);
    const client = connect(studio.url); await client.wait('init');
    const baseUrl = `http://127.0.0.1:${(provider.address() as import('node:net').AddressInfo).port}/v1`;
    client.socket.send(JSON.stringify({ type: 'configure', baseUrl, model: 'large-model', apiKey: 'fake', contextMode: 'auto', contextWindow: 131072 })); await client.wait('configured');
    client.socket.send(JSON.stringify({ type: 'configure_integrations', enabled: false })); await client.wait('integration_state');
    client.socket.send(JSON.stringify({ type: 'chat', sessionId: 'chat-window', prompt: 'List files' })); await client.wait('run_end');
    client.socket.send(JSON.stringify({ type: 'configure', baseUrl, model: 'unknown-model', apiKey: '', contextMode: 'manual', contextWindow: 8192 })); await client.wait('configured');
    client.socket.send(JSON.stringify({ type: 'get_conversation', sessionId: 'chat-window' }));
    const restored = await client.wait('conversation');
    expect(restored.messages.map((item: any) => item.content)).toEqual(['List files', 'Finished listing']);
    expect(restored.context).toMatchObject({ window: 200000, model: 'large-model', limitSource: 'runtime' });
    expect(restored.context.inputBudget).toBeGreaterThan(180000);
    expect(restored.progress).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_start', tool: 'list_files' }), expect.objectContaining({ type: 'tool_end', tool: 'list_files', status: 'completed' })]));
    expect(client.messages.some(item => item.type === 'chat_session' && item.sessionId === 'chat-window')).toBe(true);
  });
});
