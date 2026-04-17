/**
 * 定时任务 API
 * GET  /api/scheduled-tasks       — 列出当前用户所有任务
 * DELETE /api/scheduled-tasks/:id — 取消任务
 */

import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth } from "../auth/middleware.js";
import { cancelJob } from "../scheduler/scheduler.js";

export async function handleGetScheduledTasks(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    "SELECT * FROM opc_scheduled_tasks WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );
  sendJson(res, 200, { tasks: rows });
}

export async function handleDeleteScheduledTask(req: AuthRequest, res: ServerResponse, db: Db, taskId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    "SELECT id, status FROM opc_scheduled_tasks WHERE id = $1 AND user_id = $2",
    [taskId, userId],
  );
  if (!rows[0]) { sendJson(res, 404, { error: "任务不存在" }); return; }
  if (rows[0].status === "cancelled") { sendJson(res, 400, { error: "任务已取消" }); return; }

  await db.query("UPDATE opc_scheduled_tasks SET status = 'cancelled' WHERE id = $1", [taskId]);
  cancelJob(taskId);
  sendJson(res, 200, { success: true });
}
