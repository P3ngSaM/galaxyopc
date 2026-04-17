/**
 * Agent 对话引擎 — 指令式多轮自动对话
 *
 * 用户通过 @Agent 发出指令/议题，两个（或多个）Agent 自动进行多轮对话，
 * 到达轮次上限或检测到收敛后自动结束并生成总结。
 *
 * 信息隔离：每个 Agent 只能看到其主人授权范围（share_scope）内的公司信息。
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import type { ChatMessage } from "../chat/ai-client.js";
import { callAi, callAiStreamWithTools, getModel } from "../chat/ai-client.js";
import { requireAuth, parseBody } from "../auth/middleware.js";

// ── Types ─────────────────────────────────────────────────────────────

interface RoomMember {
  user_id: string;
  company_id: string;
  agent_role: string;
  share_scope: unknown;
  name: string;
}

interface DialogueSession {
  id: string;
  room_id: string;
  initiator_id: string;
  topic: string;
  max_turns: number;
  current_turn: number;
  status: string;
}

// ── Scoped Context Builder ────────────────────────────────────────────

async function buildScopedContext(db: Db, companyId: string, shareScope: string[], userId?: string): Promise<string> {
  if (!companyId && !userId) return "（未关联公司）";
  const sections: string[] = [];

  if (shareScope.includes("basic_info") && companyId) {
    const { rows } = await db.query(
      "SELECT name, industry, status, description FROM opc_companies WHERE id = $1",
      [companyId],
    );
    const c = rows[0];
    if (c) sections.push(`公司：${c.name} | 行业：${c.industry || "未设置"} | 状态：${c.status}\n简介：${c.description || "暂无"}`);
  }
  if (shareScope.includes("finance_summary") && companyId) {
    const { rows } = await db.query(
      "SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id = $1 GROUP BY type",
      [companyId],
    );
    let income = 0, expense = 0;
    for (const r of rows) { if (r.type === "income") income = Number(r.total); else expense = Number(r.total); }
    sections.push(`财务概况：总收入约 ${Math.round(income / 1000)}k，总支出约 ${Math.round(expense / 1000)}k`);
  }
  if (shareScope.includes("projects") && companyId) {
    const { rows } = await db.query("SELECT name, status FROM opc_projects WHERE company_id = $1 LIMIT 10", [companyId]);
    if (rows.length > 0) sections.push("项目：" + rows.map((r: any) => `${r.name}(${r.status})`).join("、"));
  }
  if (shareScope.includes("contacts") && companyId) {
    const { rows } = await db.query("SELECT pipeline_stage, COUNT(*) as cnt FROM opc_contacts WHERE company_id = $1 GROUP BY pipeline_stage", [companyId]);
    if (rows.length > 0) sections.push("客户：" + rows.map((r: any) => `${r.pipeline_stage}: ${r.cnt}人`).join("、"));
  }
  if (shareScope.includes("capabilities") && companyId) {
    const { rows } = await db.query("SELECT role_name FROM opc_staff_config WHERE company_id = $1 AND enabled = 1", [companyId]);
    if (rows.length > 0) sections.push("团队能力：" + rows.map((r: any) => r.role_name).join("、"));
  }
  if (shareScope.includes("employees") && companyId) {
    const { rows } = await db.query("SELECT COUNT(*) as cnt, department FROM opc_employees WHERE company_id = $1 AND status = 'active' GROUP BY department LIMIT 10", [companyId]);
    if (rows.length > 0) {
      const total = rows.reduce((s: number, r: any) => s + Number(r.cnt), 0);
      sections.push(`团队规模：${total}人，分布在 ${rows.map((r: any) => r.department || "综合").join("、")}`);
    }
  }
  if (shareScope.includes("schedule") && userId) {
    const today = new Date().toISOString().slice(0, 10);
    const weekLater = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const { rows } = await db.query(
      "SELECT title, date, start_time, end_time, location, category FROM opc_schedules WHERE user_id = $1 AND date BETWEEN $2 AND $3 AND status = 'scheduled' ORDER BY date, start_time LIMIT 20",
      [userId, today, weekLater],
    );
    if (rows.length > 0) {
      const items = rows.map((r: any) => {
        const time = r.start_time ? `${r.start_time}${r.end_time ? "-" + r.end_time : ""}` : "全天";
        return `${r.date.slice(5)} ${time} ${r.title}${r.location ? "(" + r.location + ")" : ""}`;
      });
      sections.push("近期日程：" + items.join("、"));
    }
  }
  return sections.length > 0 ? sections.join("\n") : "（公司信息有限）";
}

function parseScope(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  try { return JSON.parse(String(raw)); } catch { return ["basic_info"]; }
}

// ── Single Agent Reply (used for plain chat, non-dialogue) ────────────

export async function runAgentReply(db: Db, params: {
  roomId: string; senderUserId: string; senderContent: string;
  responderUserId: string; responderCompanyId: string; responderAgentRole: string;
  responderShareScope: unknown; responderUserName: string;
}): Promise<string> {
  const scope = parseScope(params.responderShareScope);
  const scopedContext = await buildScopedContext(db, params.responderCompanyId, scope, params.responderUserId);
  const { rows: recentMsgs } = await db.query(
    `SELECT sender_user_id, content, msg_type FROM opc_agent_messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [params.roomId],
  );
  const { rows: senderRows } = await db.query("SELECT name FROM opc_users WHERE id = $1", [params.senderUserId]);
  const senderName = senderRows[0]?.name || "对方";
  const { rows: userRows } = await db.query("SELECT selected_model FROM opc_users WHERE id = $1", [params.responderUserId]);
  const userModel = userRows[0]?.selected_model || getModel();

  const systemPrompt = `你是 ${params.responderUserName} 的 AI 代理（${params.responderAgentRole}角色）。
你代表 ${params.responderUserName} 与其他用户的 Agent 交流。

你的主人的公司信息（仅以下是你被授权透露的内容）：
${scopedContext}

对话规则：
- 你代表 ${params.responderUserName} 的立场和利益
- 只能透露上述授权范围内的信息，绝不泄露更多细节
- 超出授权范围的信息，礼貌地说"这个需要跟我的主人确认后才能回复"
- 专业但友好的商务交流态度
- 简洁回复，像真人对话
- 用中文回复`;

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const msg of recentMsgs.reverse()) {
    if (msg.msg_type === "system") continue;
    messages.push({ role: msg.sender_user_id === params.responderUserId ? "assistant" : "user", content: msg.content });
  }
  if (messages.length === 1 || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: `${senderName} 说：${params.senderContent}` });
  }
  const resp = await callAi(messages, undefined, userModel);
  return resp.content;
}

// ── Multi-Turn Dialogue Engine (SSE) ──────────────────────────────────

// Active sessions tracked in memory for stop control
const _activeSessions = new Map<string, { stopped: boolean }>();

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function runDialogueTurn(
  db: Db,
  session: DialogueSession,
  speaker: RoomMember,
  listener: RoomMember,
  topic: string,
  turnNumber: number,
  maxTurns: number,
  onChunk?: (chunk: string) => void,
  cachedContext?: string,
  cachedModel?: string,
): Promise<{ content: string; wantsToEnd: boolean }> {
  const scopedContext = cachedContext ?? await buildScopedContext(db, speaker.company_id, parseScope(speaker.share_scope), speaker.user_id);

  const { rows: recentMsgs } = await db.query(
    `SELECT sender_user_id, content, msg_type FROM opc_agent_messages
     WHERE room_id = $1 AND msg_type != 'system'
     ORDER BY created_at DESC LIMIT 30`,
    [session.room_id],
  );

  const model = cachedModel || getModel();

  const systemPrompt = `你是 ${speaker.name} 的 AI 代理（${speaker.agent_role}角色）。

你正在与 ${listener.name} 的 Agent 进行一场商务对话。
讨论议题：${topic}
当前是第 ${turnNumber}/${maxTurns} 轮对话。

你的主人的公司信息（仅授权范围内）：
${scopedContext}

对话规则：
- 代表 ${speaker.name} 的立场和利益
- 只透露授权范围内的信息
- 每轮推进对话，不要原地踏步或重复之前说过的话
- 如果双方已经达成共识或没有更多可讨论的，在回复末尾单独一行写 [CONSENSUS]
- 简洁有力，像真人商务交流
- 用中文回复`;

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const msg of recentMsgs.reverse()) {
    if (msg.msg_type === "system") continue;
    messages.push({
      role: msg.sender_user_id === speaker.user_id ? "assistant" : "user",
      content: msg.content,
    });
  }
  if (messages.length === 1 || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: `请围绕「${topic}」继续对话。` });
  }

  const result = await callAiStreamWithTools(messages, undefined, onChunk, model);
  const content = result.content;
  const wantsToEnd = content.includes("[CONSENSUS]");
  const cleanContent = content.replace(/\[CONSENSUS\]/g, "").trim();

  return { content: cleanContent, wantsToEnd };
}

async function generateSummary(
  db: Db,
  session: DialogueSession,
  members: RoomMember[],
): Promise<string> {
  const { rows: msgs } = await db.query(
    `SELECT m.sender_user_id, m.content, u.name as sender_name
     FROM opc_agent_messages m
     JOIN opc_users u ON u.id = m.sender_user_id
     WHERE m.room_id = $1 AND m.msg_type = 'agent'
     ORDER BY m.created_at ASC LIMIT 60`,
    [session.room_id],
  );

  const dialogueText = msgs
    .map((m: any) => `${m.sender_name}: ${m.content}`)
    .join("\n\n");

  const summaryPrompt: ChatMessage[] = [
    {
      role: "system",
      content: `你是一个商务对话总结专家。请对以下两方 Agent 的对话进行精炼总结。
议题：${session.topic}
总共进行了 ${session.current_turn} 轮对话。

输出格式：
1. **议题回顾**：一句话概括
2. **关键结论**：双方达成了哪些共识
3. **待跟进事项**：还有哪些需要人工确认或后续推进的
4. **建议**：给发起者的一句话建议

用中文回复，简洁精炼。`,
    },
    { role: "user", content: dialogueText },
  ];

  const resp = await callAi(summaryPrompt);
  return resp.content;
}

/**
 * SSE handler: POST /api/agent-rooms/:id/dialogue
 * Body: { topic, max_turns? }
 *
 * Streams events: session_start, turn_start, turn_done, summary, session_end
 */
export async function handleStartDialogue(
  req: AuthRequest, res: ServerResponse, db: Db, roomId: string,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const topic = String(body.topic || "").trim();
  const maxTurns = Math.min(Math.max(Number(body.max_turns) || 10, 2), 30);
  const userId = req.user!.userId;

  if (!topic) { res.writeHead(400); res.end(JSON.stringify({ error: "请输入对话议题" })); return; }

  // Check membership
  const { rows: memberCheck } = await db.query(
    "SELECT 1 FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'accepted'",
    [roomId, userId],
  );
  if (memberCheck.length === 0) { res.writeHead(403); res.end(JSON.stringify({ error: "你不是该房间成员" })); return; }

  // Check no running session
  const { rows: running } = await db.query(
    "SELECT id FROM opc_agent_dialogue_sessions WHERE room_id = $1 AND status = 'running'",
    [roomId],
  );
  if (running.length > 0) { res.writeHead(409); res.end(JSON.stringify({ error: "该房间已有正在进行的对话，请先结束" })); return; }

  // Get configured members (exclude initiator)
  const { rows: allMembers } = await db.query(
    `SELECT m.user_id, m.company_id, m.agent_role, m.share_scope, u.name
     FROM opc_agent_room_members m
     JOIN opc_users u ON u.id = m.user_id
     WHERE m.room_id = $1 AND m.status = 'accepted' AND m.company_id != '' AND m.agent_role != ''`,
    [roomId],
  );

  const otherAgents = allMembers.filter((m: any) => m.user_id !== userId) as RoomMember[];
  const myAgent = allMembers.find((m: any) => m.user_id === userId) as RoomMember | undefined;

  if (!myAgent) { res.writeHead(400); res.end(JSON.stringify({ error: "你的 Agent 未配置，请先在设置中关联公司" })); return; }
  if (otherAgents.length === 0) { res.writeHead(400); res.end(JSON.stringify({ error: "房间内没有其他已配置的 Agent" })); return; }

  // Create session
  const sessionId = uuid();
  await db.query(
    "INSERT INTO opc_agent_dialogue_sessions (id, room_id, initiator_id, topic, max_turns) VALUES ($1,$2,$3,$4,$5)",
    [sessionId, roomId, userId, topic, maxTurns],
  );

  // System message
  await db.query(
    "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,'system',$4,'system')",
    [uuid(), roomId, userId, `📋 对话开始 — 议题：${topic}（最多 ${maxTurns} 轮）`],
  );

  // SSE setup
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const session: DialogueSession = {
    id: sessionId, room_id: roomId, initiator_id: userId,
    topic, max_turns: maxTurns, current_turn: 0, status: "running",
  };

  const ctrl = { stopped: false };
  _activeSessions.set(sessionId, ctrl);

  sseWrite(res, "session_start", {
    session_id: sessionId,
    topic,
    max_turns: maxTurns,
    agents: [myAgent, ...otherAgents].map((a) => ({ name: a.name, role: a.agent_role, user_id: a.user_id })),
  });

  // For DM: alternate between myAgent and otherAgents[0]
  // For group: round-robin among otherAgents, with myAgent interspersed
  const speakers = otherAgents.length === 1
    ? [myAgent, otherAgents[0]]
    : [myAgent, ...otherAgents];

  // Pre-build scoped context + model for all speakers (avoid repeated DB queries per turn)
  const scopeCache = new Map<string, string>();
  const modelCache = new Map<string, string>();
  for (const s of speakers) {
    const sc = parseScope(s.share_scope);
    scopeCache.set(s.user_id, await buildScopedContext(db, s.company_id, sc, s.user_id));
    const { rows: uRows } = await db.query("SELECT selected_model FROM opc_users WHERE id = $1", [s.user_id]);
    modelCache.set(s.user_id, uRows[0]?.selected_model || getModel());
  }

  let lastSpeakerIdx = -1;
  let consensusReached = false;

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (ctrl.stopped) break;

      // Pick next speaker (round-robin, skip same speaker twice)
      lastSpeakerIdx = (lastSpeakerIdx + 1) % speakers.length;
      const speaker = speakers[lastSpeakerIdx];
      const listener = speakers[(lastSpeakerIdx + 1) % speakers.length];

      session.current_turn = turn;
      await db.query(
        "UPDATE opc_agent_dialogue_sessions SET current_turn = $1 WHERE id = $2",
        [turn, sessionId],
      );

      sseWrite(res, "turn_start", {
        turn, max_turns: maxTurns,
        speaker: { name: speaker.name, role: speaker.agent_role, user_id: speaker.user_id },
      });

      const result = await runDialogueTurn(
        db, session, speaker, listener, topic, turn, maxTurns,
        (chunk: string) => {
          sseWrite(res, "turn_chunk", { turn, chunk });
        },
        scopeCache.get(speaker.user_id),
        modelCache.get(speaker.user_id),
      );

      // Save to DB
      const msgId = uuid();
      await db.query(
        "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,$4,$5,'agent')",
        [msgId, roomId, speaker.user_id, speaker.agent_role, result.content],
      );

      sseWrite(res, "turn_done", {
        turn, max_turns: maxTurns,
        speaker: { name: speaker.name, role: speaker.agent_role, user_id: speaker.user_id },
        message_id: msgId,
      });

      if (result.wantsToEnd) {
        consensusReached = true;
        break;
      }
    }

    // Generate summary
    sseWrite(res, "summarizing", { message: "正在生成对话总结..." });
    const summary = await generateSummary(db, session, speakers);

    await db.query(
      "UPDATE opc_agent_dialogue_sessions SET status = $1, summary = $2, finished_at = NOW() WHERE id = $3",
      [consensusReached ? "consensus" : (ctrl.stopped ? "stopped" : "completed"), summary, sessionId],
    );
    await db.query(
      "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,'system',$4,'system')",
      [uuid(), roomId, userId, `📊 对话总结\n\n${summary}`],
    );

    sseWrite(res, "summary", { summary });
    sseWrite(res, "session_end", {
      session_id: sessionId,
      reason: consensusReached ? "consensus" : (ctrl.stopped ? "stopped" : "max_turns"),
      total_turns: session.current_turn,
    });
  } catch (e: any) {
    console.error("[Dialogue Engine Error]", e);
    await db.query(
      "UPDATE opc_agent_dialogue_sessions SET status = 'error', finished_at = NOW() WHERE id = $1",
      [sessionId],
    );
    sseWrite(res, "error", { message: e.message || "对话引擎出错" });
  } finally {
    _activeSessions.delete(sessionId);
    res.end();
  }
}

/**
 * POST /api/agent-rooms/:id/dialogue/stop
 */
export async function handleStopDialogue(
  req: AuthRequest, res: ServerResponse, db: Db, roomId: string,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    "SELECT id FROM opc_agent_dialogue_sessions WHERE room_id = $1 AND status = 'running'",
    [roomId],
  );
  if (rows.length === 0) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "没有正在进行的对话" }));
    return;
  }
  const sessionId = rows[0].id;
  const ctrl = _activeSessions.get(sessionId);
  if (ctrl) ctrl.stopped = true;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, session_id: sessionId }));
}

/**
 * GET /api/agent-rooms/:id/dialogue/history
 */
export async function handleGetDialogueHistory(
  req: AuthRequest, res: ServerResponse, db: Db, roomId: string,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    `SELECT id, topic, max_turns, current_turn, status, summary, created_at, finished_at
     FROM opc_agent_dialogue_sessions WHERE room_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [roomId],
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ sessions: rows }));
}
