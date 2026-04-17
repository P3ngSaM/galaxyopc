/**
 * 好友系统 API — 搜索用户、发送/接受/拒绝好友申请、好友列表、删除好友
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";

export async function handleSearchUsers(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const keyword = String(body.keyword || "").trim();
  if (!keyword || keyword.length < 2) {
    sendJson(res, 400, { error: "搜索关键词至少 2 个字符" });
    return;
  }
  const userId = req.user!.userId;
  const { rows } = await db.query(
    `SELECT id, name, email, avatar FROM opc_users
     WHERE id != $1 AND status = 'active'
       AND (name ILIKE $2 OR email ILIKE $2)
     LIMIT 20`,
    [userId, `%${keyword}%`],
  );
  sendJson(res, 200, { users: rows });
}

export async function handleSendFriendRequest(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const toUserId = String(body.to_user_id || "").trim();
  const message = String(body.message || "").trim();
  const fromUserId = req.user!.userId;

  if (!toUserId) { sendJson(res, 400, { error: "缺少目标用户" }); return; }
  if (toUserId === fromUserId) { sendJson(res, 400, { error: "不能添加自己" }); return; }

  const { rows: existing } = await db.query(
    "SELECT id FROM opc_friends WHERE user_id = $1 AND friend_id = $2",
    [fromUserId, toUserId],
  );
  if (existing.length > 0) { sendJson(res, 400, { error: "已经是好友了" }); return; }

  const { rows: pendingReqs } = await db.query(
    "SELECT id FROM opc_friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'",
    [fromUserId, toUserId],
  );
  if (pendingReqs.length > 0) { sendJson(res, 400, { error: "已发送过申请，请等待对方处理" }); return; }

  // 如果对方也向我发了请求，直接互相成为好友
  const { rows: reverseReqs } = await db.query(
    "SELECT id FROM opc_friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'",
    [toUserId, fromUserId],
  );
  if (reverseReqs.length > 0) {
    await db.query("UPDATE opc_friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1", [reverseReqs[0].id]);
    await db.query("INSERT INTO opc_friends (id, user_id, friend_id) VALUES ($1,$2,$3),($4,$3,$2)", [uuid(), fromUserId, toUserId, uuid()]);
    sendJson(res, 200, { success: true, auto_accepted: true });
    return;
  }

  const id = uuid();
  await db.query(
    "INSERT INTO opc_friend_requests (id, from_user_id, to_user_id, message, status) VALUES ($1,$2,$3,$4,'pending')",
    [id, fromUserId, toUserId, message],
  );
  sendJson(res, 201, { id, status: "pending" });
}

export async function handleGetFriendRequests(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    `SELECT r.id, r.from_user_id, r.message, r.status, r.created_at,
            u.name as from_name, u.email as from_email, u.avatar as from_avatar
     FROM opc_friend_requests r
     JOIN opc_users u ON u.id = r.from_user_id
     WHERE r.to_user_id = $1
     ORDER BY r.created_at DESC LIMIT 50`,
    [userId],
  );
  sendJson(res, 200, { requests: rows });
}

export async function handleAcceptFriendRequest(req: AuthRequest, res: ServerResponse, db: Db, requestId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT from_user_id, to_user_id, status FROM opc_friend_requests WHERE id = $1",
    [requestId],
  );
  const reqRow = rows[0] as { from_user_id: string; to_user_id: string; status: string } | undefined;
  if (!reqRow || reqRow.to_user_id !== userId) { sendJson(res, 404, { error: "申请不存在" }); return; }
  if (reqRow.status !== "pending") { sendJson(res, 400, { error: "该申请已处理" }); return; }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE opc_friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1", [requestId]);
    await client.query("INSERT INTO opc_friends (id, user_id, friend_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [uuid(), userId, reqRow.from_user_id]);
    await client.query("INSERT INTO opc_friends (id, user_id, friend_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [uuid(), reqRow.from_user_id, userId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  sendJson(res, 200, { success: true });
}

export async function handleRejectFriendRequest(req: AuthRequest, res: ServerResponse, db: Db, requestId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT to_user_id, status FROM opc_friend_requests WHERE id = $1",
    [requestId],
  );
  const reqRow = rows[0] as { to_user_id: string; status: string } | undefined;
  if (!reqRow || reqRow.to_user_id !== userId) { sendJson(res, 404, { error: "申请不存在" }); return; }
  if (reqRow.status !== "pending") { sendJson(res, 400, { error: "该申请已处理" }); return; }

  await db.query("UPDATE opc_friend_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1", [requestId]);
  sendJson(res, 200, { success: true });
}

export async function handleGetFriends(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    `SELECT f.id, f.friend_id, f.alias, f.created_at,
            u.name, u.email, u.avatar
     FROM opc_friends f
     JOIN opc_users u ON u.id = f.friend_id
     WHERE f.user_id = $1 AND f.status = 'accepted'
     ORDER BY f.created_at DESC`,
    [userId],
  );
  sendJson(res, 200, { friends: rows });
}

export async function handleDeleteFriend(req: AuthRequest, res: ServerResponse, db: Db, friendshipId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT friend_id FROM opc_friends WHERE id = $1 AND user_id = $2",
    [friendshipId, userId],
  );
  if (rows.length === 0) { sendJson(res, 404, { error: "好友关系不存在" }); return; }
  const friendId = rows[0].friend_id;

  await db.query("DELETE FROM opc_friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)", [userId, friendId]);
  sendJson(res, 200, { success: true });
}

export async function handleGetPendingRequestCount(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT COUNT(*) as cnt FROM opc_friend_requests WHERE to_user_id = $1 AND status = 'pending'",
    [userId],
  );
  sendJson(res, 200, { count: Number(rows[0]?.cnt || 0) });
}
