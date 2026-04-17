/**
 * 反馈论坛 API
 *
 * POST   /api/feedback           — 提交反馈
 * GET    /api/feedback            — 获取反馈列表
 * POST   /api/feedback/:id/vote   — 点赞
 * POST   /api/feedback/:id/adopt  — 管理员采纳
 * POST   /api/feedback/:id/reply  — 管理员回复
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";
import { addPoints, FEEDBACK_ACCEPTED_BONUS } from "./growth-api.js";

// ── 提交反馈 ──
export async function handleCreateFeedback(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);
  const type = String(body.type || "bug");
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();

  if (!title) { sendJson(res, 400, { error: "标题不能为空" }); return; }
  if (!["bug", "feature", "improvement", "other"].includes(type)) {
    sendJson(res, 400, { error: "类型必须是 bug/feature/improvement/other" }); return;
  }

  const id = uuid();
  await db.query(
    "INSERT INTO opc_feedback (id, user_id, type, title, content) VALUES ($1, $2, $3, $4, $5)",
    [id, userId, type, title, content],
  );

  sendJson(res, 201, { id, type, title, content, status: "open" });
}

// ── 获取反馈列表 ──
export async function handleListFeedback(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const isAdmin = req.user!.role === "admin";

  const url = new URL(req.url || "/", "http://localhost");
  const status = url.searchParams.get("status") || "";
  const type = url.searchParams.get("type") || "";

  let where = "WHERE 1=1";
  const params: any[] = [];

  if (!isAdmin) {
    params.push(userId);
    where += ` AND f.user_id = $${params.length}`;
  }
  if (status) { params.push(status); where += ` AND f.status = $${params.length}`; }
  if (type) { params.push(type); where += ` AND f.type = $${params.length}`; }

  const { rows } = await db.query(
    `SELECT f.id, f.user_id, f.type, f.title, f.content, f.status, f.admin_reply,
            f.upvotes, f.reward_given, f.created_at, f.updated_at,
            u.name AS user_name, u.avatar AS user_avatar
     FROM opc_feedback f
     JOIN opc_users u ON u.id = f.user_id
     ${where}
     ORDER BY f.upvotes DESC, f.created_at DESC
     LIMIT 200`,
    params,
  );

  sendJson(res, 200, { feedbacks: rows, is_admin: isAdmin });
}

// ── 点赞 ──
export async function handleVoteFeedback(req: AuthRequest, res: ServerResponse, db: Db, feedbackId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  try {
    await db.query(
      "INSERT INTO opc_feedback_votes (user_id, feedback_id) VALUES ($1, $2)",
      [userId, feedbackId],
    );
    await db.query("UPDATE opc_feedback SET upvotes = upvotes + 1 WHERE id = $1", [feedbackId]);
    sendJson(res, 200, { success: true });
  } catch {
    sendJson(res, 400, { error: "你已经投过票了" });
  }
}

// ── 管理员采纳 ──
export async function handleAdoptFeedback(req: AuthRequest, res: ServerResponse, db: Db, feedbackId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.user!.role !== "admin") { sendJson(res, 403, { error: "仅管理员可操作" }); return; }

  const { rows } = await db.query("SELECT user_id, reward_given, status FROM opc_feedback WHERE id = $1", [feedbackId]);
  if (!rows[0]) { sendJson(res, 404, { error: "反馈不存在" }); return; }

  const fb = rows[0] as any;
  await db.query(
    "UPDATE opc_feedback SET status = 'accepted', reward_given = true, updated_at = NOW() WHERE id = $1",
    [feedbackId],
  );

  if (!fb.reward_given) {
    await addPoints(db, fb.user_id, FEEDBACK_ACCEPTED_BONUS, "feedback_accepted", `反馈被采纳: ${feedbackId}`);
  }

  sendJson(res, 200, { success: true, message: `已采纳，用户获得 ${FEEDBACK_ACCEPTED_BONUS} 积分` });
}

// ── 管理员回复 ──
export async function handleReplyFeedback(req: AuthRequest, res: ServerResponse, db: Db, feedbackId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (req.user!.role !== "admin") { sendJson(res, 403, { error: "仅管理员可操作" }); return; }

  const body = await parseBody(req);
  const reply = String(body.reply || "").trim();
  if (!reply) { sendJson(res, 400, { error: "回复内容不能为空" }); return; }

  const body_status = String(body.status || "").trim();
  const newStatus = ["open", "in_progress", "accepted", "rejected", "closed"].includes(body_status) ? body_status : undefined;

  let sql = "UPDATE opc_feedback SET admin_reply = $1, updated_at = NOW()";
  const params: any[] = [reply];
  if (newStatus) { params.push(newStatus); sql += `, status = $${params.length}`; }
  params.push(feedbackId);
  sql += ` WHERE id = $${params.length}`;

  await db.query(sql, params);
  sendJson(res, 200, { success: true });
}
