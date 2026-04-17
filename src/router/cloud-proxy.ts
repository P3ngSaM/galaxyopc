/**
 * 云端代理模块 — 桌面本地版将部分 API 透传到云端服务器
 *
 * 设计思路：
 *   本地版 (LOCAL_MODE=true) 运行时，城市管理、资源中心、产业情报、
 *   社区运营、订单/计费、协作好友等需要全局数据的接口透传到云端；
 *   而 AI 对话、工具管理、公司管理等私有数据在本地处理。
 *
 * 复用 proxyToRust 的反向代理模式，通过 OPC_CLOUD_API_URL 环境变量
 * 指定云端地址。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { verifyToken } from "../auth/jwt.js";

const CLOUD_API_URL = (process.env.OPC_CLOUD_API_URL || "").trim().replace(/\/+$/, "");

const INTERNAL_KEY = process.env.OPC_INTERNAL_KEY || "opc-dev-internal-key-2026";

export function getInternalKey(): string {
  return INTERNAL_KEY;
}

const CLOUD_ROUTE_PATTERNS: ReadonlyArray<RegExp> = [
  // 认证 (/api/auth/*) 由 handleCloudAuth 在 router.ts 中特殊处理，
  // 不走通用 proxyToCloud，因为需要拦截响应同步用户到本地 SQLite

  // 城市管理（完整覆盖：城市列表、地图、地理编码、我的申请）
  /^\/api\/cities$/,
  /^\/api\/admin\/cities/,
  /^\/api\/map-data$/,
  /^\/api\/geocode$/,
  /^\/api\/my-applications$/,

  // 园区全套（列表、CRUD、申请、社区、资源、预约、图片上传）
  /^\/api\/parks/,
  /^\/api\/park-resources\//,
  /^\/api\/park-images\//,
  /^\/api\/applications\//,

  // 资源中心 / 产业情报（机会地图、商机、匹配、情报富化、执行包）
  /^\/api\/intel\//,
  /^\/api\/opportunity-battles/,

  // 套餐与用量——仅模型列表和选择走云端，quota/usage-logs 本地也有实现
  /^\/api\/models$/,
  /^\/api\/user\/model$/,

  // 社区运营（签到、积分、邀请码、反馈）
  /^\/api\/growth\//,
  /^\/api\/feedback/,
  /^\/api\/community\//,

  // 好友 / 协作房间
  /^\/api\/friends/,
  /^\/api\/friend-requests/,
  /^\/api\/rooms/,

  // 订单 / 计费
  /^\/api\/orders/,

  // 管理后台统计（全局数据）
  /^\/api\/admin\/users$/,
  /^\/api\/admin\/stats$/,
  /^\/api\/admin\/province-intel/,
  /^\/api\/admin\/opportunity-enrichments/,

  // 全局技能商店（远程目录）
  /^\/api\/skills\/catalog$/,
  /^\/api\/skills\/remote-catalog$/,
  /^\/api\/skills\/ecosystem\//,

  // 订阅/套餐（云端计费核心）
  /^\/api\/subscription\//,

  // AI 对话代理（桌面版走云端模型）
  /^\/api\/chat\/proxy/,
];

/**
 * 判断当前请求是否应该代理到云端。
 * 仅在 LOCAL_MODE 且配置了 OPC_CLOUD_API_URL 时生效。
 */
export function shouldProxyToCloud(pathname: string): boolean {
  if (!CLOUD_API_URL) return false;
  return CLOUD_ROUTE_PATTERNS.some((rx) => rx.test(pathname));
}

export function getCloudApiUrl(): string {
  return CLOUD_API_URL;
}

/**
 * 将请求透传到云端服务器，完整转发 headers（含 Authorization JWT）。
 * SSE 流式响应也可正确透传。
 */
export async function proxyToCloud(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  force = false,
): Promise<boolean> {
  if (!force && !shouldProxyToCloud(url.pathname)) return false;

  const targetUrl = `${CLOUD_API_URL}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "authorization") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  headers.set("host", new URL(CLOUD_API_URL).host);
  headers.set("x-forwarded-for", req.socket.remoteAddress || "127.0.0.1");
  headers.set("x-opc-source", "desktop-local");
  headers.set("x-opc-internal-key", INTERNAL_KEY);

  // 从本地 JWT 提取真实用户身份，传递给云端
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(authHeader.slice(7));
      headers.set("x-opc-user-id", payload.userId);
      headers.set("x-opc-user-role", payload.role || "user");
    } catch {}
  }

  try {
    const ac = new AbortController();
    const isSse = url.pathname.includes("/chat") || url.pathname.includes("/swarm");
    const timer = setTimeout(() => ac.abort(), isSse ? 120_000 : 10_000);

    const requestInit: RequestInit & { duplex?: string; signal?: AbortSignal } = {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : (req as any),
      duplex: "half",
      signal: ac.signal,
    };

    const upstream = await fetch(targetUrl, requestInit);
    clearTimeout(timer);

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (key !== "transfer-encoding") {
        responseHeaders[key] = value;
      }
    });

    responseHeaders["x-opc-proxy"] = "cloud";
    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      res.end();
      return true;
    }

    Readable.fromWeb(upstream.body as any).pipe(res);
    return true;
  } catch (err) {
    console.error("[CloudProxy] 代理请求失败，回退本地路由:", (err as Error).message);
    return false;
  }
}

/**
 * 将认证请求转发到云端，返回云端的原始 JSON 响应。
 * 由 router.ts 调用，router 负责拦截响应、同步用户、签发本地 token。
 */
export async function forwardAuthToCloud(
  method: string,
  path: string,
  body: unknown,
  clientIp: string,
): Promise<{ status: number; data: any } | null> {
  if (!CLOUD_API_URL) return null;

  try {
    const resp = await fetch(`${CLOUD_API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": clientIp,
        "x-opc-source": "desktop-local",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  } catch (err) {
    console.error("[CloudAuth] forward error:", (err as Error).message);
    return null;
  }
}

/**
 * 专门用于 AI 套餐代理的请求转发。
 * 本地用户使用云端套餐时，将 AI 请求通过此方法发往云端 /api/chat/proxy。
 */
export async function proxyAiToCloud(
  token: string,
  body: Record<string, unknown>,
  onData: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  if (!CLOUD_API_URL) {
    return { ok: false, error: "未配置云端服务地址" };
  }

  try {
    const resp = await fetch(`${CLOUD_API_URL}/api/chat/proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-opc-source": "desktop-local",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `云端返回 ${resp.status}: ${text}` };
    }

    if (!resp.body) {
      return { ok: false, error: "云端响应为空" };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onData(decoder.decode(value, { stream: true }));
    }

    return { ok: true };
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, error: "请求已取消" };
    }
    return { ok: false, error: `云端代理失败: ${(err as Error).message}` };
  }
}
