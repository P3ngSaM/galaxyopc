/**
 * 星环套餐订阅 API — 验证码→付款→密钥→激活
 *
 * 付款方式支持：
 *   1. 微信支付 Native（扫码支付，API v3）— 配置 WXPAY_APPID + WXPAY_MCHID + 证书
 *   2. 模拟付款（开发环境）— 未配置微信支付时自动降级
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, parseBody, requireAuth, requireAdmin } from "../auth/middleware.js";
import { sendVerifyCode, verifyCode } from "../auth/email-code.js";
import { getClientIp, hitRateLimit } from "../auth/rate-limit.js";
import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";

interface PlanDef {
  id: string;
  name: string;
  priceFen: number;
  quota: number;
  durationDays: number;
  features?: string[];
  desc?: string;
  sortOrder?: number;
}

const DEFAULT_PLANS: Record<string, PlanDef> = {
  starter:  {
    id: "starter", name: "入门版", priceFen: 990, quota: 2000, durationDays: 30, sortOrder: 1,
    desc: "轻量尝鲜，适合偶尔使用",
    features: ["2,000 算力点/月", "约 40-60 次 AI 对话", "搜索工具 +2 点/次", "模型：qwen3.6-plus", "1 个定时任务", "基础 AI 工具集"],
  },
  basic:    {
    id: "basic", name: "基础版", priceFen: 2990, quota: 8000, durationDays: 30, sortOrder: 2,
    desc: "日常轻度使用，性价比之选",
    features: ["8,000 算力点/月", "约 150-250 次 AI 对话", "搜索工具 +2 点/次", "邮件/网页抓取 +1 点/次", "模型：qwen3.6-plus + MiniMax M2.5", "5 个定时任务", "全部 AI 工具集"],
  },
  pro:      {
    id: "pro", name: "专业版", priceFen: 5990, quota: 25000, durationDays: 30, sortOrder: 3,
    desc: "解锁全部模型，适合重度业务使用",
    features: ["25,000 算力点/月", "约 450-800 次 AI 对话", "搜索工具 +2 点/次", "邮件/网页抓取 +1 点/次", "全部 4 款模型（含 GLM-5 / Kimi）", "20 个定时任务", "高级工具优先响应"],
  },
  ultimate: {
    id: "ultimate", name: "旗舰版", priceFen: 9990, quota: 60000, durationDays: 30, sortOrder: 4,
    desc: "超大算力包，高频使用首选",
    features: ["60,000 算力点/月", "约 1,000-1,800 次 AI 对话", "搜索工具 +2 点/次", "邮件/网页抓取 +1 点/次", "全部 4 款模型（含 GLM-5 / Kimi）", "无限定时任务", "专属客服 · 优先支持"],
  },
};
const PLANS: Record<string, PlanDef> = {};

export async function loadPlansFromDb(db: Db): Promise<void> {
  try {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = 'subscription_plans'");
    if (rows[0]?.value) {
      const saved = JSON.parse(rows[0].value) as Record<string, PlanDef>;
      for (const k of Object.keys(PLANS)) delete PLANS[k];
      for (const [k, v] of Object.entries(saved)) PLANS[k] = v;
    }
  } catch {}
  if (Object.keys(PLANS).length === 0) {
    Object.assign(PLANS, JSON.parse(JSON.stringify(DEFAULT_PLANS)));
  }
}

async function savePlansToDb(db: Db): Promise<void> {
  await db.query(
    "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    ["subscription_plans", JSON.stringify(PLANS)],
  );
}

export function getPlans(): Record<string, PlanDef> { return PLANS; }

function sortedPlans(): PlanDef[] {
  return Object.values(PLANS).sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
}

function generateSecretKey(planId: string): string {
  const prefix = "XH-" + planId.toUpperCase();
  const random = crypto.randomBytes(8).toString("hex").toUpperCase();
  return `${prefix}-${random}`;
}

// ── 微信支付配置 ──
const WXPAY_APPID = (process.env.WXPAY_APPID || "").trim();
const WXPAY_MCHID = (process.env.WXPAY_MCHID || "").trim();
const WXPAY_APIV3_KEY = (process.env.WXPAY_APIV3_KEY || "").trim();
const WXPAY_SERIAL_NO = (process.env.WXPAY_SERIAL_NO || "").trim();

function resolveCertPath(envVal: string): string {
  if (!envVal) return "";
  const trimmed = envVal.trim();
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(process.cwd(), trimmed);
}
const WXPAY_CERT_PATH = resolveCertPath(process.env.WXPAY_CERT_PATH || "");
const WXPAY_KEY_PATH = resolveCertPath(process.env.WXPAY_KEY_PATH || "");

const PAYMENT_ENABLED = !!(WXPAY_APPID && WXPAY_MCHID && WXPAY_KEY_PATH && WXPAY_APIV3_KEY);

let wxpay: any = null;
if (PAYMENT_ENABLED) {
  try {
    if (WXPAY_KEY_PATH && !fs.existsSync(WXPAY_KEY_PATH)) {
      throw new Error(`私钥文件不存在: ${WXPAY_KEY_PATH}`);
    }
    if (WXPAY_CERT_PATH && !fs.existsSync(WXPAY_CERT_PATH)) {
      throw new Error(`证书文件不存在: ${WXPAY_CERT_PATH}`);
    }
    const WxPay = (await import("wechatpay-node-v3")).default;
    wxpay = new WxPay({
      appid: WXPAY_APPID,
      mchid: WXPAY_MCHID,
      publicKey: WXPAY_CERT_PATH ? fs.readFileSync(WXPAY_CERT_PATH) : Buffer.from(""),
      privateKey: fs.readFileSync(WXPAY_KEY_PATH),
      serial_no: WXPAY_SERIAL_NO || undefined,
      key: WXPAY_APIV3_KEY,
    });
    console.log("[WxPay] 微信支付 Native 已初始化，商户号:", WXPAY_MCHID);
  } catch (e) {
    console.error("[WxPay] 初始化失败:", (e as Error).message);
  }
}

/**
 * POST /api/subscription/send-code
 * body: { email }
 */
export async function handleSubscriptionSendCode(req: AuthRequest, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const clientIp = getClientIp(req);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(res, 400, { error: "请输入有效的邮箱地址" });
    return;
  }

  if (hitRateLimit("sub:send-code:ip", clientIp, 10, 10 * 60_000) || hitRateLimit("sub:send-code:email", email, 3, 10 * 60_000)) {
    sendJson(res, 429, { error: "发送过于频繁，请稍后再试" });
    return;
  }

  const result = await sendVerifyCode(email);
  if (!result.ok) {
    sendJson(res, 429, { error: result.error });
    return;
  }

  sendJson(res, 200, { ok: true, message: "验证码已发送" });
}

/**
 * POST /api/subscription/verify
 * body: { email, code }
 */
export async function handleSubscriptionVerify(req: AuthRequest, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  if (!email || !code) {
    sendJson(res, 400, { error: "邮箱和验证码不能为空" });
    return;
  }

  const result = verifyCode(email, code);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error });
    return;
  }

  sendJson(res, 200, { ok: true, verified: true });
}

/**
 * POST /api/subscription/create
 * body: { email, plan_id }
 *
 * 微信支付可用时：创建 pending 订单 → 调微信 Native 下单 → 返回二维码 URL
 * 微信支付不可用时：模拟付款 → 直接生成密钥
 */
export async function handleSubscriptionCreate(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  const body = await parseBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const planId = String(body.plan_id || "").trim();

  if (!email || !planId) {
    sendJson(res, 400, { error: "缺少邮箱或套餐信息" });
    return;
  }

  const plan = PLANS[planId];
  if (!plan) {
    sendJson(res, 400, { error: "无效的套餐类型" });
    return;
  }

  const id = uuid();
  const secretKey = generateSecretKey(planId);
  const expiresAt = new Date(Date.now() + plan.durationDays * 86400_000).toISOString();
  const tradeNo = "OPC" + Date.now() + id.slice(0, 8).replace(/-/g, "");

  if (PAYMENT_ENABLED && wxpay) {
    try {
      const notifyUrl = (process.env.OPC_PUBLIC_URL || "http://localhost:3000") + "/api/subscription/notify";
      const result = await wxpay.transactions_native({
        appid: WXPAY_APPID,
        mchid: WXPAY_MCHID,
        description: `星环OPC ${plan.name} 月度套餐`,
        out_trade_no: tradeNo,
        notify_url: notifyUrl,
        amount: {
          total: plan.priceFen,
          currency: "CNY",
        },
      });

      const codeUrl = result.data?.code_url || result.code_url;
      if ((result.status === 200 || result.status === undefined) && codeUrl) {
        await db.query(
          `INSERT INTO opc_subscription_keys (id, user_email, plan_id, secret_key, status, amount_fen, expires_at, trade_no)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)`,
          [id, email, planId, secretKey, plan.priceFen, expiresAt, tradeNo],
        );
        let qrDataUrl = "";
        try {
          qrDataUrl = await QRCode.toDataURL(codeUrl, { width: 280, margin: 2, errorCorrectionLevel: "M" });
        } catch {}
        sendJson(res, 200, {
          ok: true,
          payment: true,
          pay_type: "wxpay_native",
          code_url: codeUrl,
          qr_img: qrDataUrl,
          trade_no: tradeNo,
          plan: plan.name,
          price: (plan.priceFen / 100).toFixed(1),
        });
      } else {
        console.error("[WxPay] Native 下单失败:", JSON.stringify(result));
        const errMsg = result.data?.message || result.message || "未知错误";
        sendJson(res, 500, { error: "微信支付下单失败: " + errMsg });
      }
    } catch (e) {
      console.error("[WxPay] create error:", (e as Error).message);
      sendJson(res, 500, { error: "创建支付订单失败" });
    }
    return;
  }

  // 模拟付款（开发环境 — 未配置微信支付）
  try {
    await db.query(
      `INSERT INTO opc_subscription_keys (id, user_email, plan_id, secret_key, status, amount_fen, expires_at, trade_no)
       VALUES ($1, $2, $3, $4, 'paid', $5, $6, $7)`,
      [id, email, planId, secretKey, plan.priceFen, expiresAt, tradeNo],
    );

    sendJson(res, 200, {
      ok: true,
      payment: false,
      secret_key: secretKey,
      plan: plan.name,
      price: (plan.priceFen / 100).toFixed(1),
      expires_at: expiresAt,
    });
  } catch (e) {
    console.error("[Subscription] create error:", (e as Error).message);
    sendJson(res, 500, { error: "创建订阅失败" });
  }
}

/**
 * POST /api/subscription/notify — 微信支付回调通知
 *
 * 微信支付成功后主动回调此地址，数据经 AES-256-GCM 加密。
 */
export async function handleWxPayNotify(req: IncomingMessage, res: ServerResponse, db: Db): Promise<void> {
  if (!wxpay || !WXPAY_APIV3_KEY) {
    res.writeHead(400); res.end(JSON.stringify({ code: "FAIL", message: "not configured" }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const rawBody = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";

  let notification: any;
  try {
    notification = JSON.parse(rawBody);
  } catch {
    res.writeHead(400); res.end(JSON.stringify({ code: "FAIL", message: "invalid json" }));
    return;
  }

  if (notification.event_type !== "TRANSACTION.SUCCESS") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "SUCCESS", message: "ignored" }));
    return;
  }

  const resource = notification.resource;
  if (!resource) {
    res.writeHead(400); res.end(JSON.stringify({ code: "FAIL", message: "no resource" }));
    return;
  }

  let decrypted: any;
  try {
    decrypted = wxpay.decipher_gcm(
      resource.ciphertext,
      resource.associated_data,
      resource.nonce,
      WXPAY_APIV3_KEY,
    );
    if (typeof decrypted === "string") decrypted = JSON.parse(decrypted);
  } catch (e) {
    console.error("[WxPay] 回调解密失败:", (e as Error).message);
    res.writeHead(400); res.end(JSON.stringify({ code: "FAIL", message: "decrypt error" }));
    return;
  }

  const tradeNo = decrypted.out_trade_no;
  const tradeState = decrypted.trade_state;
  const wxTransactionId = decrypted.transaction_id;

  if (tradeState === "SUCCESS" && tradeNo) {
    try {
      const { rows } = await db.query(
        "SELECT * FROM opc_subscription_keys WHERE trade_no = $1 AND status = 'pending'",
        [tradeNo],
      );
      if (rows[0]) {
        const sub = rows[0] as any;
        const now = new Date().toISOString();
        await db.query(
          "UPDATE opc_subscription_keys SET status = 'paid', paid_at = $1, wx_transaction_id = $2 WHERE id = $3",
          [now, wxTransactionId || "", sub.id],
        );
        console.log("[WxPay] 支付成功:", tradeNo, sub.plan_id, "transaction_id:", wxTransactionId);
      }
    } catch (e) {
      console.error("[WxPay] notify db error:", (e as Error).message);
      res.writeHead(500); res.end(JSON.stringify({ code: "FAIL", message: "db error" }));
      return;
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: "SUCCESS", message: "OK" }));
}

/**
 * GET /api/subscription/status?trade_no=xxx — 前端轮询支付状态
 */
export async function handleSubscriptionStatus(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const tradeNo = url.searchParams.get("trade_no") || "";

  if (!tradeNo) {
    sendJson(res, 400, { error: "缺少 trade_no" });
    return;
  }

  const { rows } = await db.query(
    "SELECT status, secret_key, plan_id FROM opc_subscription_keys WHERE trade_no = $1",
    [tradeNo],
  );
  const sub = rows[0] as any;
  if (!sub) {
    sendJson(res, 404, { error: "订单不存在" });
    return;
  }

  // 如果还是 pending 且微信支付可用，主动查询一次微信订单状态
  if (sub.status === "pending" && wxpay) {
    try {
      const queryResult = await wxpay.query({ out_trade_no: tradeNo, mchid: WXPAY_MCHID });
      const qrData = queryResult.data || queryResult;
      if (qrData.trade_state === "SUCCESS") {
        const now = new Date().toISOString();
        await db.query(
          "UPDATE opc_subscription_keys SET status = 'paid', paid_at = $1, wx_transaction_id = $2 WHERE trade_no = $3 AND status = 'pending'",
          [now, qrData.transaction_id || "", tradeNo],
        );
        sub.status = "paid";
      }
    } catch { /* query failed, use db status */ }
  }

  const paid = sub.status === "paid" || sub.status === "activated";
  sendJson(res, 200, {
    status: sub.status,
    paid,
    secret_key: paid ? sub.secret_key : undefined,
    plan: paid ? PLANS[sub.plan_id]?.name : undefined,
  });
}

/**
 * GET /api/subscription/my — 查询当前用户的订阅记录
 */
export async function handleMySubscriptions(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  try {
    const { rows: userRows } = await db.query(
      "SELECT plan, quota_total, quota_used, plan_expires, bonus_points FROM opc_users WHERE id = $1",
      [userId],
    );
    const user = userRows[0] as any;

    const { rows: keyRows } = await db.query(
      "SELECT id, plan_id, secret_key, status, amount_fen, created_at, activated_at, expires_at FROM opc_subscription_keys WHERE activated_by = $1 ORDER BY created_at DESC LIMIT 20",
      [userId],
    );

    const currentPlan = user?.plan || "free";
    const planDef = PLANS[currentPlan];

    sendJson(res, 200, {
      current: {
        plan: currentPlan,
        plan_name: planDef?.name || "免费版",
        quota_total: user?.quota_total || 0,
        quota_used: user?.quota_used || 0,
        quota_remaining: Math.max(0, (user?.quota_total || 0) - (user?.quota_used || 0)),
        bonus_points: user?.bonus_points || 0,
        expires_at: user?.plan_expires || null,
        is_active: !!(planDef && user?.plan_expires && new Date(user.plan_expires) > new Date()),
      },
      history: keyRows.map((r: any) => ({
        id: r.id,
        plan_id: r.plan_id,
        plan_name: PLANS[r.plan_id]?.name || r.plan_id,
        status: r.status,
        price: ((r.amount_fen || 0) / 100).toFixed(1),
        created_at: r.created_at,
        activated_at: r.activated_at,
        expires_at: r.expires_at,
      })),
      payment_enabled: PAYMENT_ENABLED,
      payment_provider: PAYMENT_ENABLED ? "wxpay" : "mock",
    });
  } catch (e) {
    console.error("[Subscription] my error:", (e as Error).message);
    sendJson(res, 500, { error: "查询订阅信息失败" });
  }
}

/**
 * POST /api/subscription/activate
 * body: { secret_key }
 */
export async function handleSubscriptionActivate(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const body = await parseBody(req);
  const secretKey = String(body.secret_key || "").trim();

  if (!secretKey) {
    sendJson(res, 400, { error: "请输入套餐密钥" });
    return;
  }

  try {
    const { rows } = await db.query(
      "SELECT * FROM opc_subscription_keys WHERE secret_key = $1",
      [secretKey],
    );
    const sub = rows[0] as any;

    if (!sub) {
      sendJson(res, 404, { error: "无效的密钥" });
      return;
    }

    if (sub.status === "activated") {
      sendJson(res, 400, { error: "此密钥已被使用" });
      return;
    }

    if (sub.status !== "paid") {
      sendJson(res, 400, { error: "此密钥状态异常：" + sub.status });
      return;
    }

    const plan = PLANS[sub.plan_id];
    if (!plan) {
      sendJson(res, 400, { error: "密钥关联的套餐不存在" });
      return;
    }

    const userId = req.user!.userId;
    const now = new Date().toISOString();

    await db.query(
      `UPDATE opc_subscription_keys SET status = 'activated', activated_by = $1, activated_at = $2 WHERE id = $3`,
      [userId, now, sub.id],
    );

    await db.query(
      `UPDATE opc_users SET plan = $1, quota_total = $2, quota_used = 0, plan_expires = $3 WHERE id = $4`,
      [sub.plan_id, plan.quota, sub.expires_at, userId],
    );

    // 激活套餐后自动切换 AI 模式为 cloud
    await db.query(
      `INSERT INTO opc_tool_config (key, value) VALUES ('ai_mode', 'cloud') ON CONFLICT (key) DO UPDATE SET value = 'cloud'`,
    ).catch(() => {});

    sendJson(res, 200, {
      ok: true,
      plan: plan.name,
      plan_id: plan.id,
      quota_total: plan.quota,
      expires_at: sub.expires_at,
      ai_mode: "cloud",
      message: `已激活「${plan.name}」套餐，${plan.quota} 算力点/月`,
    });
  } catch (e) {
    console.error("[Subscription] activate error:", (e as Error).message);
    sendJson(res, 500, { error: "激活失败" });
  }
}

/** GET /api/subscription/plans */
export async function handleGetPlans(_req: AuthRequest, res: ServerResponse): Promise<void> {
  const list = sortedPlans().map((p) => ({
    id: p.id,
    name: p.name,
    price: (p.priceFen / 100).toFixed(1),
    priceFen: p.priceFen,
    quota: p.quota,
    duration_days: p.durationDays,
    features: p.features || [],
    desc: p.desc || "",
    sortOrder: p.sortOrder ?? 99,
  }));
  sendJson(res, 200, { plans: list });
}

// ══════════════════════════════════════════════════════════════════
// 管理员订单管理 API
// ══════════════════════════════════════════════════════════════════

/** GET /api/admin/subscription-orders — 管理员查看所有订阅订单 + 金额汇总 */
export async function handleAdminSubscriptionOrders(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;

  try {
    const { rows } = await db.query(`
      SELECT k.id, k.user_email, k.plan_id, k.secret_key, k.status,
             k.amount_fen, k.trade_no, k.created_at, k.activated_at,
             k.expires_at, k.paid_at, k.activated_by,
             u.name as activated_by_name, u.phone as activated_by_phone
      FROM opc_subscription_keys k
      LEFT JOIN opc_users u ON u.id = k.activated_by
      ORDER BY k.created_at DESC
      LIMIT 500
    `);

    const totalRevenueFen = rows.reduce((s: number, r: any) =>
      s + (r.status === "paid" || r.status === "activated" ? (r.amount_fen || 0) : 0), 0);
    const paidCount = rows.filter((r: any) => r.status === "paid" || r.status === "activated").length;
    const pendingCount = rows.filter((r: any) => r.status === "pending").length;

    const byPlan: Record<string, { count: number; revenue: number }> = {};
    for (const r of rows as any[]) {
      if (r.status !== "paid" && r.status !== "activated") continue;
      const pid = r.plan_id || "unknown";
      if (!byPlan[pid]) byPlan[pid] = { count: 0, revenue: 0 };
      byPlan[pid].count++;
      byPlan[pid].revenue += r.amount_fen || 0;
    }

    sendJson(res, 200, {
      orders: rows.map((r: any) => ({
        id: r.id,
        email: r.user_email,
        plan_id: r.plan_id,
        plan_name: PLANS[r.plan_id]?.name || r.plan_id,
        secret_key: r.secret_key,
        status: r.status,
        amount: ((r.amount_fen || 0) / 100).toFixed(2),
        amount_fen: r.amount_fen || 0,
        trade_no: r.trade_no,
        created_at: r.created_at,
        paid_at: r.paid_at,
        activated_at: r.activated_at,
        expires_at: r.expires_at,
        activated_by_name: r.activated_by_name,
        activated_by_phone: r.activated_by_phone,
      })),
      summary: {
        total_orders: rows.length,
        paid_count: paidCount,
        pending_count: pendingCount,
        total_revenue: (totalRevenueFen / 100).toFixed(2),
        total_revenue_fen: totalRevenueFen,
        by_plan: Object.entries(byPlan).map(([pid, d]) => ({
          plan_id: pid,
          plan_name: PLANS[pid]?.name || pid,
          count: d.count,
          revenue: (d.revenue / 100).toFixed(2),
        })),
      },
    });
  } catch (e) {
    console.error("[Admin] subscription orders error:", (e as Error).message);
    sendJson(res, 500, { error: "查询订单失败" });
  }
}

/** DELETE /api/admin/subscription-orders/:id — 管理员删除订单 */
export async function handleAdminDeleteSubscriptionOrder(req: AuthRequest, res: ServerResponse, db: Db, orderId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;

  try {
    const { rowCount } = await db.query(
      "DELETE FROM opc_subscription_keys WHERE id = $1",
      [orderId],
    );
    if (!rowCount) {
      sendJson(res, 404, { error: "订单不存在" });
      return;
    }
    sendJson(res, 200, { ok: true, message: "订单已删除" });
  } catch (e) {
    console.error("[Admin] delete subscription order error:", (e as Error).message);
    sendJson(res, 500, { error: "删除失败" });
  }
}

/** GET /api/admin/plan-config — 获取套餐配置 */
export async function handleGetPlanConfig(req: AuthRequest, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { plans: sortedPlans() });
}

/** POST /api/admin/plan-config — 更新单个套餐 */
export async function handleUpdatePlanConfig(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  const planId = String(body.plan_id || "");
  if (!PLANS[planId]) {
    sendJson(res, 404, { error: "套餐不存在" });
    return;
  }
  if (typeof body.priceFen === "number") PLANS[planId].priceFen = body.priceFen;
  if (typeof body.quota === "number") PLANS[planId].quota = body.quota;
  if (typeof body.durationDays === "number") PLANS[planId].durationDays = body.durationDays;
  if (typeof body.name === "string" && body.name.trim()) PLANS[planId].name = body.name.trim();
  if (typeof body.desc === "string") PLANS[planId].desc = body.desc;
  if (Array.isArray(body.features)) PLANS[planId].features = body.features;
  if (typeof body.sortOrder === "number") PLANS[planId].sortOrder = body.sortOrder;
  try {
    await savePlansToDb(db);
    sendJson(res, 200, { ok: true, plan: PLANS[planId] });
  } catch (e) {
    sendJson(res, 500, { error: "保存失败" });
  }
}

/** POST /api/admin/plan-config/add — 新增套餐 */
export async function handleAddPlan(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  const planId = String(body.id || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!planId || planId.length < 2) {
    sendJson(res, 400, { error: "套餐 ID 无效（至少2个字母/数字）" });
    return;
  }
  if (PLANS[planId]) {
    sendJson(res, 409, { error: "套餐 ID 已存在" });
    return;
  }
  const name = String(body.name || planId).trim();
  const priceFen = typeof body.priceFen === "number" ? body.priceFen : 0;
  const quota = typeof body.quota === "number" ? body.quota : 1000;
  const durationDays = typeof body.durationDays === "number" ? body.durationDays : 30;
  const sortOrder = typeof body.sortOrder === "number" ? body.sortOrder : Object.keys(PLANS).length + 1;
  const features: string[] = Array.isArray(body.features) ? body.features : [];
  const desc: string = typeof body.desc === "string" ? body.desc : "";
  PLANS[planId] = { id: planId, name, priceFen, quota, durationDays, sortOrder, features, desc };
  try {
    await savePlansToDb(db);
    sendJson(res, 200, { ok: true, plan: PLANS[planId] });
  } catch (e) {
    delete PLANS[planId];
    sendJson(res, 500, { error: "保存失败" });
  }
}

/** DELETE /api/admin/plan-config/:id — 删除套餐 */
export async function handleDeletePlan(req: AuthRequest, res: ServerResponse, db: Db, planId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;
  if (!PLANS[planId]) {
    sendJson(res, 404, { error: "套餐不存在" });
    return;
  }
  const backup = PLANS[planId];
  delete PLANS[planId];
  try {
    await savePlansToDb(db);
    sendJson(res, 200, { ok: true, deleted: planId });
  } catch (e) {
    PLANS[planId] = backup;
    sendJson(res, 500, { error: "删除失败" });
  }
}
