/**
 * Agent 社交房间 API — 创建房间、邀请成员、消息列表、Agent 对话
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";
import { runAgentReply } from "./agent-dialogue.js";

export async function handleListRooms(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.type, r.status, r.created_at,
       (SELECT COUNT(*) FROM opc_agent_room_members WHERE room_id = r.id AND status = 'accepted') as member_count,
       (SELECT content FROM opc_agent_messages WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1) as last_message
     FROM opc_agent_rooms r
     JOIN opc_agent_room_members m ON m.room_id = r.id
     WHERE m.user_id = $1 AND m.status = 'accepted' AND r.status = 'active'
     ORDER BY r.created_at DESC`,
    [userId],
  );
  const { rows: pendingRows } = await db.query(
    "SELECT COUNT(*) as cnt FROM opc_agent_room_members WHERE user_id = $1 AND status = 'pending'",
    [userId],
  );
  sendJson(res, 200, { rooms: rows, pending_count: Number(pendingRows[0]?.cnt || 0) });
}

export async function handleCreateRoom(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const name = String(body.name || "").trim();
  const type = body.type === "group" ? "group" : "dm";
  const companyId = String(body.company_id || "").trim();
  const agentRole = String(body.agent_role || "assistant").trim();
  const inviteFriendId = String(body.invite_friend_id || "").trim();
  const userId = req.user!.userId;

  if (type === "dm" && !inviteFriendId) {
    sendJson(res, 400, { error: "私聊必须指定对方用户" });
    return;
  }

  // DM 不重复创建
  if (type === "dm" && inviteFriendId) {
    const { rows: existingDm } = await db.query(
      `SELECT r.id FROM opc_agent_rooms r
       WHERE r.type = 'dm' AND r.status = 'active'
         AND EXISTS (SELECT 1 FROM opc_agent_room_members WHERE room_id = r.id AND user_id = $1)
         AND EXISTS (SELECT 1 FROM opc_agent_room_members WHERE room_id = r.id AND user_id = $2)`,
      [userId, inviteFriendId],
    );
    if (existingDm.length > 0) {
      sendJson(res, 200, { room_id: existingDm[0].id, existing: true });
      return;
    }
  }

  const roomId = uuid();
  const roomName = name || (type === "dm" ? "私聊" : "Agent 群聊");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO opc_agent_rooms (id, name, type, creator_id) VALUES ($1,$2,$3,$4)",
      [roomId, roomName, type, userId],
    );
    await client.query(
      "INSERT INTO opc_agent_room_members (id, room_id, user_id, company_id, agent_role, status) VALUES ($1,$2,$3,$4,$5,'accepted')",
      [uuid(), roomId, userId, companyId, agentRole],
    );
    if (inviteFriendId) {
      // 被邀请方：pending 状态，需要对方确认并自选公司
      await client.query(
        "INSERT INTO opc_agent_room_members (id, room_id, user_id, company_id, agent_role, status) VALUES ($1,$2,$3,'','','pending')",
        [uuid(), roomId, inviteFriendId],
      );
    }
    // 系统消息
    await client.query(
      "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,'system',$4,'system')",
      [uuid(), roomId, userId, `房间已创建`],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  sendJson(res, 201, { room_id: roomId });
}

export async function handleGetRoom(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: memberCheck } = await db.query(
    "SELECT 1 FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'accepted'",
    [roomId, userId],
  );
  if (memberCheck.length === 0) { sendJson(res, 403, { error: "你不是该房间成员" }); return; }

  const { rows: roomRows } = await db.query("SELECT * FROM opc_agent_rooms WHERE id = $1", [roomId]);
  if (roomRows.length === 0) { sendJson(res, 404, { error: "房间不存在" }); return; }

  const { rows: members } = await db.query(
    `SELECT m.user_id, m.company_id, m.agent_role, m.share_scope, m.joined_at, m.status as member_status,
            u.name, u.email, u.avatar,
            c.name as company_name
     FROM opc_agent_room_members m
     JOIN opc_users u ON u.id = m.user_id
     LEFT JOIN opc_companies c ON c.id = m.company_id
     WHERE m.room_id = $1 AND m.status = 'accepted'`,
    [roomId],
  );

  // 返回待接受邀请的用户名
  const { rows: pendingMembers } = await db.query(
    `SELECT u.name FROM opc_agent_room_members m JOIN opc_users u ON u.id = m.user_id WHERE m.room_id = $1 AND m.status = 'pending'`,
    [roomId],
  );

  sendJson(res, 200, { room: roomRows[0], members, pending_members: pendingMembers });
}

export async function handleInviteToRoom(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const inviteUserId = String(body.user_id || "").trim();
  const userId = req.user!.userId;

  if (!inviteUserId) { sendJson(res, 400, { error: "缺少邀请用户" }); return; }

  const { rows: memberCheck } = await db.query(
    "SELECT 1 FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'accepted'",
    [roomId, userId],
  );
  if (memberCheck.length === 0) { sendJson(res, 403, { error: "你不是该房间成员" }); return; }

  const { rows: roomRows } = await db.query("SELECT type FROM opc_agent_rooms WHERE id = $1", [roomId]);
  if (roomRows[0]?.type === "dm") { sendJson(res, 400, { error: "私聊房间不能邀请更多人" }); return; }

  const { rows: alreadyIn } = await db.query(
    "SELECT 1 FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2",
    [roomId, inviteUserId],
  );
  if (alreadyIn.length > 0) { sendJson(res, 400, { error: "该用户已在房间中" }); return; }

  await db.query(
    "INSERT INTO opc_agent_room_members (id, room_id, user_id) VALUES ($1,$2,$3)",
    [uuid(), roomId, inviteUserId],
  );

  const { rows: invitee } = await db.query("SELECT name FROM opc_users WHERE id = $1", [inviteUserId]);
  await db.query(
    "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,'system',$4,'system')",
    [uuid(), roomId, userId, `${invitee[0]?.name || "用户"} 加入了房间`],
  );

  sendJson(res, 200, { success: true });
}

export async function handleRemoveFromRoom(req: AuthRequest, res: ServerResponse, db: Db, roomId: string, targetUserId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: roomRows } = await db.query("SELECT creator_id FROM opc_agent_rooms WHERE id = $1", [roomId]);
  if (roomRows[0]?.creator_id !== userId && targetUserId !== userId) {
    sendJson(res, 403, { error: "只有房间创建者可以移除成员" });
    return;
  }

  await db.query("DELETE FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2", [roomId, targetUserId]);
  sendJson(res, 200, { success: true });
}

export async function handleGetRoomMessages(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: memberCheck } = await db.query(
    "SELECT 1 FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'accepted'",
    [roomId, userId],
  );
  if (memberCheck.length === 0) { sendJson(res, 403, { error: "你不是该房间成员" }); return; }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const before = url.searchParams.get("before") || "";

  let query = `SELECT m.id, m.sender_user_id, m.sender_agent_role, m.content, m.msg_type, m.reply_to, m.created_at,
                      u.name as sender_name, u.avatar as sender_avatar
               FROM opc_agent_messages m
               JOIN opc_users u ON u.id = m.sender_user_id
               WHERE m.room_id = $1`;
  const params: unknown[] = [roomId];

  if (before) {
    query += ` AND m.created_at < $2`;
    params.push(before);
  }
  query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await db.query(query, params);
  sendJson(res, 200, { messages: rows.reverse() });
}

export async function handleSendRoomMessage(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const content = String(body.content || "").trim();
  const userId = req.user!.userId;

  if (!content) { sendJson(res, 400, { error: "消息不能为空" }); return; }

  const { rows: memberRows } = await db.query(
    "SELECT company_id, agent_role FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'accepted'",
    [roomId, userId],
  );
  if (memberRows.length === 0) { sendJson(res, 403, { error: "你不是该房间成员" }); return; }

  // 用户发出的消息（以 Agent 身份）
  const myMember = memberRows[0] as { company_id: string; agent_role: string };
  const userMsgId = uuid();
  await db.query(
    "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,$4,$5,'agent')",
    [userMsgId, roomId, userId, myMember.agent_role, content],
  );

  // Plain message: just save it. Agent auto-replies are now handled by the dialogue engine.
  sendJson(res, 200, { message_id: userMsgId, replies: [] });
}

export async function handleDeleteRoom(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: roomRows } = await db.query("SELECT creator_id FROM opc_agent_rooms WHERE id = $1 AND status = 'active'", [roomId]);
  if (roomRows.length === 0) { sendJson(res, 404, { error: "房间不存在" }); return; }

  const { rows: memberCheck } = await db.query(
    "SELECT 1 FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'accepted'",
    [roomId, userId],
  );
  if (memberCheck.length === 0) { sendJson(res, 403, { error: "你不是该房间成员" }); return; }

  // 只有创建者可以删除
  if (roomRows[0].creator_id !== userId) {
    sendJson(res, 403, { error: "只有房间创建者可以删除对话" });
    return;
  }

  await db.query("UPDATE opc_agent_rooms SET status = 'archived' WHERE id = $1", [roomId]);
  sendJson(res, 200, { success: true });
}

export async function handleUpdateShareScope(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const shareScope = body.share_scope;
  const companyId = String(body.company_id || "").trim();
  const agentRole = String(body.agent_role || "").trim();
  const userId = req.user!.userId;

  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (shareScope !== undefined) {
    updates.push(`share_scope = $${idx++}`);
    params.push(JSON.stringify(shareScope));
  }
  if (companyId) {
    updates.push(`company_id = $${idx++}`);
    params.push(companyId);
  }
  if (agentRole) {
    updates.push(`agent_role = $${idx++}`);
    params.push(agentRole);
  }

  if (updates.length === 0) { sendJson(res, 400, { error: "没有要更新的内容" }); return; }

  params.push(roomId, userId);
  await db.query(
    `UPDATE opc_agent_room_members SET ${updates.join(", ")} WHERE room_id = $${idx++} AND user_id = $${idx}`,
    params,
  );
  sendJson(res, 200, { success: true });
}

// ─── 邀请制入会 ─────────────────────────────────────────────────────

export async function handleGetMyInvites(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    `SELECT r.id as room_id, r.name as room_name, r.created_at,
            creator.name as inviter_name, creator.avatar as inviter_avatar,
            cc.name as inviter_company_name
     FROM opc_agent_room_members m
     JOIN opc_agent_rooms r ON r.id = m.room_id
     JOIN opc_users creator ON creator.id = r.creator_id
     LEFT JOIN opc_agent_room_members cm ON cm.room_id = r.id AND cm.user_id = r.creator_id
     LEFT JOIN opc_companies cc ON cc.id = cm.company_id
     WHERE m.user_id = $1 AND m.status = 'pending' AND r.status = 'active'
     ORDER BY m.joined_at DESC`,
    [userId],
  );
  sendJson(res, 200, { invites: rows });
}

export async function handleAcceptInvite(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const companyId = String(body.company_id || "").trim();
  const agentRole = String(body.agent_role || "assistant").trim();
  const userId = req.user!.userId;

  const { rows: memberRows } = await db.query(
    "SELECT id FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'pending'",
    [roomId, userId],
  );
  if (memberRows.length === 0) { sendJson(res, 404, { error: "没有找到待处理的邀请" }); return; }

  await db.query(
    "UPDATE opc_agent_room_members SET status = 'accepted', company_id = $1, agent_role = $2 WHERE room_id = $3 AND user_id = $4",
    [companyId, agentRole || "assistant", roomId, userId],
  );

  const { rows: userRows } = await db.query("SELECT name FROM opc_users WHERE id = $1", [userId]);
  const userName = userRows[0]?.name || "用户";
  await db.query(
    "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,'system',$4,'system')",
    [uuid(), roomId, userId, `${userName} 接受邀请并加入了对话`],
  );

  sendJson(res, 200, { success: true });
}

export async function handleRejectInvite(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: memberRows } = await db.query(
    "SELECT id FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'pending'",
    [roomId, userId],
  );
  if (memberRows.length === 0) { sendJson(res, 404, { error: "没有找到待处理的邀请" }); return; }

  await db.query("DELETE FROM opc_agent_room_members WHERE room_id = $1 AND user_id = $2 AND status = 'pending'", [roomId, userId]);

  const { rows: userRows } = await db.query("SELECT name FROM opc_users WHERE id = $1", [userId]);
  const userName = userRows[0]?.name || "用户";
  await db.query(
    "INSERT INTO opc_agent_messages (id, room_id, sender_user_id, sender_agent_role, content, msg_type) VALUES ($1,$2,$3,'system',$4,'system')",
    [uuid(), roomId, userId, `${userName} 婉拒了邀请`],
  );

  sendJson(res, 200, { success: true });
}
