/**
 * 记忆提炼器 — 每轮对话结束后异步提炼用户长期记忆
 *
 * 工作流：
 *   对话结束 → callAi 提炼本轮对话中的有价值信息
 *            → 去重后写入 opc_user_memories
 *            → 下次对话时 context-builder 加载注入 system prompt
 */

import type { Db } from "../db.js";
import { callAi } from "./ai-client.js";
import { upsertUserMemory } from "./memory-service.js";

type MemoryCategory = "preference" | "decision" | "fact" | "personality" | "goal";

interface ExtractedMemory {
  category: MemoryCategory;
  content: string;
  importance: number;
}

const MIN_MSG_LENGTH = 4;         // onboarding 时用户消息可能很短（名字、选项等）
const MAX_PER_EXTRACT = 4;        // 单次最多提炼几条
const MAX_TOTAL_PER_USER = 120;   // 用户记忆上限，超出后淘汰低价值旧记忆

export async function extractAndSaveMemory(
  db: Db,
  userId: string,
  companyId: string,
  conversationId: string,
  userMessage: string,
  assistantReply: string,
): Promise<void> {
  // 用户消息太短且 AI 回复也很短 → 没有可提炼的内容
  if (userMessage.length < MIN_MSG_LENGTH && assistantReply.length < 80) return;

  // 加载已有记忆（用于去重提示）
  const { rows: existing } = await db.query(
    `SELECT content FROM opc_user_memories
     WHERE user_id = $1 AND is_active = true
     ORDER BY importance DESC, updated_at DESC LIMIT 30`,
    [userId],
  );
  const existingList = (existing as { content: string }[]).map(r => r.content);

  const existingBlock = existingList.length > 0
    ? `\n\n已有记忆（不要提取重复或相似的内容）：\n${existingList.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : "";

  const extractPrompt = `你是记忆提炼助手。从以下对话片段中提取值得长期记住的用户信息。

用户说：${userMessage}
AI回复：${assistantReply.slice(0, 600)}${existingBlock}

提取规则：
- 最多提取 ${MAX_PER_EXTRACT} 条，没有值得记住的就返回 []
- 只提取用户明确表达的信息，不要推测或演绎
- 不记录临时性请求（"帮我查XXX"、"给我写个XXX"）
- 聚焦：用户偏好、长期目标、重要决定、性格特质、核心业务信息
- 特别注意：如果用户给 AI 取名（如"叫你 Alex"、"你叫XX"），必须提取为 preference 类别，content 格式为"用户给 AI 取名为 XXX"，importance 设为 9
- content 写成第三人称一句话（例："用户偏好简洁直接的回复风格"）

category 取值：
- preference：沟通偏好、风格偏好、工具偏好
- decision：用户做出的决定、计划采取的行动
- fact：用户的业务信息、背景信息、关键数字
- personality：性格特质、决策风格、思维方式
- goal：目标、愿景、KPI、时间节点

importance 评分（1-10）：
- 9-10：核心目标、重大决定
- 6-8：重要偏好、关键业务信息
- 3-5：一般背景信息
- 1-2：临时细节（通常不值得记）

只输出 JSON 数组，不要任何其他文字：
[{"category":"...","content":"...","importance":数字}]`;

  let extracted: ExtractedMemory[] = [];
  try {
    const response = await callAi(
      [{ role: "user", content: extractPrompt }],
      undefined,
      undefined, // 使用默认模型（最省 token 的）
    );
    const text = response.content.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        extracted = parsed
          .filter(
            (item): item is ExtractedMemory =>
              typeof item.category === "string" &&
              typeof item.content === "string" &&
              item.content.length > 5 &&
              typeof item.importance === "number",
          )
          .slice(0, MAX_PER_EXTRACT);
      }
    }
  } catch {
    return; // 提炼失败静默忽略，不影响主流程
  }

  if (extracted.length === 0) return;

  // 检查总量，超出则淘汰最旧的低价值记忆
  const { rows: countRows } = await db.query(
    "SELECT COUNT(*) as cnt FROM opc_user_memories WHERE user_id = $1 AND is_active = true",
    [userId],
  );
  const totalCount = Number((countRows[0] as { cnt: string }).cnt);
  if (totalCount + extracted.length > MAX_TOTAL_PER_USER) {
    const pruneCount = totalCount + extracted.length - MAX_TOTAL_PER_USER;
    await db.query(
      `DELETE FROM opc_user_memories WHERE id IN (
        SELECT id FROM opc_user_memories WHERE user_id = $1 AND is_active = true
        ORDER BY importance ASC, updated_at ASC LIMIT $2
      )`,
      [userId, pruneCount],
    );
  }

  // 写入新记忆
  for (const mem of extracted) {
    await upsertUserMemory(db, {
      userId,
      companyId,
      conversationId,
      category: mem.category,
      content: mem.content,
      importance: mem.importance,
    });
  }
}
