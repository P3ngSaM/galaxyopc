/**
 * 今日焦点引擎 — 每日智能汇总：跟进客户、到期合同、异常财务、待办事项
 * 仅 LOCAL_MODE 下启用
 */

import type { Db } from "../db.js";
import { isLocalModeEnabled } from "./security.js";
import { callAi } from "../chat/ai-client.js";

export interface FocusItem {
  category: "follow_up" | "contract_expiring" | "finance_alert" | "todo_due" | "email_unread";
  priority: number; // 1-10, higher = more urgent
  title: string;
  detail: string;
  entityId?: string;
  entityType?: string;
  actionHint?: string;
}

export interface DailyFocus {
  date: string;
  items: FocusItem[];
  summary: string;
}

export async function generateDailyFocus(db: Db, userId: string): Promise<DailyFocus> {
  if (!isLocalModeEnabled()) return { date: today(), items: [], summary: "仅本地版可用" };

  const items: FocusItem[] = [];
  const companyCids = await getUserCompanyIds(db, userId);

  if (companyCids.length > 0) {
    const [followUps, expContracts, finAlerts] = await Promise.all([
      getFollowUpDue(db, companyCids),
      getExpiringContracts(db, companyCids),
      getFinanceAlerts(db, companyCids),
    ]);
    items.push(...followUps, ...expContracts, ...finAlerts);
  }

  const [todos, emails] = await Promise.all([
    getTodoDue(db, userId),
    getUnreadEmails(db, userId),
  ]);
  items.push(...todos, ...emails);

  items.sort((a, b) => b.priority - a.priority);

  const summary = buildSummary(items);
  return { date: today(), items: items.slice(0, 20), summary };
}

// ─── 数据采集器 ──────────────────────────────────────────────────

async function getUserCompanyIds(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.query(
    "SELECT company_id FROM opc_user_companies WHERE user_id = $1", [userId],
  );
  return (rows as any[]).map(r => r.company_id);
}

async function getFollowUpDue(db: Db, cids: string[]): Promise<FocusItem[]> {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.company AS org, c.pipeline_stage, c.deal_value, c.follow_up_date, c.notes, co.name AS company_name
       FROM opc_contacts c
       LEFT JOIN opc_companies co ON co.id = c.company_id
       WHERE c.company_id = ANY($1)
         AND c.follow_up_date IS NOT NULL
         AND c.follow_up_date::date <= (CURRENT_DATE + INTERVAL '2 days')
       ORDER BY c.follow_up_date ASC
       LIMIT 10`,
      [cids],
    );
    return (rows as any[]).map(r => {
      const isOverdue = new Date(r.follow_up_date) < new Date(today());
      return {
        category: "follow_up" as const,
        priority: isOverdue ? 9 : 7,
        title: `${isOverdue ? "[逾期] " : ""}跟进客户: ${r.name}`,
        detail: `${r.company_name || ""} · ${r.org || ""} · ${r.pipeline_stage || "未分类"}${r.deal_value ? ` · ¥${r.deal_value}` : ""}`,
        entityId: r.id,
        entityType: "contact",
        actionHint: isOverdue ? "已逾期，建议立即联系" : "今日/明日应跟进",
      };
    });
  } catch { return []; }
}

async function getExpiringContracts(db: Db, cids: string[]): Promise<FocusItem[]> {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.end_date, c.amount, co.name AS company_name
       FROM opc_contracts c
       LEFT JOIN opc_companies co ON co.id = c.company_id
       WHERE c.company_id = ANY($1)
         AND c.status = 'active'
         AND c.end_date IS NOT NULL
         AND c.end_date::date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '15 days')
       ORDER BY c.end_date ASC
       LIMIT 5`,
      [cids],
    );
    return (rows as any[]).map(r => {
      const daysLeft = Math.ceil((new Date(r.end_date).getTime() - Date.now()) / 86400000);
      return {
        category: "contract_expiring" as const,
        priority: daysLeft <= 3 ? 8 : 6,
        title: `合同即将到期: ${r.title}`,
        detail: `${r.company_name || ""} · ${daysLeft}天后到期${r.amount ? ` · ¥${r.amount}` : ""}`,
        entityId: r.id,
        entityType: "contract",
        actionHint: daysLeft <= 3 ? "紧急！建议立即处理续约" : "建议提前准备续约方案",
      };
    });
  } catch { return []; }
}

async function getFinanceAlerts(db: Db, cids: string[]): Promise<FocusItem[]> {
  try {
    const items: FocusItem[] = [];
    const { rows } = await db.query(
      `SELECT co.name AS company_name, co.id AS company_id,
              SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END) AS income_7d,
              SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END) AS expense_7d
       FROM opc_transactions t
       JOIN opc_companies co ON co.id = t.company_id
       WHERE t.company_id = ANY($1)
         AND t.transaction_date >= (CURRENT_DATE - INTERVAL '7 days')
       GROUP BY co.id, co.name`,
      [cids],
    );
    for (const r of rows as any[]) {
      if (r.expense_7d > r.income_7d * 2 && r.expense_7d > 1000) {
        items.push({
          category: "finance_alert",
          priority: 7,
          title: `支出预警: ${r.company_name}`,
          detail: `近7天支出 ¥${Number(r.expense_7d).toFixed(0)} 超过收入 ¥${Number(r.income_7d).toFixed(0)} 的两倍`,
          entityId: r.company_id,
          entityType: "company",
          actionHint: "建议检查近期大额支出",
        });
      }
    }
    return items;
  } catch { return []; }
}

async function getTodoDue(db: Db, userId: string): Promise<FocusItem[]> {
  try {
    const { rows } = await db.query(
      `SELECT id, title, description, due_date, priority FROM opc_schedules
       WHERE user_id = $1 AND type = 'todo' AND status != 'done'
         AND due_date IS NOT NULL AND due_date::date <= (CURRENT_DATE + INTERVAL '1 day')
       ORDER BY due_date ASC LIMIT 10`,
      [userId],
    );
    return (rows as any[]).map(r => {
      const isOverdue = new Date(r.due_date) < new Date(today());
      return {
        category: "todo_due" as const,
        priority: isOverdue ? 8 : 5,
        title: `${isOverdue ? "[逾期] " : ""}待办: ${r.title}`,
        detail: r.description || "无备注",
        entityId: r.id,
        entityType: "schedule",
        actionHint: isOverdue ? "已逾期，请尽快处理" : "今天/明天到期",
      };
    });
  } catch { return []; }
}

async function getUnreadEmails(db: Db, userId: string): Promise<FocusItem[]> {
  try {
    const { rows } = await db.query(
      `SELECT id, from_name, from_addr, subject, received_at FROM opc_email_inbox
       WHERE user_id = $1 AND is_read = false
       ORDER BY received_at DESC LIMIT 5`,
      [userId],
    );
    return (rows as any[]).map(r => ({
      category: "email_unread" as const,
      priority: 4,
      title: `未读邮件: ${r.subject || "(无主题)"}`,
      detail: `来自 ${r.from_name || r.from_addr}`,
      entityId: r.id,
      entityType: "email",
      actionHint: "点击查看或让 AI 代为回复",
    }));
  } catch { return []; }
}

// ─── 自动日报/周报 ─────────────────────────────────────────────────

export async function generateAutoReport(
  db: Db, userId: string, companyId: string, reportType: "daily" | "weekly",
): Promise<string> {
  const cids = companyId ? [companyId] : await getUserCompanyIds(db, userId);
  const dateRange = reportType === "daily" ? "1 day" : "7 days";
  const label = reportType === "daily" ? "日报" : "周报";

  let dataContext = "";

  try {
    const { rows: txRows } = await db.query(
      `SELECT type, SUM(amount) AS total, COUNT(*) AS cnt FROM opc_transactions
       WHERE company_id = ANY($1) AND transaction_date >= (CURRENT_DATE - INTERVAL '${dateRange}')
       GROUP BY type`,
      [cids],
    );
    const income = (txRows as any[]).find(r => r.type === "income");
    const expense = (txRows as any[]).find(r => r.type === "expense");
    dataContext += `收入: ¥${income ? Number(income.total).toFixed(0) : 0} (${income?.cnt || 0}笔), 支出: ¥${expense ? Number(expense.total).toFixed(0) : 0} (${expense?.cnt || 0}笔)\n`;
  } catch {}

  try {
    const { rows: contactRows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM opc_contacts WHERE company_id = ANY($1) AND created_at >= (CURRENT_DATE - INTERVAL '${dateRange}')`,
      [cids],
    );
    dataContext += `新增客户: ${(contactRows[0] as any)?.cnt || 0}\n`;
  } catch {}

  try {
    const { rows: todoRows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='done') AS done, COUNT(*) AS total
       FROM opc_schedules WHERE user_id = $1 AND type='todo'
         AND updated_at >= (CURRENT_DATE - INTERVAL '${dateRange}')`,
      [userId],
    );
    const t = todoRows[0] as any;
    dataContext += `待办完成: ${t?.done || 0}/${t?.total || 0}\n`;
  } catch {}

  const prompt = `基于以下数据生成一份简洁的${label}（中文，Markdown格式，控制在300字内）：

${dataContext}

要求：
1. 开头一句话总结当天/本周整体情况
2. 分"财务""客户""待办"三个模块简述
3. 最后给出1-2条建议
4. 语气专业但亲切`;

  const resp = await callAi([{ role: "user", content: prompt }]);
  return resp.content || `${label}生成失败`;
}

// ─── Helpers ──────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildSummary(items: FocusItem[]): string {
  if (items.length === 0) return "今天没有需要特别关注的事项，继续保持！";
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.category] = (counts[item.category] || 0) + 1;
  const parts: string[] = [];
  if (counts.follow_up) parts.push(`${counts.follow_up} 个客户需跟进`);
  if (counts.contract_expiring) parts.push(`${counts.contract_expiring} 份合同即将到期`);
  if (counts.finance_alert) parts.push(`${counts.finance_alert} 条财务预警`);
  if (counts.todo_due) parts.push(`${counts.todo_due} 个待办到期`);
  if (counts.email_unread) parts.push(`${counts.email_unread} 封未读邮件`);
  const urgent = items.filter(i => i.priority >= 8).length;
  return `今日共 ${items.length} 项关注事项${urgent ? `（其中 ${urgent} 项紧急）` : ""}：${parts.join("、")}`;
}
