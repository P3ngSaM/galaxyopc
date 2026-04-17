/**
 * 定时任务调度器
 *
 * - 每分钟轮询 DB，执行到期的一次性任务
 * - 对周期性任务维护内存中的 cron job Map
 * - 支持发邮件（nodemailer）和站内消息（INSERT chat message）
 */

import cron from "node-cron";
import nodemailer from "nodemailer";
import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import { initEmailPoller } from "../email/email-reader.js";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.163.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

let _db: Db;
let _tickRunning = false;
let _lastTickStartedAt = 0;
const SCHEDULER_TIMEZONE = process.env.TZ || "Asia/Shanghai";

export function initScheduler(pool: Db): void {
  _db = pool;

  // 用 setInterval 替代 node-cron 做心跳，避免 node-cron 在高负载下打印 missed execution 警告
  setInterval(() => {
    tick().catch((e) => console.error("[Scheduler] tick error:", e));
  }, 60_000);

  setTimeout(() => {
    tick().catch((e) => console.error("[Scheduler] initial tick error:", e));
  }, 5_000);

  // 启动邮件轮询器（每5分钟）
  initEmailPoller(pool);

  console.log("[Scheduler] 定时任务调度器已启动");
}

async function tick(): Promise<void> {
  if (_tickRunning) {
    console.warn("[Scheduler] tick skipped: previous tick still running");
    return;
  }
  _tickRunning = true;
  _lastTickStartedAt = Date.now();

  try {
  // 1. 自动取消已过期的待付款订单
  const { rowCount } = await _db.query(
    `UPDATE opc_orders SET status = 'expired'
     WHERE status = 'pending' AND expired_at <= NOW()`,
  );
  if (rowCount && rowCount > 0) {
    console.log(`[Scheduler] 已自动取消 ${rowCount} 笔过期订单`);
  }

  // 2. 执行到期的一次性任务
  const { rows: onceRows } = await _db.query(
    `SELECT * FROM opc_scheduled_tasks
     WHERE status = 'pending' AND run_at IS NOT NULL AND run_at <= NOW()
     ORDER BY run_at
     LIMIT 20`,
  );

  // 并发执行到期任务，避免串行阻塞 tick
  await Promise.allSettled(onceRows.map((task) => executeTask(task)));

  // 3. 周期任务由心跳统一判断，不再为每条任务注册一个独立 cron job
  const { rows: cronRows } = await _db.query(
    `SELECT * FROM opc_scheduled_tasks
     WHERE status = 'pending' AND cron_expr IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 500`,
  );

  const now = new Date();
  const dueCronTasks: Record<string, unknown>[] = [];
  for (const task of cronRows as Record<string, unknown>[]) {
    if (shouldRunCronTask(task, now)) {
      dueCronTasks.push(task);
    }
  }

  if (dueCronTasks.length > 0) {
    await Promise.allSettled(dueCronTasks.map((task) => executeTask(task)));
  }
  } finally {
    const elapsed = Date.now() - _lastTickStartedAt;
    if (elapsed > 10_000) {
      console.warn(`[Scheduler] tick slow: ${elapsed}ms`);
    }
    _tickRunning = false;
  }
}

function shouldRunCronTask(task: Record<string, unknown>, now: Date): boolean {
  const expr = String(task.cron_expr || "");
  if (!expr || !cron.validate(expr)) {
    console.warn(`[Scheduler] 无效 cron 表达式: ${expr} (task ${task.id})`);
    return false;
  }

  const matchMinute = new Date(now);
  matchMinute.setSeconds(0, 0);

  const lastRun = task.last_run ? new Date(String(task.last_run)) : null;
  if (lastRun && !Number.isNaN(lastRun.getTime())) {
    const lastRunMinute = new Date(lastRun);
    lastRunMinute.setSeconds(0, 0);
    if (lastRunMinute.getTime() === matchMinute.getTime()) {
      return false;
    }
  }

  try {
    return matchesCronExpression(expr, matchMinute);
  } catch (error) {
    console.warn(`[Scheduler] cron 匹配失败 (task ${task.id}):`, error);
    return false;
  }
}

function matchesCronExpression(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  const normalized = parts.length === 5 ? ["0", ...parts] : parts;
  if (normalized.length !== 6) throw new Error(`不支持的 cron 表达式: ${expr}`);

  const second = date.getSeconds();
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const weekDay = date.getDay();

  return (
    matchesCronField(normalized[0], second, 0, 59) &&
    matchesCronField(normalized[1], minute, 0, 59) &&
    matchesCronField(normalized[2], hour, 0, 23) &&
    matchesCronField(normalized[3], day, 1, 31) &&
    matchesCronField(normalized[4], month, 1, 12, MONTH_NAME_MAP) &&
    matchesCronField(normalized[5], weekDay, 0, 7, WEEKDAY_NAME_MAP, true)
  );
}

const MONTH_NAME_MAP: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const WEEKDAY_NAME_MAP: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

function matchesCronField(
  rawField: string,
  value: number,
  min: number,
  max: number,
  names?: Record<string, number>,
  normalizeSunday = false,
): boolean {
  return rawField.split(",").some((segment) => matchesCronSegment(segment.trim(), value, min, max, names, normalizeSunday));
}

function matchesCronSegment(
  rawSegment: string,
  value: number,
  min: number,
  max: number,
  names?: Record<string, number>,
  normalizeSunday = false,
): boolean {
  if (rawSegment === "*") return true;

  const [basePart, stepPart] = rawSegment.split("/");
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isFinite(step) || step <= 0) return false;

  let rangeStart = min;
  let rangeEnd = max;

  if (basePart && basePart !== "*") {
    if (basePart.includes("-")) {
      const [startRaw, endRaw] = basePart.split("-");
      rangeStart = parseCronValue(startRaw, names, normalizeSunday);
      rangeEnd = parseCronValue(endRaw, names, normalizeSunday);
    } else {
      const exact = parseCronValue(basePart, names, normalizeSunday);
      rangeStart = exact;
      rangeEnd = exact;
    }
  }

  if (rangeStart > rangeEnd) return false;
  if (value < rangeStart || value > rangeEnd) return false;
  return ((value - rangeStart) % step) === 0;
}

function parseCronValue(rawValue: string, names?: Record<string, number>, normalizeSunday = false): number {
  const normalized = rawValue.trim().toUpperCase();
  let parsed = names && normalized in names ? names[normalized] : Number(normalized);
  if (!Number.isFinite(parsed)) return Number.NaN;
  if (normalizeSunday && parsed === 7) parsed = 0;
  return parsed;
}

export async function executeTask(task: Record<string, unknown>): Promise<void> {
  const taskId = String(task.id);

  // 标记为 running（乐观锁：只有 pending 才能执行）
  const { rowCount } = await _db.query(
    "UPDATE opc_scheduled_tasks SET status = 'running' WHERE id = $1 AND status = 'pending'",
    [taskId],
  );
  if (!rowCount) return; // 并发保护

  const payload = (task.payload as Record<string, string>) || {};
  const taskType = String(task.task_type);
  let lastError: string | null = null;

  try {
    if (taskType === "email" || taskType === "both") {
      await sendEmail(payload);
    }
    if (taskType === "notify" || taskType === "both") {
      await sendNotify(String(task.user_id), task.company_id ? String(task.company_id) : null, String(payload.notify_message || ""));
    }
  } catch (e: unknown) {
    lastError = (e as Error).message;
    console.error(`[Scheduler] task ${taskId} 执行失败:`, lastError);
  }

  const newRunCount = Number(task.run_count || 0) + 1;
  const maxRuns = task.max_runs != null ? Number(task.max_runs) : null;
  const isCronTask = task.cron_expr != null;

  let newStatus: string;
  if (lastError) {
    newStatus = "failed";
  } else if (!isCronTask) {
    // 一次性任务完成后即为 done
    newStatus = "done";
  } else if (maxRuns !== null && newRunCount >= maxRuns) {
    // 周期任务达到最大执行次数
    newStatus = "done";
  } else {
    // 周期任务继续
    newStatus = "pending";
  }

  await _db.query(
    `UPDATE opc_scheduled_tasks
     SET status = $1, run_count = $2, last_run = NOW(), last_error = $3
     WHERE id = $4`,
    [newStatus, newRunCount, lastError, taskId],
  );
}

export function cancelJob(taskId: string): void {
  void taskId;
}

// ─── 发邮件 ───────────────────────────────────────────────────────────

async function sendEmail(payload: Record<string, string>): Promise<void> {
  if (!SMTP_USER || !SMTP_PASS) throw new Error("邮件服务未配置 (SMTP_USER/SMTP_PASS)");

  const to = payload.to || payload.to_email;
  const subject = payload.subject;
  const body = payload.body;
  if (!to || !subject || !body) throw new Error("邮件参数不完整 (to/subject/body)");

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"星环OPC" <${SMTP_USER}>`,
    to,
    subject,
    html: `<div style="max-width:640px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
      <div style="border-bottom:2px solid #f97316;padding-bottom:16px;margin-bottom:24px;">
        <h2 style="color:#f97316;margin:0;font-size:18px;">星环OPC</h2>
        <p style="color:#888;font-size:12px;margin:4px 0 0;">一人公司 AI 运营平台</p>
      </div>
      <div style="color:#333;font-size:14px;line-height:1.8;">${body}</div>
      <div style="border-top:1px solid #eee;padding-top:16px;margin-top:32px;">
        <p style="color:#999;font-size:11px;margin:0;">此邮件由 星环OPC 定时任务系统自动发送</p>
      </div>
    </div>`,
  });
}

// ─── 站内通知（写入最近一条对话）────────────────────────────────────

async function sendNotify(userId: string, companyId: string | null, message: string): Promise<void> {
  if (!message) throw new Error("通知内容不能为空");

  // 找到该用户最近的一条 conversation
  const qArgs: unknown[] = [userId];
  let convQ = "SELECT id, company_id FROM opc_chat_conversations WHERE user_id = $1";
  if (companyId) { convQ += " AND company_id = $2"; qArgs.push(companyId); }
  convQ += " ORDER BY updated_at DESC LIMIT 1";

  const { rows } = await _db.query(convQ, qArgs);

  let convId: string;
  let cid: string;

  if (rows[0]) {
    convId = String(rows[0].id);
    cid = String(rows[0].company_id);
  } else {
    // 没有对话则创建一个
    convId = uuid();
    cid = companyId || "";
    await _db.query(
      "INSERT INTO opc_chat_conversations (id, user_id, company_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
      [convId, userId, cid, "系统通知"],
    );
  }

  const msgId = uuid();
  await _db.query(
    `INSERT INTO opc_chat_messages (id, user_id, company_id, conversation_id, role, content, created_at)
     VALUES ($1, $2, $3, $4, 'system', $5, NOW())`,
    [msgId, userId, cid, convId, message],
  );

  // 更新 conversation 的 updated_at
  await _db.query("UPDATE opc_chat_conversations SET updated_at = NOW() WHERE id = $1", [convId]);
}
