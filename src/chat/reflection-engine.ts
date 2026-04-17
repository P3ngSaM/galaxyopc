import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import { callAi } from "./ai-client.js";

type SkillCategory = "business" | "content" | "finance" | "legal" | "product" | "marketing" | "efficiency" | "custom";

interface ReflectionPayload {
  summary?: string;
  lessons?: string[];
  style_adjustments?: string[];
  reusable_workflow?: {
    name?: string;
    description?: string;
    category?: SkillCategory | string;
    prompt?: string;
  } | null;
}

function cleanShortList(input: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLen));
}

function normalizeSkillCategory(input: unknown): SkillCategory {
  const value = String(input || "").trim().toLowerCase();
  if (["business", "content", "finance", "legal", "product", "marketing", "efficiency"].includes(value)) {
    return value as SkillCategory;
  }
  return "custom";
}

async function saveReusableWorkflowAsSkill(
  db: Db,
  userId: string,
  workflow: NonNullable<ReflectionPayload["reusable_workflow"]>,
): Promise<void> {
  const name = String(workflow.name || "").trim().slice(0, 24);
  const description = String(workflow.description || "").trim().slice(0, 120);
  const prompt = String(workflow.prompt || "").trim();
  if (!name || !description || prompt.length < 80) return;

  const { rows } = await db.query(
    "SELECT id FROM opc_skills WHERE user_id = $1 AND name = $2 LIMIT 1",
    [userId, name],
  );
  if (rows[0]) {
    await db.query(
      `UPDATE opc_skills
       SET description = $1,
           category = $2,
           prompt = $3,
           enabled = 1,
           updated_at = NOW()
       WHERE id = $4`,
      [description, normalizeSkillCategory(workflow.category), prompt, (rows[0] as { id: string }).id],
    );
    return;
  }

  await db.query(
    `INSERT INTO opc_skills
       (id, user_id, name, description, category, prompt, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, NOW(), NOW())`,
    [uuid(), userId, name, description, normalizeSkillCategory(workflow.category), prompt],
  );
}

export async function extractAndSaveReflection(
  db: Db,
  options: {
    userId: string;
    companyId?: string;
    conversationId: string;
    userMessage: string;
    assistantReply: string;
    calledTools?: string[];
  },
): Promise<void> {
  const userMessage = String(options.userMessage || "").trim();
  const assistantReply = String(options.assistantReply || "").trim();
  if (userMessage.length < 12 || assistantReply.length < 40) return;

  const { rows: recentRows } = await db.query(
    `SELECT summary FROM opc_agent_reflections
     WHERE user_id = $1 AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 6`,
    [options.userId],
  );
  const recentReflections = (recentRows as Array<{ summary: string }>).map((row) => row.summary).filter(Boolean);

  const prompt = `你是 agent 运行复盘器。请从这轮对话里提取“以后应该持续记住的工作方式”，只保留对未来回答和执行真正有帮助的内容。

用户消息：
${userMessage}

AI回复：
${assistantReply.slice(0, 1200)}

本轮调用工具：
${(options.calledTools || []).join(", ") || "无"}

已有近期复盘（避免重复）：
${recentReflections.join("\n") || "无"}

输出规则：
- 只提炼长期可复用的经验，不要记录一次性细节
- summary 用一句中文写清楚本轮最值得保留的经验，30字内；如果没有则为空字符串
- lessons 最多 3 条，写成明确动作原则
- style_adjustments 最多 2 条，只写稳定的沟通/输出偏好
- reusable_workflow 只有在本轮已经形成可复用工作流时才返回，否则返回 null
- 只有当 workflow 足够通用、以后可重复调用时，才生成 reusable_workflow
- reusable_workflow.prompt 要写成可直接给子智能体使用的系统提示词，180 到 400 字

只输出 JSON：
{
  "summary": "",
  "lessons": ["..."],
  "style_adjustments": ["..."],
  "reusable_workflow": {
    "name": "",
    "description": "",
    "category": "business|content|finance|legal|product|marketing|efficiency|custom",
    "prompt": ""
  }
}`;

  let payload: ReflectionPayload | null = null;
  try {
    const result = await callAi([{ role: "user", content: prompt }]);
    const match = result.content.match(/\{[\s\S]*\}/);
    if (!match) return;
    payload = JSON.parse(match[0]) as ReflectionPayload;
  } catch {
    return;
  }

  if (!payload) return;
  const summary = String(payload.summary || "").trim().slice(0, 60);
  const lessons = cleanShortList(payload.lessons, 3, 120);
  const styleAdjustments = cleanShortList(payload.style_adjustments, 2, 80);
  if (!summary && lessons.length === 0 && styleAdjustments.length === 0 && !payload.reusable_workflow) return;

  const duplicateRows = await db.query(
    `SELECT id FROM opc_agent_reflections
     WHERE user_id = $1 AND summary = $2 AND is_active = true
     LIMIT 1`,
    [options.userId, summary || "__EMPTY__"],
  );

  if (duplicateRows.rows[0]) {
    await db.query(
      `UPDATE opc_agent_reflections
       SET lessons_json = $1,
           style_adjustments_json = $2,
           tools_json = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [
        JSON.stringify(lessons),
        JSON.stringify(styleAdjustments),
        JSON.stringify(options.calledTools || []),
        (duplicateRows.rows[0] as { id: string }).id,
      ],
    );
  } else {
    await db.query(
      `INSERT INTO opc_agent_reflections
         (id, user_id, company_id, source_conv_id, summary, lessons_json, style_adjustments_json, tools_json, created_at, updated_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), true)`,
      [
        uuid(),
        options.userId,
        options.companyId || null,
        options.conversationId,
        summary,
        JSON.stringify(lessons),
        JSON.stringify(styleAdjustments),
        JSON.stringify(options.calledTools || []),
      ],
    );
  }

  if (payload.reusable_workflow) {
    await saveReusableWorkflowAsSkill(db, options.userId, payload.reusable_workflow);
  }
}
