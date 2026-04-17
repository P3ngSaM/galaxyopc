/**
 * 多人协作 — 团队成员管理 API
 *
 * GET    /api/companies/:cid/members           — 成员列表
 * POST   /api/companies/:cid/members/invite     — 邀请用户
 * GET    /api/company-invites/pending            — 我收到的待处理邀请
 * POST   /api/company-invites/:id/accept         — 接受邀请
 * POST   /api/company-invites/:id/reject         — 拒绝邀请
 * PUT    /api/companies/:cid/members/:uid/role   — 修改角色
 * DELETE /api/companies/:cid/members/:uid        — 移除成员
 * POST   /api/companies/:cid/members/leave       — 主动退出
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";

const ROLE_LEVELS: Record<string, number> = { owner: 3, admin: 2, member: 1 };

async function getMyRole(db: Db, userId: string, companyId: string): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT role FROM opc_user_companies WHERE user_id = $1 AND company_id = $2",
    [userId, companyId],
  );
  return rows[0] ? (rows[0] as any).role : null;
}

function canManage(myRole: string, requiredLevel: string): boolean {
  return (ROLE_LEVELS[myRole] || 0) >= (ROLE_LEVELS[requiredLevel] || 99);
}

// ── 成员列表 ──
export async function handleListMembers(req: AuthRequest, res: ServerResponse, db: Db, cid: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const myRole = await getMyRole(db, req.user!.userId, cid);
  if (!myRole) { sendJson(res, 403, { error: "无权访问" }); return; }

  const { rows } = await db.query(
    `SELECT u.id, u.name, u.avatar, u.email, uc.role, uc.created_at AS joined_at
     FROM opc_user_companies uc
     JOIN opc_users u ON u.id = uc.user_id
     WHERE uc.company_id = $1
     ORDER BY CASE uc.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, uc.created_at`,
    [cid],
  );

  const { rows: invites } = await db.query(
    `SELECT i.id, i.role, i.status, i.created_at, u.name AS invitee_name, u.avatar AS invitee_avatar
     FROM opc_company_invites i
     JOIN opc_users u ON u.id = i.invitee_id
     WHERE i.company_id = $1 AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
    [cid],
  );

  sendJson(res, 200, { members: rows, pending_invites: invites, my_role: myRole });
}

// ── 邀请用户 ──
export async function handleInviteMember(req: AuthRequest, res: ServerResponse, db: Db, cid: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const myRole = await getMyRole(db, userId, cid);
  if (!myRole || !canManage(myRole, "admin")) {
    sendJson(res, 403, { error: "需要管理员以上权限" }); return;
  }

  const body = await parseBody(req) as { invitee_id?: string; role?: string };
  const inviteeId = String(body.invitee_id || "").trim();
  const role = (body.role === "admin" && myRole === "owner") ? "admin" : "member";

  if (!inviteeId) { sendJson(res, 400, { error: "请指定用户" }); return; }
  if (inviteeId === userId) { sendJson(res, 400, { error: "不能邀请自己" }); return; }

  const { rows: userCheck } = await db.query("SELECT id, name FROM opc_users WHERE id = $1", [inviteeId]);
  if (!userCheck[0]) { sendJson(res, 404, { error: "用户不存在" }); return; }

  const { rows: alreadyMember } = await db.query(
    "SELECT 1 FROM opc_user_companies WHERE user_id = $1 AND company_id = $2",
    [inviteeId, cid],
  );
  if (alreadyMember[0]) { sendJson(res, 400, { error: "该用户已是公司成员" }); return; }

  const { rows: existingInvite } = await db.query(
    "SELECT 1 FROM opc_company_invites WHERE invitee_id = $1 AND company_id = $2 AND status = 'pending'",
    [inviteeId, cid],
  );
  if (existingInvite[0]) { sendJson(res, 400, { error: "已发送过邀请，等待对方回应" }); return; }

  const id = uuid();
  await db.query(
    "INSERT INTO opc_company_invites (id, company_id, inviter_id, invitee_id, role) VALUES ($1, $2, $3, $4, $5)",
    [id, cid, userId, inviteeId, role],
  );

  sendJson(res, 201, { id, invitee_name: (userCheck[0] as any).name, role, status: "pending" });
}

// ── 我收到的待处理邀请 ──
export async function handlePendingInvites(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    `SELECT i.id, i.company_id, i.role, i.created_at,
            c.name AS company_name, c.industry AS company_industry,
            u.name AS inviter_name, u.avatar AS inviter_avatar
     FROM opc_company_invites i
     JOIN opc_companies c ON c.id = i.company_id
     JOIN opc_users u ON u.id = i.inviter_id
     WHERE i.invitee_id = $1 AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
    [req.user!.userId],
  );
  sendJson(res, 200, { invites: rows });
}

// ── 接受邀请 ──
export async function handleAcceptInvite(req: AuthRequest, res: ServerResponse, db: Db, inviteId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    "SELECT * FROM opc_company_invites WHERE id = $1 AND invitee_id = $2 AND status = 'pending'",
    [inviteId, userId],
  );
  if (!rows[0]) { sendJson(res, 404, { error: "邀请不存在或已处理" }); return; }
  const invite = rows[0] as any;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE opc_company_invites SET status = 'accepted' WHERE id = $1", [inviteId]);
    await client.query(
      "INSERT INTO opc_user_companies (user_id, company_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, company_id) DO NOTHING",
      [userId, invite.company_id, invite.role],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  sendJson(res, 200, { success: true, company_id: invite.company_id });
}

// ── 拒绝邀请 ──
export async function handleRejectInvite(req: AuthRequest, res: ServerResponse, db: Db, inviteId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  await db.query(
    "UPDATE opc_company_invites SET status = 'rejected' WHERE id = $1 AND invitee_id = $2 AND status = 'pending'",
    [inviteId, req.user!.userId],
  );
  sendJson(res, 200, { success: true });
}

// ── 修改成员角色 ──
export async function handleChangeRole(req: AuthRequest, res: ServerResponse, db: Db, cid: string, targetUid: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const myRole = await getMyRole(db, userId, cid);
  if (!myRole || myRole !== "owner") {
    sendJson(res, 403, { error: "仅公司所有者可修改角色" }); return;
  }
  if (targetUid === userId) { sendJson(res, 400, { error: "不能修改自己的角色" }); return; }

  const body = await parseBody(req) as { role?: string };
  const newRole = String(body.role || "");
  if (!["admin", "member"].includes(newRole)) {
    sendJson(res, 400, { error: "角色只能是 admin 或 member" }); return;
  }

  const { rowCount } = await db.query(
    "UPDATE opc_user_companies SET role = $1 WHERE user_id = $2 AND company_id = $3",
    [newRole, targetUid, cid],
  );
  if (!rowCount) { sendJson(res, 404, { error: "该用户不是公司成员" }); return; }
  sendJson(res, 200, { success: true });
}

// ── 移除成员 ──
export async function handleRemoveMember(req: AuthRequest, res: ServerResponse, db: Db, cid: string, targetUid: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const myRole = await getMyRole(db, userId, cid);
  if (!myRole || !canManage(myRole, "admin")) {
    sendJson(res, 403, { error: "需要管理员以上权限" }); return;
  }

  if (targetUid === userId) { sendJson(res, 400, { error: "不能移除自己，请使用退出功能" }); return; }

  const targetRole = await getMyRole(db, targetUid, cid);
  if (!targetRole) { sendJson(res, 404, { error: "该用户不是公司成员" }); return; }
  if (targetRole === "owner") { sendJson(res, 403, { error: "不能移除公司所有者" }); return; }
  if (targetRole === "admin" && myRole !== "owner") {
    sendJson(res, 403, { error: "只有所有者才能移除管理员" }); return;
  }

  await db.query("DELETE FROM opc_user_companies WHERE user_id = $1 AND company_id = $2", [targetUid, cid]);
  sendJson(res, 200, { success: true });
}

// ── 主动退出 ──
export async function handleLeaveCompany(req: AuthRequest, res: ServerResponse, db: Db, cid: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const myRole = await getMyRole(db, userId, cid);
  if (!myRole) { sendJson(res, 404, { error: "你不是该公司成员" }); return; }
  if (myRole === "owner") { sendJson(res, 400, { error: "所有者不能退出公司，请先转让所有权" }); return; }

  await db.query("DELETE FROM opc_user_companies WHERE user_id = $1 AND company_id = $2", [userId, cid]);
  sendJson(res, 200, { success: true });
}

// ── 搜索可邀请的用户 ──
export async function handleSearchUsersForTeam(req: AuthRequest, res: ServerResponse, db: Db, cid: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const myRole = await getMyRole(db, req.user!.userId, cid);
  if (!myRole || !canManage(myRole, "admin")) {
    sendJson(res, 403, { error: "需要管理员以上权限" }); return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q || q.length < 2) { sendJson(res, 200, { users: [] }); return; }

  const { rows } = await db.query(
    `SELECT u.id, u.name, u.avatar, u.email
     FROM opc_users u
     WHERE (u.name ILIKE $1 OR u.email ILIKE $1)
       AND u.id NOT IN (SELECT user_id FROM opc_user_companies WHERE company_id = $2)
       AND u.id NOT IN (SELECT invitee_id FROM opc_company_invites WHERE company_id = $2 AND status = 'pending')
     LIMIT 20`,
    [`%${q}%`, cid],
  );
  sendJson(res, 200, { users: rows });
}
