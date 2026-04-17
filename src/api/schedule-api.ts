/**
 * 日程管理 API
 * GET    /api/schedules?month=2026-03  — 按月查询当前用户日程
 * POST   /api/schedules                — 创建日程
 * PUT    /api/schedules/:id            — 修改日程
 * DELETE /api/schedules/:id            — 删除日程
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";

export async function handleListSchedules(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);

  const startDate = month + "-01";
  // End of month: go to next month
  const [y, m] = month.split("-").map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const endDate = nextMonth + "-01";

  const { rows } = await db.query(
    "SELECT * FROM opc_schedules WHERE user_id = $1 AND date >= $2 AND date < $3 ORDER BY date, start_time",
    [userId, startDate, endDate],
  );
  sendJson(res, 200, { schedules: rows, month });
}

export async function handleCreateSchedule(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);

  const title = String(body.title || "").trim();
  const date = String(body.date || "").trim();
  if (!title) { sendJson(res, 400, { error: "标题不能为空" }); return; }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { sendJson(res, 400, { error: "日期格式应为 YYYY-MM-DD" }); return; }

  const id = uuid();
  await db.query(
    `INSERT INTO opc_schedules (id, user_id, company_id, title, date, start_time, end_time, location, description, category, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, userId,
      String(body.company_id || ""),
      title, date,
      String(body.start_time || ""),
      String(body.end_time || ""),
      String(body.location || ""),
      String(body.description || ""),
      String(body.category || "work"),
      String(body.status || "scheduled"),
    ],
  );
  const { rows } = await db.query("SELECT * FROM opc_schedules WHERE id = $1", [id]);
  sendJson(res, 201, { success: true, schedule: rows[0] });
}

export async function handleUpdateSchedule(req: AuthRequest, res: ServerResponse, db: Db, scheduleId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);

  const { rows: existing } = await db.query(
    "SELECT id FROM opc_schedules WHERE id = $1 AND user_id = $2",
    [scheduleId, userId],
  );
  if (!existing[0]) { sendJson(res, 404, { error: "日程不存在" }); return; }

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const allowed = ["title", "date", "start_time", "end_time", "location", "description", "category", "status", "company_id"];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(String(body[key]));
    }
  }

  if (fields.length === 0) { sendJson(res, 400, { error: "没有需要更新的字段" }); return; }

  values.push(scheduleId, userId);
  await db.query(
    `UPDATE opc_schedules SET ${fields.join(", ")} WHERE id = $${idx++} AND user_id = $${idx}`,
    values,
  );
  const { rows } = await db.query("SELECT * FROM opc_schedules WHERE id = $1", [scheduleId]);
  sendJson(res, 200, { success: true, schedule: rows[0] });
}

export async function handleDeleteSchedule(req: AuthRequest, res: ServerResponse, db: Db, scheduleId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rowCount } = await db.query(
    "DELETE FROM opc_schedules WHERE id = $1 AND user_id = $2",
    [scheduleId, userId],
  );
  if (!rowCount) { sendJson(res, 404, { error: "日程不存在" }); return; }
  sendJson(res, 200, { success: true });
}
