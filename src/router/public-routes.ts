import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { sendJson } from "../auth/middleware.js";
import { servePortalPage } from "../web/portal-ui.js";
import { serveTenantPage } from "../web/tenant-ui.js";
import { serveIotPage } from "../web/iot-ui.js";
import type { RouteContext } from "./route-context.js";

function serveUploadedFile(res: import("node:http").ServerResponse, subDir: string, fileName: string): boolean {
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) return false;
  const uploadBase = resolve(process.cwd(), basename(process.cwd()) === "opc-server" ? "uploads" : "opc-server/uploads", subDir);
  const filePath = join(uploadBase, fileName);
  if (!existsSync(filePath)) return false;
  const ext = extname(fileName).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".png" ? "image/png"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : ext === ".svg" ? "image/svg+xml"
    : "";
  if (!mime) return false;
  readFile(filePath).then(data => {
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
    res.end(data);
  }).catch(() => { res.writeHead(404); res.end(); });
  return true;
}

export async function handlePublicRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/health" && method === "GET") {
    sendJson(res, 200, { status: "ok", version: "0.2.0", uptime: process.uptime() });
    return true;
  }

  if (pathname === "/" || pathname === "/index.html") {
    servePortalPage(req, res);
    return true;
  }

  // 租户专属页面: /vip/slug
  const tenantPageMatch = pathname.match(/^\/vip\/([^/]+)\/?$/);
  if (tenantPageMatch && method === "GET") {
    const slug = decodeURIComponent(tenantPageMatch[1]);
    await serveTenantPage(req, res, db, slug);
    return true;
  }

  // 物联网 3D 平台页面
  if (pathname === "/iot" || pathname === "/iot/") {
    serveIotPage(req, res);
    return true;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (pathname === "/logo.png") {
    try {
      const imgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "img", "logo.png");
      const data = await readFile(imgPath);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "Not Found" });
    }
    return true;
  }

  // 上传文件服务
  if (pathname.startsWith("/tenant-logos/") && method === "GET") {
    if (serveUploadedFile(res, "tenant-logos", pathname.replace("/tenant-logos/", ""))) return true;
    sendJson(res, 404, { error: "Not Found" });
    return true;
  }
  if (pathname.startsWith("/iot-photos/") && method === "GET") {
    if (serveUploadedFile(res, "iot-photos", pathname.replace("/iot-photos/", ""))) return true;
    sendJson(res, 404, { error: "Not Found" });
    return true;
  }

  if (pathname.startsWith("/park-images/") && method === "GET") {
    if (serveUploadedFile(res, "park-images", pathname.replace("/park-images/", ""))) return true;
    sendJson(res, 404, { error: "Not Found" });
    return true;
  }

  return false;
}
