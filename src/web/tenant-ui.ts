/**
 * 租户白标页面 — 基于主站 portal-ui 的完整渲染
 * 加载租户配置后注入品牌覆盖，生成与主站功能完全一致的 OPC 页面
 * 访问路径: /vip/{slug}
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db.js";
import { serveTenantPortalPage } from "./portal-ui.js";

export async function serveTenantPage(req: IncomingMessage, res: ServerResponse, db: Db, slug: string): Promise<void> {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const isPreview = url.searchParams.get("preview") === "1";
    const query = isPreview
      ? "SELECT * FROM opc_tenant_configs WHERE slug = $1"
      : "SELECT * FROM opc_tenant_configs WHERE slug = $1 AND is_published = true";
    const { rows } = await db.query(query, [slug]);
    if (!rows.length) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>页面不存在</title></head>
        <body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#080A12;color:#F5F7FF;font-family:system-ui">
        <div style="text-align:center"><h1>404</h1><p>该 OPC 页面不存在或尚未发布</p><a href="/" style="color:#5E6AD2">返回首页</a></div></body></html>`);
      return;
    }
    serveTenantPortalPage(req, res, rows[0]);
  } catch (e) {
    console.error("[TenantUI Error]", e);
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end("服务器内部错误");
  }
}
