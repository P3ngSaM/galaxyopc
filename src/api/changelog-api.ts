/**
 * 更新日志管理 API — CRUD + 用户已读标记 + 未读查询
 */
import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, parseBody, requireAuth, requireAdmin } from "../auth/middleware.js";
import type { Db } from "../db.js";

// ═══ 管理端：列表（含分页） ═══
export async function handleListChangelogs(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const url = new URL(req.url || "/", "http://localhost");
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const offset = (page - 1) * limit;

  const { rows: countRows } = await db.query("SELECT COUNT(*)::int AS total FROM opc_changelogs");
  const total = countRows[0]?.total || 0;

  const { rows } = await db.query(
    `SELECT * FROM opc_changelogs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  sendJson(res, 200, { changelogs: rows, total, page, limit });
}

// ═══ 管理端：创建 ═══
export async function handleCreateChangelog(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  const version = String(body.version || "").trim();
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();
  const tag = String(body.tag || "feature").trim();
  const published = Boolean(body.published);

  if (!version || !title) return sendJson(res, 400, { error: "版本号和标题不能为空" });

  const { rows } = await db.query(
    `INSERT INTO opc_changelogs (version, title, content, tag, published, published_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [version, title, content, tag, published, published ? new Date().toISOString() : null]
  );
  sendJson(res, 201, { changelog: rows[0] });
}

// ═══ 管理端：更新 ═══
export async function handleUpdateChangelog(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);

  const fields: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  for (const key of ["version", "title", "content", "tag"] as const) {
    if (body[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      vals.push(String(body[key]));
    }
  }
  if (body.published !== undefined) {
    fields.push(`published = $${idx++}`);
    vals.push(Boolean(body.published));
    if (body.published) {
      fields.push(`published_at = COALESCE(published_at, now())`);
    }
  }
  if (fields.length === 0) return sendJson(res, 400, { error: "没有要更新的字段" });

  fields.push(`updated_at = now()`);
  vals.push(id);
  const { rows } = await db.query(
    `UPDATE opc_changelogs SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    vals
  );
  if (!rows.length) return sendJson(res, 404, { error: "日志不存在" });
  sendJson(res, 200, { changelog: rows[0] });
}

// ═══ 管理端：删除 ═══
export async function handleDeleteChangelog(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  if (!requireAdmin(req, res)) return;
  await db.query("DELETE FROM opc_changelogs WHERE id = $1", [id]);
  sendJson(res, 200, { ok: true });
}

// ═══ 用户端：获取未读更新 ═══
export async function handleGetUnreadChangelogs(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    `SELECT c.* FROM opc_changelogs c
     WHERE c.published = true
       AND c.id NOT IN (SELECT changelog_id FROM opc_changelog_reads WHERE user_id = $1)
     ORDER BY c.published_at DESC
     LIMIT 10`,
    [userId]
  );
  sendJson(res, 200, { changelogs: rows });
}

// ═══ 用户端：标记已读 ═══
export async function handleMarkChangelogRead(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);
  const ids: string[] = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);

  if (!ids.length) return sendJson(res, 400, { error: "请提供更新 ID" });

  for (const id of ids) {
    await db.query(
      `INSERT INTO opc_changelog_reads (user_id, changelog_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, id]
    );
  }
  sendJson(res, 200, { ok: true, marked: ids.length });
}
