/**
 * 邮件 REST API
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { requireAuth, sendJson, parseBody } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { sendEmailReply, detectImapHost, testImapConnection } from "../email/email-reader.js";

// POST /api/email/accounts  (从前端直接配置，等同于 setup_email save)
export async function handleCreateEmailAccount(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);

  const email = String(body.email || "").trim();
  const password = String(body.password || "").trim();
  if (!email || !password) { sendJson(res, 400, { error: "email 和 password 为必填项" }); return; }

  const detected = detectImapHost(email);
  const imapHost = String(body.imap_host || detected.imap_host || "");
  const smtpHost = String(body.smtp_host || detected.smtp_host || "");

  if (!imapHost || !smtpHost) {
    sendJson(res, 400, { error: "无法自动识别该邮箱的 IMAP/SMTP 地址，请手动填写 imap_host 和 smtp_host" });
    return;
  }

  const imapPort = Number(body.imap_port) || 993;
  const smtpPort = Number(body.smtp_port) || 465;

  const testResult = await testImapConnection({ imap_host: imapHost, imap_port: imapPort, email, password });
  if (!testResult.ok) {
    sendJson(res, 400, { error: `IMAP 连接测试失败：${testResult.error}。请检查邮箱授权码或服务器地址` });
    return;
  }

  const { rows: existing } = await db.query(
    "SELECT id FROM opc_email_accounts WHERE user_id = $1 AND email = $2", [userId, email]
  );

  if (existing.length > 0) {
    await db.query(
      `UPDATE opc_email_accounts SET display_name=$1, imap_host=$2, imap_port=$3, smtp_host=$4, smtp_port=$5, password=$6, enabled=true, last_uid=0 WHERE id=$7`,
      [body.display_name || null, imapHost, imapPort, smtpHost, smtpPort, password, existing[0].id]
    );
    sendJson(res, 200, { success: true, message: `邮箱 ${email} 配置已更新，5分钟内开始拉取新邮件`, account_id: existing[0].id });
  } else {
    const id = uuid();
    await db.query(
      `INSERT INTO opc_email_accounts (id, user_id, email, display_name, imap_host, imap_port, smtp_host, smtp_port, password, enabled, last_uid, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,0,NOW())`,
      [id, userId, email, body.display_name || null, imapHost, imapPort, smtpHost, smtpPort, password]
    );
    sendJson(res, 200, { success: true, message: `邮箱 ${email} 配置成功！系统将每5分钟自动拉取新邮件。`, account_id: id });
  }
}

// GET /api/email/accounts
export async function handleGetEmailAccounts(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT id, email, display_name, imap_host, smtp_host, imap_port, smtp_port, enabled, last_poll, created_at FROM opc_email_accounts WHERE user_id = $1 ORDER BY created_at",
    [userId]
  );
  sendJson(res, 200, { accounts: rows });
}

// DELETE /api/email/accounts/:id
export async function handleDeleteEmailAccount(req: AuthRequest, res: ServerResponse, db: Db, accountId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rowCount } = await db.query(
    "DELETE FROM opc_email_accounts WHERE id = $1 AND user_id = $2",
    [accountId, userId]
  );
  sendJson(res, 200, { success: (rowCount || 0) > 0 });
}

// GET /api/email/inbox
export async function handleGetEmailInbox(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const statusFilter = url.searchParams.get("status") || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = Math.min(50, Number(url.searchParams.get("limit") || "20"));
  const offset = (page - 1) * limit;

  const params: unknown[] = [userId];
  let sql = "SELECT id, from_addr, from_name, subject, received_at, ai_summary, ai_action, status, is_read, created_at FROM opc_email_inbox WHERE user_id = $1";
  if (statusFilter && statusFilter !== "all") {
    sql += ` AND status = $${params.length + 1}`;
    params.push(statusFilter);
  }
  sql += ` ORDER BY received_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const { rows } = await db.query(sql, params);
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) as total FROM opc_email_inbox WHERE user_id = $1${statusFilter && statusFilter !== "all" ? " AND status = $2" : ""}`,
    statusFilter && statusFilter !== "all" ? [userId, statusFilter] : [userId]
  );

  sendJson(res, 200, { emails: rows, total: Number(countRows[0]?.total || 0), page, limit });
}

// GET /api/email/inbox/:id
export async function handleGetEmailDetail(req: AuthRequest, res: ServerResponse, db: Db, emailId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    "SELECT * FROM opc_email_inbox WHERE id = $1 AND user_id = $2",
    [emailId, userId]
  );
  if (!rows[0]) { sendJson(res, 404, { error: "邮件不存在" }); return; }
  // 标记已读
  await db.query("UPDATE opc_email_inbox SET is_read = true WHERE id = $1", [emailId]);
  sendJson(res, 200, { email: rows[0] });
}

// POST /api/email/inbox/:id/confirm-reply
export async function handleConfirmReply(req: AuthRequest, res: ServerResponse, db: Db, emailId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    "SELECT * FROM opc_email_inbox WHERE id = $1 AND user_id = $2",
    [emailId, userId]
  );
  if (!rows[0]) { sendJson(res, 404, { error: "邮件不存在" }); return; }

  const email = rows[0] as { account_id: string; from_addr: string; subject: string; reply_draft: string | null; status: string };
  if (!email.reply_draft) { sendJson(res, 400, { error: "此邮件没有回复草稿" }); return; }
  if (email.status === "replied") { sendJson(res, 400, { error: "此邮件已回复" }); return; }

  const { rows: accRows } = await db.query(
    "SELECT * FROM opc_email_accounts WHERE id = $1 AND user_id = $2",
    [email.account_id, userId]
  );
  if (!accRows[0]) { sendJson(res, 404, { error: "邮件账户不存在，请先配置邮箱" }); return; }

  await sendEmailReply(accRows[0] as Parameters<typeof sendEmailReply>[0], email.from_addr, email.subject || "", email.reply_draft);
  await db.query("UPDATE opc_email_inbox SET status = 'replied', is_read = true WHERE id = $1", [emailId]);
  sendJson(res, 200, { success: true, message: `回复已发送至 ${email.from_addr}` });
}

// POST /api/email/inbox/:id/confirm-task
export async function handleConfirmTask(req: AuthRequest, res: ServerResponse, db: Db, emailId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    "SELECT * FROM opc_email_inbox WHERE id = $1 AND user_id = $2",
    [emailId, userId]
  );
  if (!rows[0]) { sendJson(res, 404, { error: "邮件不存在" }); return; }

  const email = rows[0] as {
    account_id: string; subject: string; task_suggestion: { name?: string; notify_message?: string } | null; status: string
  };
  if (!email.task_suggestion) { sendJson(res, 400, { error: "此邮件没有任务建议" }); return; }
  if (email.status === "task_created") { sendJson(res, 400, { error: "任务已创建" }); return; }

  const body = await parseBody(req);
  const taskName = (body.name as string | undefined) || email.task_suggestion.name || email.subject || "邮件任务";

  const taskId = uuid();
  await db.query(
    `INSERT INTO opc_scheduled_tasks (id, user_id, name, task_type, run_at, payload, status, run_count, created_at)
     VALUES ($1,$2,$3,'notify',NOW() + INTERVAL '1 minute',$4,'pending',0,NOW())`,
    [taskId, userId, taskName, JSON.stringify({ notify_message: email.task_suggestion?.notify_message || taskName })]
  );
  await db.query("UPDATE opc_email_inbox SET status = 'task_created', is_read = true WHERE id = $1", [emailId]);
  sendJson(res, 200, { success: true, task_id: taskId, message: `任务「${taskName}」已创建` });
}

// POST /api/email/inbox/:id/archive
export async function handleArchiveEmail(req: AuthRequest, res: ServerResponse, db: Db, emailId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rowCount } = await db.query(
    "UPDATE opc_email_inbox SET status = 'archived', is_read = true WHERE id = $1 AND user_id = $2",
    [emailId, userId]
  );
  sendJson(res, 200, { success: (rowCount || 0) > 0 });
}
