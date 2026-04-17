/**
 * OPC Server — 一人公司孵化平台 线上版
 *
 * Node.js HTTP + PostgreSQL 连接池
 * - JWT 认证
 * - AI 对话 (tool calling)
 * - SPA 前端 (内联 HTML)
 */

import { createServer } from "node:http";
import "dotenv/config";

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err.message, err.stack?.split("\n")[1] || "");
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});
import { createPool, initDatabase } from "./src/db.js";
import { setJwtSecret } from "./src/auth/jwt.js";
import { setInternalKey } from "./src/auth/middleware.js";
import { getInternalKey } from "./src/router/cloud-proxy.js";
import { configureAi, type AiMode } from "./src/chat/ai-client.js";
import { configureSearch, configureSmtp } from "./src/chat/tool-executor.js";
import { createRouter } from "./src/router.js";
import { hashPassword } from "./src/auth/password.js";
import { v4 as uuid } from "uuid";
import { initScheduler } from "./src/scheduler/scheduler.js";
import { startWorkflowScheduler } from "./src/local-agent/workflow-engine.js";
import { startFeishu } from "./src/local-agent/feishu-bridge.js";
import { loadPlansFromDb } from "./src/api/subscription-api.js";

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const PORT = parseInt(env("PORT", "3000"), 10);
const JWT_SECRET = env("JWT_SECRET", "");
const ADMIN_PHONE = env("ADMIN_PHONE", "");
const ADMIN_PASSWORD = env("ADMIN_PASSWORD", "");
const AI_BASE_URL = env("AI_BASE_URL", "");
const AI_API_KEY = env("AI_API_KEY", "");
const AI_MODEL = env("AI_MODEL", "");

async function main() {
  if (!JWT_SECRET) {
    console.error("[OPC] 错误: 必须设置 JWT_SECRET 环境变量");
    process.exit(1);
  }
  setJwtSecret(JWT_SECRET);
  setInternalKey(getInternalKey());
  const AI_MODE = env("AI_MODE", "local") as AiMode;
  if (AI_API_KEY) {
    configureAi({ baseUrl: AI_BASE_URL || undefined, apiKey: AI_API_KEY, model: AI_MODEL || undefined, mode: AI_MODE });
  }

  const dbType = env("DB_TYPE", "postgres");
  if (dbType !== "sqlite" && !env("DB_PASSWORD", "")) {
    console.error("[OPC] 错误: 必须设置 DB_PASSWORD 环境变量");
    process.exit(1);
  }
  const pool = await createPool({
    host: env("DB_HOST", "localhost"),
    port: parseInt(env("DB_PORT", "5432"), 10),
    user: env("DB_USER", "postgres"),
    password: env("DB_PASSWORD", ""),
    database: env("DB_NAME", "opc_db"),
  });

  try {
    await initDatabase(pool);
    console.log(dbType === "sqlite" ? "[OPC] SQLite 初始化完成" : "[OPC] PostgreSQL 连接成功，迁移完成");
  } catch (e) {
    console.error("[OPC] 数据库初始化失败:", e);
    process.exit(1);
  }

  initScheduler(pool);
  startWorkflowScheduler(pool);
  await loadPlansFromDb(pool);

  if (ADMIN_PHONE && ADMIN_PASSWORD) {
    const { rows } = await pool.query("SELECT id FROM opc_users WHERE phone = $1", [ADMIN_PHONE]);
    if (rows.length === 0) {
      const id = uuid();
      await pool.query(
        "INSERT INTO opc_users (id, phone, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)",
        [id, ADMIN_PHONE, hashPassword(ADMIN_PASSWORD), "管理员", "admin"],
      );
      console.log(`[OPC] 管理员账户已创建: ${ADMIN_PHONE}`);
    }
  }

  const isLocal = env("LOCAL_MODE", "") === "true" || env("OPC_LOCAL_MODE", "") === "1" || dbType === "sqlite";
  if (AI_API_KEY) {
    const { rows: existing } = await pool.query("SELECT value FROM opc_tool_config WHERE key = 'ai_api_key'");
    if (!existing.length || !existing[0].value) {
      const upsert = "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";
      await pool.query(upsert, ["ai_api_key", AI_API_KEY]);
      if (AI_BASE_URL) await pool.query(upsert, ["ai_base_url", AI_BASE_URL]);
      if (AI_MODEL) await pool.query(upsert, ["ai_model", AI_MODEL]);
      console.log(isLocal ? "[OPC] LOCAL_MODE: AI 配置已从环境变量初始化" : "[OPC] AI 配置已从环境变量初始化");
    }
  }

  // 从 DB 加载用户配置的 AI 参数（含 AI 运行模式）
  {
    const { rows } = await pool.query("SELECT key, value FROM opc_tool_config WHERE key IN ($1, $2, $3, $4)", [
      "ai_api_key", "ai_base_url", "ai_model", "ai_mode",
    ]);
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value;
    if (cfg.ai_api_key) {
      configureAi({
        baseUrl: cfg.ai_base_url || undefined,
        apiKey: cfg.ai_api_key,
        model: cfg.ai_model || undefined,
        mode: (cfg.ai_mode as AiMode) || undefined,
      });
      console.log("[OPC] AI 配置已从数据库加载");
    }
  }

  // 从 DB 加载搜索服务配置
  {
    const { rows } = await pool.query("SELECT key, value FROM opc_tool_config WHERE key IN ($1, $2)", [
      "uapi_key", "uapi_url",
    ]);
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value;
    if (cfg.uapi_key) {
      configureSearch({ apiKey: cfg.uapi_key, apiUrl: cfg.uapi_url || undefined });
      console.log("[OPC] 搜索服务配置已从数据库加载");
    }
  }

  if (process.env.UAPI_KEY) {
    const { rows: existing } = await pool.query("SELECT value FROM opc_tool_config WHERE key = 'uapi_key'");
    if (!existing.length || !existing[0].value) {
      const upsert = "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";
      await pool.query(upsert, ["uapi_key", process.env.UAPI_KEY]);
      if (process.env.UAPI_URL) await pool.query(upsert, ["uapi_url", process.env.UAPI_URL]);
      configureSearch({ apiKey: process.env.UAPI_KEY, apiUrl: process.env.UAPI_URL || undefined });
      console.log("[OPC] 搜索服务配置已从环境变量初始化");
    }
  }

  // 从 opc_email_accounts 加载第一个启用的邮箱作为 SMTP 发件配置
  {
    const { rows } = await pool.query(
      "SELECT email, smtp_host, smtp_port, password FROM opc_email_accounts WHERE enabled = true ORDER BY created_at LIMIT 1",
    );
    if (rows.length > 0) {
      configureSmtp({
        host: rows[0].smtp_host,
        port: rows[0].smtp_port,
        user: rows[0].email,
        pass: rows[0].password,
      });
      console.log("[OPC] SMTP 邮箱配置已从用户邮箱加载:", rows[0].email);
    }
  }

  if (isLocal) {
    const { rows: fsRows } = await pool.query("SELECT key, value FROM opc_tool_config WHERE key IN ($1, $2)", ["feishu_app_id", "feishu_app_secret"]);
    const fsCfg: Record<string, string> = {};
    for (const r of fsRows) fsCfg[r.key] = r.value;
    if (fsCfg.feishu_app_id && fsCfg.feishu_app_secret) {
      startFeishu(fsCfg.feishu_app_id, fsCfg.feishu_app_secret, pool).then(r => {
        if (r.ok) console.log("[OPC] 飞书长连接已自动恢复");
        else console.warn("[OPC] 飞书连接恢复失败:", r.error);
      }).catch(() => {});
    }
  }

  const handler = createRouter(pool);
  const server = createServer(handler);
  server.maxConnections = 200;
  server.timeout = 300_000;       // 5 分钟请求超时（覆盖 SSE 场景）
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const cloudApiUrl = env("OPC_CLOUD_API_URL", "");
  if (isLocal && cloudApiUrl) {
    console.log(`[OPC] 桌面本地版已启用云端代理: ${cloudApiUrl}`);
  }

  server.listen(PORT, "0.0.0.0", () => {
    const edition = dbType === "sqlite" ? "SQLite Local Edition" : "PostgreSQL Edition";
    const aiModeLabel = isLocal ? ` | AI: ${AI_MODE}` : "";
    const cloudLabel = isLocal && cloudApiUrl ? " | Cloud: ON" : "";
    console.log(`
  ╔═══════════════════════════════════════════╗
  ║     星环OPC — 一人公司孵化平台 v0.2       ║
  ║     ${edition.padEnd(36)}║
  ║     http://localhost:${String(PORT).padEnd(20)}║${aiModeLabel}${cloudLabel}
  ╚═══════════════════════════════════════════╝
  `);
  });
}

main().catch((e) => {
  console.error("[OPC] 启动失败:", e);
  process.exit(1);
});
