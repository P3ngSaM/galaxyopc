/**
 * 本地工具定义（给 AI 的 schema）+ 统一执行入口
 * 仅 LOCAL_MODE 下注册
 */

import type { ToolDef } from "../chat/ai-client.js";
import type { Db } from "../db.js";
import {
  isLocalModeEnabled, classifyRisk, requestApproval,
  writeAuditLog, describeOperation,
} from "./security.js";
import {
  execLocalShell, execLocalReadFile, execLocalWriteFile,
  execLocalListDir, execLocalMoveFile, execLocalDeleteFile,
  execLocalSearchFiles, execLocalOpenApp, execLocalScreenshot,
  execLocalClipboard,
} from "./local-executor.js";
import { undoLast, restoreBackup, getRecentBackups } from "./file-backup.js";

export function getLocalToolDefinitions(): ToolDef[] {
  if (!isLocalModeEnabled()) return [];

  return [
    {
      type: "function",
      function: {
        name: "local_shell",
        description: "在用户电脑上执行 Shell 命令（Windows 为 PowerShell，Mac/Linux 为 Bash）。可用于安装软件、运行脚本、查看系统信息等。需要用户确认后执行。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的命令" },
            cwd: { type: "string", description: "工作目录，默认用户主目录" },
            timeout: { type: "number", description: "超时秒数，默认30，最大120" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_read_file",
        description: "读取用户电脑上的文件内容。支持文本文件(txt/md/json等,最大2MB)和PDF文件(自动提取文字,最大10MB)。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件绝对路径或 ~ 开头的路径" },
            encoding: { type: "string", description: "编码，默认 utf-8" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_write_file",
        description: "在用户电脑上创建或写入文件。自动创建父目录。需要用户确认。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件绝对路径或 ~ 开头的路径" },
            content: { type: "string", description: "文件内容" },
            mode: { type: "string", enum: ["write", "append"], description: "写入模式：write(覆盖)/append(追加)，默认 write" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_list_dir",
        description: "列出用户电脑上某个目录的文件和文件夹。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径，默认用户主目录" },
            show_hidden: { type: "boolean", description: "是否显示隐藏文件" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_move_file",
        description: "移动或重命名文件/文件夹。需要用户确认。",
        parameters: {
          type: "object",
          properties: {
            source: { type: "string", description: "源路径" },
            target: { type: "string", description: "目标路径" },
          },
          required: ["source", "target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_delete_file",
        description: "删除文件或文件夹。高风险操作，必须用户确认。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要删除的路径" },
            recursive: { type: "boolean", description: "是否递归删除非空目录" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_search_files",
        description: "在用户电脑上搜索文件（按文件名匹配）。支持通配符 * 和 ?。",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "搜索起始目录，默认用户主目录" },
            pattern: { type: "string", description: "文件名匹配模式，如 *.pdf、report*" },
            max_depth: { type: "number", description: "最大搜索深度，默认3" },
            max_results: { type: "number", description: "最大结果数，默认50" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_open_app",
        description: "打开本地应用程序或文件（用系统默认程序打开）。需要用户确认。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "应用或文件路径" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_screenshot",
        description: "截取用户电脑的屏幕截图并保存为 PNG 文件。",
        parameters: {
          type: "object",
          properties: {
            save_to: { type: "string", description: "保存路径，默认临时目录" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_clipboard",
        description: "读取或写入用户电脑的剪贴板内容。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "write"], description: "read(读取)/write(写入)" },
            content: { type: "string", description: "写入内容（action=write时必填）" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "local_undo",
        description: "撤销最近一次本地文件操作（覆盖写入、移动、删除）。系统会自动备份被修改的文件，调用此工具可恢复原始内容。也可指定 backup_id 撤销特定操作。用户说「撤销」「恢复」「回退刚才的操作」时使用此工具。",
        parameters: {
          type: "object",
          properties: {
            backup_id: { type: "string", description: "指定要撤销的备份ID。不填则撤销最近一次操作" },
            action: { type: "string", enum: ["undo", "list"], description: "undo(撤销)/list(列出可撤销的操作)，默认 undo" },
          },
        },
      },
    },
  ];
}

export async function executeLocalTool(
  toolName: string, args: Record<string, unknown>,
  db: Db, userId: string,
): Promise<string> {
  if (!isLocalModeEnabled()) {
    return JSON.stringify({ error: "本地操作仅在桌面版可用" });
  }

  const riskLevel = classifyRisk(toolName, args);

  if (riskLevel !== "low") {
    const approved = await requestApproval(userId, toolName, args);
    if (!approved) {
      await writeAuditLog(db, userId, toolName, args, "用户拒绝", riskLevel, false);
      return JSON.stringify({ error: "操作已被用户拒绝", tool: toolName, description: describeOperation(toolName, args) });
    }
  }

  let result: string;
  try {
    switch (toolName) {
      case "local_shell": result = await execLocalShell(args); break;
      case "local_read_file": result = await execLocalReadFile(args); break;
      case "local_write_file": result = await execLocalWriteFile(args); break;
      case "local_list_dir": result = await execLocalListDir(args); break;
      case "local_move_file": result = await execLocalMoveFile(args); break;
      case "local_delete_file": result = await execLocalDeleteFile(args); break;
      case "local_search_files": result = await execLocalSearchFiles(args); break;
      case "local_open_app": result = await execLocalOpenApp(args); break;
      case "local_screenshot": result = await execLocalScreenshot(args); break;
      case "local_clipboard": result = await execLocalClipboard(args); break;
      case "local_undo": result = await execLocalUndo(args); break;
      default: result = JSON.stringify({ error: `未知本地工具: ${toolName}` });
    }
  } catch (e: any) {
    result = JSON.stringify({ error: `本地工具执行错误: ${e.message}` });
  }

  await writeAuditLog(db, userId, toolName, args, result, riskLevel, true);
  return result;
}

async function execLocalUndo(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action || "undo");

  if (action === "list") {
    const backups = await getRecentBackups(10);
    if (backups.length === 0) {
      return JSON.stringify({ success: true, message: "当前没有可撤销的操作", backups: [] });
    }
    return JSON.stringify({
      success: true,
      total: backups.length,
      backups: backups.map(b => ({
        id: b.id,
        path: b.originalPath,
        operation: b.operation,
        size: b.size,
        time: new Date(b.createdAt).toLocaleString("zh-CN"),
      })),
    });
  }

  const backupId = String(args.backup_id || "");
  if (backupId) {
    const result = await restoreBackup(backupId);
    return JSON.stringify(result);
  }

  const result = await undoLast();
  return JSON.stringify(result);
}
