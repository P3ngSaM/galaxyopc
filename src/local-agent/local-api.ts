/**
 * 本地操作 API — 审批队列 + 任务管理 + 审计日志
 */

import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, parseBody, requireAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { getPendingApprovals, resolveApproval, isLocalModeEnabled, setAutoApprove } from "./security.js";
import { planTask, executeTaskSteps, getTask, listTasks, cancelTask } from "./task-planner.js";
import { startFeishu, stopFeishu, getFeishuStatus } from "./feishu-bridge.js";
import { getRecentBackups, restoreBackup } from "./file-backup.js";

function guardLocal(req: AuthRequest, res: ServerResponse): boolean {
  if (!isLocalModeEnabled()) {
    sendJson(res, 403, { error: "此功能仅在本地版可用" });
    return false;
  }
  if (!requireAuth(req, res)) return false;
  return true;
}

// GET /api/local/approvals — 获取待审批操作列表
export async function handleGetApprovals(req: AuthRequest, res: ServerResponse) {
  if (!guardLocal(req, res)) return;
  const list = getPendingApprovals(req.user!.userId);
  sendJson(res, 200, { approvals: list });
}

// POST /api/local/approvals/:id — 审批操作（approve/reject）
export async function handleResolveApproval(req: AuthRequest, res: ServerResponse, _db: Db, approvalId: string) {
  if (!guardLocal(req, res)) return;
  const body = await parseBody(req);
  const approved = body.approved === true;
  const ok = resolveApproval(approvalId, approved);
  if (!ok) {
    sendJson(res, 404, { error: "审批请求不存在或已处理" });
    return;
  }
  sendJson(res, 200, { success: true, approved });
}

// POST /api/local/auto-approve — 设置自动批准模式
export async function handleSetAutoApprove(req: AuthRequest, res: ServerResponse) {
  if (!guardLocal(req, res)) return;
  const body = await parseBody(req);
  const enabled = body.enabled === true;
  setAutoApprove(req.user!.userId, enabled);
  sendJson(res, 200, { success: true, autoApprove: enabled });
}

// POST /api/local/tasks — 创建并执行任务
export async function handleCreateTask(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  const body = await parseBody(req);
  const instruction = String(body.instruction || "").trim();
  if (!instruction) {
    sendJson(res, 400, { error: "instruction 为必填项" });
    return;
  }
  const companyId = String(body.company_id || "");
  const source = String(body.source || "web");

  const task = await planTask(db, req.user!.userId, instruction, companyId, source);
  sendJson(res, 201, { task });

  // 异步执行（不阻塞响应）
  executeTaskSteps(db, task, companyId).catch(e => {
    console.error("[TaskPlanner] execution error:", e);
  });
}

// GET /api/local/tasks — 任务列表
export async function handleListTasks(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  const tasks = await listTasks(db, req.user!.userId);
  sendJson(res, 200, { tasks });
}

// GET /api/local/tasks/:id — 任务详情
export async function handleGetTask(req: AuthRequest, res: ServerResponse, db: Db, taskId: string) {
  if (!guardLocal(req, res)) return;
  const task = await getTask(db, taskId, req.user!.userId);
  if (!task) {
    sendJson(res, 404, { error: "任务不存在" });
    return;
  }
  sendJson(res, 200, { task });
}

// POST /api/local/tasks/:id/cancel — 取消任务
export async function handleCancelTask(req: AuthRequest, res: ServerResponse, db: Db, taskId: string) {
  if (!guardLocal(req, res)) return;
  const ok = cancelTask(taskId);
  sendJson(res, 200, { success: ok, message: ok ? "任务已取消" : "任务不在执行中" });
}

// GET /api/local/audit-log — 审计日志
export async function handleGetAuditLog(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  const { rows } = await db.query(
    "SELECT * FROM opc_local_audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
    [req.user!.userId],
  );
  sendJson(res, 200, { logs: rows });
}

// GET /api/local/system-info — 系统信息
export async function handleSystemInfo(req: AuthRequest, res: ServerResponse) {
  if (!guardLocal(req, res)) return;
  const os = await import("os");
  sendJson(res, 200, {
    platform: process.platform,
    arch: os.arch(),
    hostname: os.hostname(),
    home: os.homedir(),
    cpus: os.cpus().length,
    memory: {
      total: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10 + " GB",
      free: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10 + " GB",
    },
    uptime: Math.round(os.uptime() / 3600 * 10) / 10 + " 小时",
    node: process.version,
  });
}

// ─── 文件备份 ────────────────────────────────────────────────────────

// GET /api/local/backups — 最近可回滚的文件操作
export async function handleGetBackups(req: AuthRequest, res: ServerResponse) {
  if (!guardLocal(req, res)) return;
  const backups = await getRecentBackups(30);
  sendJson(res, 200, {
    total: backups.length,
    backups: backups.map(b => ({
      id: b.id,
      path: b.originalPath,
      operation: b.operation,
      size: b.size,
      time: new Date(b.createdAt).toLocaleString("zh-CN"),
      timestamp: b.createdAt,
    })),
  });
}

// POST /api/local/backups/:id/restore — 回滚指定备份
export async function handleRestoreBackup(req: AuthRequest, res: ServerResponse, _db: Db, backupId: string) {
  if (!guardLocal(req, res)) return;
  const result = await restoreBackup(backupId);
  sendJson(res, result.success ? 200 : 400, result);
}

// ─── 飞书长连接 ──────────────────────────────────────────────────────

export async function handleFeishuConnect(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  const body = await parseBody(req);
  const appId = String(body.app_id || "").trim();
  const appSecret = String(body.app_secret || "").trim();
  if (!appId || !appSecret) { sendJson(res, 400, { error: "app_id 和 app_secret 不能为空" }); return; }

  // 存到 opc_tool_config
  const upsert = "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";
  await db.query(upsert, ["feishu_app_id", appId]);
  await db.query(upsert, ["feishu_app_secret", appSecret]);

  const result = await startFeishu(appId, appSecret, db);
  if (result.ok) {
    sendJson(res, 200, { success: true, message: "飞书长连接已建立" });
  } else {
    sendJson(res, 500, { error: result.error || "连接失败" });
  }
}

export async function handleFeishuDisconnect(req: AuthRequest, res: ServerResponse) {
  if (!guardLocal(req, res)) return;
  await stopFeishu();
  sendJson(res, 200, { success: true, message: "飞书已断开" });
}

export function handleFeishuStatus(req: AuthRequest, res: ServerResponse) {
  if (!guardLocal(req, res)) return;
  sendJson(res, 200, getFeishuStatus());
}
