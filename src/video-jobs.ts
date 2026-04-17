import { v4 as uuid } from "uuid";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import type { Db } from "./db.js";

export type VideoJobRecord = {
  id: string;
  title: string;
  status: "queued" | "rendering" | "completed" | "failed";
  script_json: string;
  output_url?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  error_message?: string;
  requester_id?: string;
};

const PROMO_DIR = path.resolve(process.cwd(), "../promo-video");
const OUT_DIR = path.resolve(process.cwd(), "public/videos");
const runningJobs = new Set<string>();

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizeAiVideoConfig(input: any): Record<string, unknown> {
  const scenesInput = Array.isArray(input?.scenes) ? input.scenes : [];
  const scenes = scenesInput.slice(0, 6).map((scene: any, index: number) => ({
    icon: String(scene?.icon || "✨").slice(0, 2),
    title: String(scene?.title || `场景${index + 1}`).slice(0, 20),
    subtitle: String(scene?.subtitle || "").slice(0, 40),
    color: String(scene?.color || input?.accentColor || "#f97316"),
    body: String(scene?.body || scene?.subtitle || "").slice(0, 220),
    videoSrc: scene?.videoSrc ? String(scene.videoSrc) : undefined,
    subs: (Array.isArray(scene?.subs) ? scene.subs : [])
      .slice(0, 4)
      .map((sub: any, subIndex: number) => ({
        text: String(sub?.text || "").slice(0, 40),
        start: clampNumber(sub?.start, subIndex * 60, 0, 210),
        end: clampNumber(sub?.end, (subIndex + 1) * 80, 1, 210),
      }))
      .filter((sub: any) => sub.text),
  }));

  if (!scenes.length) {
    scenes.push({
      icon: "✨",
      title: String(input?.productName || "AI视频"),
      subtitle: String(input?.tagline || "自动生成视频"),
      color: String(input?.accentColor || "#f97316"),
      body: "已根据当前内容自动生成基础视频脚本，可继续补充更多场景以获得更丰富的画面表达。",
      subs: [
        { text: "AI 已生成基础视频脚本", start: 0, end: 100 },
        { text: "可继续补充场景内容后重新渲染", start: 100, end: 210 },
      ],
      videoSrc: undefined,
    });
  }

  return {
    productName: String(input?.productName || input?.title || "AI视频").slice(0, 40),
    tagline: String(input?.tagline || "让内容更快变成视频").slice(0, 60),
    accentColor: String(input?.accentColor || "#f97316"),
    scenes,
  };
}

function mapRowToJob(row: any): VideoJobRecord {
  return {
    id: String(row.id),
    title: String(row.title || "AI视频"),
    status: (row.status || "queued") as VideoJobRecord["status"],
    script_json: String(row.script_json || "{}"),
    output_url: row.output_url ? String(row.output_url) : undefined,
    created_at: String(row.created_at || new Date().toISOString()),
    updated_at: String(row.updated_at || row.created_at || new Date().toISOString()),
    completed_at: row.completed_at ? String(row.completed_at) : undefined,
    error_message: row.error_message ? String(row.error_message) : undefined,
    requester_id: row.requester_id ? String(row.requester_id) : undefined,
  };
}

function runRenderProcess(renderScript: string, outPath: string, propsPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [renderScript, outPath, propsPath], {
      cwd: PROMO_DIR,
      env: { ...process.env, NODE_ENV: "production" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 300000);

    child.stdout.on("data", (chunk) => { stdout += String(chunk || ""); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk || ""); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
      reject(new Error(detail || `Remotion 渲染失败，退出码 ${String(code)}，signal=${String(signal || "")}`));
    });
  });
}

export async function createVideoJob(
  db: Db,
  options: { title?: string; scriptJson: string; requesterId?: string; id?: string },
): Promise<VideoJobRecord> {
  const id = options.id || uuid();
  const title = options.title || "AI视频";
  const normalizedConfig = normalizeAiVideoConfig(JSON.parse(options.scriptJson || "{}"));
  await db.query(
    `INSERT INTO opc_video_jobs
      (id, title, status, script_json, requester_id, created_at, updated_at)
     VALUES ($1, $2, 'queued', $3, $4, NOW(), NOW())`,
    [id, title, JSON.stringify(normalizedConfig), options.requesterId || null],
  );
  const { rows } = await db.query("SELECT * FROM opc_video_jobs WHERE id = $1 LIMIT 1", [id]);
  return mapRowToJob(rows[0]);
}

export async function getVideoJob(db: Db, id: string): Promise<VideoJobRecord | null> {
  const { rows } = await db.query("SELECT * FROM opc_video_jobs WHERE id = $1 LIMIT 1", [id]);
  if (!rows[0]) return null;
  return mapRowToJob(rows[0]);
}

export async function getLatestVideoJobForUser(db: Db, requesterId: string): Promise<VideoJobRecord | null> {
  const { rows } = await db.query(
    "SELECT * FROM opc_video_jobs WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 1",
    [requesterId],
  );
  if (!rows[0]) return null;
  return mapRowToJob(rows[0]);
}

export async function listVideoJobs(db: Db): Promise<VideoJobRecord[]> {
  const { rows } = await db.query("SELECT * FROM opc_video_jobs ORDER BY created_at DESC LIMIT 100");
  return (rows as any[]).map(mapRowToJob);
}

export async function scheduleVideoRender(db: Db, jobId: string): Promise<void> {
  setImmediate(() => {
    void renderVideoJob(db, jobId);
  });
}

export async function renderVideoJob(db: Db, id: string): Promise<void> {
  if (runningJobs.has(id)) return;
  runningJobs.add(id);
  try {
    const job = await getVideoJob(db, id);
    if (!job) return;

    await db.query(
      "UPDATE opc_video_jobs SET status = 'rendering', updated_at = NOW(), error_message = '' WHERE id = $1",
      [id],
    );

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    if (!fs.existsSync(PROMO_DIR)) {
      throw new Error(`未找到 promo-video 目录: ${PROMO_DIR}`);
    }
    if (!fs.existsSync(path.join(PROMO_DIR, "node_modules"))) {
      throw new Error("未检测到 promo-video/node_modules，请先在 promo-video 目录执行 npm install");
    }

    const outPath = path.join(OUT_DIR, `${id}.mp4`);
    const propsPath = path.join(PROMO_DIR, `${id}-props.json`);
    const parsedConfig = JSON.parse(job.script_json);
    fs.writeFileSync(propsPath, JSON.stringify({ videoConfig: parsedConfig }), "utf-8");

    const renderScript = path.join(PROMO_DIR, "render.mjs");
    await runRenderProcess(renderScript, outPath, propsPath);

    const outputUrl = `/public/videos/${id}.mp4`;
    await db.query(
      `UPDATE opc_video_jobs
       SET status = 'completed', output_url = $2, updated_at = NOW(), completed_at = NOW(), error_message = ''
       WHERE id = $1`,
      [id, outputUrl],
    );

    try { fs.unlinkSync(propsPath); } catch { /* ignore */ }
    console.log(`[Video] 渲染完成: ${job.title} → ${outputUrl}`);
  } catch (err: unknown) {
    const message = (err as Error).message?.slice(0, 300) || "渲染失败";
    await db.query(
      "UPDATE opc_video_jobs SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
      [id, message],
    );
    console.error("[Video] 渲染失败:", message);
  } finally {
    runningJobs.delete(id);
  }
}
