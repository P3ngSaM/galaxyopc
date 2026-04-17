/**
 * AI 蜂群 API — SSE 流式蜂群对话 + 蜂群会话查询
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";
import { runSwarm } from "../chat/swarm-engine.js";
import { getModel } from "../chat/ai-client.js";
import { checkQuota, calcCostPoints, logUsage } from "../chat/chat-service.js";

const activeSwarms = new Map<string, boolean>();
const IS_LOCAL = process.env.LOCAL_MODE === "true" || process.env.OPC_LOCAL_MODE === "1";
const MAX_SWARM_PER_USER = IS_LOCAL ? Infinity : 3;

async function getUserSwarmUsage(db: Db, userId: string): Promise<number> {
  const { rows: countRows } = await db.query(
    "SELECT COUNT(*) AS cnt FROM opc_swarm_sessions WHERE user_id = $1",
    [userId],
  );
  const totalCount = Number((countRows[0] as any)?.cnt || 0);

  const { rows: userRows } = await db.query(
    "SELECT swarm_reset_baseline FROM opc_users WHERE id = $1",
    [userId],
  );
  const baseline = Number((userRows[0] as any)?.swarm_reset_baseline || 0);

  return Math.max(0, totalCount - baseline);
}

export async function handleSwarmStream(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
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
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { clientDisconnected = true; ac.abort(); }
  };

  try {
    const body = await parseBody(req);
    const companyId = String(body.company_id || "").trim();
    let conversationId = String(body.conversation_id || "").trim();
    const userMessage = String(body.message || "").trim();
    const userId = req.user!.userId;

    if (!userMessage) {
      writeEvent("error", { error: "消息不能为空" });
      res.end();
      return;
    }

    // 配额检查
    const quota = await checkQuota(db, userId);
    if (!quota.ok) {
      writeEvent("error", { error: "算力额度不足，请升级套餐继续使用", quota_exceeded: true, plan: quota.plan });
      res.end();
      return;
    }

    // 龙宫使用次数限制
    const swarmCount = await getUserSwarmUsage(db, userId);
    if (swarmCount >= MAX_SWARM_PER_USER) {
      writeEvent("error", { error: `龙宫模式每个账户限用 ${MAX_SWARM_PER_USER} 次，您已使用 ${swarmCount} 次。升级套餐可获得更多次数。` });
      res.end();
      return;
    }

    // Per-user 并发守卫
    if (activeSwarms.get(userId)) {
      writeEvent("error", { error: "已有蜂群任务执行中，请稍候" });
      res.end();
      return;
    }
    activeSwarms.set(userId, true);

    // SSE 心跳，防止代理/浏览器断开长连接
    const heartbeat = setInterval(() => {
      if (clientDisconnected) { clearInterval(heartbeat); return; }
      try { res.write(": heartbeat\n\n"); } catch { clientDisconnected = true; }
    }, 15000);

    // 累计 token 用量
    let swarmTokensIn = 0, swarmTokensOut = 0;

    try {

    if (companyId) {
      const { rows: accessRows } = await db.query(
        "SELECT 1 FROM opc_user_companies WHERE user_id = $1 AND company_id = $2",
        [userId, companyId],
      );
      if (!accessRows[0]) {
        writeEvent("error", { error: "无权访问该公司" });
        clearInterval(heartbeat);
        activeSwarms.delete(userId);
        res.end();
        return;
      }
    }

    if (!conversationId) {
      conversationId = uuid();
      const title = `[龙宫] ${userMessage.slice(0, 25)}...`;
      await db.query(
        "INSERT INTO opc_chat_conversations (id, user_id, company_id, title, created_at, updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())",
        [conversationId, userId, companyId || '', title],
      );
    }

    await db.query(
      "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at) VALUES ($1,$2,$3,$4,'user',$5,NOW())",
      [uuid(), userId, companyId || '', conversationId, userMessage],
    );

    const { rows: userRows } = await db.query("SELECT selected_model FROM opc_users WHERE id = $1", [userId]);
    const userModel = userRows[0]?.selected_model || getModel();

    writeEvent("meta", { conversation_id: conversationId, mode: "swarm" });

    await runSwarm(db, userId, companyId, conversationId, userMessage, userModel, {
      onPlanStart: () => {
        writeEvent("swarm_planning", { message: "正在分析任务需求..." });
      },
      onPlanReady: (plan, agents) => {
        writeEvent("swarm_plan", {
          mode: plan.mode,
          reasoning: plan.reasoning,
          agents: plan.agents.map((a, i) => ({
            role: a.role,
            role_name: agents[i]?.role_name || a.role,
            task: a.task,
            model: a.model || '',
          })),
        });
      },
      onAgentStart: (role, roleName, task, model) => {
        writeEvent("agent_start", { role, role_name: roleName, task, model: model || '' });
      },
      onAgentChunk: (role, delta) => {
        writeEvent("agent_chunk", { role, delta });
      },
      onAgentDone: (role, output) => {
        writeEvent("agent_done", { role, output_preview: output.slice(0, 200) });
      },
      onSummaryChunk: (delta) => {
        writeEvent("summary_chunk", { delta });
      },
      onReviewStart: () => {
        writeEvent("review_start", { message: "审计专家正在审核各位专家的输出质量..." });
      },
      onDone: async (summary, swarmSessionId) => {
        await db.query(
          "INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at) VALUES ($1,$2,$3,$4,'assistant',$5,NOW())",
          [uuid(), userId, companyId || '', conversationId, summary],
        );

        // 龙宫用量计费
        const { points: costPts, costYuan } = await calcCostPoints(
          db,
          { prompt_tokens: swarmTokensIn, completion_tokens: swarmTokensOut, total_tokens: swarmTokensIn + swarmTokensOut },
          userModel,
        );
        await logUsage(db, userId, swarmTokensIn, swarmTokensOut, costPts, costYuan, "swarm", userModel, conversationId).catch(() => {});

        const updatedQuota = await checkQuota(db, userId);
        writeEvent("done", { swarm_session_id: swarmSessionId, usage: { tokens_in: swarmTokensIn, tokens_out: swarmTokensOut, cost_points: costPts, remaining: updatedQuota.remaining } });
        if (!clientDisconnected) res.end();
      },
      onAgentReview: (role, score, feedback) => {
        writeEvent("agent_review", { role, score, feedback });
      },
      onAgentRevise: (role, roleName) => {
        writeEvent("agent_revise", { role, role_name: roleName, message: "协调者要求修订输出" });
      },
      onAuditEntry: (entry) => {
        swarmTokensIn += entry.tokens_in || 0;
        swarmTokensOut += entry.tokens_out || 0;
        writeEvent("audit_entry", entry);
      },
      onError: (error) => {
        writeEvent("error", { error });
        if (!clientDisconnected) res.end();
      },
    }, ac.signal);

    } finally {
      clearInterval(heartbeat);
      activeSwarms.delete(userId);
    }
  } catch (e) {
    writeEvent("error", { error: (e as Error).message || "蜂群模式出错" });
    if (!clientDisconnected) res.end();
  }
}

export async function handleGetSwarmQuota(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  if (IS_LOCAL) {
    sendJson(res, 200, { used: 0, max: 999999, remaining: 999999, unlimited: true });
    return;
  }
  const used = await getUserSwarmUsage(db, userId);
  sendJson(res, 200, { used, max: MAX_SWARM_PER_USER, remaining: Math.max(0, MAX_SWARM_PER_USER - used) });
}

export async function handleGetSwarmSessions(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT * FROM opc_swarm_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
    [userId],
  );
  sendJson(res, 200, { sessions: rows });
}

export async function handleGetSwarmTurns(req: AuthRequest, res: ServerResponse, db: Db, sessionId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: sessionRows } = await db.query(
    "SELECT * FROM opc_swarm_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (sessionRows.length === 0) {
    sendJson(res, 404, { error: "蜂群会话不存在" });
    return;
  }

  const { rows: turns } = await db.query(
    "SELECT * FROM opc_swarm_turns WHERE swarm_session_id = $1 ORDER BY sequence ASC",
    [sessionId],
  );
  sendJson(res, 200, { session: sessionRows[0], turns });
}

export async function handleGetSwarmAudit(req: AuthRequest, res: ServerResponse, db: Db, sessionId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: sessionRows } = await db.query(
    "SELECT * FROM opc_swarm_sessions WHERE id = $1 AND user_id = $2",
    [sessionId, userId],
  );
  if (sessionRows.length === 0) {
    sendJson(res, 404, { error: "蜂群会话不存在" });
    return;
  }

  const { rows: audit } = await db.query(
    "SELECT * FROM opc_swarm_audit_log WHERE swarm_session_id = $1 ORDER BY created_at ASC",
    [sessionId],
  );
  sendJson(res, 200, { session: sessionRows[0], audit });
}
