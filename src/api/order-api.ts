/**
 * 订单 & 支付 API
 *
 * 当前实现：手动扫码支付（微信客服），后续可接入微信/支付宝原生支付 SDK。
 * 流程：
 *   1. POST /api/orders          — 创建订单，返回 orderId + qrUrl
 *   2. GET  /api/orders/:id      — 轮询订单状态
 *   3. POST /api/orders/:id/pay  — (管理员)手动标记为已付款并开通套餐
 */

import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { requireAuth, sendJson, parseBody, requireAdmin } from "../auth/middleware.js";
import { randomUUID } from "node:crypto";

// 套餐配置（价格单位：分）
const PLAN_CONFIG: Record<string, { name: string; amountFen: number; quotaTotal: number; months: number }> = {
  plus:  { name: "Plus 会员",  amountFen: 1990,  quotaTotal: 3000,   months: 1 },
  pro:   { name: "Pro 会员",   amountFen: 4900,  quotaTotal: 10000,  months: 1 },
  ultra: { name: "Ultra 会员", amountFen: 9900,  quotaTotal: 30000,  months: 1 },
};

// 客服微信二维码（管理员可通过环境变量覆盖）
const WECHAT_SERVICE_QR = process.env.WECHAT_SERVICE_QR_URL || "";

/** POST /api/orders — 创建订单 */
export async function handleCreateOrder(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);
  const planId = (body.plan_id as string || "").toLowerCase();

  const plan = PLAN_CONFIG[planId];
  if (!plan) {
    sendJson(res, 400, { error: "无效的套餐 ID" });
    return;
  }

  const orderId = randomUUID();
  // 订单5分钟内有效
  const expiredAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  await db.query(
    `INSERT INTO opc_orders (id, user_id, plan_id, amount_fen, status, pay_type, qr_url, expired_at)
     VALUES ($1, $2, $3, $4, 'pending', 'wechat', $5, $6)`,
    [orderId, userId, planId, plan.amountFen, WECHAT_SERVICE_QR, expiredAt]
  );

  sendJson(res, 200, {
    order_id: orderId,
    plan_id: planId,
    plan_name: plan.name,
    amount_fen: plan.amountFen,
    amount_yuan: (plan.amountFen / 100).toFixed(2),
    qr_url: WECHAT_SERVICE_QR,
    pay_type: "wechat_service",
    expired_at: expiredAt,
    tip: "请扫码联系客服，并备注订单号: " + orderId.slice(0, 8),
  });
}

/** GET /api/orders/:id — 查询订单状态 */
export async function handleGetOrder(req: AuthRequest, res: ServerResponse, db: Db, orderId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    `SELECT id, plan_id, amount_fen, status, paid_at, expired_at, created_at FROM opc_orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  if (!rows.length) {
    sendJson(res, 404, { error: "订单不存在" });
    return;
  }
  const o = rows[0] as { id: string; plan_id: string; amount_fen: number; status: string; paid_at: string | null; expired_at: string; created_at: string };
  const plan = PLAN_CONFIG[o.plan_id] || { name: o.plan_id, amountFen: o.amount_fen, quotaTotal: 500, months: 1 };
  sendJson(res, 200, {
    order_id: o.id,
    plan_id: o.plan_id,
    plan_name: plan.name,
    amount_yuan: (o.amount_fen / 100).toFixed(2),
    status: o.status,
    paid_at: o.paid_at,
    expired_at: o.expired_at,
    created_at: o.created_at,
  });
}

/** POST /api/orders/:id/confirm — 管理员手动确认付款 & 开通套餐 */
export async function handleConfirmOrder(req: AuthRequest, res: ServerResponse, db: Db, orderId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const { rows } = await db.query(
    `SELECT id, user_id, plan_id, status FROM opc_orders WHERE id = $1`,
    [orderId]
  );
  if (!rows.length) {
    sendJson(res, 404, { error: "订单不存在" });
    return;
  }
  const o = rows[0] as { id: string; user_id: string; plan_id: string; status: string };
  if (o.status !== "pending") {
    sendJson(res, 400, { error: `订单状态为 ${o.status}，无法重复确认` });
    return;
  }

  const plan = PLAN_CONFIG[o.plan_id];
  if (!plan) {
    sendJson(res, 400, { error: "未知套餐配置" });
    return;
  }

  const now = new Date();
  const planExpires = new Date(now);
  planExpires.setMonth(planExpires.getMonth() + plan.months);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // 标记订单已支付
    await client.query(
      `UPDATE opc_orders SET status = 'paid', paid_at = $1 WHERE id = $2`,
      [now.toISOString(), orderId]
    );
    // 升级用户套餐
    await client.query(
      `UPDATE opc_users SET plan = $1, quota_total = $2, plan_expires = $3, quota_used = 0, quota_reset_at = $4 WHERE id = $5`,
      [o.plan_id, plan.quotaTotal, planExpires.toISOString(), planExpires.toISOString(), o.user_id]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  sendJson(res, 200, { ok: true, message: `已为用户开通 ${plan.name}，有效期至 ${planExpires.toLocaleDateString("zh-CN")}` });
}

/** GET /api/admin/orders — 管理员查看所有待确认订单 */
export async function handleListOrders(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const { rows } = await db.query(`
    SELECT o.id, o.user_id, u.name as user_name, u.phone as user_phone, o.plan_id, o.amount_fen, o.status, o.paid_at, o.created_at
    FROM opc_orders o JOIN opc_users u ON u.id = o.user_id
    ORDER BY o.created_at DESC LIMIT 100
  `);
  sendJson(res, 200, { orders: rows });
}

/** GET /api/orders — 当前用户的订单列表 */
export async function handleListUserOrders(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    `SELECT id, plan_id, amount_fen, status, paid_at, expired_at, created_at
     FROM opc_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  sendJson(res, 200, { orders: rows });
}

/** POST /api/orders/:id/cancel — 用户取消待付款订单 */
export async function handleCancelOrder(req: AuthRequest, res: ServerResponse, db: Db, orderId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    `SELECT id, status FROM opc_orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  if (!rows.length) {
    sendJson(res, 404, { error: "订单不存在" });
    return;
  }
  const o = rows[0] as { id: string; status: string };
  if (o.status !== "pending") {
    sendJson(res, 400, { error: "只有待付款订单可以取消" });
    return;
  }
  await db.query(`UPDATE opc_orders SET status = 'cancelled' WHERE id = $1`, [orderId]);
  sendJson(res, 200, { ok: true });
}

/** DELETE /api/orders/:id — 用户删除已完成/取消/过期的订单 */
export async function handleDeleteOrder(req: AuthRequest, res: ServerResponse, db: Db, orderId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query(
    `SELECT id, status FROM opc_orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  );
  if (!rows.length) {
    sendJson(res, 404, { error: "订单不存在" });
    return;
  }
  const o = rows[0] as { id: string; status: string };
  if (o.status === "pending") {
    sendJson(res, 400, { error: "待付款订单请先取消再删除" });
    return;
  }
  await db.query(`DELETE FROM opc_orders WHERE id = $1`, [orderId]);
  sendJson(res, 200, { ok: true });
}
