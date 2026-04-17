/**
 * 本地操作安全模块 — 路径校验、风险分级、审批队列
 * 仅 LOCAL_MODE 下启用
 */

import os from "os";
import path from "path";
import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";

export type RiskLevel = "low" | "medium" | "high";

export interface ApprovalRequest {
  id: string;
  userId: string;
  tool: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  description: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  resolve?: (approved: boolean) => void;
}

const DANGEROUS_PATHS_WIN = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
];

const DANGEROUS_PATHS_UNIX = [
  "/bin", "/sbin", "/usr/bin", "/usr/sbin",
  "/etc", "/var", "/boot", "/sys", "/proc",
];

const DANGEROUS_COMMANDS = [
  /\brm\s+-rf\s+[\/\\]/i,
  /\bformat\b/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+(delete|add)/i,
  /\bnetsh\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
];

const pendingApprovals = new Map<string, ApprovalRequest>();
const autoApproveUsers = new Set<string>();

export function setAutoApprove(userId: string, enabled: boolean): void {
  if (enabled) autoApproveUsers.add(userId);
  else autoApproveUsers.delete(userId);
}

export function isLocalModeEnabled(): boolean {
  return process.env.LOCAL_MODE === "true"
    || process.env.OPC_LOCAL_MODE === "1"
    || process.env.OPC_LOCAL_MODE === "true"
    || process.env.DB_TYPE === "sqlite";
}

export function getHomeDir(): string {
  return os.homedir();
}

export function normalizePath(p: string): string {
  if (p.startsWith("~")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

export function isDangerousPath(p: string): boolean {
  const normalized = normalizePath(p).toLowerCase();
  const dangerous = process.platform === "win32" ? DANGEROUS_PATHS_WIN : DANGEROUS_PATHS_UNIX;
  return dangerous.some(d => normalized.startsWith(d.toLowerCase()));
}

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_COMMANDS.some(rx => rx.test(cmd));
}

export function classifyRisk(tool: string, args: Record<string, unknown>): RiskLevel {
  switch (tool) {
    case "local_list_dir":
    case "local_read_file":
    case "local_search_files":
    case "local_screenshot":
    case "local_clipboard_read":
    case "local_clipboard_write":
    case "local_undo":
      return "low";

    case "local_write_file":
    case "local_move_file":
    case "local_open_app": {
      const p = String(args.path || args.target || "");
      return isDangerousPath(p) ? "high" : "low";
    }

    case "local_delete_file": {
      const p = String(args.path || "");
      return isDangerousPath(p) ? "high" : "medium";
    }

    case "local_shell": {
      const cmd = String(args.command || "");
      return isDangerousCommand(cmd) ? "high" : "medium";
    }

    default:
      return "high";
  }
}

export function describeOperation(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "local_shell": return `执行命令: ${String(args.command || "").slice(0, 120)}`;
    case "local_read_file": return `读取文件: ${args.path}`;
    case "local_write_file": return `写入文件: ${args.path}`;
    case "local_list_dir": return `列出目录: ${args.path || getHomeDir()}`;
    case "local_move_file": return `移动文件: ${args.source} → ${args.target}`;
    case "local_delete_file": return `删除: ${args.path}`;
    case "local_search_files": return `搜索文件: 在 ${args.directory || getHomeDir()} 中查找 "${args.pattern}"`;
    case "local_open_app": return `打开应用: ${args.command || args.path}`;
    case "local_screenshot": return "截取屏幕截图";
    case "local_clipboard_read": return "读取剪贴板";
    case "local_clipboard_write": return `写入剪贴板: ${String(args.content || "").slice(0, 60)}`;
    default: return `${tool}: ${JSON.stringify(args).slice(0, 100)}`;
  }
}

export function requestApproval(userId: string, tool: string, args: Record<string, unknown>): Promise<boolean> {
  const riskLevel = classifyRisk(tool, args);

  if (riskLevel === "low" || autoApproveUsers.has(userId)) {
    return Promise.resolve(true);
  }

  // 本地桌面版：medium 风险自动通过，只有 high 风险才需要确认
  if (isLocalModeEnabled() && riskLevel === "medium") {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const req: ApprovalRequest = {
      id: uuid(),
      userId,
      tool,
      args,
      riskLevel,
      description: describeOperation(tool, args),
      status: "pending",
      createdAt: Date.now(),
      resolve,
    };
    pendingApprovals.set(req.id, req);

    setTimeout(() => {
      if (pendingApprovals.has(req.id) && req.status === "pending") {
        req.status = "rejected";
        pendingApprovals.delete(req.id);
        resolve(false);
      }
    }, 60_000);
  });
}

export function getPendingApprovals(userId: string): ApprovalRequest[] {
  const list: ApprovalRequest[] = [];
  for (const req of pendingApprovals.values()) {
    if (req.userId === userId && req.status === "pending") {
      list.push({ ...req, resolve: undefined });
    }
  }
  return list;
}

export function getAllPendingApprovals(): ApprovalRequest[] {
  const list: ApprovalRequest[] = [];
  for (const req of pendingApprovals.values()) {
    if (req.status === "pending") {
      list.push({ ...req, resolve: undefined });
    }
  }
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export function resolveApproval(requestId: string, approved: boolean): boolean {
  const req = pendingApprovals.get(requestId);
  if (!req || req.status !== "pending") return false;
  req.status = approved ? "approved" : "rejected";
  if (req.resolve) req.resolve(approved);
  pendingApprovals.delete(requestId);
  return true;
}

export async function writeAuditLog(
  db: Db, userId: string, tool: string,
  args: Record<string, unknown>, result: string,
  riskLevel: RiskLevel, approved: boolean,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO opc_local_audit_log (id, user_id, tool, args, result, risk_level, approved, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [uuid(), userId, tool, JSON.stringify(args), result.slice(0, 4000), riskLevel, approved],
    );
  } catch (e) {
    console.error("[AuditLog] write error:", e);
  }
}
