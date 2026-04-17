/**
 * AI API 客户端 — 直接调用 OpenAI 兼容接口
 */

const AI_TIMEOUT_MS = 120_000;
const AI_STREAM_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_CONCURRENT_AI = readIntEnv("AI_MAX_CONCURRENT", 10);
const DEFAULT_TEMPERATURE = readFloatEnv("AI_TEMPERATURE", 0.7);
const DEFAULT_MAX_TOKENS = readIntEnv("AI_MAX_TOKENS", 4096);
const DEFAULT_ENABLE_THINKING = readBoolEnv("AI_ENABLE_THINKING", false);

let _activeAiCalls = 0;
const _waitQueue: Array<() => void> = [];
let _maxConcurrentAi = DEFAULT_MAX_CONCURRENT_AI;
let _temperature = DEFAULT_TEMPERATURE;
let _maxTokens = DEFAULT_MAX_TOKENS;
let _enableThinking = DEFAULT_ENABLE_THINKING;

function acquireAiSlot(signal?: AbortSignal): Promise<void> {
  if (_activeAiCalls < _maxConcurrentAi) {
    _activeAiCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("AI 请求已取消"));
      return;
    }

    const resume = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      const idx = _waitQueue.indexOf(resume);
      if (idx >= 0) _waitQueue.splice(idx, 1);
      cleanup();
      reject(new Error("AI 请求已取消"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    _waitQueue.push(resume);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseAiSlot(): void {
  if (_waitQueue.length > 0) {
    const next = _waitQueue.shift()!;
    next();
  } else {
    _activeAiCalls--;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

export interface AiResponse {
  content: string;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage?: TokenUsage;
}

export interface ResponsesToolDef {
  type: string;
  [key: string]: unknown;
}

export interface ResponsesApiResult {
  id?: string;
  model?: string;
  status?: string;
  output: Array<Record<string, unknown>>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
  };
}

let _baseUrl = process.env.AI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
let _apiKey = process.env.AI_API_KEY || "";
let _model = process.env.AI_MODEL || "qwen3.6-plus";

/**
 * AI 运行模式：
 * - local:  使用用户自配的 API Key 直连大模型（零成本）
 * - cloud:  通过云端套餐代理，消耗用户配额
 * - hybrid: 纯对话走本地，工具调用走云端（省钱 + 高质量）
 */
export type AiMode = "local" | "cloud" | "hybrid";

let _aiMode: AiMode = (process.env.AI_MODE as AiMode) || "local";

export function configureAi(opts: { baseUrl?: string; apiKey?: string; model?: string; mode?: AiMode }): void {
  if (opts.baseUrl) _baseUrl = opts.baseUrl.replace(/\/+$/, "");
  if (opts.apiKey) _apiKey = opts.apiKey;
  if (opts.model) _model = opts.model;
  if (opts.mode) _aiMode = opts.mode;
  _temperature = readFloatEnv("AI_TEMPERATURE", _temperature);
  _maxTokens = readIntEnv("AI_MAX_TOKENS", _maxTokens);
  _maxConcurrentAi = readIntEnv("AI_MAX_CONCURRENT", _maxConcurrentAi);
  _enableThinking = readBoolEnv("AI_ENABLE_THINKING", _enableThinking);
}

export function getModel(): string { return _model; }
export function getAiMode(): AiMode { return _aiMode; }
export function setAiMode(mode: AiMode): void { _aiMode = mode; }
export function hasLocalAiKey(): boolean { return !!_apiKey; }
export function getAiBaseUrl(): string { return _baseUrl; }

/**
 * 根据当前 AI 模式决定某次请求是否走本地。
 * hybrid 模式下：有 tools 走云端，纯对话走本地。
 */
export function shouldUseLocalAi(hasTools: boolean): boolean {
  if (_aiMode === "local") return true;
  if (_aiMode === "cloud") return false;
  // hybrid: 纯对话走本地（如果有本地 key），有工具走云端
  return !hasTools && hasLocalAiKey();
}

function sanitizeMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map(m => {
    if (m.role === "assistant" && (m as any).tool_calls) {
      const tcs = (m as any).tool_calls as any[];
      const cleaned = tcs.map(tc => {
        const args = tc.function?.arguments ?? "{}";
        let safe: string;
        try { JSON.parse(args); safe = args; } catch { safe = "{}"; }
        return { ...tc, function: { ...tc.function, arguments: safe } };
      });
      return { ...m, tool_calls: cleaned };
    }
    return m;
  });
}

function supportsThinkingToggle(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("qwen") || normalized.startsWith("qwq");
}

function buildResponsesUrl(): string {
  return `${_baseUrl.replace(/\/+$/, "")}/responses`;
}

export async function callAiResponses(
  input: string,
  tools: ResponsesToolDef[],
  opts?: {
    modelOverride?: string;
    signal?: AbortSignal;
    enableThinking?: boolean;
    toolChoice?: "auto" | "none" | "required";
  },
): Promise<ResponsesApiResult> {
  const model = opts?.modelOverride || _model;
  const enableThinking = opts?.enableThinking ?? _enableThinking;
  const body: Record<string, unknown> = {
    model,
    input,
    tools,
    tool_choice: opts?.toolChoice || "auto",
  };
  if (supportsThinkingToggle(model)) {
    body.enable_thinking = enableThinking;
  }

  const res = await fetch(buildResponsesUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${_apiKey}` },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI Responses API Error ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    id?: string;
    model?: string;
    status?: string;
    error?: { message?: string };
    output?: Array<Record<string, unknown>>;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  return {
    id: data.id,
    model: data.model,
    status: data.status,
    output: data.output || [],
    usage: data.usage ? {
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      total_tokens: data.usage.total_tokens,
      reasoning_tokens: data.usage.output_tokens_details?.reasoning_tokens || 0,
    } : undefined,
  };
}

export async function callAi(
  messages: ChatMessage[],
  tools?: ToolDef[],
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<AiResponse> {
  const ac = new AbortController();
  let timedOut = false;
  const abortForwarder = () => ac.abort();
  await acquireAiSlot(signal);
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, AI_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", abortForwarder, { once: true });

  try {
    const safeMessages = sanitizeMessages(messages);
    const body: Record<string, unknown> = {
      model: modelOverride || _model,
      messages: safeMessages,
      temperature: _temperature,
      max_tokens: _maxTokens,
    };
    if (supportsThinkingToggle(String(body.model || ""))) {
      body.enable_thinking = _enableThinking;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(`${_baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${_apiKey}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI API Error ${res.status}: ${text}`);
    }

    const data = await res.json() as {
      choices: Array<{ message: { content?: string; tool_calls?: ToolCall[] }; finish_reason: string }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error("AI 返回空结果");

    return {
      content: choice.message.content || "",
      tool_calls: choice.message.tool_calls || [],
      finish_reason: choice.finish_reason,
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
        reasoning_tokens: data.usage.completion_tokens_details?.reasoning_tokens || 0,
      } : undefined,
    };
  } catch (error: unknown) {
    if (ac.signal.aborted) {
      if (signal?.aborted) throw new Error("AI 请求已取消");
      if (timedOut) throw new Error("AI 请求超时，请稍后重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortForwarder);
    releaseAiSlot();
  }
}

export interface StreamToolResult {
  content: string;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage?: TokenUsage;
}

/**
 * Streaming AI call with tool_calls detection.
 * - Content deltas are pushed to `onDelta` in real-time for immediate display.
 * - tool_calls are accumulated from incremental SSE chunks.
 * - Returns the full content + any tool_calls detected.
 */
export async function callAiStreamWithTools(
  messages: ChatMessage[],
  tools?: ToolDef[],
  onDelta?: (delta: string) => void,
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<StreamToolResult> {
  const ac = new AbortController();
  let timedOut = false;
  const abortForwarder = () => ac.abort();
  await acquireAiSlot(signal);
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, AI_STREAM_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", abortForwarder, { once: true });

  try {
  const safeMessages = sanitizeMessages(messages);
  const body: Record<string, unknown> = {
    model: modelOverride || _model,
    messages: safeMessages,
    temperature: _temperature,
    max_tokens: _maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (supportsThinkingToggle(String(body.model || ""))) {
    body.enable_thinking = _enableThinking;
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(`${_baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${_apiKey}` },
    body: JSON.stringify(body),
    signal: ac.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI API Error ${res.status}: ${text}`);
  }

  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  // Fallback: provider returned non-stream JSON despite stream=true
  if (ctype.includes("application/json")) {
    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content || "";
    if (content && onDelta) {
      for (let i = 0; i < content.length; i += 6) {
        onDelta(content.slice(i, i + 6));
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    return {
      content,
      tool_calls: choice?.message?.tool_calls || [],
      finish_reason: choice?.finish_reason || "stop",
    };
  }

  if (!res.body) throw new Error("AI 流式响应为空");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let finishReason = "stop";
  const tcMap = new Map<number, { id: string; name: string; args: string }>();
  let streamUsage: TokenUsage | undefined;

  const processLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let obj: {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    try { obj = JSON.parse(payload); } catch { return; }
    if (obj.usage) {
      streamUsage = {
        prompt_tokens: obj.usage.prompt_tokens,
        completion_tokens: obj.usage.completion_tokens,
        total_tokens: obj.usage.total_tokens,
        reasoning_tokens: obj.usage.completion_tokens_details?.reasoning_tokens || 0,
      };
    }
    const choice = obj.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (delta.content) {
      fullContent += delta.content;
      if (onDelta) onDelta(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let entry = tcMap.get(tc.index);
        if (!entry) { entry = { id: "", name: "", args: "" }; tcMap.set(tc.index, entry); }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
    }
  };

  try {
    while (true) {
      if (ac.signal.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (line) processLine(line);
      }
    }
    if (buffer.trim()) processLine(buffer.trim());
  } finally {
    reader.cancel().catch(() => {});
  }

  const toolCalls: ToolCall[] = [];
  const sorted = [...tcMap.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, entry] of sorted) {
    if (entry.name) {
      toolCalls.push({
        id: entry.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "function",
        function: { name: entry.name, arguments: entry.args },
      });
    }
  }

  return { content: fullContent, tool_calls: toolCalls, finish_reason: finishReason, usage: streamUsage };

  } catch (error: unknown) {
    if (ac.signal.aborted) {
      if (signal?.aborted) throw new Error("AI 流式请求已取消");
      if (timedOut) throw new Error("AI 流式请求超时，请稍后重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortForwarder);
    releaseAiSlot();
  }
}

/** Simple streaming without tool support (kept for backward compat) */
export async function callAiStream(
  messages: ChatMessage[],
  onDelta?: (delta: string) => void,
): Promise<string> {
  const result = await callAiStreamWithTools(messages, undefined, onDelta);
  return result.content;
}

function readIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readFloatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
