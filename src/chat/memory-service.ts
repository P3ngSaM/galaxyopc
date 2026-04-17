import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";

type MemoryCategory = "preference" | "decision" | "fact" | "personality" | "goal";

export interface MemoryRecord {
  id: string;
  user_id: string;
  company_id: string | null;
  category: MemoryCategory | string;
  content: string;
  importance: number;
  updated_at: string;
}

interface CandidateScore {
  memory: MemoryRecord;
  score: number;
}

function normalizeText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTerms(input: string): string[] {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((term) => term.length >= 2)
    .slice(0, 24);
}

function calcRecencyBoost(updatedAt: string): number {
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  if (ageDays <= 3) return 10;
  if (ageDays <= 14) return 6;
  if (ageDays <= 45) return 3;
  return 0;
}

function calcOverlapScore(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const normalized = normalizeText(content);
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      score += term.length >= 4 ? 7 : 4;
    }
  }
  return score;
}

export async function selectRelevantMemories(
  db: Db,
  options: {
    userId: string;
    companyId?: string;
    currentMessage?: string;
    limit?: number;
  },
): Promise<MemoryRecord[]> {
  const limit = Math.max(1, Math.min(20, options.limit ?? 12));
  const { rows } = await db.query(
    `SELECT id, user_id, company_id, category, content, importance, updated_at
     FROM opc_user_memories
     WHERE user_id = $1 AND is_active = true
     ORDER BY importance DESC, updated_at DESC
     LIMIT 80`,
    [options.userId],
  );
  const terms = splitTerms(options.currentMessage || "");
  const scored = (rows as MemoryRecord[]).map((memory): CandidateScore => {
    let score = Number(memory.importance || 0) * 10 + calcRecencyBoost(memory.updated_at);
    if (options.companyId && memory.company_id && memory.company_id === options.companyId) score += 8;
    score += calcOverlapScore(memory.content, terms);
    if (terms.length > 0 && memory.category === "preference") score += 2;
    return { memory, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || Number(b.memory.importance || 0) - Number(a.memory.importance || 0))
    .slice(0, limit)
    .map((entry) => entry.memory);
}

function isNearDuplicate(a: string, b: string): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

export async function upsertUserMemory(
  db: Db,
  payload: {
    userId: string;
    companyId?: string;
    conversationId?: string;
    category: MemoryCategory | string;
    content: string;
    importance: number;
  },
): Promise<void> {
  const content = String(payload.content || "").trim();
  if (!content) return;

  const { rows } = await db.query(
    `SELECT id, content, importance
     FROM opc_user_memories
     WHERE user_id = $1 AND is_active = true
     ORDER BY importance DESC, updated_at DESC
     LIMIT 40`,
    [payload.userId],
  );
  const existing = (rows as Array<{ id: string; content: string; importance: number }>).find((row) =>
    isNearDuplicate(row.content, content),
  );

  if (existing) {
    await db.query(
      `UPDATE opc_user_memories
       SET content = $1,
           category = $2,
           importance = $3,
           company_id = COALESCE($4, company_id),
           source_conv_id = COALESCE($5, source_conv_id),
           updated_at = NOW(),
           is_active = true
       WHERE id = $6`,
      [
        content,
        payload.category,
        Math.max(Number(existing.importance || 0), Math.max(1, Math.min(10, Math.round(payload.importance)))),
        payload.companyId || null,
        payload.conversationId || null,
        existing.id,
      ],
    );
    return;
  }

  await db.query(
    `INSERT INTO opc_user_memories
       (id, user_id, company_id, category, content, importance, source_conv_id, created_at, updated_at, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), true)`,
    [
      uuid(),
      payload.userId,
      payload.companyId || null,
      payload.category,
      content,
      Math.max(1, Math.min(10, Math.round(payload.importance))),
      payload.conversationId || null,
    ],
  );
}
