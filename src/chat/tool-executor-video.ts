import { v4 as uuid } from "uuid";
import { asNumber, asString } from "./tool-executor-helpers.js";
import type { Db } from "../db.js";
import { createVideoJob, getLatestVideoJobForUser, getVideoJob, listVideoJobs, scheduleVideoRender } from "../video-jobs.js";

// ─── AI 视频脚本 Schema（供 AI 生成 JSON 时参考）──────────────
const SCRIPT_SCHEMA_HINT = `
请以 JSON 格式输出视频配置，结构如下：
{
  "productName": "产品/主题名称",
  "tagline": "一句话定位（20字以内）",
  "accentColor": "#十六进制颜色（主题色）",
  "scenes": [
    {
      "icon": "单个emoji",
      "title": "场景标题（8字以内）",
      "subtitle": "副标题（15字以内）",
      "color": "#十六进制颜色",
      "body": "场景正文说明（50-80字）",
      "subs": [
        { "text": "字幕文字（20字以内）", "start": 0, "end": 80 },
        { "text": "第二条字幕", "start": 80, "end": 210 }
      ]
    }
  ]
}
场景数量建议 3-6 个，subs 的 end 值不要超过 210（7秒@30fps）。
只输出 JSON，不要有其他文字。`;

export async function execOpcVideoIsolated(
  params: Record<string, unknown>,
  db: Db,
  requesterId?: string,
): Promise<string> {
  const action = asString(params.action);

  switch (action) {
    // ── 0. 兼容旧接口：直接创建脚本骨架 ───────────────────────────
    case "create_script": {
      const title = asString(params.title, "AI生成视频");
      const template = asString(params.template, "promo");
      const durationSeconds = asNumber(params.duration_seconds, 30);

      return JSON.stringify({
        success: true,
        action: "create_script",
        script: {
          title,
          template,
          duration_seconds: durationSeconds,
          topic: title,
        },
      });
    }

    // ── 1. AI 生成视频脚本 ────────────────────────────────────
    case "generate_script": {
      const topic = asString(params.topic, "");
      const scenesCount = asNumber(params.scenes_count, 4);

      if (!topic) {
        return JSON.stringify({ error: "请提供视频主题 topic" });
      }

      // 返回 prompt，让上层 AI 调用 chat/simple 来生成 JSON
      return JSON.stringify({
        success: true,
        action: "generate_script",
        topic,
        script: {
          title: topic,
          template: "promo",
          duration_seconds: 30,
          topic,
        },
        prompt: `你是一位专业的视频脚本策划师。请为主题「${topic}」制作一个包含 ${scenesCount} 个场景的短视频脚本。\n${SCRIPT_SCHEMA_HINT}`,
        note: "请将此 prompt 发送给 AI 获取脚本 JSON，然后用 render_video 渲染。",
        schema_hint: SCRIPT_SCHEMA_HINT,
      });
    }

    // ── 2. 渲染视频（接收 AI 生成的 JSON 脚本）───────────────
    case "render_video": {
      const scriptJson = asString(params.script_json, "");
      const title = asString(params.title, "AI生成视频");

      if (!scriptJson) {
        return JSON.stringify({ error: "请提供 script_json（AI 生成的视频配置 JSON）" });
      }

      // 验证 JSON 格式
      let parsedConfig: unknown;
      try {
        parsedConfig = JSON.parse(scriptJson);
      } catch {
        return JSON.stringify({ error: "script_json 格式不正确，请确保是合法的 JSON" });
      }

      const job = await createVideoJob(db, {
        id: uuid(),
        title,
        scriptJson: JSON.stringify(parsedConfig),
        requesterId,
      });
      await scheduleVideoRender(db, job.id);

      return JSON.stringify({
        success: true,
        video_id: job.id,
        status: "queued",
        note: `视频「${title}」已加入渲染队列。渲染约需 1-3 分钟，请用 get_status 查询进度，完成后可从 /public/videos/${job.id}.mp4 下载。`,
      });
    }

    // ── 3. 查询渲染进度 ──────────────────────────────────────
    case "get_status": {
      const videoId = asString(params.video_id);
      let job = videoId ? await getVideoJob(db, videoId) : null;

      if (!job && requesterId) {
        job = await getLatestVideoJobForUser(db, requesterId);
      }
      if (!job && !videoId) {
        const videos = await listVideoJobs(db);
        if (videos[0]) job = videos[0];
      }
      if (!job && videoId) return JSON.stringify({ error: "视频任务不存在，可能已过期或 video_id 不正确" });
      if (!job) return JSON.stringify({ error: "暂无可查询的视频任务，请先生成或渲染视频" });

      return JSON.stringify({
        success: true,
        video_id: job.id,
        title: job.title,
        status: job.status,
        output_url: job.output_url,
        error: job.error_message,
        created_at: job.created_at,
      });
    }

    // ── 4. 列出所有视频任务 ──────────────────────────────────
    case "list_videos": {
      const videos = (await listVideoJobs(db)).map((v) => ({
        id: v.id,
        title: v.title,
        status: v.status,
        output_url: v.output_url,
        created_at: v.created_at,
        error: v.error_message,
      }));
      return JSON.stringify({ success: true, videos, count: videos.length });
    }

    // ── 5. 快捷：一步生成并渲染（AI 已给出 script_json）──────
    case "create_and_render": {
      // 语法糖：等同于先 generate_script（由外部 AI 完成）再 render_video
      return await execOpcVideoIsolated({ ...params, action: "render_video" }, db, requesterId);
    }

    default:
      return JSON.stringify({
        error: `opc_video: 未知 action '${action}'`,
        available_actions: ["create_script", "generate_script", "render_video", "get_status", "list_videos"],
      });
  }
}
