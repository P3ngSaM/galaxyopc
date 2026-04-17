/**
 * AI 对话 API
 *
 * POST /api/chat            — 发送消息 (同步返回)
 * GET  /api/conversations    — 获取对话列表
 * GET  /api/conversations/:id/messages — 获取对话消息
 * POST /api/conversations    — 创建新对话
 * DELETE /api/conversations/:id — 删除对话
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";
import { callAi, getModel } from "./ai-client.js";
import { runAgentChatTurn, runAgentChatStreamTurn } from "./agent-runtime.js";
import { checkQuota } from "./chat-service.js";

interface ChatFlowResult {
  reply: string;
  conversation_id: string;
  tool_calls_count: number;
}

async function runChatFlow(req: AuthRequest, db: Db): Promise<ChatFlowResult> {
  return runAgentChatTurn(req, db);
}

// ─── 发送消息 ──────────────────────────────────────────────────────────

export async function handleChat(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  try {
    const result = await runChatFlow(req, db);
    sendJson(res, 200, result);
  } catch (e: unknown) {
    const err = e as Error & { code?: string };
    const msg = err.message || "未知错误";
    if (err.code === "QUOTA_EXCEEDED") {
      sendJson(res, 429, { error: msg, quota_exceeded: true });
      return;
    }
    if (msg === "消息不能为空") {
      sendJson(res, 400, { error: msg });
      return;
    }
    if (msg === "无权访问该公司") {
      sendJson(res, 403, { error: msg });
      return;
    }
    console.error("[Chat Error]", e);
    sendJson(res, 500, { error: `AI 对话出错: ${msg}` });
  }
}

export async function handleChatStream(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const ac = new AbortController();
  let clientDisconnected = false;
  res.on("close", () => { clientDisconnected = true; ac.abort(); });

  const writeEvent = (event: string, data: unknown) => {
    if (clientDisconnected) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  try {
    await runAgentChatStreamTurn(req, db, {
      onMeta: (data) => writeEvent("meta", data),
      onChunk: (delta) => writeEvent("chunk", { delta }),
      onToolStart: (data) => writeEvent("tool_start", data),
      onToolEnd: (data) => writeEvent("tool_end", data),
      onDone: (data) => writeEvent("done", data),
    }, ac.signal);
    res.end();
  } catch (e: unknown) {
    const err = e as Error & { code?: string; plan?: string };
    if (err.code === "QUOTA_EXCEEDED") {
      writeEvent("error", { error: err.message, quota_exceeded: true, plan: err.plan });
      res.end();
      return;
    }
    writeEvent("error", { error: err.message || "未知错误" });
    res.end();
  }
}

// ─── 对话列表 ──────────────────────────────────────────────────────────

export async function handleListConversations(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows } = await db.query(
    "SELECT * FROM opc_chat_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50",
    [req.user!.userId],
  );

  sendJson(res, 200, { conversations: rows });
}

// ─── 获取对话消息 ──────────────────────────────────────────────────────

export async function handleGetMessages(req: AuthRequest, res: ServerResponse, db: Db, convId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows: convRows } = await db.query(
    "SELECT * FROM opc_chat_conversations WHERE id = $1 AND user_id = $2",
    [convId, req.user!.userId],
  );
  const conv = convRows[0];
  if (!conv) {
    sendJson(res, 404, { error: "对话不存在" });
    return;
  }

  const { rows: messages } = await db.query(
    "SELECT id, role, content, tool_calls, tool_call_id, tool_name, created_at FROM opc_chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC",
    [convId],
  );

  // 查询蜂群数据用于页面刷新恢复
  let swarmData: { session: Record<string, unknown>; turns: Record<string, unknown>[] } | null = null;
  try {
    const { rows: swarmRows } = await db.query(
      "SELECT * FROM opc_swarm_sessions WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1",
      [convId],
    );
    if (swarmRows.length > 0) {
      const session = swarmRows[0] as Record<string, unknown>;
      const { rows: turnRows } = await db.query(
        "SELECT * FROM opc_swarm_turns WHERE swarm_session_id = $1 ORDER BY sequence ASC",
        [session.id as string],
      );
      swarmData = { session, turns: turnRows as Record<string, unknown>[] };
    }
  } catch { /* swarm tables may not exist yet */ }

  sendJson(res, 200, { conversation: conv, messages, swarm_data: swarmData });
}

// ─── 创建新对话 ────────────────────────────────────────────────────────

export async function handleCreateConversation(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const body = await parseBody(req);
  const companyId = String(body.company_id || "").trim();
  const title = String(body.title || "新对话").trim();

  const id = uuid();
  await db.query(
    "INSERT INTO opc_chat_conversations (id, user_id, company_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
    [id, req.user!.userId, companyId, title],
  );

  sendJson(res, 201, { conversation: { id, company_id: companyId, title } });
}

// ─── 删除对话 ──────────────────────────────────────────────────────────

export async function handleDeleteConversation(req: AuthRequest, res: ServerResponse, db: Db, convId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows: convRows } = await db.query(
    "SELECT id FROM opc_chat_conversations WHERE id = $1 AND user_id = $2",
    [convId, req.user!.userId],
  );
  const conv = convRows[0];
  if (!conv) {
    sendJson(res, 404, { error: "对话不存在" });
    return;
  }

  await db.query("DELETE FROM opc_chat_messages WHERE conversation_id = $1", [convId]);
  await db.query("DELETE FROM opc_chat_conversations WHERE id = $1", [convId]);

  sendJson(res, 200, { success: true });
}

// ─── 用户额度与套餐信息 ──────────────────────────────────────────────

const PLAN_INFO: Record<string, { name: string; price: number; quota: number; desc: string }> = {
  free:   { name: "内测体验",   price: 0,    quota: 500,    desc: "注册即享，内测期间免费" },
  plus:   { name: "Plus 会员",  price: 9.9,  quota: 6000,   desc: "全功能访问，5 个定时任务" },
  pro:    { name: "Pro 会员",   price: 19.9, quota: 15000,  desc: "全模型 + 高级工具，20 个定时任务" },
  ultra:  { name: "Ultra 会员", price: 49.9, quota: 999999, desc: "不限速 + 专属支持，无限定时任务" },
};

export async function handleSimpleChat(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  try {
    const body = await parseBody(req);
    const message = String(body.message || '').trim();
    if (!message) { sendJson(res, 400, { error: '消息不能为空' }); return; }
    // 用轻量快速模型，不消耗用户额度
    const fastModel = getModel().startsWith('qwen') ? 'qwen-turbo' : getModel();
    const result = await callAi([{ role: 'user', content: message }], undefined, fastModel);
    sendJson(res, 200, { content: result.content });
  } catch (e: unknown) {
    sendJson(res, 500, { error: (e as Error).message || 'AI 生成失败' });
  }
}

export async function handleGetQuota(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT plan, quota_total, quota_used, plan_expires, verified, bonus_points FROM opc_users WHERE id = $1",
    [userId],
  );
  const u = rows[0] as { plan: string; quota_total: number; quota_used: number; plan_expires: string; verified: number; bonus_points: number } | undefined;
  if (!u) { sendJson(res, 404, { error: "用户不存在" }); return; }

  const { rows: usageRows } = await db.query(
    "SELECT COALESCE(SUM(tokens_in),0) as total_in, COALESCE(SUM(tokens_out),0) as total_out, COALESCE(SUM(cost_points),0) as total_cost, COUNT(*) as request_count FROM opc_usage_log WHERE user_id = $1",
    [userId],
  );
  const usage = usageRows[0] || { total_in: 0, total_out: 0, total_cost: 0, request_count: 0 };

  const { rows: todayRows } = await db.query(
    "SELECT COALESCE(SUM(cost_points),0) as today_cost, COUNT(*) as today_count FROM opc_usage_log WHERE user_id = $1 AND created_at >= CURRENT_DATE",
    [userId],
  );
  const today = todayRows[0] || { today_cost: 0, today_count: 0 };

  const monthlyRemaining = u.plan === "ultra" ? 999999 : u.quota_total - u.quota_used;
  const bonusPoints = u.bonus_points ?? 0;

  sendJson(res, 200, {
    plan: u.plan,
    plan_name: PLAN_INFO[u.plan]?.name || u.plan,
    quota_total: u.quota_total,
    quota_used: u.quota_used,
    quota_remaining: monthlyRemaining,
    bonus_points: bonusPoints,
    total_remaining: u.plan === "ultra" ? 999999 : monthlyRemaining + bonusPoints,
    plan_expires: u.plan_expires,
    verified: u.verified,
    usage_stats: {
      total_tokens_in: Number(usage.total_in),
      total_tokens_out: Number(usage.total_out),
      total_cost_points: Number(usage.total_cost),
      total_requests: Number(usage.request_count),
      today_cost_points: Number(today.today_cost),
      today_requests: Number(today.today_count),
    },
    plans: Object.entries(PLAN_INFO).map(([k, v]) => ({ id: k, ...v, current: k === u.plan })),
  });
}
