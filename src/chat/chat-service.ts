import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { TokenUsage, ToolCall } from "./ai-client.js";
import { extractAndSaveMemory } from "./memory-extractor.js";
import { markOnboardingDoneIfReady, updateOnboardingProgress } from "./onboarding-progress.js";
import { extractAndSaveReflection } from "./reflection-engine.js";
import { upsertUserMemory } from "./memory-service.js";

export const MAX_TOOL_ROUNDS = 20;
export const HISTORY_LIMIT = 80;

const RENAME_PATTERNS = [
  /(?:叫你|你叫|以后叫你?|你的?名字?(?:叫|是|改|改为|设为)?)\s*[「""''【《]?([A-Za-z\u4e00-\u9fff]{1,12})[」""''】》]?/i,
  /(?:给你|帮你|给?\s*AI)\s*(?:取名|起名|命名|改名)\s*(?:叫|为|是)?\s*[「""''【《]?([A-Za-z\u4e00-\u9fff]{1,12})[」""''】》]?/i,
  /(?:call\s*you|name\s*you|your\s*name\s*is)\s+([A-Za-z]{1,12})/i,
];
const NAME_STOP = new Set(["我", "你", "他", "她", "它", "什么", "啥", "谁", "哪", "吧", "吗", "呢"]);

export const TOOL_EXTRA_POINTS: Record<string, number> = {
  opc_search: 2,
  opc_email: 1,
  opc_webpage: 1,
};

export function sanitizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((toolCall) => {
    const args = toolCall.function?.arguments ?? "{}";
    let safe = "{}";
    try {
      JSON.parse(args);
      safe = args;
    } catch {
      safe = "{}";
    }
    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: safe,
      },
    };
  });
}

export async function calcCostPoints(
  db: Db,
  usage: TokenUsage | undefined,
  modelId: string,
): Promise<{ points: number; costYuan: number }> {
  if (!usage || (usage.prompt_tokens === 0 && usage.completion_tokens === 0)) {
    return { points: 1, costYuan: 0.001 };
  }
  const { rows } = await db.query(
    "SELECT input_per_1k, output_per_1k FROM opc_model_prices WHERE model_id = $1",
    [modelId],
  );
  const price = rows[0] ?? { input_per_1k: 0.0008, output_per_1k: 0.0048 };
  const reasoningTokens = Math.max(0, usage.reasoning_tokens || 0);
  const billableCompletionTokens = Math.max(0, usage.completion_tokens - reasoningTokens);
  const costYuan =
    (usage.prompt_tokens / 1000) * Number((price as { input_per_1k: number }).input_per_1k) +
    (billableCompletionTokens / 1000) * Number((price as { output_per_1k: number }).output_per_1k);
  return { points: Math.max(1, Math.ceil(costYuan / 0.001)), costYuan };
}

export async function checkQuota(db: Db, userId: string): Promise<{ ok: boolean; remaining: number; plan: string }> {
  const { rows } = await db.query(
    "SELECT plan, quota_total, quota_used, bonus_points FROM opc_users WHERE id = $1",
    [userId],
  );
  const user = rows[0] as { plan: string; quota_total: number; quota_used: number; bonus_points: number } | undefined;
  if (!user) return { ok: false, remaining: 0, plan: "free" };
  if (user.plan === "ultra") return { ok: true, remaining: 999999, plan: "ultra" };
  const monthly = user.quota_total - user.quota_used;
  const bonus = user.bonus_points ?? 0;
  return { ok: monthly + bonus > 0, remaining: monthly + bonus, plan: user.plan };
}

export async function logUsage(
  db: Db,
  userId: string,
  tokensIn: number,
  tokensOut: number,
  costPoints: number,
  costYuan: number,
  toolName: string,
  modelId: string,
  conversationId: string,
): Promise<void> {
  const points = Math.ceil(costPoints);
  try {
    await db.query(
      "INSERT INTO opc_usage_log (id, user_id, tokens_in, tokens_out, cost_points, tool_name, model_id, conversation_id, api_cost_yuan, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
      [uuid(), userId, tokensIn, tokensOut, points, toolName, modelId, conversationId, costYuan],
    );
  } catch (error) {
    console.error("[Usage Log Error]", error);
  }

  const { rows } = await db.query(
    "SELECT plan, quota_total, quota_used, bonus_points FROM opc_users WHERE id = $1",
    [userId],
  );
  const user = rows[0] as { plan: string; quota_total: number; quota_used: number; bonus_points: number } | undefined;
  if (!user || user.plan === "ultra") return;

  const monthlyLeft = Math.max(0, user.quota_total - user.quota_used);
  const fromMonthly = Math.min(points, monthlyLeft);
  const fromBonus = points - fromMonthly;

  if (fromMonthly > 0) {
    await db.query("UPDATE opc_users SET quota_used = quota_used + $1 WHERE id = $2", [fromMonthly, userId]);
  }
  if (fromBonus > 0) {
    await db.query("UPDATE opc_users SET bonus_points = GREATEST(0, bonus_points - $1) WHERE id = $2", [fromBonus, userId]);
  }
}

export async function ensureConversationAccess(
  db: Db,
  userId: string,
  companyId: string,
  conversationId: string,
  userMessage: string,
): Promise<string> {
  if (companyId) {
    const { rows } = await db.query(
      "SELECT 1 FROM opc_user_companies WHERE user_id = $1 AND company_id = $2",
      [userId, companyId],
    );
    if (!rows[0]) {
      throw new Error("无权访问该公司");
    }
  }

  if (!conversationId) {
    const nextConversationId = uuid();
    const title = userMessage.slice(0, 30) + (userMessage.length > 30 ? "..." : "");
    await db.query(
      "INSERT INTO opc_chat_conversations (id, user_id, company_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
      [nextConversationId, userId, companyId, title],
    );
    return nextConversationId;
  }

  const { rows } = await db.query(
    "SELECT id, company_id FROM opc_chat_conversations WHERE id = $1 AND user_id = $2",
    [conversationId, userId],
  );
  const conversation = rows[0] as { id: string; company_id: string } | undefined;
  if (!conversation) {
    throw new Error("对话不存在或无权访问");
  }
  if (companyId && conversation.company_id && conversation.company_id !== companyId) {
    throw new Error("对话所属公司不匹配");
  }

  await db.query(
    "UPDATE opc_chat_conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2",
    [conversationId, userId],
  );
  return conversationId;
}

export async function queuePostChatTasks(
  db: Db,
  userId: string,
  companyId: string,
  conversationId: string,
  userMessage: string,
  assistantReply: string,
  meta: { calledTools?: string[] } = {},
): Promise<void> {
  detectAndSaveRename(db, userId, companyId, conversationId, userMessage).catch(() => {});
  extractAndSaveMemory(db, userId, companyId, conversationId, userMessage, assistantReply).catch(() => {});
  extractAndSaveReflection(db, {
    userId,
    companyId,
    conversationId,
    userMessage,
    assistantReply,
    calledTools: meta.calledTools || [],
  }).catch(() => {});
  updateOnboardingProgress(db, userId, userMessage)
    .then(() => markOnboardingDoneIfReady(db, userId))
    .catch(() => {});
}

async function detectAndSaveRename(db: Db, userId: string, companyId: string, convId: string, userMsg: string): Promise<void> {
  for (const pattern of RENAME_PATTERNS) {
    const matched = userMsg.match(pattern);
    if (!matched?.[1]) continue;
    const name = matched[1].replace(/[。，,.、\s]+$/, "").trim();
    if (!name || NAME_STOP.has(name) || name.length > 12) continue;

    const content = `用户给 AI 取名为 ${name}`;
    await upsertUserMemory(db, {
      userId,
      companyId,
      conversationId: convId,
      category: "preference",
      content,
      importance: 9,
    });
    return;
  }
}
