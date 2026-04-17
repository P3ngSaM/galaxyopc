/**
 * 文件备份引擎 — 写前快照 + 回滚 + 自动清理
 *
 * 备份目录结构：
 *   ~/.xhopc-backups/
 *     index.json          ← 备份索引
 *     <timestamp>/
 *       <hash>.bak        ← 原始文件内容
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";

const BACKUP_ROOT = path.join(os.homedir(), ".xhopc-backups");
const INDEX_PATH = path.join(BACKUP_ROOT, "index.json");
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;   // 500 MB

export interface BackupEntry {
  id: string;
  originalPath: string;
  backupPath: string;
  operation: "write" | "overwrite" | "move" | "delete";
  size: number;
  createdAt: number;
  restored: boolean;
}

async function ensureBackupDir(): Promise<void> {
  await fsp.mkdir(BACKUP_ROOT, { recursive: true });
}

async function loadIndex(): Promise<BackupEntry[]> {
  try {
    const raw = await fsp.readFile(INDEX_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveIndex(entries: BackupEntry[]): Promise<void> {
  await fsp.writeFile(INDEX_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

function shortHash(filePath: string): string {
  return crypto.createHash("md5").update(filePath).digest("hex").slice(0, 12);
}

/**
 * 在执行破坏性操作前，备份目标文件。
 * 如果文件不存在（新建文件），不创建备份但返回一个占位记录用于回滚（删除新文件）。
 */
export async function backupBeforeWrite(
  filePath: string,
  operation: BackupEntry["operation"],
): Promise<BackupEntry | null> {
  await ensureBackupDir();

  const normalizedPath = path.resolve(filePath);
  let fileExists = false;
  let fileSize = 0;

  try {
    const stat = await fsp.stat(normalizedPath);
    fileExists = true;
    fileSize = stat.size;

    if (stat.isDirectory()) {
      return null;
    }

    if (fileSize > 50 * 1024 * 1024) {
      return null;
    }
  } catch {
    // 文件不存在 → 新建操作
  }

  const ts = Date.now();
  const id = `${ts}-${shortHash(normalizedPath)}`;
  const backupDir = path.join(BACKUP_ROOT, String(ts));
  await fsp.mkdir(backupDir, { recursive: true });

  let backupPath = "";

  if (fileExists) {
    const backupName = `${shortHash(normalizedPath)}.bak`;
    backupPath = path.join(backupDir, backupName);
    await fsp.copyFile(normalizedPath, backupPath);
  }

  const entry: BackupEntry = {
    id,
    originalPath: normalizedPath,
    backupPath,
    operation,
    size: fileSize,
    createdAt: ts,
    restored: false,
  };

  const index = await loadIndex();
  index.push(entry);
  await saveIndex(index);

  scheduleCleanup();

  return entry;
}

/**
 * 回滚指定备份：恢复原始文件内容或删除新建的文件。
 */
export async function restoreBackup(backupId: string): Promise<{
  success: boolean;
  message: string;
  originalPath?: string;
}> {
  const index = await loadIndex();
  const entry = index.find(e => e.id === backupId);

  if (!entry) {
    return { success: false, message: "备份记录不存在" };
  }
  if (entry.restored) {
    return { success: false, message: "该备份已经回滚过" };
  }

  try {
    if (entry.backupPath) {
      try {
        await fsp.stat(entry.backupPath);
      } catch {
        return { success: false, message: "备份文件已被清理，无法回滚" };
      }
      await fsp.mkdir(path.dirname(entry.originalPath), { recursive: true });
      await fsp.copyFile(entry.backupPath, entry.originalPath);
    } else {
      try {
        await fsp.unlink(entry.originalPath);
      } catch {
        // 文件可能已被删除
      }
    }

    entry.restored = true;
    await saveIndex(index);

    return {
      success: true,
      message: entry.backupPath
        ? `已恢复文件: ${entry.originalPath}`
        : `已删除新建文件: ${entry.originalPath}`,
      originalPath: entry.originalPath,
    };
  } catch (e: any) {
    return { success: false, message: `回滚失败: ${e.message}` };
  }
}

/**
 * 获取最近的可回滚操作（按时间倒序）
 */
export async function getRecentBackups(limit = 20): Promise<BackupEntry[]> {
  const index = await loadIndex();
  return index
    .filter(e => !e.restored)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * 撤销最近一次文件操作
 */
export async function undoLast(): Promise<{
  success: boolean;
  message: string;
  entry?: BackupEntry;
}> {
  const recent = await getRecentBackups(1);
  if (recent.length === 0) {
    return { success: false, message: "没有可撤销的操作" };
  }
  const entry = recent[0];
  const result = await restoreBackup(entry.id);
  return { ...result, entry };
}

let cleanupScheduled = false;

function scheduleCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  setTimeout(async () => {
    cleanupScheduled = false;
    try {
      await cleanupOldBackups();
    } catch (e) {
      console.error("[Backup] cleanup error:", e);
    }
  }, 5000);
}

async function cleanupOldBackups(): Promise<void> {
  const index = await loadIndex();
  const now = Date.now();
  let totalSize = 0;

  const keep: BackupEntry[] = [];
  const remove: BackupEntry[] = [];

  const sorted = [...index].sort((a, b) => b.createdAt - a.createdAt);

  for (const entry of sorted) {
    const tooOld = now - entry.createdAt > MAX_AGE_MS;
    const tooLarge = totalSize > MAX_TOTAL_BYTES;

    if (tooOld || tooLarge || entry.restored) {
      remove.push(entry);
    } else {
      totalSize += entry.size;
      keep.push(entry);
    }
  }

  for (const entry of remove) {
    if (entry.backupPath) {
      try {
        await fsp.unlink(entry.backupPath);
      } catch { /* already gone */ }
      try {
        const dir = path.dirname(entry.backupPath);
        const remaining = await fsp.readdir(dir);
        if (remaining.length === 0) {
          await fsp.rmdir(dir);
        }
      } catch { /* ignore */ }
    }
  }

  await saveIndex(keep);
}

export function formatBackupInfo(entry: BackupEntry | null): Record<string, unknown> | undefined {
  if (!entry) return undefined;
  return {
    backup_id: entry.id,
    can_undo: true,
    message: "已自动备份原文件，如需撤销可告诉我「撤销刚才的操作」",
  };
}
