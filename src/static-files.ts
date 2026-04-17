import type { IncomingMessage, ServerResponse } from "http";
import fs from "fs";
import path from "path";

const VIDEOS_DIR = path.resolve(process.cwd(), "public/videos");

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export async function servePublicVideo(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  // 防路径穿越
  const rel = pathname.replace(/^\/public\/videos\//, "");
  if (rel.includes("..") || rel.includes("/")) return false;

  const ext = path.extname(rel).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return false;

  const filePath = path.join(VIDEOS_DIR, rel);
  if (!fs.existsSync(filePath)) return false;

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  if (range && mime.startsWith("video/")) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  return true;
}
