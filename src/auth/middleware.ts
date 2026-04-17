import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken, type TokenPayload } from "./jwt.js";

export interface AuthRequest extends IncomingMessage {
  user?: TokenPayload;
  body?: Record<string, unknown>;
}

let _internalKey = "";

export function setInternalKey(key: string): void {
  _internalKey = key;
}

export function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function isInternalRequest(req: IncomingMessage): boolean {
  if (!_internalKey) return false;
  return req.headers["x-opc-internal-key"] === _internalKey;
}

/**
 * 校验 JWT，将用户信息注入 req.user。
 * 返回 true 表示认证通过，false 表示已向 res 写入 401。
 *
 * 桌面本地版的 cloud-proxy 转发请求时会带 x-opc-internal-key，
 * 命中后跳过 JWT 验证。若附带 x-opc-user-id，使用真实用户 ID
 * （用于 AI 对话等需追踪配额的场景），否则用虚拟管理员身份。
 */
export function requireAuth(req: AuthRequest, res: ServerResponse): boolean {
  if (isInternalRequest(req)) {
    const realUserId = req.headers["x-opc-user-id"] as string | undefined;
    const realRole = (req.headers["x-opc-user-role"] as string) || "user";
    req.user = {
      userId: realUserId || "__opc_internal__",
      phone: "",
      role: realUserId ? realRole : "admin",
    };
    return true;
  }
  const token = extractToken(req);
  if (!token) {
    sendJson(res, 401, { error: "未登录，请先登录" });
    return false;
  }
  try {
    req.user = verifyToken(token);
    return true;
  } catch {
    sendJson(res, 401, { error: "登录已过期，请重新登录" });
    return false;
  }
}

export function requireAdmin(req: AuthRequest, res: ServerResponse): boolean {
  if (!requireAuth(req, res)) return false;
  if (req.user!.role !== "admin") {
    sendJson(res, 403, { error: "权限不足" });
    return false;
  }
  return true;
}

const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "*";

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(JSON.stringify(data));
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

export async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (c: Buffer) => {
      totalSize += c.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("请求体过大（超过 5MB）"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
