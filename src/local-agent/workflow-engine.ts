/**
 * 智能工作流引擎 — 条件触发 + 多步动作链
 * 触发方式：定时(cron) / 事件(data_change) / 手动(manual)
 * 动作类型：send_email / create_todo / ai_generate / notify / local_tool / opc_tool
 *           fetch_webpage / render_html / render_video
 * 仅 LOCAL_MODE 下启用
 */

import { v4 as uuid } from "uuid";
import { createHash } from "crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import type { Db } from "../db.js";
import { callAi } from "../chat/ai-client.js";
import { executeTool } from "../chat/tool-executor.js";
import { isLocalModeEnabled } from "./security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Workflow {
  id: string;
  userId: string;
  companyId?: string;
  name: string;
  description?: string;
  triggerType: "cron" | "event" | "manual";
  triggerConfig: Record<string, unknown>;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  enabled: boolean;
  lastRunAt?: string;
  runCount: number;
  createdAt: string;
}

export interface WorkflowCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "lt" | "contains" | "exists";
  value: unknown;
}

export interface WorkflowAction {
  type: "send_email" | "create_todo" | "ai_generate" | "notify" | "opc_tool" | "local_tool"
      | "fetch_webpage" | "render_html" | "render_video";
  config: Record<string, unknown>;
  label?: string;
}

interface WorkflowLogStep {
  action: string;
  status: "done" | "failed" | "skipped";
  result?: string;
  error?: string;
}

// ─── 自然语言创建工作流 ───────────────────────────────────────────

export async function createWorkflowFromNL(
  db: Db, userId: string, instruction: string, companyId?: string,
): Promise<Workflow> {
  const prompt = `你是工作流配置专家。将用户指令转为工作流 JSON。

可用触发器：
- cron: 定时触发，config 含 expression（cron 表达式）如 "0 17 * * 5" = 每周五17:00
- event: 数据变化触发，config 含 event_type（如 new_contact, contract_expiring, follow_up_due）
- manual: 手动触发

可用动作（actions 数组，按顺序执行，支持 {{上一步结果变量}}）：
- fetch_webpage: 抓取网页/RSS内容，config 含 url（支持{{变量}}）、save_as（保存到上下文的键名，如 "content"）
- ai_generate: AI 生成内容，config 含 prompt（支持{{content}}等变量）、save_as（保存键名或文档标题）
- render_html: 将 HTML 内容渲染为图片并保存，config 含 html（支持{{变量}}）、save_as（文件名，无需后缀）
- render_video: 用 Remotion 渲染视频，config 含 topic（视频主题，支持{{变量}}）、scenes_count（场景数，默认4）、save_as（文件名）
- send_email: 发邮件，config 含 to/subject/body（支持{{变量}}，body 可用 attachment_key 附带上一步生成的文件路径）
- create_todo: 创建待办，config 含 title/description/due_days（几天后到期）
- notify: 站内通知，config 含 message（支持{{变量}}）
- opc_tool: 调用业务工具，config 含 tool/action/params

变量说明：前一步 save_as 的键名可在后续步骤用 {{键名}} 引用；特殊变量：{{ai_result}} = 最近一次 ai_generate 结果，{{fetch_content}} = 最近一次 fetch_webpage 内容，{{video_path}} = 最近一次渲染的视频路径，{{html_path}} = 最近一次渲染的图片路径。

返回 JSON 格式：
{ "name": "工作流名称", "description": "描述", "trigger_type": "cron|event|manual", "trigger_config": {}, "conditions": [], "actions": [{ "type": "...", "config": {}, "label": "步骤描述" }] }

只返回 JSON，不要其他文字。

用户指令：${instruction}`;

  const resp = await callAi([{ role: "user", content: prompt }]);
  const text = resp.content || "{}";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/```json?\s*/g, "").replace(/```/g, "").trim());
  } catch {
    parsed = {
      name: instruction.slice(0, 50),
      description: instruction,
      trigger_type: "manual",
      trigger_config: {},
      conditions: [],
      actions: [{ type: "notify", config: { message: instruction }, label: instruction }],
    };
  }

  const wf: Workflow = {
    id: uuid(),
    userId,
    companyId: companyId || undefined,
    name: String(parsed.name || "未命名工作流"),
    description: String(parsed.description || ""),
    triggerType: (parsed.trigger_type as Workflow["triggerType"]) || "manual",
    triggerConfig: (parsed.trigger_config as Record<string, unknown>) || {},
    conditions: (parsed.conditions as WorkflowCondition[]) || [],
    actions: (parsed.actions as WorkflowAction[]) || [],
    enabled: true,
    runCount: 0,
    createdAt: new Date().toISOString(),
  };

  await db.query(
    `INSERT INTO opc_workflows (id, user_id, company_id, name, description, trigger_type, trigger_config, conditions, actions, enabled, run_count, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [wf.id, userId, wf.companyId || null, wf.name, wf.description, wf.triggerType,
     JSON.stringify(wf.triggerConfig), JSON.stringify(wf.conditions),
     JSON.stringify(wf.actions), true, 0, wf.createdAt],
  );

  return wf;
}

// ─── 直接创建（跳过 AI 解析）─────────────────────────────────────

export async function createWorkflowDirect(
  db: Db, userId: string, data: Record<string, unknown>, companyId?: string,
): Promise<Workflow> {
  const wf: Workflow = {
    id: uuid(),
    userId,
    companyId: companyId || undefined,
    name: String(data.name || "未命名工作流"),
    description: String(data.description || ""),
    triggerType: (data.trigger_type as Workflow["triggerType"]) || "manual",
    triggerConfig: (data.trigger_config as Record<string, unknown>) || {},
    conditions: (data.conditions as WorkflowCondition[]) || [],
    actions: (data.actions as WorkflowAction[]) || [],
    enabled: true,
    runCount: 0,
    createdAt: new Date().toISOString(),
  };

  await db.query(
    `INSERT INTO opc_workflows (id, user_id, company_id, name, description, trigger_type, trigger_config, conditions, actions, enabled, run_count, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [wf.id, userId, wf.companyId || null, wf.name, wf.description, wf.triggerType,
     JSON.stringify(wf.triggerConfig), JSON.stringify(wf.conditions),
     JSON.stringify(wf.actions), true, 0, wf.createdAt],
  );

  return wf;
}

// ─── 执行工作流 ────────────────────────────────────────────────────

export async function executeWorkflow(
  db: Db, wf: Workflow, context?: Record<string, unknown>,
): Promise<{ success: boolean; logId: string }> {
  const logId = uuid();
  const steps: WorkflowLogStep[] = [];

  // 共享上下文，支持步骤间传递变量
  const ctx: Record<string, unknown> = { ...(context || {}), workflow_name: wf.name };

  await db.query(
    `INSERT INTO opc_workflow_logs (id, workflow_id, user_id, status, started_at) VALUES ($1,$2,$3,'running',NOW())`,
    [logId, wf.id, wf.userId],
  );

  let allOk = true;

  for (const action of wf.actions) {
    const step: WorkflowLogStep = { action: action.label || action.type, status: "done" };
    // 将 ctx 作为局部 context 引用（允许新节点向其写入变量）
    const context = ctx;
    try {
      switch (action.type) {
        case "send_email": {
          const cfg = action.config;
          const result = await executeTool("opc_email", {
            to: cfg.to, subject: interpolate(String(cfg.subject || ""), context),
            body: interpolate(String(cfg.body || ""), context),
          }, db, wf.companyId || "", wf.userId);
          step.result = result;
          break;
        }
        case "create_todo": {
          const cfg = action.config;
          const dueDays = Number(cfg.due_days) || 3;
          const dueDate = new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10);
          const result = await executeTool("opc_schedule", {
            action: "add_todo",
            title: interpolate(String(cfg.title || ""), context),
            description: interpolate(String(cfg.description || ""), context),
            due_date: dueDate,
          }, db, wf.companyId || "", wf.userId);
          step.result = result;
          break;
        }
        case "ai_generate": {
          const cfg = action.config;
          const aiResp = await callAi([{
            role: "user",
            content: interpolate(String(cfg.prompt || ""), context),
          }]);
          const aiContent = aiResp.content || "";
          step.result = aiContent.slice(0, 2000);
          if (cfg.save_as) {
            const saveKey = String(cfg.save_as);
            // 将 AI 输出存入上下文供下游节点引用
            context[saveKey] = aiContent;
            context["ai_result"] = aiContent;
            // 同时保存为文档（仅当 save_as 含有文档名称时）
            try {
              await executeTool("opc_document", {
                action: "generate",
                title: saveKey,
                content: aiContent,
              }, db, wf.companyId || "", wf.userId);
            } catch (_) {}
          } else {
            context["ai_result"] = aiContent;
          }
          break;
        }
        case "notify": {
          const cfg = action.config;
          const msg = interpolate(String(cfg.message || ""), context);
          await db.query(
            `INSERT INTO opc_chat_messages (id, conversation_id, role, content, created_at)
             VALUES ($1, 'system-notify', 'assistant', $2, NOW())`,
            [uuid(), `[工作流通知] ${wf.name}: ${msg}`],
          );
          step.result = msg;
          break;
        }
        case "opc_tool": {
          const cfg = action.config;
          const result = await executeTool(
            String(cfg.tool), { action: cfg.action, ...(cfg.params as Record<string, unknown> || {}) },
            db, wf.companyId || "", wf.userId,
          );
          step.result = result;
          break;
        }
        case "local_tool": {
          if (!isLocalModeEnabled()) { step.status = "skipped"; step.error = "非本地版"; break; }
          const cfg = action.config;
          const { executeLocalTool } = await import("./local-tools.js");
          const result = await executeLocalTool(
            String(cfg.tool), (cfg.params as Record<string, unknown>) || {},
            db, wf.userId,
          );
          step.result = result;
          break;
        }
        case "fetch_webpage": {
          const cfg = action.config;
          const url = interpolate(String(cfg.url || ""), context);
          if (!url) { step.status = "skipped"; step.error = "缺少 url"; break; }
          const content = await fetchWebpage(url);
          step.result = content.slice(0, 500) + (content.length > 500 ? "..." : "");
          if (context) {
            const key = String(cfg.save_as || "fetch_content");
            context[key] = content;
            context["fetch_content"] = content;
          }
          break;
        }
        case "render_html": {
          const cfg = action.config;
          const htmlContent = interpolate(String(cfg.html || ""), context);
          const saveName = String(cfg.save_as || `html-${Date.now()}`);
          const outPath = await renderHtmlToImage(htmlContent, saveName);
          step.result = `已保存到: ${outPath}`;
          if (context) {
            const key = String(cfg.save_as || "html_path");
            context[key] = outPath;
            context["html_path"] = outPath;
          }
          break;
        }
        case "render_video": {
          const cfg = action.config;
          const topic = interpolate(String(cfg.topic || "产品介绍"), context);
          const scenesCount = Number(cfg.scenes_count) || 4;
          const saveName = String(cfg.save_as || `video-${Date.now()}`);
          const outPath = await renderRemotionVideo(topic, scenesCount, saveName, db, wf.userId, wf.companyId);
          step.result = `视频已渲染: ${outPath}`;
          if (context) {
            const key = String(cfg.save_as || "video_path");
            context[key] = outPath;
            context["video_path"] = outPath;
          }
          break;
        }
        default:
          step.status = "skipped";
          step.error = `未知动作: ${action.type}`;
      }
    } catch (e: any) {
      step.status = "failed";
      step.error = e.message;
      allOk = false;
    }
    steps.push(step);
    if (step.status === "failed") break;
  }

  await db.query(
    `UPDATE opc_workflow_logs SET status=$1, steps=$2, error=$3, finished_at=NOW() WHERE id=$4`,
    [allOk ? "done" : "failed", JSON.stringify(steps), allOk ? null : steps.find(s => s.error)?.error, logId],
  );
  await db.query(
    `UPDATE opc_workflows SET last_run_at=NOW(), run_count=run_count+1 WHERE id=$1`,
    [wf.id],
  );

  return { success: allOk, logId };
}

function interpolate(template: string, ctx?: Record<string, unknown>): string {
  if (!ctx) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return ctx[key] !== undefined ? String(ctx[key]) : `{{${key}}}`;
  });
}

// ─── 新节点辅助函数 ────────────────────────────────────────────────

async function fetchWebpage(url: string, visited = new Set<string>(), depth = 0): Promise<string> {
  const { default: https } = await import("https");
  const { default: http } = await import("http");
  const { default: zlib } = await import("zlib");
  const normalized = new URL(url).toString();
  if (visited.has(normalized)) throw new Error(`目标站点发生重定向循环: ${normalized}`);
  if (depth > 8) throw new Error("目标站点重定向次数过多");
  visited.add(normalized);

  return new Promise((resolve, reject) => {
    const isHttps = normalized.startsWith("https");
    const client = isHttps ? https : http;
    const req = client.get(normalized, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OPC-Workflow-Bot/1.0)",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Encoding": "gzip, deflate",
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location as string, normalized).toString();
        fetchWebpage(nextUrl, visited, depth + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`网页请求失败 (${res.statusCode})`));
        return;
      }

      const chunks: Buffer[] = [];
      const encoding = res.headers["content-encoding"];

      const processStream = (stream: NodeJS.ReadableStream) => {
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          // 粗略去除 HTML 标签，保留文本
          const text = raw
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          resolve(text.slice(0, 8000));
        });
        stream.on("error", reject);
      };

      if (encoding === "gzip") {
        const gunzip = zlib.createGunzip();
        res.pipe(gunzip);
        processStream(gunzip);
      } else if (encoding === "deflate") {
        const inflate = zlib.createInflate();
        res.pipe(inflate);
        processStream(inflate);
      } else {
        processStream(res);
      }
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("抓取超时")); });
  });
}

async function renderHtmlToImage(html: string, saveName: string): Promise<string> {
  const outputDir = path.resolve(__dirname, "../../../workflow-outputs");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const safeHash = createHash("md5").update(html.slice(0, 200) + Date.now()).digest("hex").slice(0, 8);
  const fileName = `${saveName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_")}-${safeHash}.html`;
  const htmlPath = path.join(outputDir, fileName);
  const pngPath = htmlPath.replace(/\.html$/, ".png");

  writeFileSync(htmlPath, html, "utf-8");

  // 尝试用 puppeteer 截图（如果已安装）
  try {
    const puppeteerScript = `
const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  await p.goto('file://${htmlPath.replace(/\\/g, "/")}', { waitUntil: 'networkidle2', timeout: 30000 });
  await p.screenshot({ path: '${pngPath.replace(/\\/g, "/")}', fullPage: true });
  await b.close();
})();`;
    const scriptPath = path.join(outputDir, `_snap_${safeHash}.js`);
    writeFileSync(scriptPath, puppeteerScript, "utf-8");
    execSync(`node "${scriptPath}"`, { timeout: 60000 });
    return pngPath;
  } catch {
    // Puppeteer 未安装，返回 HTML 文件路径
    return htmlPath;
  }
}

async function renderRemotionVideo(
  topic: string, scenesCount: number, saveName: string,
  db: Db, userId: string, companyId?: string,
): Promise<string> {
  // 先让 AI 生成脚本
  const scriptPrompt = `你是视频脚本专家。为主题"${topic}"生成 ${scenesCount} 个视频场景脚本。
返回 JSON（只返回 JSON 不要其他文字）：
{
  "productName": "产品/主题名称",
  "tagline": "一句话介绍",
  "accentColor": "#16a34a",
  "scenes": [
    {
      "icon": "🚀",
      "title": "场景标题",
      "subtitle": "副标题",
      "color": "#3b82f6",
      "body": "正文说明，50-80字",
      "subs": [
        { "text": "第一条字幕", "start": 0, "end": 80 },
        { "text": "第二条字幕", "start": 80, "end": 210 }
      ]
    }
  ]
}
要求：scenes 数量为 ${scenesCount}，subs 的 end 值不超过 210。`;
  const aiResp = await callAi([{ role: "user", content: scriptPrompt }]);
  let scriptJson: unknown;
  try {
    const raw = (aiResp.content || "{}").replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    scriptJson = JSON.parse(raw);
  } catch {
    scriptJson = { productName: topic, tagline: topic, accentColor: "#f97316", scenes: [] };
  }

  // 直接调用 Remotion 渲染（同步等待完成，工作流可拿到最终路径）
  const PROMO_DIR = path.resolve(__dirname, "../../../promo-video");
  const OUT_DIR = path.resolve(__dirname, "../../public/videos");
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const jobId = `wf-${Date.now()}`;
  const outPath = path.join(OUT_DIR, `${jobId}.mp4`);
  // props 文件放到 promo-video 目录，避免 Windows 路径空格问题
  const propsPath = path.join(PROMO_DIR, `${jobId}-props.json`);
  writeFileSync(propsPath, JSON.stringify({ videoConfig: scriptJson }), "utf-8");

  const renderScript = path.join(PROMO_DIR, "render.mjs");

  try {
    execSync(
      `node "${renderScript}" "${outPath}" "${propsPath}"`,
      { cwd: PROMO_DIR, timeout: 300000, stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } },
    );
    try { unlinkSync(propsPath); } catch { /* ignore */ }
    return `/public/videos/${jobId}.mp4`;
  } catch (e: unknown) {
    try { unlinkSync(propsPath); } catch { /* ignore */ }
    const msg = (e as any)?.stderr?.toString?.() || (e as Error).message || "渲染失败";
    throw new Error(`视频渲染失败: ${msg.slice(0, 400)}`);
  }
}

// ─── 定时工作流轮询 ────────────────────────────────────────────────

let _wfInterval: ReturnType<typeof setInterval> | null = null;

export function startWorkflowScheduler(db: Db): void {
  if (!isLocalModeEnabled() || _wfInterval) return;

  _wfInterval = setInterval(async () => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM opc_workflows WHERE enabled = true AND trigger_type = 'cron'`,
      );
      const now = new Date();
      for (const r of rows as any[]) {
        const expr = r.trigger_config?.expression;
        if (!expr) continue;
        if (!shouldRunCron(expr, now, r.last_run_at ? new Date(r.last_run_at) : null)) continue;
        const wf = rowToWorkflow(r);
        executeWorkflow(db, wf).catch(e => console.error("[Workflow cron error]", wf.name, e));
      }
    } catch (e) {
      console.error("[WorkflowScheduler] poll error:", e);
    }
  }, 60_000);

  console.log("[WorkflowScheduler] started (1min interval)");
}

function shouldRunCron(expr: string, now: Date, lastRun: Date | null): boolean {
  const parts = expr.split(/\s+/);
  if (parts.length < 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const match = (field: string, value: number) => {
    if (field === "*") return true;
    if (field.includes(",")) return field.split(",").some(v => parseInt(v, 10) === value);
    if (field.includes("/")) {
      const [, step] = field.split("/");
      return value % parseInt(step, 10) === 0;
    }
    return parseInt(field, 10) === value;
  };

  if (!match(minute, now.getMinutes())) return false;
  if (!match(hour, now.getHours())) return false;
  if (!match(dayOfMonth, now.getDate())) return false;
  if (!match(month, now.getMonth() + 1)) return false;
  if (!match(dayOfWeek, now.getDay())) return false;

  if (lastRun && (now.getTime() - lastRun.getTime()) < 55_000) return false;
  return true;
}

function rowToWorkflow(r: any): Workflow {
  return {
    id: r.id, userId: r.user_id, companyId: r.company_id,
    name: r.name, description: r.description,
    triggerType: r.trigger_type, triggerConfig: r.trigger_config || {},
    conditions: r.conditions || [], actions: r.actions || [],
    enabled: r.enabled, lastRunAt: r.last_run_at,
    runCount: r.run_count || 0, createdAt: r.created_at,
  };
}

// ─── CRUD helpers ──────────────────────────────────────────────────

export async function listWorkflows(db: Db, userId: string): Promise<Workflow[]> {
  const { rows } = await db.query(
    "SELECT * FROM opc_workflows WHERE user_id = $1 ORDER BY created_at DESC", [userId],
  );
  return (rows as any[]).map(rowToWorkflow);
}

export async function getWorkflow(db: Db, wfId: string, userId: string): Promise<Workflow | null> {
  const { rows } = await db.query("SELECT * FROM opc_workflows WHERE id=$1 AND user_id=$2", [wfId, userId]);
  return rows[0] ? rowToWorkflow(rows[0]) : null;
}

export async function toggleWorkflow(db: Db, wfId: string, userId: string, enabled: boolean): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE opc_workflows SET enabled=$1 WHERE id=$2 AND user_id=$3", [enabled, wfId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteWorkflow(db: Db, wfId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM opc_workflows WHERE id=$1 AND user_id=$2", [wfId, userId]);
  return (rowCount ?? 0) > 0;
}

export async function getWorkflowLogs(db: Db, wfId: string, limit = 20): Promise<any[]> {
  const { rows } = await db.query(
    "SELECT * FROM opc_workflow_logs WHERE workflow_id=$1 ORDER BY started_at DESC LIMIT $2", [wfId, limit],
  );
  return rows;
}
