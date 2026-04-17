/**
 * 本地操作工具执行器 — 10 个本地工具的具体实现
 * 仅 LOCAL_MODE 下启用
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { exec, execSync } from "child_process";
import { normalizePath, getHomeDir } from "./security.js";
import { backupBeforeWrite, formatBackupInfo } from "./file-backup.js";

const IS_WIN = process.platform === "win32";
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB read limit
const MAX_OUTPUT = 64_000; // 64KB command output limit

function s(v: unknown, def = ""): string {
  return v !== undefined && v !== null ? String(v) : def;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (已截断，共 ${text.length} 字符)`;
}

// ─── local_shell ─────────────────────────────────────────────────────

export async function execLocalShell(args: Record<string, unknown>): Promise<string> {
  const command = s(args.command);
  if (!command) return JSON.stringify({ error: "command 为必填项" });

  const cwd = args.cwd ? normalizePath(s(args.cwd)) : getHomeDir();
  const timeout = Math.min(Number(args.timeout) || 30, 120) * 1000;

  return new Promise((resolve) => {
    const shell = IS_WIN ? "powershell.exe" : "/bin/bash";
    const shellArgs = IS_WIN ? ["-NoProfile", "-Command", command] : ["-c", command];

    const child = exec(`${shell} ${shellArgs.map(a => `"${a}"`).join(" ")}`, {
      cwd,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, LANG: "en_US.UTF-8" },
    }, (error, stdout, stderr) => {
      const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number }).code || 1 : 0;
      const out = truncate(stdout || "", MAX_OUTPUT);
      const err = truncate(stderr || "", MAX_OUTPUT / 2);
      resolve(JSON.stringify({
        success: !error,
        exit_code: exitCode,
        stdout: out,
        stderr: err || undefined,
        cwd,
      }));
    });
  });
}

// ─── local_read_file ─────────────────────────────────────────────────

const PDF_MAX_SIZE = 10 * 1024 * 1024; // PDF 允许更大，10MB

export async function execLocalReadFile(args: Record<string, unknown>): Promise<string> {
  const filePath = normalizePath(s(args.path));
  if (!filePath) return JSON.stringify({ error: "path 为必填项" });

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return JSON.stringify({ error: "目标是一个目录，请使用 local_list_dir" });

    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".pdf") {
      if (stat.size > PDF_MAX_SIZE) {
        return JSON.stringify({ error: `PDF 过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 10MB` });
      }
      try {
        // @ts-ignore - pdf-parse has no type declarations
        const pdfParse = (await import("pdf-parse")).default;
        const buffer = await fsp.readFile(filePath);
        const data = await pdfParse(buffer);
        const text = truncate(data.text || "", MAX_OUTPUT);
        return JSON.stringify({
          success: true,
          path: filePath,
          size: stat.size,
          format: "pdf",
          pages: data.numpages,
          content: text || "(PDF 为扫描件/图片格式，无法提取文字内容)",
        });
      } catch (pe: any) {
        return JSON.stringify({ error: `PDF 解析失败: ${pe.message}` });
      }
    }

    if (stat.size > MAX_FILE_SIZE) {
      return JSON.stringify({ error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 2MB` });
    }

    const encoding = s(args.encoding, "utf-8") as BufferEncoding;
    const content = await fsp.readFile(filePath, { encoding });
    return JSON.stringify({
      success: true,
      path: filePath,
      size: stat.size,
      content: truncate(content, MAX_OUTPUT),
    });
  } catch (e: any) {
    return JSON.stringify({ error: `读取失败: ${e.message}` });
  }
}

// ─── local_write_file ────────────────────────────────────────────────

export async function execLocalWriteFile(args: Record<string, unknown>): Promise<string> {
  const filePath = normalizePath(s(args.path));
  const content = s(args.content);
  if (!filePath) return JSON.stringify({ error: "path 为必填项" });

  try {
    const mode = s(args.mode, "write");
    const isOverwrite = mode === "write" && fs.existsSync(filePath);

    const backup = await backupBeforeWrite(filePath, isOverwrite ? "overwrite" : "write");

    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    if (mode === "append") {
      await fsp.appendFile(filePath, content, "utf-8");
    } else {
      await fsp.writeFile(filePath, content, "utf-8");
    }

    const stat = await fsp.stat(filePath);
    return JSON.stringify({
      success: true,
      path: filePath,
      size: stat.size,
      mode,
      ...(isOverwrite ? { overwritten: true } : {}),
      ...formatBackupInfo(backup),
    });
  } catch (e: any) {
    return JSON.stringify({ error: `写入失败: ${e.message}` });
  }
}

// ─── local_list_dir ──────────────────────────────────────────────────

export async function execLocalListDir(args: Record<string, unknown>): Promise<string> {
  const dirPath = normalizePath(s(args.path) || getHomeDir());
  const showHidden = Boolean(args.show_hidden);

  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const items = entries
      .filter(e => showHidden || !e.name.startsWith("."))
      .slice(0, 200)
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other",
      }));

    const dirs = items.filter(i => i.type === "directory").length;
    const files = items.filter(i => i.type === "file").length;

    return JSON.stringify({
      success: true,
      path: dirPath,
      total: entries.length,
      shown: items.length,
      summary: `${dirs} 个文件夹, ${files} 个文件`,
      items,
    });
  } catch (e: any) {
    return JSON.stringify({ error: `列目录失败: ${e.message}` });
  }
}

// ─── local_move_file ─────────────────────────────────────────────────

export async function execLocalMoveFile(args: Record<string, unknown>): Promise<string> {
  const source = normalizePath(s(args.source));
  const target = normalizePath(s(args.target));
  if (!source || !target) return JSON.stringify({ error: "source 和 target 为必填项" });

  try {
    const backup = await backupBeforeWrite(source, "move");

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(source, target);
    return JSON.stringify({ success: true, source, target, ...formatBackupInfo(backup) });
  } catch (e: any) {
    if (e.code === "EXDEV") {
      try {
        await fsp.copyFile(source, target);
        await fsp.unlink(source);
        return JSON.stringify({ success: true, source, target, note: "跨磁盘移动（先复制后删除）" });
      } catch (e2: any) {
        return JSON.stringify({ error: `跨盘移动失败: ${e2.message}` });
      }
    }
    return JSON.stringify({ error: `移动失败: ${e.message}` });
  }
}

// ─── local_delete_file ───────────────────────────────────────────────

export async function execLocalDeleteFile(args: Record<string, unknown>): Promise<string> {
  const filePath = normalizePath(s(args.path));
  if (!filePath) return JSON.stringify({ error: "path 为必填项" });

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(filePath);
      if (entries.length > 0 && !args.recursive) {
        return JSON.stringify({ error: `目录非空 (${entries.length} 个项目)，设置 recursive=true 以递归删除` });
      }
      await fsp.rm(filePath, { recursive: true, force: true });
      return JSON.stringify({ success: true, path: filePath, type: "directory" });
    } else {
      const backup = await backupBeforeWrite(filePath, "delete");
      await fsp.unlink(filePath);
      return JSON.stringify({
        success: true, path: filePath, type: "file", size: stat.size,
        ...formatBackupInfo(backup),
      });
    }
  } catch (e: any) {
    return JSON.stringify({ error: `删除失败: ${e.message}` });
  }
}

// ─── local_search_files ──────────────────────────────────────────────

export async function execLocalSearchFiles(args: Record<string, unknown>): Promise<string> {
  const dir = normalizePath(s(args.directory) || getHomeDir());
  const pattern = s(args.pattern);
  if (!pattern) return JSON.stringify({ error: "pattern 为必填项" });

  const maxDepth = Math.min(Number(args.max_depth) || 3, 6);
  const maxResults = Math.min(Number(args.max_results) || 50, 200);
  const regex = new RegExp(pattern.replace(/\*/g, ".*").replace(/\?/g, "."), "i");

  const results: { path: string; type: string; size?: number }[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || results.length >= maxResults) return;
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = path.join(dir, entry.name);
        if (regex.test(entry.name)) {
          const item: { path: string; type: string; size?: number } = {
            path: fullPath,
            type: entry.isDirectory() ? "directory" : "file",
          };
          if (entry.isFile()) {
            try {
              const st = await fsp.stat(fullPath);
              item.size = st.size;
            } catch { /* ignore */ }
          }
          results.push(item);
        }
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        }
      }
    } catch { /* permission denied, etc. */ }
  }

  await walk(dir, 0);
  return JSON.stringify({
    success: true,
    directory: dir,
    pattern,
    total: results.length,
    results,
  });
}

// ─── local_open_app ──────────────────────────────────────────────────

export async function execLocalOpenApp(args: Record<string, unknown>): Promise<string> {
  const target = s(args.path) || s(args.command);
  if (!target) return JSON.stringify({ error: "path 或 command 为必填项" });

  try {
    let cmd: string;
    if (IS_WIN) {
      cmd = `start "" "${target}"`;
    } else if (process.platform === "darwin") {
      cmd = `open "${target}"`;
    } else {
      cmd = `xdg-open "${target}"`;
    }
    execSync(cmd, { timeout: 10_000, stdio: "ignore" });
    return JSON.stringify({ success: true, opened: target });
  } catch (e: any) {
    return JSON.stringify({ error: `打开失败: ${e.message}` });
  }
}

// ─── local_screenshot ────────────────────────────────────────────────

export async function execLocalScreenshot(args: Record<string, unknown>): Promise<string> {
  const saveTo = normalizePath(s(args.save_to) || path.join(os.tmpdir(), `screenshot_${Date.now()}.png`));

  try {
    if (IS_WIN) {
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $bmp.Save('${saveTo.replace(/'/g, "''")}')
        $g.Dispose(); $bmp.Dispose()
      `;
      execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, "; ")}"`, { timeout: 15_000 });
    } else if (process.platform === "darwin") {
      execSync(`screencapture -x "${saveTo}"`, { timeout: 10_000 });
    } else {
      execSync(`import -window root "${saveTo}"`, { timeout: 10_000 });
    }

    const stat = await fsp.stat(saveTo);
    return JSON.stringify({ success: true, path: saveTo, size: stat.size });
  } catch (e: any) {
    return JSON.stringify({ error: `截图失败: ${e.message}` });
  }
}

// ─── local_clipboard ─────────────────────────────────────────────────

export async function execLocalClipboard(args: Record<string, unknown>): Promise<string> {
  const action = s(args.action, "read");

  try {
    if (action === "write") {
      const content = s(args.content);
      if (!content) return JSON.stringify({ error: "content 为必填项" });
      if (IS_WIN) {
        execSync(`echo ${content} | clip`, { timeout: 5000 });
      } else if (process.platform === "darwin") {
        execSync(`echo "${content.replace(/"/g, '\\"')}" | pbcopy`, { timeout: 5000 });
      } else {
        execSync(`echo "${content.replace(/"/g, '\\"')}" | xclip -selection clipboard`, { timeout: 5000 });
      }
      return JSON.stringify({ success: true, action: "write", length: content.length });
    } else {
      let text = "";
      if (IS_WIN) {
        text = execSync("powershell -NoProfile -Command Get-Clipboard", { timeout: 5000 }).toString().trim();
      } else if (process.platform === "darwin") {
        text = execSync("pbpaste", { timeout: 5000 }).toString();
      } else {
        text = execSync("xclip -selection clipboard -o", { timeout: 5000 }).toString();
      }
      return JSON.stringify({ success: true, action: "read", content: truncate(text, 8000) });
    }
  } catch (e: any) {
    return JSON.stringify({ error: `剪贴板操作失败: ${e.message}` });
  }
}
