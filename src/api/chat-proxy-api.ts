/**
 * AI 套餐代理端点 — POST /api/chat/proxy
 *
 * 供桌面本地版用户使用云端套餐时调用：
 *   1. 验证 JWT 身份
 *   2. 检查用户套餐配额
 *   3. 将 AI 请求转发到平台配置的大模型
 *   4. 流式返回结果
 *   5. 扣除配额 & 写用量日志
 *
 * 本端点仅在线上版（云端）部署时有意义，
 * 桌面版用户通过 proxyAiToCloud() 调到这里。
 */

import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";
import { callAiStreamWithTools, type ChatMessage, type ToolDef } from "../chat/ai-client.js";
import { checkQuota, calcCostPoints, logUsage } from "../chat/chat-service.js";
import type { Db } from "../db.js";
import { v4 as uuid } from "uuid";

export async function handleChatProxy(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const source = req.headers["x-opc-source"] || "";
  if (source !== "desktop-local") {
    sendJson(res, 403, { error: "此接口仅供桌面本地版调用" });
    return;
  }

  const userId = req.user!.userId;

  const quota = await checkQuota(db, userId);
  if (!quota.ok) {
    sendJson(res, 429, { error: "算力额度不足，请升级套餐继续使用", quota_exceeded: true, plan: quota.plan });
    return;
  }

  const body = await parseBody(req) as Record<string, unknown>;
  const messages: ChatMessage[] = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
  const tools: ToolDef[] | undefined = Array.isArray(body.tools) ? (body.tools as ToolDef[]) : undefined;
  const modelOverride: string | undefined = typeof body.model === "string" ? body.model : undefined;
  const stream: boolean = body.stream !== false;

  if (!messages.length) {
    sendJson(res, 400, { error: "messages 不能为空" });
    return;
  }

  if (!stream) {
    try {
      const result = await callAiStreamWithTools(messages, tools, undefined, modelOverride);
      const model = modelOverride || "default";
      const { points, costYuan } = await calcCostPoints(db, result.usage, model);
      await logUsage(db, userId, result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0, points, costYuan, "chat_proxy", model, "proxy").catch(() => {});

      sendJson(res, 200, {
        content: result.content,
        tool_calls: result.tool_calls,
        finish_reason: result.finish_reason,
        usage: result.usage,
        quota_remaining: quota.remaining - points,
      });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return;
  }

  // SSE 流式模式
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
    const result = await callAiStreamWithTools(
      messages,
      tools,
      (delta) => writeEvent("chunk", { delta }),
      modelOverride,
      ac.signal,
    );

    const model = modelOverride || "default";
    const { points, costYuan } = await calcCostPoints(db, result.usage, model);
    await logUsage(
      db, userId,
      result.usage?.prompt_tokens || 0,
      result.usage?.completion_tokens || 0,
      points, costYuan,
      "chat_proxy", model, "proxy",
    ).catch(() => {});

    const updatedQuota = await checkQuota(db, userId);
    writeEvent("done", {
      tool_calls: result.tool_calls,
      usage: result.usage,
      quota_remaining: updatedQuota.remaining,
    });
  } catch (e) {
    writeEvent("error", { error: (e as Error).message });
  } finally {
    res.end();
  }
}

/**
 * GET /api/chat/proxy/quota — 桌面版查询云端配额
 */
export async function handleChatProxyQuota(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const userId = req.user!.userId;
  const quota = await checkQuota(db, userId);

  const { rows } = await db.query(
    "SELECT plan, quota_total, quota_used, bonus_points, plan_expires FROM opc_users WHERE id = $1",
    [userId],
  );
  const u = rows[0] as { plan: string; quota_total: number; quota_used: number; bonus_points: number; plan_expires: string } | undefined;

  sendJson(res, 200, {
    ok: quota.ok,
    remaining: quota.remaining,
    plan: quota.plan,
    quota_total: u?.quota_total || 0,
    quota_used: u?.quota_used || 0,
    bonus_points: u?.bonus_points || 0,
    plan_expires: u?.plan_expires || null,
  });
}
