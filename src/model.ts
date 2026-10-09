import type { Config } from './config.js';
import type { Message, TokenUsage, ToolCall } from './types.js';
export interface ChatResult { content: string; toolCalls: ToolCall[]; usage?: TokenUsage; model: string }
export interface ChatOptions { maxOutputTokens?: number; timeoutMs?: number; retryAttempts?: number; idleTimeoutMs?:number; onActivity?:(kind:'text'|'tool')=>void }
export interface ModelCapabilities { id: string; contextWindow?: number; maxOutputTokens?: number }
export class ModelResponseError extends Error {
  constructor(message: string, public readonly partialOutput: boolean, options?: ErrorOptions) { super(message, options); this.name = 'ModelResponseError'; }
}
/** A transport interruption is recoverable; incomplete tool calls never leave the client. */
export class ModelStreamInterruptedError extends ModelResponseError {
  constructor(message: string, public readonly partialContent: string, public readonly hadToolFragments: boolean, options?: ErrorOptions) {
    super(message, !!partialContent || hadToolFragments, options); this.name = 'ModelStreamInterruptedError';
  }
}

export class ModelClient {
  private usageSupported = true;
  private catalog?: ModelCapabilities[];
  private catalogRequest?: Promise<ModelCapabilities[]>;
  constructor(private c: Config) {}
  get config() { return this.c; }
  async modelCatalog(): Promise<ModelCapabilities[]> {
    if (this.catalogRequest) return this.catalogRequest;
    this.catalogRequest = (async () => {
      const response = await fetch(`${this.c.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.c.apiKey}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Models HTTP ${response.status}`);
      const json = await response.json() as { data?: unknown[] };
      if (!Array.isArray(json.data)) throw new Error('Danh mục model không hợp lệ');
      const integer = (...values: unknown[]) => values.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) as number | undefined;
      this.catalog = json.data.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, any>;
        if (typeof item.id !== 'string' || !item.id.trim()) return [];
        return [{ id: item.id, contextWindow: integer(item.context_length, item.context_window, item.max_context_length, item.max_input_tokens, item.top_provider?.context_length), maxOutputTokens: integer(item.max_output_tokens, item.max_completion_tokens, item.top_provider?.max_completion_tokens) }];
      });
      return this.catalog;
    })();
    try { return await this.catalogRequest; } finally { this.catalogRequest = undefined; }
  }
  async modelLimits(model: string) {
    // A provider may expose IDs only. Unknown limits remain explicit; do not
    // invent a context window from a model name or claim infinite capacity.
    if (!this.catalog) { try { await this.modelCatalog(); } catch { this.catalog = []; } }
    return this.catalog!.find(item => item.id === model);
  }
  async models() {
    const response = await fetch(`${this.c.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.c.apiKey}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Models HTTP ${response.status}`);
    return (await response.json() as { data: { id: string }[] }).data.map(item => item.id);
  }

  async chat(messages: Message[], tools: unknown[], model = this.c.model, signal?: AbortSignal, onToken?: (s: string) => void, options: ChatOptions = {}): Promise<ChatResult> {
    let last: unknown;
    let requestUsage = this.usageSupported;
    const timeoutMs = Math.max(1000, Math.min(180000, Math.floor(options.timeoutMs || 180000)));
    const attempts = Math.max(1, Math.min(4, Math.floor(options.retryAttempts || 4)));
    const expiresAt=Date.now()+timeoutMs;
    const retrySignal=()=>AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(Math.max(1,expiresAt-Date.now()))]);
    for (let attempt = 0; attempt < attempts; attempt++) {
      signal?.throwIfAborted();
      const remainingMs=expiresAt-Date.now();if(remainingMs<=0)throw new Error('Model request deadline exceeded; retry budget shares one deadline.');
      const idle=new AbortController();let idleTimer:ReturnType<typeof setTimeout>|undefined;
      const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>idle.abort(new Error('Model stream idle timeout: no data received')),Math.max(250,Math.min(remainingMs,options.idleTimeoutMs||60000)));};touch();
      let emitted = false;
      try {
        const response = await fetch(`${this.c.baseUrl}/chat/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.c.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: true, ...(requestUsage ? { stream_options: { include_usage: true } } : {}), ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}) }),
          signal: AbortSignal.any([...(signal?[signal]:[]),idle.signal,AbortSignal.timeout(remainingMs)])
        });
        if (response.status === 401 || response.status === 403) throw new Error(`Xác thực API thất bại (HTTP ${response.status}); kiểm tra khóa API`);
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          // Some compatible routers do not implement streaming usage yet.
          if (response.status === 400 && requestUsage && /stream_options|include_usage/i.test(detail)) { requestUsage = false; this.usageSupported = false; continue; }
          if (response.status === 429 || response.status >= 500) { last = new Error(`HTTP ${response.status}: ${detail}`); if (attempt < attempts - 1) await this.backoff(attempt, retrySignal()); continue; }
          throw new Error(`API HTTP ${response.status}: ${detail}`);
        }
        if (!response.body) throw new Error('Response không có stream');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '', content = '';
        let finishReason: string | null = null, doneMarker = false;
        let usage: TokenUsage | undefined;
        const calls = new Map<number, ToolCall>();
        function consume(line: string) {
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim(); if (data === '[DONE]') { doneMarker = true; return; } if (!data) return;
          let json: any; try { json = JSON.parse(data); } catch { return; }
          if (json.error) throw new Error('API stream: ' + (json.error.message || 'unknown error'));
          if (json.usage && Number.isFinite(json.usage.prompt_tokens) && Number.isFinite(json.usage.completion_tokens)) {
            usage = { prompt: json.usage.prompt_tokens, completion: json.usage.completion_tokens, total: json.usage.total_tokens ?? json.usage.prompt_tokens + json.usage.completion_tokens, cached: json.usage.prompt_tokens_details?.cached_tokens || 0, estimated: false };
          }
          const delta = json.choices?.[0]?.delta;
          if (typeof json.choices?.[0]?.finish_reason === 'string') finishReason = json.choices[0].finish_reason;
          if (delta?.content) { options.onActivity?.('text'); emitted = true; content += delta.content; onToken?.(delta.content); }
          for (const call of delta?.tool_calls || []) {
            options.onActivity?.('tool');
            emitted = true;
            const previous = calls.get(call.index) || { id: call.id || '', type: 'function' as const, function: { name: '', arguments: '' } };
            previous.id ||= call.id || ''; previous.function.name += call.function?.name || ''; previous.function.arguments += call.function?.arguments || ''; calls.set(call.index, previous);
          }
        }
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
            touch();for (const line of lines) { consume(line);if(doneMarker)break; }
            if(doneMarker){void reader.cancel().catch(()=>{});break;}
          }
          buffer += decoder.decode(); if (!doneMarker && buffer.trim()) consume(buffer);
        } catch (error) {
          signal?.throwIfAborted();
          if (/API stream/i.test(String(error))) throw error;
          throw new ModelStreamInterruptedError(`Luồng model bị ngắt: ${error instanceof Error ? error.message : String(error)}`, content, calls.size > 0, { cause: error });
        } finally { reader.releaseLock(); }
        if (finishReason === 'length' || finishReason === 'content_filter') throw new Error(`API stream: phản hồi chưa hoàn tất (${finishReason}); không thực thi tool hoặc coi đây là kết quả hoàn thành.`);
        const toolCalls = [...calls.values()];
        const ids = new Set<string>();
        for (const call of toolCalls) {
          if (!call.id || ids.has(call.id) || !call.function.name) throw new Error('API stream: tool-call thiếu hoặc trùng ID/tên; không thực thi lượt công cụ này.');
          ids.add(call.id);
          let args: unknown;
          try { args = JSON.parse(call.function.arguments); } catch {
            if (!finishReason && !doneMarker) throw new ModelStreamInterruptedError('API stream: JSON công cụ bị cắt do luồng thiếu dấu hoàn tất; chưa thực thi.', content, true);
            throw new Error('API stream: JSON tham số công cụ bị cắt hoặc không hợp lệ; không thực thi lượt công cụ này.');
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('API stream: tham số công cụ phải là JSON object.');
        }
        if (!content.trim() && !toolCalls.length) throw new Error('Model trả phản hồi rỗng; tác vụ chưa hoàn thành.');
        if (!finishReason && !doneMarker) throw new ModelStreamInterruptedError('Luồng model kết thúc thiếu dấu hoàn tất; chưa thực thi công cụ.', content, calls.size > 0);
        return { content, toolCalls, usage, model };
      } catch (error) {
        last = error; signal?.throwIfAborted();
        if (error instanceof ModelStreamInterruptedError && error.partialOutput) throw error;
        // Replaying after visible output could duplicate text or tool actions.
        if (emitted) throw new ModelResponseError(error instanceof Error ? error.message : String(error), true, { cause: error });
        if (/Xác thực|API HTTP|API stream/i.test(String(error))) throw error;
        if (attempt < attempts - 1) await this.backoff(attempt, retrySignal());
      } finally { clearTimeout(idleTimer); }
    }
    throw last || new Error('API không chấp nhận cấu hình streaming.');
  }
  private async backoff(attempt: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, Math.min(4000, 250 * 2 ** attempt));
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
}
