import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Message, ToolCall } from './types.js';
import type { ConversationState } from './conversation.js';
import { durableJson } from './checkpoints.js';
interface RecordedTool { id: string; call: ToolCall; mutating: boolean; status: 'pending' | 'completed'; result?: string; checkpointId?: string }
interface HistoricalTool { id: string; callId: string; name: string; signature: string; mutating: boolean; status: 'pending' | 'completed'; checkpointId?: string }
interface JournalData { version: 1; key: string; updatedAt: string; status: 'running' | 'completed' | 'interrupted'; state?: ConversationState; active?: { answer: Message; tools: RecordedTool[] }; history: HistoricalTool[] }
function signature(call: ToolCall) {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, sort(value)])) : value;
  let args: unknown; try { args = sort(JSON.parse(call.function.arguments)); } catch { args = call.function.arguments; }
  return createHash('sha256').update(JSON.stringify([call.function.name, args])).digest('hex');
}
function compact(record: RecordedTool): HistoricalTool { return { id: record.id, callId: record.call.id, name: record.call.function.name, signature: signature(record.call), mutating: record.mutating, status: record.status, ...(record.checkpointId ? { checkpointId: record.checkpointId } : {}) }; }
export class RunJournal {
  private file: string; private data: JournalData; private resumeGuard = false;
  private effectSignatures = new Set<string>();
  constructor(workspace: string, public readonly key: string) {
    this.file = path.join(path.resolve(workspace), '.vibe', 'run-journals', createHash('sha256').update(key).digest('hex') + '.json');
    if (fs.existsSync(this.file)) { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (value.version !== 1 || value.key !== key || !Array.isArray(value.history)) throw new Error('Invalid journal; inspect before resuming'); value.history = value.history.map((record: HistoricalTool | RecordedTool) => 'call' in record ? compact(record) : record); this.data = value; }
    else this.data = { version: 1, key, updatedAt: new Date().toISOString(), status: 'running', history: [] };
    for (const record of this.data.history) if (record.mutating) this.effectSignatures.add(record.signature);
  }
  private archiveActive() { if (this.data.active) for (const record of this.data.active.tools) { const history = compact(record); this.data.history.push(history); if (history.mutating) this.effectSignatures.add(history.signature); } delete this.data.active; }
  private persist() { this.data.updatedAt = new Date().toISOString(); durableJson(this.file, this.data); }
  beginRun(state: ConversationState) { this.archiveActive(); this.data.state = structuredClone(state); this.data.status = 'running'; this.persist(); }
  guardCompletedEffects(){this.resumeGuard=true;}
  saveState(state: ConversationState) { this.data.state = structuredClone(state); this.persist(); }
  beginBatch(answer: Message, state: ConversationState) { this.data.state = structuredClone(state); this.data.active = { answer: structuredClone(answer), tools: [] }; this.data.status = 'running'; this.persist(); }
  beginTool(call: ToolCall, mutating: boolean) {
    const fingerprint = signature(call);
    if (this.resumeGuard && mutating && (this.effectSignatures.has(fingerprint) || (this.data.active?.tools || []).some(tool => tool.mutating && signature(tool.call) === fingerprint))) throw new Error('Resume blocked replay of previously executed or uncertain side effect. Inspect current state; choose a new verified action.');
    if (!this.data.active) throw new Error('Journal tool requires active batch');
    const record: RecordedTool = { id: `${Date.now()}-${this.data.active.tools.length}`, call: structuredClone(call), mutating, status: 'pending' };
    this.data.active.tools.push(record); this.persist(); return record.id;
  }
  completeTool(id: string, result: unknown, checkpointId?: string) {
    const record = this.data.active?.tools.find(tool => tool.id === id); if (!record) throw new Error('Journal tool entry missing');
    record.result = JSON.stringify(result); record.checkpointId = checkpointId; record.status = 'completed'; this.persist();
  }
  finishBatch(state: ConversationState) { this.archiveActive(); this.data.state = structuredClone(state); this.persist(); }
  finish(state: ConversationState) { this.finishBatch(state); this.data.status = 'completed'; this.persist(); }
  interrupted(state?: ConversationState) { if (state && !this.data.active) this.data.state = structuredClone(state); this.data.status = 'interrupted'; this.persist(); }
  status() { return { key: this.key, status: this.data.status, updatedAt: this.data.updatedAt, resumable: !!this.data.state && this.data.status !== 'completed', uncertain: this.data.active?.tools.filter(tool => tool.status === 'pending' && tool.mutating).map(tool => ({ tool: tool.call.function.name, id: tool.call.id })) || [] }; }
  resumeState() {
    if (!this.data.state) throw new Error('No durable run checkpoint');
    const state = structuredClone(this.data.state), active = this.data.active;
    if (active) {
      state.messages.push(active.answer);
      for (const call of active.answer.tool_calls || []) {
        const record = active.tools.find(tool => tool.call.id === call.id);
        const content = record?.status === 'completed' ? record.result! : JSON.stringify({ ok: false, outcome: record?.mutating ? 'unknown' : 'not_executed', error: record?.mutating ? 'Interrupted side effect may already have executed. NEVER replay it blindly; inspect files/status and report uncertainty.' : 'Interrupted before tool completion; safe read may be repeated.' });
        state.messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
      this.archiveActive();
    }
    this.resumeGuard = true; this.data.state = structuredClone(state); this.data.status = 'running'; this.persist(); return state;
  }
}
