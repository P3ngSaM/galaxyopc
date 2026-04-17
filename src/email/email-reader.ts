/**
 * 邮件收信模块 — IMAP 轮询 + AI 分析 + 站内通知
 */

import { ImapFlow } from "imapflow";
import { v4 as uuid } from "uuid";
import nodemailer from "nodemailer";
import type { Db } from "../db.js";
import { callAi, type ChatMessage } from "../chat/ai-client.js";

interface EmailAccount {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  password: string;
  last_uid: number;
}

interface EmailRow {
  id: string;
  account_id: string;
  user_id: string;
  from_addr: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
}

let _polling = false;

/** 由 scheduler.ts 启动时调用，每5分钟轮询所有账户 */
export function initEmailPoller(db: Db): void {
  // 启动后延迟30秒再首次轮询，避免服务刚起时抢资源
  setTimeout(() => {
    pollAllAccounts(db).catch((e) => console.error("[EmailPoller] 首次轮询失败:", e));
  }, 30_000);

  setInterval(() => {
    pollAllAccounts(db).catch((e) => console.error("[EmailPoller] 轮询失败:", e));
  }, 5 * 60 * 1000);

  console.log("[EmailPoller] 邮件轮询器已启动（每5分钟）");
}

/** 轮询所有 enabled=true 的账户 */
async function pollAllAccounts(db: Db): Promise<void> {
  if (_polling) {
    console.warn("[EmailPoller] 跳过本轮轮询：上一轮仍在执行");
    return;
  }
  _polling = true;
  try {
  const { rows } = await db.query(
    "SELECT * FROM opc_email_accounts WHERE enabled = true"
  );
  for (const account of rows as EmailAccount[]) {
    try {
      await pollAccountEmails(db, account);
    } catch (e) {
      console.error(`[EmailPoller] 账户 ${account.email} 轮询失败:`, (e as Error).message);
    }
  }
  } finally {
    _polling = false;
  }
}

/** 用 imapflow 拉取某账户的新邮件（uid > account.last_uid） */
async function pollAccountEmails(db: Db, account: EmailAccount): Promise<void> {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
    tls: { rejectUnauthorized: false },
    socketTimeout: 30000,
  });

  client.on("error", (err: Error) => {
    console.error(`[EmailPoller] IMAP连接错误 (${account.email}):`, err.message);
  });

  await client.connect();
  let newMaxUid = account.last_uid;

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = account.last_uid > 0
        ? { uid: `${account.last_uid + 1}:*` }
        : { seen: false };

      const msgs: unknown[] = [];
      for await (const msg of client.fetch(since, {
        uid: true, envelope: true, bodyStructure: true, source: false,
      })) {
        msgs.push(msg);
      }

      for (const msg of msgs as Record<string, unknown>[]) {
        const uid = Number(msg.uid);
        if (uid <= account.last_uid) continue;

        const env = msg.envelope as Record<string, unknown> | undefined;
        if (!env) continue;

        const fromArr = (env.from as Array<{ name?: string; address?: string }> | undefined) || [];
        const fromAddr = fromArr[0]?.address || "";
        const fromName = fromArr[0]?.name || null;
        const subject = (env.subject as string | undefined) || null;
        const msgId = (env.messageId as string | undefined) || null;
        const date = (env.date as Date | undefined) || new Date();

        // 去重检查
        if (msgId) {
          const { rows: dup } = await db.query(
            "SELECT id FROM opc_email_inbox WHERE message_id = $1 AND account_id = $2",
            [msgId, account.id]
          );
          if (dup.length > 0) { if (uid > newMaxUid) newMaxUid = uid; continue; }
        }

        // 拉取正文（尝试 TEXT/PLAIN 部分）
        let bodyText: string | null = null;
        try {
          const fetchResult = await client.fetchOne(`${uid}`, { bodyParts: ["TEXT"] }, { uid: true });
          const parts = (fetchResult && fetchResult.bodyParts) ? fetchResult.bodyParts as Map<string, Buffer> : undefined;
          if (parts) {
            const textBuf = parts.get("TEXT") || parts.get("text");
            if (textBuf) bodyText = textBuf.toString("utf8").slice(0, 2000);
          }
        } catch (_e) {
          // 正文拉取失败时跳过
        }

        const emailId = uuid();
        await db.query(
          `INSERT INTO opc_email_inbox
            (id, account_id, user_id, uid, message_id, from_addr, from_name, subject, body_text, received_at, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new',NOW())`,
          [emailId, account.id, account.user_id, uid, msgId, fromAddr, fromName, subject, bodyText, date]
        );

        if (uid > newMaxUid) newMaxUid = uid;

        // 异步 AI 分析，不阻塞轮询
        const emailRow: EmailRow = {
          id: emailId, account_id: account.id, user_id: account.user_id,
          from_addr: fromAddr, from_name: fromName, subject, body_text: bodyText,
        };
        analyzeEmail(db, emailRow).catch((e) =>
          console.error(`[EmailPoller] AI分析失败 ${emailId}:`, (e as Error).message)
        );
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  if (newMaxUid > account.last_uid) {
    await db.query(
      "UPDATE opc_email_accounts SET last_uid = $1, last_poll = NOW() WHERE id = $2",
      [newMaxUid, account.id]
    );
  } else {
    await db.query("UPDATE opc_email_accounts SET last_poll = NOW() WHERE id = $1", [account.id]);
  }
}

/** AI 分析邮件，写分析结果，发站内通知 */
async function analyzeEmail(db: Db, email: EmailRow): Promise<void> {
  const prompt = `你是邮件助手。分析这封来信并输出 JSON：
- 来自：${email.from_name || ""} <${email.from_addr}>
- 主题：${email.subject || "（无主题）"}
- 正文：${(email.body_text || "").slice(0, 600)}

输出格式（只输出 JSON，无其他文字）：
{
  "summary": "一句话摘要（30字内）",
  "action": "reply",
  "reply_draft": "回复正文（仅 action=reply 时，HTML 格式）",
  "task_suggestion": { "name": "任务名", "notify_message": "提醒内容" }
}

action 取值规则：
- reply：客户来信/需要跟进/有问题需回答
- task：含有待办/截止日期/需要做某事
- none：广告/通知/不需处理

注意：task_suggestion 仅在 action=task 时输出，reply_draft 仅在 action=reply 时输出`;

  let aiResult: { summary?: string; action?: string; reply_draft?: string; task_suggestion?: { name?: string; notify_message?: string } } = {};

  try {
    const response = await callAi([{ role: "user", content: prompt } as ChatMessage]);
    const raw = response.content;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) aiResult = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("[EmailPoller] AI分析解析失败:", (e as Error).message);
    aiResult = { summary: "AI分析失败", action: "none" };
  }

  const summary = aiResult.summary || "";
  const action = aiResult.action || "none";
  const replyDraft = action === "reply" ? (aiResult.reply_draft || null) : null;
  const taskSuggestion = action === "task" ? (aiResult.task_suggestion || null) : null;

  await db.query(
    `UPDATE opc_email_inbox
     SET ai_summary = $1, ai_action = $2, reply_draft = $3, task_suggestion = $4, status = 'notified'
     WHERE id = $5`,
    [summary, action, replyDraft, taskSuggestion ? JSON.stringify(taskSuggestion) : null, email.id]
  );

  const fromDisplay = email.from_name ? `${email.from_name}（${email.from_addr}）` : email.from_addr;
  console.log(`[EmailPoller] 已处理: ${fromDisplay} - ${email.subject || "(无主题)"} → ${action}`);
}

/** 站内通知（写入最近一条对话） */
async function sendNotify(db: Db, userId: string, message: string): Promise<void> {
  const { rows } = await db.query(
    "SELECT id, company_id FROM opc_chat_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1",
    [userId]
  );

  let convId: string;
  let cid: string;

  if (rows[0]) {
    convId = String(rows[0].id);
    cid = String(rows[0].company_id);
  } else {
    convId = uuid();
    cid = "";
    await db.query(
      "INSERT INTO opc_chat_conversations (id, user_id, company_id, title, created_at, updated_at) VALUES ($1,$2,$3,$4,NOW(),NOW())",
      [convId, userId, cid, "邮件通知"]
    );
  }

  await db.query(
    `INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at)
     VALUES ($1,$2,$3,$4,'system',$5,NOW())`,
    [uuid(), userId, cid, convId, message]
  );
  await db.query("UPDATE opc_chat_conversations SET updated_at = NOW() WHERE id = $1", [convId]);
}

/** 通过 SMTP 发送回复邮件 */
export async function sendEmailReply(
  account: EmailAccount,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: true,
    auth: { user: account.email, pass: account.password },
  });

  const displayName = account.display_name || account.email;
  await transporter.sendMail({
    from: `"${displayName}" <${account.email}>`,
    to,
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
    html: `<div style="max-width:640px;margin:0 auto;padding:24px;font-family:-apple-system,sans-serif;">
      <div style="color:#333;font-size:14px;line-height:1.8;">${body}</div>
      <div style="border-top:1px solid #eee;padding-top:12px;margin-top:24px;color:#999;font-size:11px;">
        由 星环OPC 自动整理，通过您的邮箱 ${account.email} 发出
      </div>
    </div>`,
  });
}

/** 常用邮箱的 IMAP/SMTP 主机自动检测 */
export function detectImapHost(email: string): { imap_host: string; smtp_host: string } {
  const domain = email.split("@")[1]?.toLowerCase() || "";
  if (domain.includes("163.com")) return { imap_host: "imap.163.com", smtp_host: "smtp.163.com" };
  if (domain.includes("qq.com")) return { imap_host: "imap.qq.com", smtp_host: "smtp.qq.com" };
  if (domain.includes("126.com")) return { imap_host: "imap.126.com", smtp_host: "smtp.126.com" };
  if (domain.includes("gmail.com")) return { imap_host: "imap.gmail.com", smtp_host: "smtp.gmail.com" };
  if (domain.includes("outlook") || domain.includes("hotmail")) return { imap_host: "outlook.office365.com", smtp_host: "smtp-mail.outlook.com" };
  if (domain.includes("sina.com")) return { imap_host: "imap.sina.com", smtp_host: "smtp.sina.com" };
  if (domain.includes("sohu.com")) return { imap_host: "imap.sohu.com", smtp_host: "smtp.sohu.com" };
  // 无法自动识别，返回空让用户填
  return { imap_host: "", smtp_host: "" };
}

/** 测试 IMAP 连接是否可用 */
export async function testImapConnection(account: Pick<EmailAccount, "imap_host" | "imap_port" | "email" | "password">): Promise<{ ok: boolean; error?: string }> {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  client.on("error", () => {});

  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("连接超时（5s）")), 5000)),
    ]);
    await client.logout();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
