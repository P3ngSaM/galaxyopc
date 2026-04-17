import type { IncomingMessage, ServerResponse } from "http";
import path from "path";
import fs from "fs";
import type { AuthRequest } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { createVideoJob, getVideoJob, getLatestVideoJobForUser, listVideoJobs, scheduleVideoRender } from "../video-jobs.js";

const PROMO_DIR = path.resolve(process.cwd(), "../promo-video");
const OUT_DIR = path.resolve(process.cwd(), "public/videos");

function jsonRes(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

// 内部核心函数（供工作流引擎直接调用）
export async function handleVideoRenderCore(
  db: Db,
  scriptConfig: Record<string, unknown>,
  title = "AI视频",
  requesterId?: string,
): Promise<{ jobId: string; outputPath: string; status: string }> {
  const job = await createVideoJob(db, {
    title,
    scriptJson: JSON.stringify(scriptConfig),
    requesterId,
  });
  await scheduleVideoRender(db, job.id);
  return { jobId: job.id, outputPath: "", status: "queued" };
}

// POST /api/video/render — 提交渲染任务
export async function handleVideoRender(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  const body = (await readBody(req)) as Record<string, string>;
  const { title = "AI视频", script_json } = body;

  if (!script_json) {
    return jsonRes(res, { error: "缺少 script_json" }, 400);
  }

  // 验证 JSON
  try { JSON.parse(script_json); } catch {
    return jsonRes(res, { error: "script_json 不是合法的 JSON" }, 400);
  }

  const job = await createVideoJob(db, {
    title,
    scriptJson: script_json,
    requesterId: req.user?.userId,
  });
  await scheduleVideoRender(db, job.id);

  jsonRes(res, {
    success: true,
    video_id: job.id,
    status: "queued",
    message: `视频「${title}」已加入渲染队列，约需 1-3 分钟。`,
  });
}

// GET /api/video/jobs — 列出所有任务
export async function handleVideoJobs(_req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  const jobs = await listVideoJobs(db);
  const videos = jobs.map((v) => ({
    id: v.id,
    title: v.title,
    status: v.status,
    output_url: v.output_url,
    created_at: v.created_at,
    error: v.error_message,
  }));
  jsonRes(res, { success: true, videos });
}

// GET /api/video/job/:id — 查询单个任务
export async function handleVideoJobStatus(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  let job = await getVideoJob(db, id);
  if (!job && req.user?.userId) {
    job = await getLatestVideoJobForUser(db, req.user.userId);
  }
  if (!job) return jsonRes(res, { error: "任务不存在" }, 404);
  jsonRes(res, {
    success: true,
    id: job.id,
    title: job.title,
    status: job.status,
    output_url: job.output_url,
    created_at: job.created_at,
    error: job.error_message,
  });
}

// POST /api/video/open-folder — 在系统文件管理器中打开视频目录
export async function handleVideoOpenFolder(_req: AuthRequest, res: ServerResponse): Promise<void> {
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const { execSync } = await import("child_process");
    const platform = process.platform;
    if (platform === "win32") {
      execSync(`explorer "${OUT_DIR}"`, { timeout: 5000 });
    } else if (platform === "darwin") {
      execSync(`open "${OUT_DIR}"`, { timeout: 5000 });
    } else {
      execSync(`xdg-open "${OUT_DIR}"`, { timeout: 5000 });
    }
    jsonRes(res, { success: true, path: OUT_DIR });
  } catch (e: unknown) {
    jsonRes(res, { success: false, path: OUT_DIR, error: (e as Error).message });
  }
}

// GET /api/video/files — 列出磁盘上所有已生成的 mp4 文件（含工作流产出）
export async function handleVideoFiles(_req: AuthRequest, res: ServerResponse): Promise<void> {
  const files: Array<{ name: string; url: string; size: number; mtime: string }> = [];
  try {
    if (fs.existsSync(OUT_DIR)) {
      const entries = fs.readdirSync(OUT_DIR).filter(f => f.endsWith(".mp4"));
      for (const name of entries) {
        const stat = fs.statSync(path.join(OUT_DIR, name));
        files.push({
          name,
          url: `/public/videos/${name}`,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
      files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    }
  } catch { /* ignore */ }
  jsonRes(res, { success: true, files });
}
