/**
 * 管理端 API — 用户管理、园区管理（给城投管理员用）
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAdmin, requireAuth, parseBody } from "../auth/middleware.js";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { getAllPendingApprovals, resolveApproval } from "../local-agent/security.js";

type ProvinceIntelJob = {
  id: string;
  province: string;
  centerAddress: string;
  status: "running" | "success" | "error";
  startedAt: string;
  endedAt?: string;
  pid?: number;
  targetsPath: string;
  outputDir: string;
  aggregatePath: string;
  mapPath: string;
  progress: string[];
  error?: string;
};

const provinceIntelJobs = new Map<string, ProvinceIntelJob>();
const PARK_IMAGE_DIR = path.resolve(process.cwd(), path.basename(process.cwd()) === "opc-server" ? "uploads" : "opc-server/uploads", "park-images");
const FEATURED_CENTER_SEEDS: Record<string, Record<string, unknown>> = {
  "featured-chengdu-opc-center": {
    id: "featured-chengdu-opc-center",
    name: "星环OPC中心",
    region: "四川省成都市双流区怡心街道",
    city_name: "成都市",
    address: "四川省成都市双流区怡心街道华府大道四段双兴大道1号电子科技大学科技园B区12栋4单元7F",
    lat: 30.47083,
    lng: 104.00872,
    total_seats: 60,
    used_seats: 10,
    contact_name: "星环OPC 成都运营组",
    contact_phone: "",
    recruit_info: "依托电子科技大学科技园（天府园）区位与科创资源，作为星环 OPC 成都核心节点，承接产品孵化、城市网点运营和资源分发。",
    recruit_open: true,
    tags: "OPC中心,成都核心节点,电子科大科技园,资源分发",
    status: "active",
    creator_id: "",
  },
  "featured-bazhong-opc-center": {
    id: "featured-bazhong-opc-center",
    name: "巴中·星环OPC中心",
    region: "四川省巴中市巴州区",
    city_name: "巴中市",
    address: "四川巴中经济开发区",
    lat: 31.8679,
    lng: 106.7473,
    total_seats: 100,
    used_seats: 18,
    contact_name: "星环OPC 巴中筹开组",
    contact_phone: "",
    recruit_info: "依托巴中经开区，面向数字游民、独立开发者、跨境电商和智慧文旅创业者，建设轻组织、重系统的一人公司孵化加速器。",
    recruit_open: true,
    tags: "巴中市,工位100,OPC中心",
    status: "active",
    creator_id: "",
  },
  "featured-qujing-opc-center": {
    id: "featured-qujing-opc-center",
    name: "曲靖·星环OPC中心",
    region: "云南省曲靖市麒麟区",
    city_name: "曲靖市",
    address: "云南省曲靖市麒麟区",
    lat: 25.49,
    lng: 103.7963,
    total_seats: 80,
    used_seats: 12,
    contact_name: "星环OPC 曲靖筹备组",
    contact_phone: "",
    recruit_info: "聚焦曲靖作为云南重要产业与交通枢纽的区位优势，布局适合一人公司的轻创业、轻协作、轻交付资源网络。",
    recruit_open: true,
    tags: "曲靖市,工位80,OPC中心",
    status: "active",
    creator_id: "",
  },
};

type GeocodeFallbackPoint = {
  longitude: number;
  latitude: number;
  formattedAddress: string;
  province: string;
  city: string;
  district: string;
  keywords: string[];
};

let geocodeFallbackCache: GeocodeFallbackPoint[] | null = null;

function normalizeLocationText(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[·,，。:：;；、\-]/g, "")
    .trim();
}

function inferProvinceFromAddress(address: string): string {
  const text = String(address || "");
  const match = text.match(/(.+?(?:省|市|自治区|特别行政区))/);
  return match?.[1] || "";
}

function decodeBase64Image(dataUri: string): { buffer: Buffer; ext: string } | null {
  const match = String(dataUri || "").match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!match) return null;
  const extRaw = String(match[1] || "").toLowerCase();
  const ext = extRaw === "jpeg" ? "jpg" : extRaw;
  if (!["jpg", "png", "webp", "gif"].includes(ext)) return null;
  try {
    return { buffer: Buffer.from(match[2], "base64"), ext };
  } catch {
    return null;
  }
}

async function parseLargeJsonBody(req: AuthRequest, maxSize = 40 * 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`请求体过大（超过 ${Math.round(maxSize / 1024 / 1024)}MB）`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function isLegacyParkApplicationColumnError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || "");
  const message = String((error as { message?: unknown })?.message || error || "");
  if (code !== "42703" && !/no such column/i.test(message) && !/不存在/i.test(message)) return false;
  return /(apply_reason|company_projects|monetization_plan|contact_mobile|expectation|review_note|approved_points)/i.test(message);
}

function normalizeParkApplicationRow<T extends Record<string, unknown>>(row: T): T & Record<string, unknown> {
  return {
    ...row,
    apply_reason: row.apply_reason ?? row.message ?? "",
    company_projects: row.company_projects ?? "",
    monetization_plan: row.monetization_plan ?? "",
    contact_mobile: row.contact_mobile ?? "",
    expectation: row.expectation ?? "",
    review_note: row.review_note ?? "",
    approved_points: Number(row.approved_points || 0),
  };
}

function normalizeParkApplicationRows<T extends Record<string, unknown>>(rows: T[]): Array<T & Record<string, unknown>> {
  return rows.map((row) => normalizeParkApplicationRow(row));
}

function loadGeocodeFallbackPoints(): GeocodeFallbackPoint[] {
  if (geocodeFallbackCache) return geocodeFallbackCache;

  const candidates = [
    path.resolve(process.cwd(), "research", "southwest-opportunity-map.json"),
    path.resolve(process.cwd(), "research", "yunnan-opportunity-map.json"),
    path.resolve(process.cwd(), "research", "sichuan-opportunity-map.json"),
    path.resolve(process.cwd(), "research", "dazhu-opportunity-map.json"),
    path.resolve(process.cwd(), "opc-server", "research", "southwest-opportunity-map.json"),
    path.resolve(process.cwd(), "opc-server", "research", "yunnan-opportunity-map.json"),
    path.resolve(process.cwd(), "opc-server", "research", "sichuan-opportunity-map.json"),
    path.resolve(process.cwd(), "opc-server", "research", "dazhu-opportunity-map.json"),
  ];

  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as {
        industries?: Record<string, unknown>[];
        opportunities?: Record<string, unknown>[];
      };
      const allItems = [...(raw.industries || []), ...(raw.opportunities || [])];
      const points = allItems
        .map((item) => {
          const longitude = Number(item.longitude);
          const latitude = Number(item.latitude);
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
          const address = String(item.address || "");
          const province = String(item.province || "") || inferProvinceFromAddress(address);
          const city = String(item.city || "");
          const district = String(item.county || item.district || "");
          const keywords = [
            address,
            item.name,
            item.title,
            item.targetOrg,
            province,
            city,
            district,
            `${province}${city}${district}`,
            `${city}${district}`,
          ]
            .map(normalizeLocationText)
            .filter(Boolean);
          return {
            longitude,
            latitude,
            formattedAddress: address || `${province}${city}${district}`,
            province,
            city,
            district,
            keywords,
          } satisfies GeocodeFallbackPoint;
        })
        .filter((item): item is GeocodeFallbackPoint => !!item);

      if (points.length) {
        geocodeFallbackCache = points;
        return points;
      }
    } catch (error) {
      console.warn("[Geocode] load fallback map failed:", filePath, error);
    }
  }

  geocodeFallbackCache = [];
  return geocodeFallbackCache;
}

function lookupGeocodeFallback(address: string, cityHint: string): GeocodeFallbackPoint | null {
  const points = loadGeocodeFallbackPoints();
  if (!points.length) return null;

  const normalizedAddress = normalizeLocationText(address);
  const normalizedCityHint = normalizeLocationText(cityHint);
  let bestScore = 0;
  let bestPoint: GeocodeFallbackPoint | null = null;

  for (const point of points) {
    let score = 0;
    for (const keyword of point.keywords) {
      if (!keyword) continue;
      if (normalizedAddress === keyword) score += 100;
      else if (normalizedAddress.includes(keyword)) score += Math.min(80, keyword.length * 4);
      else if (keyword.includes(normalizedAddress) && normalizedAddress.length >= 4) score += Math.min(60, normalizedAddress.length * 3);
    }
    if (normalizedCityHint) {
      const pointCity = normalizeLocationText(point.city);
      const pointDistrict = normalizeLocationText(point.district);
      if (normalizedCityHint === pointCity) score += 20;
      if (normalizedAddress.includes(pointDistrict)) score += 12;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPoint = point;
    }
  }

  return bestScore >= 12 ? bestPoint : null;
}

function toProvinceSlug(province: string): string {
  return String(province || "").replace(/省|市|自治区|回族|壮族|维吾尔|特别行政区/g, "").trim() || "province";
}

function listProvinceIntelJobs(): ProvinceIntelJob[] {
  return [...provinceIntelJobs.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// ─── 管理面板统计 ──────────────────────────────────────────────────────

export async function handleAdminStats(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const { rows: userRows } = await db.query("SELECT COUNT(*) as c FROM opc_users");
  const userCount = userRows[0] as { c: string };
  const { rows: companyRows } = await db.query("SELECT COUNT(*) as c FROM opc_companies");
  const companyCount = companyRows[0] as { c: string };
  const { rows: cityRows } = await db.query("SELECT COUNT(*) as c FROM opc_cities");
  const cityCount = cityRows[0] as { c: string };
  const { rows: seatStats } = await db.query("SELECT status, COUNT(*)::int as c FROM opc_seats GROUP BY status");
  const { rows: todayUserRows } = await db.query(
    "SELECT COUNT(*) as c FROM opc_users WHERE created_at::date = CURRENT_DATE",
  );
  const todayUsers = todayUserRows[0] as { c: string };
  const { rows: todayCompanyRows } = await db.query(
    "SELECT COUNT(*) as c FROM opc_companies WHERE created_at::date = CURRENT_DATE",
  );
  const todayCompanies = todayCompanyRows[0] as { c: string };

  sendJson(res, 200, {
    users: Number(userCount.c),
    companies: Number(companyCount.c),
    cities: Number(cityCount.c),
    seats: seatStats,
    today_users: Number(todayUsers.c),
    today_companies: Number(todayCompanies.c),
  });
}

export async function handleGetToolAuditLog(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const limit = Math.max(20, Math.min(200, Number(new URL(req.url || "/", "http://localhost").searchParams.get("limit")) || 100));
  const { rows } = await db.query(
    `SELECT l.id, l.user_id, l.tool, l.args, l.result, l.risk_level, l.approved, l.created_at,
            u.name AS user_name, u.phone AS user_phone, u.email AS user_email
     FROM opc_local_audit_log l
     LEFT JOIN opc_users u ON u.id = l.user_id
     ORDER BY l.created_at DESC
     LIMIT $1`,
    [limit],
  );
  sendJson(res, 200, { logs: rows });
}

export async function handleGetToolApprovals(req: AuthRequest, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { approvals: getAllPendingApprovals() });
}

export async function handleResolveToolApproval(req: AuthRequest, res: ServerResponse, approvalId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  const approved = body.approved === true;
  const ok = resolveApproval(approvalId, approved);
  if (!ok) {
    sendJson(res, 404, { error: "审批请求不存在或已处理" });
    return;
  }
  sendJson(res, 200, { success: true, approved });
}

export async function handleListProvinceIntelJobs(req: AuthRequest, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { jobs: listProvinceIntelJobs() });
}

export async function handleStartProvinceIntel(req: AuthRequest, res: ServerResponse): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  const province = String(body.province || "").trim();
  const centerAddress = String(body.center_address || body.centerAddress || province).trim();
  const city = String(body.city || "").trim();
  const limit = Math.max(1, Number(body.limit) || 5);
  const delayMs = Math.max(0, Number(body.delay_ms || body.delayMs) || 800);
  const maxTargets = Math.max(0, Number(body.max_targets || body.maxTargets) || 0);
  if (!province) {
    sendJson(res, 400, { error: "province 必填" });
    return;
  }

  const running = listProvinceIntelJobs().find((item) => item.province === province && item.status === "running");
  if (running) {
    sendJson(res, 400, { error: `${province} 已有进行中的任务`, job: running });
    return;
  }

  const slug = toProvinceSlug(province);
  const today = new Date().toISOString().slice(0, 10);
  const targetsPath = path.resolve(process.cwd(), "research", `${slug}-targets.json`);
  const outputDir = path.resolve(process.cwd(), "research", slug);
  const aggregatePath = path.resolve(process.cwd(), "research", `${province}-产业与机会总览-${today}.json`);
  const mapPath = path.resolve(process.cwd(), "research", `${slug}-opportunity-map.json`);
  const job: ProvinceIntelJob = {
    id: uuid(),
    province,
    centerAddress,
    status: "running",
    startedAt: new Date().toISOString(),
    targetsPath,
    outputDir,
    aggregatePath,
    mapPath,
    progress: [`[${new Date().toLocaleString("zh-CN")}] 已创建任务，准备启动`],
  };
  provinceIntelJobs.set(job.id, job);

  const scriptPath = path.resolve(process.cwd(), "scripts", "run-province-intel-pipeline.mjs");
  const child = spawn(process.execPath, [
    scriptPath,
    "--province", province,
    "--center-address", centerAddress,
    "--output-dir", path.relative(process.cwd(), outputDir),
    "--targets", path.relative(process.cwd(), targetsPath),
    "--limit", String(limit),
    "--delay-ms", String(delayMs),
    ...(city ? ["--city", city] : []),
    ...(maxTargets > 0 ? ["--max-targets", String(maxTargets)] : []),
  ], {
    cwd: process.cwd(),
    windowsHide: true,
    env: process.env,
  });

  job.pid = child.pid;
  job.progress.push(`[${new Date().toLocaleString("zh-CN")}] 进程已启动 PID=${String(child.pid || "-")}`);

  const appendLog = (chunk: Buffer | string, tag: "OUT" | "ERR") => {
    const text = String(chunk || "").trim();
    if (!text) return;
    text.split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      job.progress.push(`[${tag}] ${line}`);
    });
    if (job.progress.length > 120) job.progress = job.progress.slice(-120);
  };

  child.stdout.on("data", (chunk) => appendLog(chunk, "OUT"));
  child.stderr.on("data", (chunk) => appendLog(chunk, "ERR"));
  child.on("error", (error) => {
    job.status = "error";
    job.endedAt = new Date().toISOString();
    job.error = error.message || String(error);
    job.progress.push(`[ERR] ${job.error}`);
  });
  child.on("exit", (code) => {
    job.endedAt = new Date().toISOString();
    if (code === 0) {
      job.status = "success";
      job.progress.push(`[${new Date().toLocaleString("zh-CN")}] 任务完成`);
    } else {
      job.status = "error";
      job.error = `进程退出码 ${String(code)}`;
      job.progress.push(`[ERR] ${job.error}`);
    }
  });

  sendJson(res, 200, { ok: true, job });
}

// ─── 用户列表 ──────────────────────────────────────────────────────────

export async function handleListUsers(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const { rows: users } = await db.query(
    `SELECT id, phone, name, email, role, city_id, status, plan, quota_total, quota_used, bonus_points, selected_model, quota_reset_at, swarm_reset_baseline, created_at, last_login
     FROM opc_users ORDER BY created_at DESC LIMIT 200`,
  );

  const enriched: Record<string, unknown>[] = [];
  for (const u of users as { id: string; swarm_reset_baseline?: number }[]) {
    const { rows: cntRows } = await db.query("SELECT COUNT(*) as c FROM opc_user_companies WHERE user_id = $1", [
      u.id,
    ]);
    const { rows: todayRows } = await db.query(
      `SELECT COALESCE(SUM(cost_points),0) as today FROM opc_usage_log WHERE user_id = $1 AND created_at >= date_trunc('day', NOW())`,
      [u.id],
    );
    const { rows: swarmRows } = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM opc_swarm_sessions WHERE user_id = $1",
      [u.id],
    );
    const swarmTotal = Number((swarmRows[0] as { cnt?: number } | undefined)?.cnt || 0);
    const swarmUsed = Math.max(0, swarmTotal - Number(u.swarm_reset_baseline || 0));
    enriched.push({ ...u, company_count: Number(cntRows[0].c), today_points: Number(todayRows[0].today), swarm_used: swarmUsed });
  }

  sendJson(res, 200, { users: enriched });
}

// ─── 更新用户（状态、角色） ───────────────────────────────────────────

export async function handleUpdateUser(req: AuthRequest, res: ServerResponse, db: Db, userId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const body = await parseBody(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (body.role !== undefined) {
    sets.push(`role = $${idx++}`);
    vals.push(String(body.role));
  }
  if (body.status !== undefined) {
    sets.push(`status = $${idx++}`);
    vals.push(String(body.status));
  }
  if (body.city_id !== undefined) {
    sets.push(`city_id = $${idx++}`);
    vals.push(String(body.city_id));
  }
  if (body.reset_quota === true) {
    sets.push(`quota_used = 0`);
  }
  if (body.reset_swarm === true) {
    const { rows: swarmRows } = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM opc_swarm_sessions WHERE user_id = $1",
      [userId],
    );
    const swarmTotal = Number((swarmRows[0] as { cnt?: number } | undefined)?.cnt || 0);
    sets.push(`swarm_reset_baseline = $${idx++}`);
    vals.push(swarmTotal);
  }
  if (typeof body.quota_total === "number" && body.quota_total >= 0) {
    sets.push(`quota_total = $${idx++}`);
    vals.push(body.quota_total);
  }
  if (typeof body.bonus_points === "number" && body.bonus_points >= 0) {
    sets.push(`bonus_points = $${idx++}`);
    vals.push(body.bonus_points);
  }
  if (body.plan !== undefined && ["free", "pro", "ultra"].includes(String(body.plan))) {
    sets.push(`plan = $${idx++}`);
    vals.push(String(body.plan));
  }

  if (sets.length === 0) {
    sendJson(res, 400, { error: "无更新内容" });
    return;
  }

  vals.push(userId);
  await db.query(`UPDATE opc_users SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

  const { rows } = await db.query(
    "SELECT id, phone, name, email, role, city_id, status, swarm_reset_baseline FROM opc_users WHERE id = $1",
    [userId],
  );
  const user = rows[0];
  sendJson(res, 200, { user });
}

// ─── 删除用户 ──────────────────────────────────────────────────────────

export async function handleDeleteUser(req: AuthRequest, res: ServerResponse, db: Db, userId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;

  if (userId === req.user!.userId) {
    sendJson(res, 400, { error: "不能删除自己" });
    return;
  }

  const { rows } = await db.query("SELECT role FROM opc_users WHERE id = $1", [userId]);
  if (!rows[0]) {
    sendJson(res, 404, { error: "用户不存在" });
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM opc_points_log WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM opc_feedback_votes WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM opc_feedback WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM opc_chat_messages WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM opc_chat_conversations WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM opc_usage_log WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM opc_user_memories WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM opc_users WHERE id = $1", [userId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[handleDeleteUser] error:", e);
    sendJson(res, 500, { error: "删除失败" });
    return;
  } finally {
    client.release();
  }

  sendJson(res, 200, { success: true });
}

// ─── 公开城市列表（所有登录用户可用）──────────────────────────────────

export async function handlePublicCities(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  await ensureAllFeaturedCenterParks(db);
  const { rows } = await db.query(
    "SELECT id, name, region, address, cover_image, cover_images, lat, lng, city_name, total_seats, used_seats, contact_name, contact_phone, recruit_info, recruit_open, tags, creator_id, status FROM opc_cities WHERE status = 'active' ORDER BY region, name"
  );
  sendJson(res, 200, { cities: rows });
}

// ─── 地图数据（所有点位：用户 + 园区）──────────────────────────────────

export async function handleMapData(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  await ensureAllFeaturedCenterParks(db);

  const { rows: parks } = await db.query(
    "SELECT id, name, region, address, cover_image, cover_images, lat, lng, city_name, total_seats, used_seats, contact_name, contact_phone, recruit_open, recruit_info, tags, status FROM opc_cities WHERE status = 'active' AND lat != 0 AND lng != 0"
  );

  const { rows: users } = await db.query(
    `SELECT user_province, user_city, user_district, COUNT(*)::int as count
     FROM opc_users WHERE user_city != ''
     GROUP BY user_province, user_city, user_district
     ORDER BY count DESC`
  );

  sendJson(res, 200, { parks, users });
}

const DEFAULT_PARK_RESOURCE_TEMPLATES = [
  {
    resource_type: "desk",
    name: "共享工位",
    description: "适合日常办公、接待和短时驻场使用，默认按半天或全天登记。",
    points_cost: 30,
    capacity: 20,
    unit_label: "次",
    requires_approval: false,
  },
  {
    resource_type: "meeting_room",
    name: "会议室",
    description: "适合商务洽谈、小型提案会和远程会议，建议提前预约。",
    points_cost: 80,
    capacity: 2,
    unit_label: "小时",
    requires_approval: true,
  },
  {
    resource_type: "printer",
    name: "打印机",
    description: "支持日常文档打印与方案资料输出。",
    points_cost: 10,
    capacity: 1,
    unit_label: "次",
    requires_approval: false,
  },
];

async function ensureDefaultParkResources(db: Db | any, parkId: string): Promise<void> {
  const { rows } = await db.query("SELECT COUNT(*)::int AS count FROM opc_park_resources WHERE park_id = $1", [parkId]);
  if (Number(rows[0]?.count || 0) > 0) return;
  for (const template of DEFAULT_PARK_RESOURCE_TEMPLATES) {
    await db.query(
      `INSERT INTO opc_park_resources
       (id, park_id, name, resource_type, description, points_cost, capacity, unit_label, requires_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uuid(), parkId, template.name, template.resource_type, template.description, template.points_cost, template.capacity, template.unit_label, template.requires_approval],
    );
  }
}

function getFeaturedCenterSeed(parkId: string): Record<string, unknown> | null {
  return FEATURED_CENTER_SEEDS[parkId] || null;
}

async function ensureAllFeaturedCenterParks(db: Db): Promise<void> {
  for (const parkId of Object.keys(FEATURED_CENTER_SEEDS)) {
    await ensureFeaturedCenterPark(db, parkId);
  }
}

async function ensureFeaturedCenterPark(db: Db, parkId: string): Promise<Record<string, any> | null> {
  const seed = getFeaturedCenterSeed(parkId);
  if (!seed) return null;
  const existing = await db.query("SELECT * FROM opc_cities WHERE id = $1", [parkId]);
  if (existing.rows[0]) return existing.rows[0];
  await db.query(
    `INSERT INTO opc_cities
     (id, name, region, address, cover_image, cover_images, total_seats, used_seats, contact_name, contact_phone, status, lat, lng, city_name, creator_id, recruit_info, recruit_open, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (id) DO NOTHING`,
    [
      String(seed.id || parkId),
      String(seed.name || ""),
      String(seed.region || ""),
      String(seed.address || ""),
      String(seed.cover_image || ""),
      String(seed.cover_images || ""),
      Number(seed.total_seats || 0),
      Number(seed.used_seats || 0),
      String(seed.contact_name || ""),
      String(seed.contact_phone || ""),
      String(seed.status || "active"),
      Number(seed.lat || 0),
      Number(seed.lng || 0),
      String(seed.city_name || ""),
      String(seed.creator_id || ""),
      String(seed.recruit_info || ""),
      Boolean(seed.recruit_open),
      String(seed.tags || ""),
    ],
  );
  const { rows } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [parkId]);
  return rows[0] || null;
}

async function getParkById(db: Db, parkId: string): Promise<Record<string, any> | null> {
  const { rows } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [parkId]);
  if (rows[0]) return rows[0];
  return await ensureFeaturedCenterPark(db, parkId);
}

function canManagePark(req: AuthRequest, park: Record<string, any> | null): boolean {
  if (!req.user || !park) return false;
  return req.user.role === "admin" || park.creator_id === req.user.userId;
}

function sanitizeText(value: unknown, limit = 1000): string {
  return String(value || "").trim().slice(0, limit);
}

function buildMembershipPassCode(userId: string, parkId: string): string {
  return `${parkId.slice(0, 4).toUpperCase()}-${userId.slice(0, 4).toUpperCase()}-${Date.now().toString().slice(-6)}`;
}

// ─── 普通用户创建园区 ──────────────────────────────────────────────────

export async function handleUserListParks(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  await ensureAllFeaturedCenterParks(db);
  const { rows } = await db.query(
    "SELECT * FROM opc_cities WHERE creator_id = $1 ORDER BY created_at DESC",
    [req.user!.userId],
  );
  sendJson(res, 200, { parks: rows });
}

export async function handleUserCreatePark(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const body = await parseBody(req);
  const name = String(body.name || "").trim();
  if (!name) { sendJson(res, 400, { error: "园区名称不能为空" }); return; }
  if (!body.lat || !body.lng) { sendJson(res, 400, { error: "请选择园区位置" }); return; }

  const id = uuid();
  const totalSeats = Number(body.total_seats) || 0;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO opc_cities (id, name, region, address, cover_image, cover_images, total_seats, contact_name, contact_phone, status, lat, lng, city_name, creator_id, recruit_info, recruit_open, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $12, $13, $14, $15, $16)`,
      [
        id, name,
        String(body.region || ""),
        String(body.address || ""),
        String(body.cover_image || ""),
        String(body.cover_images || body.cover_image || ""),
        totalSeats,
        String(body.contact_name || ""),
        String(body.contact_phone || ""),
        Number(body.lat) || 0,
        Number(body.lng) || 0,
        String(body.city_name || ""),
        req.user!.userId,
        String(body.recruit_info || ""),
        body.recruit_open === true,
        String(body.tags || ""),
      ],
    );
    for (let i = 1; i <= totalSeats; i++) {
      const seatId = uuid();
      await client.query(
        "INSERT INTO opc_seats (id, city_id, seat_number, status) VALUES ($1, $2, $3, 'available')",
        [seatId, id, i.toString().padStart(3, "0")],
      );
    }
    await ensureDefaultParkResources(client, id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }

  const { rows } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [id]);
  sendJson(res, 201, { park: rows[0] });
}

// ─── 更新用户位置 ──────────────────────────────────────────────────────

export async function handleUpdateUserLocation(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const province = String(body.user_province || "").trim();
  const city = String(body.user_city || "").trim();
  const district = String(body.user_district || "").trim();
  if (!province || !city) { sendJson(res, 400, { error: "请填写省份和城市" }); return; }
  await db.query(
    "UPDATE opc_users SET user_province = $1, user_city = $2, user_district = $3, lat = $4, lng = $5 WHERE id = $6",
    [province, city, district, Number(body.lat) || 0, Number(body.lng) || 0, req.user!.userId],
  );
  sendJson(res, 200, { success: true });
}

// ─── 用户编辑园区 ──────────────────────────────────────────────────────

export async function handleUserUpdatePark(req: AuthRequest, res: ServerResponse, db: Db, parkId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  let { rows: existing } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [parkId]);
  if (!existing.length) {
    const seeded = await ensureFeaturedCenterPark(db, parkId);
    if (seeded) existing = [seeded];
  }
  if (!existing.length) { sendJson(res, 404, { error: "园区不存在" }); return; }
  const park = existing[0];

  const isAdmin = req.user!.role === "admin";
  if (!isAdmin && park.creator_id !== req.user!.userId) {
    sendJson(res, 403, { error: "只能编辑自己创建的园区" }); return;
  }

  const body = await parseBody(req);
  const allowed = ["name", "region", "address", "cover_image", "cover_images", "contact_name", "contact_phone", "recruit_info", "recruit_open", "tags", "lat", "lng", "city_name", "total_seats"];
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  for (const f of allowed) {
    if (body[f] !== undefined) {
      if (f === "lat" || f === "lng" || f === "total_seats") {
        sets.push(`${f} = $${idx++}`);
        vals.push(Number(body[f]) || 0);
      } else if (f === "recruit_open") {
        sets.push(`${f} = $${idx++}`);
        vals.push(body[f] === true || body[f] === "true");
      } else {
        sets.push(`${f} = $${idx++}`);
        vals.push(String(body[f]));
      }
    }
  }

  if (sets.length === 0) { sendJson(res, 400, { error: "无更新内容" }); return; }

  vals.push(parkId);
  await db.query(`UPDATE opc_cities SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

  const { rows } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [parkId]);
  sendJson(res, 200, { park: rows[0] });
}

// ─── 用户删除园区 ──────────────────────────────────────────────────────

export async function handleUserDeletePark(req: AuthRequest, res: ServerResponse, db: Db, parkId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows: existing } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [parkId]);
  if (!existing.length) { sendJson(res, 404, { error: "园区不存在" }); return; }
  const park = existing[0];

  const isAdmin = req.user!.role === "admin";
  if (!isAdmin && park.creator_id !== req.user!.userId) {
    sendJson(res, 403, { error: "只能删除自己创建的园区" }); return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM opc_seats WHERE city_id = $1", [parkId]);
    await client.query("DELETE FROM opc_cities WHERE id = $1", [parkId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally { client.release(); }

  sendJson(res, 200, { success: true });
}

export async function handleUploadParkImages(req: AuthRequest, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  let body: Record<string, unknown>;
  try {
    body = await parseLargeJsonBody(req);
  } catch (error) {
    sendJson(res, 413, { error: error instanceof Error ? error.message : "上传内容过大" });
    return;
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) { sendJson(res, 400, { error: "请至少上传一张图片" }); return; }
  if (images.length > 5) { sendJson(res, 400, { error: "最多上传 5 张图片" }); return; }

  await mkdir(PARK_IMAGE_DIR, { recursive: true });
  const urls: string[] = [];

  for (let i = 0; i < images.length; i += 1) {
    const decoded = decodeBase64Image(String(images[i] || ""));
    if (!decoded) { sendJson(res, 400, { error: `第 ${i + 1} 张图片格式无效` }); return; }
    if (decoded.buffer.byteLength > 8 * 1024 * 1024) { sendJson(res, 400, { error: `第 ${i + 1} 张图片超过 8MB` }); return; }
    const filename = `${Date.now()}-${req.user!.userId}-${uuid()}.${decoded.ext}`;
    await writeFile(path.join(PARK_IMAGE_DIR, filename), decoded.buffer);
    urls.push(`/park-images/${filename}`);
  }

  sendJson(res, 200, { urls });
}

// ─── 园区列表（管理员）──────────────────────────────────────────────────

export async function handleListCities(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const { rows: cities } = await db.query("SELECT * FROM opc_cities ORDER BY created_at DESC");

  const enriched: Record<string, unknown>[] = [];
  for (const c of cities as { id: string }[]) {
    const { rows: seatStats } = await db.query(
      "SELECT status, COUNT(*)::int as cnt FROM opc_seats WHERE city_id = $1 GROUP BY status",
      [c.id],
    );
    enriched.push({ ...c, seat_stats: seatStats });
  }

  sendJson(res, 200, { cities: enriched });
}

// ─── 创建园区 ──────────────────────────────────────────────────────────

export async function handleCreateCity(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const body = await parseBody(req);
  const name = String(body.name || "").trim();
  if (!name) {
    sendJson(res, 400, { error: "园区名称不能为空" });
    return;
  }

  const id = uuid();
  const totalSeats = Number(body.total_seats) || 0;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO opc_cities (id, name, region, address, total_seats, contact_name, contact_phone, status, lat, lng, city_name, creator_id, recruit_info, recruit_open, tags, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12, $13, $14, NOW())",
      [
        id,
        name,
        String(body.region || ""),
        String(body.address || ""),
        totalSeats,
        String(body.contact_name || ""),
        String(body.contact_phone || ""),
        Number(body.lat) || 0,
        Number(body.lng) || 0,
        String(body.city_name || ""),
        req.user!.userId,
        String(body.recruit_info || ""),
        body.recruit_open === true,
        String(body.tags || ""),
      ],
    );
    for (let i = 1; i <= totalSeats; i++) {
      const seatId = uuid();
      const seatNum = `${i.toString().padStart(3, "0")}`;
      await client.query(
        "INSERT INTO opc_seats (id, city_id, seat_number, status, created_at) VALUES ($1, $2, $3, 'available', NOW())",
        [seatId, id, seatNum],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const { rows } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [id]);
  const city = rows[0];
  sendJson(res, 201, { city });
}

// ─── 更新园区 ──────────────────────────────────────────────────────────

export async function handleUpdateCity(req: AuthRequest, res: ServerResponse, db: Db, cityId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;

  const body = await parseBody(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  for (const f of ["name", "region", "address", "contact_name", "contact_phone", "status"]) {
    if (body[f] !== undefined) {
      sets.push(`${f} = $${idx++}`);
      vals.push(String(body[f]));
    }
  }

  if (sets.length === 0) {
    sendJson(res, 400, { error: "无更新内容" });
    return;
  }

  vals.push(cityId);
  await db.query(`UPDATE opc_cities SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

  const { rows } = await db.query("SELECT * FROM opc_cities WHERE id = $1", [cityId]);
  const city = rows[0];
  sendJson(res, 200, { city });
}

// ─── 地理编码（地址→坐标）──────────────────────────────────────────────

const geocodeErrorLogAt = new Map<string, number>();
let geocodeCooldownUntil = 0;
let geocodeCooldownReason = "";
let geocodeInFlight = 0;
const GEOCODE_MAX_CONCURRENCY = 2;
const GEOCODE_REQUEST_TIMEOUT_MS = 3000;
const GEOCODE_COOLDOWN_MS = 5 * 60 * 1000;
const GEOCODE_ENGINE_COOLDOWN_MS = 60 * 1000;

function shouldLogGeocodeError(key: string, intervalMs = 60_000): boolean {
  const now = Date.now();
  const last = geocodeErrorLogAt.get(key) || 0;
  if (now - last < intervalMs) return false;
  geocodeErrorLogAt.set(key, now);
  return true;
}

function tripGeocodeCooldown(reason: string, durationMs: number): void {
  geocodeCooldownUntil = Date.now() + durationMs;
  geocodeCooldownReason = reason;
}

function getGeocodeCooldownReason(): string {
  if (Date.now() < geocodeCooldownUntil) return geocodeCooldownReason || "cooldown";
  geocodeCooldownReason = "";
  geocodeCooldownUntil = 0;
  return "";
}

function buildGeocodeCacheKey(address: string, city: string): string {
  return `${String(city || "").trim()}|${String(address || "").trim()}`.toLowerCase();
}

export async function handleGeocode(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const address = url.searchParams.get("address") || "";
  const city = url.searchParams.get("city") || "";

  if (!address) {
    sendJson(res, 400, { error: "address 参数必填" });
    return;
  }

  const cacheKey = buildGeocodeCacheKey(address, city);
  const { rows: cacheRows } = await db.query(
    "SELECT * FROM opc_geocode_cache WHERE address_key = $1 LIMIT 1",
    [cacheKey],
  );
  if (cacheRows[0]) {
    const cached = cacheRows[0] as any;
    sendJson(res, 200, {
      longitude: Number(cached.longitude || 0),
      latitude: Number(cached.latitude || 0),
      formatted_address: String(cached.formatted_address || ""),
      province: String(cached.province || ""),
      city: String(cached.city || ""),
      district: String(cached.district || ""),
      cached: true,
      source: String(cached.source || "cache"),
    });
    return;
  }

  const cooldownReason = getGeocodeCooldownReason();
  if (cooldownReason || geocodeInFlight >= GEOCODE_MAX_CONCURRENCY) {
    const fallback = lookupGeocodeFallback(address, city);
    if (fallback) {
      await db.query(
        `INSERT INTO opc_geocode_cache
          (address_key, address, city, longitude, latitude, formatted_address, province, district, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (address_key) DO UPDATE SET
           longitude = EXCLUDED.longitude,
           latitude = EXCLUDED.latitude,
           formatted_address = EXCLUDED.formatted_address,
           province = EXCLUDED.province,
           district = EXCLUDED.district,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [cacheKey, address, city, fallback.longitude, fallback.latitude, fallback.formattedAddress, fallback.province, fallback.district, "fallback"],
      );
      sendJson(res, 200, {
        longitude: fallback.longitude,
        latitude: fallback.latitude,
        formatted_address: fallback.formattedAddress,
        province: fallback.province,
        city: fallback.city,
        district: fallback.district,
        fallback: true,
        fallback_reason: cooldownReason ? `cooldown:${cooldownReason}` : "geocode-busy",
      });
      return;
    }
    sendJson(res, 429, { error: cooldownReason ? `地理编码服务暂时降级：${cooldownReason}` : "地理编码服务繁忙，请稍后重试" });
    return;
  }

  const amapKey = process.env.AMAP_SERVER_KEY || process.env.AMAP_KEY || "";
  if (!amapKey) {
    sendJson(res, 500, { error: "服务端未配置 AMAP_SERVER_KEY（高德 Web 服务 Key）" });
    return;
  }

  const params = new URLSearchParams({ key: amapKey, address, output: "json" });
  if (city) params.set("city", city);

  const apiUrl = `https://restapi.amap.com/v3/geocode/geo?${params.toString()}`;

  try {
    geocodeInFlight += 1;
    const data: any = await new Promise((resolve, reject) => {
      const reqUpstream = https.get(apiUrl, (resp) => {
        let body = "";
        resp.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        resp.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("json parse error")); } });
        resp.on("error", reject);
      }).on("error", reject);
      reqUpstream.setTimeout(GEOCODE_REQUEST_TIMEOUT_MS, () => {
        reqUpstream.destroy(new Error("timeout"));
      });
    });

    if (data.status !== "1") {
      const info = String(data.info || "未知错误");
      const infocode = String(data.infocode || "-");
      const isQuotaError = infocode === "10021";
      const isEngineDataError = infocode === "30001";
      if (isQuotaError) {
        tripGeocodeCooldown(`amap-quota-${infocode}`, GEOCODE_COOLDOWN_MS);
      } else if (isEngineDataError) {
        tripGeocodeCooldown(`amap-engine-${infocode}`, GEOCODE_ENGINE_COOLDOWN_MS);
      }
      const logKey = `${infocode}:${info}`;
      if (shouldLogGeocodeError(logKey, isQuotaError ? 120_000 : 60_000)) {
        console[isQuotaError || isEngineDataError ? "warn" : "error"]("[Geocode] 高德返回错误:", JSON.stringify(data));
      }
      const fallback = lookupGeocodeFallback(address, city);
      if (fallback) {
        await db.query(
          `INSERT INTO opc_geocode_cache
            (address_key, address, city, longitude, latitude, formatted_address, province, district, source, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (address_key) DO UPDATE SET
             longitude = EXCLUDED.longitude,
             latitude = EXCLUDED.latitude,
             formatted_address = EXCLUDED.formatted_address,
             province = EXCLUDED.province,
             district = EXCLUDED.district,
             source = EXCLUDED.source,
             updated_at = NOW()`,
          [cacheKey, address, city, fallback.longitude, fallback.latitude, fallback.formattedAddress, fallback.province, fallback.district, "fallback"],
        );
        sendJson(res, 200, {
          longitude: fallback.longitude,
          latitude: fallback.latitude,
          formatted_address: fallback.formattedAddress,
          province: fallback.province,
          city: fallback.city,
          district: fallback.district,
          fallback: true,
          fallback_reason: `amap:${data.info || "未知错误"}:${data.infocode || "-"}`,
        });
        return;
      }
      sendJson(res, 400, { error: `地理编码失败: ${data.info || "未知错误"}（infocode: ${data.infocode || "-"}）` });
      return;
    }

    const geocodes = data.geocodes || [];
    if (!geocodes.length) {
      sendJson(res, 404, { error: "未找到该地址的坐标信息" });
      return;
    }

    const geo = geocodes[0];
    const loc = (geo.location || "").split(",");
    if (loc.length !== 2) {
      sendJson(res, 500, { error: "坐标格式错误" });
      return;
    }

    await db.query(
      `INSERT INTO opc_geocode_cache
        (address_key, address, city, longitude, latitude, formatted_address, province, district, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (address_key) DO UPDATE SET
         longitude = EXCLUDED.longitude,
         latitude = EXCLUDED.latitude,
         formatted_address = EXCLUDED.formatted_address,
         province = EXCLUDED.province,
         district = EXCLUDED.district,
         source = EXCLUDED.source,
         updated_at = NOW()`,
      [cacheKey, address, city, parseFloat(loc[0]), parseFloat(loc[1]), geo.formatted_address || "", geo.province || "", geo.district || "", "amap"],
    );

    sendJson(res, 200, {
      longitude: parseFloat(loc[0]),
      latitude: parseFloat(loc[1]),
      formatted_address: geo.formatted_address || "",
      province: geo.province || "",
      city: geo.city || "",
      district: geo.district || "",
    });
  } catch (e: any) {
    if (String(e?.message || e) === "timeout") {
      tripGeocodeCooldown("timeout", GEOCODE_ENGINE_COOLDOWN_MS);
    }
    if (shouldLogGeocodeError(`exception:${e?.message || e}`, 60_000)) {
      console.warn("[Geocode] 服务异常:", e?.message || e);
    }
    const fallback = lookupGeocodeFallback(address, city);
    if (fallback) {
      await db.query(
        `INSERT INTO opc_geocode_cache
          (address_key, address, city, longitude, latitude, formatted_address, province, district, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (address_key) DO UPDATE SET
           longitude = EXCLUDED.longitude,
           latitude = EXCLUDED.latitude,
           formatted_address = EXCLUDED.formatted_address,
           province = EXCLUDED.province,
           district = EXCLUDED.district,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [cacheKey, address, city, fallback.longitude, fallback.latitude, fallback.formattedAddress, fallback.province, fallback.district, "fallback"],
      );
      sendJson(res, 200, {
        longitude: fallback.longitude,
        latitude: fallback.latitude,
        formatted_address: fallback.formattedAddress,
        province: fallback.province,
        city: fallback.city,
        district: fallback.district,
        fallback: true,
        fallback_reason: `exception:${e?.message || e}`,
      });
      return;
    }
    sendJson(res, 500, { error: `地理编码服务异常: ${e.message || e}` });
  } finally {
    geocodeInFlight = Math.max(0, geocodeInFlight - 1);
  }
}

// ─── 园区入驻申请 ──────────────────────────────────────────────────────

export async function handleApplyPark(req: AuthRequest, res: ServerResponse, db: Db, parkId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);

  const park = await getParkById(db, parkId);
  if (!park || park.status !== "active") { sendJson(res, 404, { error: "园区不存在" }); return; }

  if (park.total_seats > 0 && (park.used_seats || 0) >= park.total_seats) {
    sendJson(res, 400, { error: "该园区工位已满，暂时无法申请入驻" }); return;
  }

  const applyReason = sanitizeText(body.apply_reason || body.message, 1000);
  const companyProjects = sanitizeText(body.company_projects, 1600);
  const monetizationPlan = sanitizeText(body.monetization_plan, 1600);
  const contactMobile = sanitizeText(body.contact_mobile || req.user?.phone, 80);
  const expectation = sanitizeText(body.expectation, 800);

  if (!applyReason) { sendJson(res, 400, { error: "请填写入驻原因" }); return; }
  if (!companyProjects) { sendJson(res, 400, { error: "请填写公司项目或代表案例" }); return; }
  if (!monetizationPlan) { sendJson(res, 400, { error: "请填写业务模式或盈利方式" }); return; }

  const { rows: existing } = await db.query(
    "SELECT id, status FROM opc_park_applications WHERE park_id = $1 AND user_id = $2 AND status IN ('pending','approved')",
    [parkId, userId]
  );
  if (existing.length) {
    const s = existing[0].status;
    if (s === 'pending') { sendJson(res, 400, { error: "您已提交过申请，请等待审批" }); return; }
    if (s === 'approved') { sendJson(res, 400, { error: "您已入驻该园区" }); return; }
  }

  const id = 'pa_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  try {
    await db.query(
      `INSERT INTO opc_park_applications
       (id, park_id, user_id, message, apply_reason, company_projects, monetization_plan, contact_mobile, expectation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, parkId, userId, applyReason, applyReason, companyProjects, monetizationPlan, contactMobile, expectation]
    );
  } catch (error) {
    if (!isLegacyParkApplicationColumnError(error)) throw error;
    await db.query(
      `INSERT INTO opc_park_applications
       (id, park_id, user_id, message)
       VALUES ($1, $2, $3, $4)`,
      [id, parkId, userId, applyReason]
    );
  }
  sendJson(res, 200, { success: true, id });
}

export async function handleGetParkApplications(req: AuthRequest, res: ServerResponse, db: Db, parkId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const park = await getParkById(db, parkId);
  if (!park) { sendJson(res, 404, { error: "园区不存在" }); return; }
  if (!canManagePark(req, park)) { sendJson(res, 403, { error: "仅园区创建者可查看申请" }); return; }

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT a.id, a.user_id, a.message, a.apply_reason, a.company_projects, a.monetization_plan, a.contact_mobile,
              a.expectation, a.review_note, a.approved_points, a.status, a.created_at, a.reviewed_at,
              u.name as user_name, u.phone as user_phone, u.email as user_email,
              u.user_province, u.user_city, u.user_district
       FROM opc_park_applications a
       JOIN opc_users u ON u.id = a.user_id
       WHERE a.park_id = $1
       ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC`,
      [parkId]
    ));
  } catch (error) {
    if (!isLegacyParkApplicationColumnError(error)) throw error;
    ({ rows } = await db.query(
      `SELECT a.id, a.user_id, a.message,
              a.message AS apply_reason, '' AS company_projects, '' AS monetization_plan, '' AS contact_mobile,
              '' AS expectation, '' AS review_note, 0 AS approved_points, a.status, a.created_at, a.reviewed_at,
              u.name as user_name, u.phone as user_phone, u.email as user_email,
              u.user_province, u.user_city, u.user_district
       FROM opc_park_applications a
       JOIN opc_users u ON u.id = a.user_id
       WHERE a.park_id = $1
       ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC`,
      [parkId]
    ));
  }
  sendJson(res, 200, { applications: normalizeParkApplicationRows(rows) });
}

export async function handleReviewApplication(req: AuthRequest, res: ServerResponse, db: Db, appId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);
  const action = body.action;
  if (action !== 'approve' && action !== 'reject') { sendJson(res, 400, { error: "action 必须是 approve 或 reject" }); return; }
  const reviewNote = sanitizeText(body.review_note, 1200);
  const initialPoints = Math.max(0, Number(body.initial_points) || 300);

  const { rows: appRows } = await db.query(
    "SELECT a.*, c.creator_id, c.total_seats, c.used_seats FROM opc_park_applications a JOIN opc_cities c ON c.id = a.park_id WHERE a.id = $1",
    [appId]
  );
  if (!appRows.length) { sendJson(res, 404, { error: "申请不存在" }); return; }
  const app = appRows[0];

  if (app.status !== 'pending') { sendJson(res, 400, { error: "该申请已处理" }); return; }

  if (!canManagePark(req, app)) { sendJson(res, 403, { error: "仅园区创建者可审批" }); return; }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    if (action === 'approve') {
      if (app.total_seats > 0 && (app.used_seats || 0) >= app.total_seats) {
        await client.query("ROLLBACK");
        sendJson(res, 400, { error: "园区工位已满，无法通过申请" }); return;
      }

      try {
        await client.query(
          `UPDATE opc_park_applications
           SET status = 'approved', review_note = $1, approved_points = $2, reviewed_by = $3, reviewed_at = NOW()
           WHERE id = $4`,
          [reviewNote, initialPoints, userId, appId],
        );
      } catch (error) {
        if (!isLegacyParkApplicationColumnError(error)) throw error;
        await client.query(
          `UPDATE opc_park_applications
           SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
           WHERE id = $2`,
          [userId, appId],
        );
      }
      await client.query("UPDATE opc_cities SET used_seats = COALESCE(used_seats, 0) + 1 WHERE id = $1", [app.park_id]);

      const membershipId = uuid();
      const checkinCode = buildMembershipPassCode(app.user_id, app.park_id);
      await client.query(
        `INSERT INTO opc_park_memberships
         (id, park_id, user_id, application_id, status, initial_points, points_balance, approved_by, note, checkin_code)
         VALUES ($1, $2, $3, $4, 'active', $5, $5, $6, $7, $8)
         ON CONFLICT (park_id, user_id) DO UPDATE
         SET application_id = EXCLUDED.application_id,
             status = 'active',
             initial_points = EXCLUDED.initial_points,
             points_balance = EXCLUDED.points_balance,
             approved_by = EXCLUDED.approved_by,
             note = EXCLUDED.note,
             checkin_code = EXCLUDED.checkin_code,
             updated_at = NOW()`,
        [membershipId, app.park_id, app.user_id, appId, initialPoints, userId, reviewNote, checkinCode],
      );

      const { rows: membershipRows } = await client.query(
        "SELECT id, points_balance FROM opc_park_memberships WHERE park_id = $1 AND user_id = $2",
        [app.park_id, app.user_id],
      );
      const membership = membershipRows[0];
      if (membership && initialPoints > 0) {
        await client.query(
          `INSERT INTO opc_park_points_log
           (id, park_id, membership_id, user_id, change_points, balance_after, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [uuid(), app.park_id, membership.id, app.user_id, initialPoints, membership.points_balance, "入驻通过赠送初始积分"],
        );
      }
      await ensureDefaultParkResources(client, app.park_id);
    } else {
      try {
        await client.query(
          `UPDATE opc_park_applications
           SET status = 'rejected', review_note = $1, reviewed_by = $2, reviewed_at = NOW()
           WHERE id = $3`,
          [reviewNote, userId, appId],
        );
      } catch (error) {
        if (!isLegacyParkApplicationColumnError(error)) throw error;
        await client.query(
          `UPDATE opc_park_applications
           SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW()
           WHERE id = $2`,
          [userId, appId],
        );
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  sendJson(res, 200, { success: true });
}

export async function handleGetMyApplications(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT a.id, a.park_id, a.message, a.apply_reason, a.company_projects, a.monetization_plan, a.contact_mobile,
              a.expectation, a.review_note, a.approved_points, a.status, a.created_at, a.reviewed_at,
              c.name as park_name, c.city_name, c.address
       FROM opc_park_applications a
       JOIN opc_cities c ON c.id = a.park_id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [req.user!.userId]
    ));
  } catch (error) {
    if (!isLegacyParkApplicationColumnError(error)) throw error;
    ({ rows } = await db.query(
      `SELECT a.id, a.park_id, a.message,
              a.message AS apply_reason, '' AS company_projects, '' AS monetization_plan, '' AS contact_mobile,
              '' AS expectation, '' AS review_note, 0 AS approved_points, a.status, a.created_at, a.reviewed_at,
              c.name as park_name, c.city_name, c.address
       FROM opc_park_applications a
       JOIN opc_cities c ON c.id = a.park_id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [req.user!.userId]
    ));
  }
  sendJson(res, 200, { applications: normalizeParkApplicationRows(rows) });
}

export async function handleGetParkCommunity(req: AuthRequest, res: ServerResponse, db: Db, parkId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const park = await getParkById(db, parkId);
  if (!park) { sendJson(res, 404, { error: "园区不存在" }); return; }

  await ensureDefaultParkResources(db, parkId);
  const userId = req.user!.userId;
  const canManage = canManagePark(req, park);

  let latestApplicationRows;
  try {
    ({ rows: latestApplicationRows } = await db.query(
      `SELECT id, status, apply_reason, company_projects, monetization_plan, expectation, review_note, approved_points, created_at, reviewed_at
       FROM opc_park_applications
       WHERE park_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [parkId, userId],
    ));
  } catch (error) {
    if (!isLegacyParkApplicationColumnError(error)) throw error;
    ({ rows: latestApplicationRows } = await db.query(
      `SELECT id, status, message AS apply_reason, '' AS company_projects, '' AS monetization_plan,
              '' AS expectation, '' AS review_note, 0 AS approved_points, created_at, reviewed_at
       FROM opc_park_applications
       WHERE park_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [parkId, userId],
    ));
  }

  const [{ rows: membershipRows }, { rows: resourceRows }, { rows: bookingRows }, { rows: memberStatsRows }] = await Promise.all([
    db.query(
      `SELECT m.*, u.name AS user_name
       FROM opc_park_memberships m
       JOIN opc_users u ON u.id = m.user_id
       WHERE m.park_id = $1 AND m.user_id = $2`,
      [parkId, userId],
    ),
    db.query(
      `SELECT id, name, resource_type, description, points_cost, capacity, unit_label, is_active, requires_approval
       FROM opc_park_resources
       WHERE park_id = $1 AND is_active = TRUE
       ORDER BY CASE resource_type WHEN 'desk' THEN 0 WHEN 'meeting_room' THEN 1 ELSE 2 END, created_at ASC`,
      [parkId],
    ),
    db.query(
      `SELECT b.id, b.resource_id, b.booking_date, b.start_slot, b.end_slot, b.quantity, b.points_cost, b.status, b.note, b.checkin_code,
              r.name AS resource_name, r.resource_type
       FROM opc_park_bookings b
       JOIN opc_park_resources r ON r.id = b.resource_id
       WHERE b.park_id = $1 AND b.user_id = $2
       ORDER BY b.booking_date DESC, b.created_at DESC
       LIMIT 20`,
      [parkId, userId],
    ),
    db.query(
      `SELECT
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_members,
          COALESCE(SUM(points_balance) FILTER (WHERE status = 'active'), 0)::int AS total_points,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_members
       FROM (
         SELECT status, points_balance FROM opc_park_memberships WHERE park_id = $1
         UNION ALL
         SELECT status, 0 FROM opc_park_applications WHERE park_id = $1 AND status = 'pending'
       ) t`,
      [parkId],
    ),
  ]);

  sendJson(res, 200, {
    park,
    can_manage: canManage,
    membership: membershipRows[0] || null,
    latest_application: latestApplicationRows[0] ? normalizeParkApplicationRow(latestApplicationRows[0]) : null,
    resources: resourceRows,
    my_bookings: bookingRows,
    community_stats: memberStatsRows[0] || { active_members: 0, total_points: 0, pending_members: 0 },
  });
}

export async function handleGetParkResources(req: AuthRequest, res: ServerResponse, db: Db, parkId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const park = await getParkById(db, parkId);
  if (!park) { sendJson(res, 404, { error: "园区不存在" }); return; }
  if (!canManagePark(req, park)) { sendJson(res, 403, { error: "仅管理员或网点创建者可管理资源" }); return; }
  await ensureDefaultParkResources(db, parkId);
  const { rows } = await db.query(
    `SELECT id, name, resource_type, description, points_cost, capacity, unit_label, is_active, requires_approval, created_at
     FROM opc_park_resources
     WHERE park_id = $1
     ORDER BY created_at ASC`,
    [parkId],
  );
  sendJson(res, 200, { resources: rows });
}

export async function handleSaveParkResource(req: AuthRequest, res: ServerResponse, db: Db, parkId: string, resourceId?: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  let resolvedParkId = parkId;
  if (!resolvedParkId && resourceId) {
    const { rows: resourceRows } = await db.query("SELECT park_id FROM opc_park_resources WHERE id = $1", [resourceId]);
    resolvedParkId = String(resourceRows[0]?.park_id || "");
  }
  const park = resolvedParkId ? await getParkById(db, resolvedParkId) : null;
  if (!park) { sendJson(res, 404, { error: "园区不存在" }); return; }
  if (!canManagePark(req, park)) { sendJson(res, 403, { error: "仅管理员或网点创建者可管理资源" }); return; }

  const body = await parseBody(req);
  const name = sanitizeText(body.name, 100);
  const resourceType = sanitizeText(body.resource_type || "desk", 40);
  if (!name) { sendJson(res, 400, { error: "资源名称不能为空" }); return; }

  const payload = {
    name,
    resourceType,
    description: sanitizeText(body.description, 600),
    pointsCost: Math.max(0, Number(body.points_cost) || 0),
    capacity: Math.max(1, Number(body.capacity) || 1),
    unitLabel: sanitizeText(body.unit_label, 20) || "次",
    isActive: body.is_active !== false && body.is_active !== "false",
    requiresApproval: body.requires_approval === true || body.requires_approval === "true",
  };

  if (resourceId) {
    const { rows: existing } = await db.query("SELECT id FROM opc_park_resources WHERE id = $1 AND park_id = $2", [resourceId, parkId]);
    if (!existing.length && resolvedParkId !== parkId) {
      const retry = await db.query("SELECT id FROM opc_park_resources WHERE id = $1 AND park_id = $2", [resourceId, resolvedParkId]);
      if (!retry.rows.length) { sendJson(res, 404, { error: "资源不存在" }); return; }
    }
    else if (!existing.length) { sendJson(res, 404, { error: "资源不存在" }); return; }
    await db.query(
      `UPDATE opc_park_resources
       SET name = $1, resource_type = $2, description = $3, points_cost = $4, capacity = $5,
           unit_label = $6, is_active = $7, requires_approval = $8, updated_at = NOW()
       WHERE id = $9`,
      [payload.name, payload.resourceType, payload.description, payload.pointsCost, payload.capacity, payload.unitLabel, payload.isActive, payload.requiresApproval, resourceId],
    );
  } else {
    await db.query(
      `INSERT INTO opc_park_resources
       (id, park_id, name, resource_type, description, points_cost, capacity, unit_label, is_active, requires_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [uuid(), resolvedParkId, payload.name, payload.resourceType, payload.description, payload.pointsCost, payload.capacity, payload.unitLabel, payload.isActive, payload.requiresApproval],
    );
  }

  sendJson(res, 200, { success: true });
}

export async function handleDeleteParkResource(req: AuthRequest, res: ServerResponse, db: Db, resourceId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    `SELECT r.id, r.park_id, c.creator_id
     FROM opc_park_resources r
     JOIN opc_cities c ON c.id = r.park_id
     WHERE r.id = $1`,
    [resourceId],
  );
  const resource = rows[0];
  if (!resource) { sendJson(res, 404, { error: "资源不存在" }); return; }
  if (!canManagePark(req, resource)) { sendJson(res, 403, { error: "仅管理员或网点创建者可删除资源" }); return; }
  await db.query("DELETE FROM opc_park_resources WHERE id = $1", [resourceId]);
  sendJson(res, 200, { success: true });
}

export async function handleCreateParkBooking(req: AuthRequest, res: ServerResponse, db: Db, parkId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);
  const resourceId = sanitizeText(body.resource_id, 80);
  if (!resourceId) { sendJson(res, 400, { error: "请选择要预约的资源" }); return; }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: membershipRows } = await client.query(
      "SELECT * FROM opc_park_memberships WHERE park_id = $1 AND user_id = $2 AND status = 'active'",
      [parkId, userId],
    );
    const membership = membershipRows[0];
    if (!membership) { await client.query("ROLLBACK"); sendJson(res, 403, { error: "请先通过入驻审批后再预约资源" }); return; }

    const { rows: resourceRows } = await client.query(
      "SELECT * FROM opc_park_resources WHERE id = $1 AND park_id = $2 AND is_active = TRUE",
      [resourceId, parkId],
    );
    const resource = resourceRows[0];
    if (!resource) { await client.query("ROLLBACK"); sendJson(res, 404, { error: "资源不存在或未启用" }); return; }

    const pointsCost = Math.max(0, Number(resource.points_cost) || 0);
    if ((membership.points_balance || 0) < pointsCost) {
      await client.query("ROLLBACK");
      sendJson(res, 400, { error: `当前积分不足，预约 ${resource.name} 需要 ${pointsCost} 积分` });
      return;
    }

    const bookingId = uuid();
    const nextBalance = Number(membership.points_balance || 0) - pointsCost;
    const bookingDate = sanitizeText(body.booking_date, 40) || new Date().toISOString().slice(0, 10);
    const startSlot = sanitizeText(body.start_slot, 40) || "09:00";
    const endSlot = sanitizeText(body.end_slot, 40) || (resource.resource_type === "meeting_room" ? "10:00" : startSlot);
    const quantity = Math.max(1, Number(body.quantity) || 1);
    const note = sanitizeText(body.note, 300);
    const checkinCode = buildMembershipPassCode(userId, bookingId);

    await client.query(
      `INSERT INTO opc_park_bookings
       (id, park_id, resource_id, membership_id, user_id, booking_date, start_slot, end_slot, quantity, points_cost, note, checkin_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [bookingId, parkId, resourceId, membership.id, userId, bookingDate, startSlot, endSlot, quantity, pointsCost, note, checkinCode],
    );
    await client.query(
      "UPDATE opc_park_memberships SET points_balance = $1, updated_at = NOW() WHERE id = $2",
      [nextBalance, membership.id],
    );
    await client.query(
      `INSERT INTO opc_park_points_log
       (id, park_id, membership_id, user_id, booking_id, change_points, balance_after, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuid(), parkId, membership.id, userId, bookingId, -pointsCost, nextBalance, `预约资源：${resource.name}`],
    );
    await client.query("COMMIT");
    sendJson(res, 200, { success: true, booking_id: bookingId, points_balance: nextBalance, checkin_code: checkinCode });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
