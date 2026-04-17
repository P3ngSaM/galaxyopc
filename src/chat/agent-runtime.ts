import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { parseBody } from "../auth/middleware.js";
import { callAi, callAiStreamWithTools, getModel, type ChatMessage } from "./ai-client.js";
import { buildSystemPrompt } from "./context-builder.js";
import { executeTool, getToolDefinitions } from "./tool-executor.js";
import { isLocalModeEnabled } from "../local-agent/security.js";
import {
  HISTORY_LIMIT,
  MAX_TOOL_ROUNDS,
  TOOL_EXTRA_POINTS,
  calcCostPoints,
  checkQuota,
  ensureConversationAccess,
  logUsage,
  queuePostChatTasks,
  sanitizeToolCalls,
} from "./chat-service.js";

export interface ChatFlowResult {
  reply: string;
  conversation_id: string;
  tool_calls_count: number;
}

export interface StreamAgentCallbacks {
  onMeta?: (data: Record<string, unknown>) => void;
  onChunk?: (delta: string) => void;
  onToolStart?: (data: Record<string, unknown>) => void;
  onToolEnd?: (data: Record<string, unknown>) => void;
  onDone?: (data: Record<string, unknown>) => void;
  onError?: (data: Record<string, unknown>) => void;
}

export async function runAgentChatTurn(req: AuthRequest, db: Db): Promise<ChatFlowResult> {
  const body = await parseBody(req);
  const companyId = String(body.company_id || "").trim();
  let conversationId = String(body.conversation_id || "").trim();
  const userMessage = String(body.message || "").trim();

  if (!userMessage) {
    throw new Error("消息不能为空");
  }

  const userId = req.user!.userId;
  const isLocalMode = isLocalModeEnabled();

  if (!isLocalMode) {
    const quota = await checkQuota(db, userId);
    if (!quota.ok) {
      const err = new Error("算力额度不足，请升级套餐继续使用") as Error & { code?: string };
      err.code = "QUOTA_EXCEEDED";
      throw err;
    }
  }

  conversationId = await ensureConversationAccess(db, userId, companyId, conversationId, userMessage);

  await db.query(
    "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, 'user', $5, NOW())",
    [uuid(), userId, companyId, conversationId, userMessage],
  );

  const { rows: userRows } = await db.query("SELECT name, phone, selected_model FROM opc_users WHERE id = $1", [userId]);
  const userRow = userRows[0] as { name?: string; phone?: string; selected_model?: string } | undefined;
  const displayName = userRow?.name || userRow?.phone || req.user!.phone;
  const userModel = isLocalMode ? getModel() : (userRow?.selected_model || getModel());
  const systemPrompt = await buildSystemPrompt(db, companyId, displayName, userId, userMessage);

  const { rows: historyRows } = await db.query(
    `SELECT role, content, tool_calls, tool_call_id, tool_name FROM (
      SELECT * FROM opc_chat_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
    ) sub ORDER BY created_at ASC`,
    [conversationId, HISTORY_LIMIT],
  );

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const row of historyRows) {
    if (row.role === "tool") {
      messages.push({
        role: "tool",
        content: row.content,
        tool_call_id: row.tool_call_id || "unknown",
        name: row.tool_name || undefined,
      });
    } else if (row.role === "assistant" && row.tool_calls) {
      try {
        messages.push({ role: "assistant", content: row.content, tool_calls: sanitizeToolCalls(JSON.parse(row.tool_calls)) });
      } catch {
        messages.push({ role: "assistant", content: row.content });
      }
    } else {
      messages.push({ role: row.role as "user" | "assistant", content: row.content });
    }
  }

  while (messages.length > 1 && (messages[1] as { role?: string }).role === "tool") {
    messages.splice(1, 1);
  }

  const tools = getToolDefinitions();
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let toolExtraPoints = 0;
  const calledTools: string[] = [];

  let aiResponse = await callAi(messages, tools, userModel);
  if (aiResponse.usage) {
    totalTokensIn += aiResponse.usage.prompt_tokens;
    totalTokensOut += aiResponse.usage.completion_tokens;
  }

  let rounds = 0;
  while (aiResponse.tool_calls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    await db.query(
      "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, tool_calls, created_at) VALUES ($1, $2, $3, $4, 'assistant', $5, $6, NOW())",
      [uuid(), userId, companyId, conversationId, aiResponse.content, JSON.stringify(aiResponse.tool_calls)],
    );

    const safeToolCalls = sanitizeToolCalls(aiResponse.tool_calls);
    messages.push({ role: "assistant", content: aiResponse.content, tool_calls: safeToolCalls });

    for (const toolCall of safeToolCalls) {
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }

      const toolName = toolCall.function.name;
      calledTools.push(toolName);
      toolExtraPoints += TOOL_EXTRA_POINTS[toolName] ?? 0;

      const result = await executeTool(toolName, toolArgs, db, companyId, userId);
      await db.query(
        "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, tool_call_id, tool_name, created_at) VALUES ($1, $2, $3, $4, 'tool', $5, $6, $7, NOW())",
        [uuid(), userId, companyId, conversationId, result, toolCall.id, toolName],
      );
      messages.push({ role: "tool", content: result, tool_call_id: toolCall.id, name: toolName });
    }

    aiResponse = await callAi(messages, tools, userModel);
    if (aiResponse.usage) {
      totalTokensIn += aiResponse.usage.prompt_tokens;
      totalTokensOut += aiResponse.usage.completion_tokens;
    }
  }

  if (!aiResponse.content && rounds > 0) {
    aiResponse = await callAi(messages, undefined, userModel);
    if (aiResponse.usage) {
      totalTokensIn += aiResponse.usage.prompt_tokens;
      totalTokensOut += aiResponse.usage.completion_tokens;
    }
  }

  await db.query(
    "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, 'assistant', $5, NOW())",
    [uuid(), userId, companyId, conversationId, aiResponse.content],
  );

  const { points: costPoints, costYuan } = await calcCostPoints(
    db,
    { prompt_tokens: totalTokensIn, completion_tokens: totalTokensOut, total_tokens: totalTokensIn + totalTokensOut },
    userModel,
  );
  const toolNameLabel = calledTools.length > 0 ? [...new Set(calledTools)].join(",") : "";
  await logUsage(db, userId, totalTokensIn, totalTokensOut, costPoints + toolExtraPoints, costYuan, toolNameLabel, userModel, conversationId).catch(() => {});
  await queuePostChatTasks(db, userId, companyId, conversationId, userMessage, aiResponse.content, {
    calledTools,
  });

  return {
    reply: aiResponse.content,
    conversation_id: conversationId,
    tool_calls_count: rounds,
  };
}

export async function runAgentChatStreamTurn(
  req: AuthRequest,
  db: Db,
  callbacks: StreamAgentCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const body = await parseBody(req);
  const companyId = String(body.company_id || "").trim();
  let conversationId = String(body.conversation_id || "").trim();
  const userMessage = String(body.message || "").trim();
  const userId = req.user!.userId;
  const images: string[] = Array.isArray(body.images)
    ? body.images.filter((value: unknown) => typeof value === "string" && (value as string).startsWith("data:image/"))
    : [];

  if (!userMessage && images.length === 0) {
    throw new Error("消息不能为空");
  }

  const isLocalMode = isLocalModeEnabled();
  if (!isLocalMode) {
    const quota = await checkQuota(db, userId);
    if (!quota.ok) {
      const err = new Error("算力额度不足，请升级套餐继续使用") as Error & { code?: string; plan?: string };
      err.code = "QUOTA_EXCEEDED";
      err.plan = quota.plan;
      throw err;
    }
  }

  const effectiveMessage = userMessage || (images.length > 0 ? `[用户发送了${images.length}张图片]` : "");
  conversationId = await ensureConversationAccess(db, userId, companyId, conversationId, effectiveMessage);

  await db.query(
    "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, 'user', $5, NOW())",
    [uuid(), userId, companyId, conversationId, effectiveMessage],
  );

  const { rows: userRows } = await db.query("SELECT name, phone, selected_model FROM opc_users WHERE id = $1", [userId]);
  const userRow = userRows[0] as { name?: string; phone?: string; selected_model?: string } | undefined;
  const displayName = userRow?.name || userRow?.phone || req.user!.phone;
  const userModel = isLocalMode ? getModel() : (userRow?.selected_model || getModel());
  const systemPrompt = await buildSystemPrompt(db, companyId, displayName, userId, effectiveMessage);

  const { rows: historyRows } = await db.query(
    `SELECT role, content, tool_calls, tool_call_id, tool_name FROM (
      SELECT * FROM opc_chat_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
    ) sub ORDER BY created_at ASC`,
    [conversationId, HISTORY_LIMIT],
  );

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const row of historyRows) {
    if (row.role === "tool") {
      messages.push({ role: "tool", content: row.content, tool_call_id: row.tool_call_id || "unknown", name: row.tool_name || undefined });
    } else if (row.role === "assistant" && row.tool_calls) {
      try {
        messages.push({ role: "assistant", content: row.content, tool_calls: sanitizeToolCalls(JSON.parse(row.tool_calls)) });
      } catch {
        messages.push({ role: "assistant", content: row.content });
      }
    } else if (row.role === "user" || row.role === "assistant") {
      messages.push({ role: row.role as "user" | "assistant", content: row.content });
    }
  }

  while (messages.length > 1 && (messages[1] as { role?: string }).role === "tool") {
    messages.splice(1, 1);
  }

  if (images.length > 0) {
    const lastUserIdx = messages.length - 1;
    const lastMessage = messages[lastUserIdx];
    if (lastMessage && lastMessage.role === "user") {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
        { type: "text", text: String(lastMessage.content || "") },
      ];
      for (const image of images) {
        parts.push({ type: "image_url", image_url: { url: image } });
      }
      (messages[lastUserIdx] as unknown as Record<string, unknown>).content = parts;
    }
  }

  const tools = getToolDefinitions();
  let rounds = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let toolExtraPoints = 0;
  const calledTools: string[] = [];

  callbacks.onMeta?.({ conversation_id: conversationId, tool_calls_count: 0 });

  let streamResult = await callAiStreamWithTools(
    messages,
    tools,
    (delta) => callbacks.onChunk?.(delta),
    userModel,
    signal,
  );
  if (streamResult.usage) {
    totalTokensIn += streamResult.usage.prompt_tokens;
    totalTokensOut += streamResult.usage.completion_tokens;
  }

  while (streamResult.tool_calls.length > 0 && rounds < MAX_TOOL_ROUNDS && !signal?.aborted) {
    rounds++;
    await db.query(
      "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, tool_calls, created_at) VALUES ($1, $2, $3, $4, 'assistant', $5, $6, NOW())",
      [uuid(), userId, companyId, conversationId, streamResult.content, JSON.stringify(streamResult.tool_calls)],
    );
    const safeToolCalls = sanitizeToolCalls(streamResult.tool_calls);
    messages.push({ role: "assistant", content: streamResult.content, tool_calls: safeToolCalls });

    for (const toolCall of safeToolCalls) {
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }
      const toolName = toolCall.function.name;
      const action = toolName === "invoke_skill"
        ? String(toolArgs.name || "")
        : String(toolArgs.action || toolArgs.query || toolArgs.subject || "");
      const detail = toolName === "invoke_skill" ? String(toolArgs.task || "").slice(0, 120) : "";
      callbacks.onToolStart?.({ tool: toolName, tool_call_id: toolCall.id, action, detail, args: toolArgs });

      calledTools.push(toolName);
      toolExtraPoints += TOOL_EXTRA_POINTS[toolName] ?? 0;
      const result = await executeTool(toolName, toolArgs, db, companyId, userId);

      let summary = "";
      const extraData: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(result) as Record<string, unknown>;
        if (parsed.error) summary = `错误: ${parsed.error}`;
        else if (parsed.success) summary = "执行成功";
        else summary = "已完成";
        if (parsed.export_url) extraData.export_url = parsed.export_url;
        if (parsed.document_id) extraData.document_id = parsed.document_id;
        if (parsed.title) extraData.title = parsed.title;
      } catch {
        summary = result.slice(0, 120);
      }
      callbacks.onToolEnd?.({ tool: toolName, tool_call_id: toolCall.id, action, detail, summary, ...extraData });

      await db.query(
        "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, tool_call_id, tool_name, created_at) VALUES ($1, $2, $3, $4, 'tool', $5, $6, $7, NOW())",
        [uuid(), userId, companyId, conversationId, result, toolCall.id, toolName],
      );
      messages.push({ role: "tool", content: result, tool_call_id: toolCall.id, name: toolName });
    }

    streamResult = await callAiStreamWithTools(
      messages,
      tools,
      (delta) => callbacks.onChunk?.(delta),
      userModel,
      signal,
    );
    if (streamResult.usage) {
      totalTokensIn += streamResult.usage.prompt_tokens;
      totalTokensOut += streamResult.usage.completion_tokens;
    }
  }

  if (!streamResult.content && rounds > 0 && !signal?.aborted) {
    streamResult = await callAiStreamWithTools(
      messages,
      undefined,
      (delta) => callbacks.onChunk?.(delta),
      userModel,
      signal,
    );
    if (streamResult.usage) {
      totalTokensIn += streamResult.usage.prompt_tokens;
      totalTokensOut += streamResult.usage.completion_tokens;
    }
  }

  await db.query(
    "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, 'assistant', $5, NOW())",
    [uuid(), userId, companyId, conversationId, streamResult.content || ""],
  );

  const { points: costPoints, costYuan } = await calcCostPoints(
    db,
    { prompt_tokens: totalTokensIn, completion_tokens: totalTokensOut, total_tokens: totalTokensIn + totalTokensOut },
    userModel,
  );
  const totalCostPoints = costPoints + toolExtraPoints;
  const toolNameLabel = calledTools.length > 0 ? [...new Set(calledTools)].join(",") : "";
  await logUsage(db, userId, totalTokensIn, totalTokensOut, totalCostPoints, costYuan, toolNameLabel, userModel, conversationId).catch(() => {});
  await queuePostChatTasks(db, userId, companyId, conversationId, userMessage, streamResult.content || "", {
    calledTools,
  });

  const updatedQuota = await checkQuota(db, userId);
  callbacks.onDone?.({
    usage: {
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cost_points: totalCostPoints,
      remaining: updatedQuota.remaining,
    },
  });
}
