/**
 * 公司 CRUD / 查询 API
 * 所有操作均通过 user_companies 关联表校验归属。
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";
import { markOnboardingDoneIfReady } from "../chat/onboarding-progress.js";

// ─── 获取当前用户的公司列表 ────────────────────────────────────────────

export async function handleListCompanies(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const cityFilter = url.searchParams.get("city_id") || "";

  let sql = `
    SELECT c.*, uc.role AS my_role FROM opc_companies c
    JOIN opc_user_companies uc ON uc.company_id = c.id
    WHERE uc.user_id = $1
  `;
  const params: unknown[] = [req.user!.userId];
  if (cityFilter) {
    params.push(cityFilter);
    sql += ` AND c.city_id = $${params.length}`;
  }
  sql += " ORDER BY c.created_at DESC";

  const { rows } = await db.query(sql, params);
  sendJson(res, 200, { companies: rows });
}

// ─── 获取单个公司详情 ──────────────────────────────────────────────────

export async function handleGetCompany(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId))) {
    sendJson(res, 403, { error: "无权访问该公司" });
    return;
  }

  const { rows } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [companyId]);
  const company = rows[0];
  if (!company) {
    sendJson(res, 404, { error: "公司不存在" });
    return;
  }

  const { rows: roleRows } = await db.query("SELECT role FROM opc_user_companies WHERE user_id = $1 AND company_id = $2", [req.user!.userId, companyId]);
  const myRole = roleRows[0] ? (roleRows[0] as any).role : "member";
  let stats = await getCompanyStats(db, companyId);
  const synced = await syncCompanyOpportunityBattleStatus(db, req.user!.userId, companyId, company as Record<string, unknown>, stats);
  if (synced) {
    stats = await getCompanyStats(db, companyId);
  }
  const autopilot = await runCompanyAutopilot(db, companyId, company as Record<string, unknown>, stats);
  if ((autopilot.created_alerts || 0) > 0 || (autopilot.created_todos || 0) > 0 || (autopilot.created_documents || 0) > 0) {
    stats = await getCompanyStats(db, companyId);
  }
  const dashboard = buildCompanyOperatingDashboard(company as Record<string, unknown>, stats);

  sendJson(res, 200, { company, stats, dashboard, autopilot, my_role: myRole });
}

// ─── 创建公司 ──────────────────────────────────────────────────────────

export async function handleCreateCompany(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const body = await parseBody(req);
  const name = String(body.name || "").trim();
  const industry = String(body.industry || "").trim();

  if (!name) {
    sendJson(res, 400, { error: "公司名称不能为空" });
    return;
  }

  const id = uuid();
  const registrationMode = String(body.registration_mode || body.registrationMode || "virtual").trim() || "virtual";
  const registrationStage = String(body.registration_stage || body.registrationStage || (registrationMode === "real" ? "preparing" : "simulated")).trim() || "not_started";
  const startupStage = String(body.startup_stage || body.startupStage || "setup").trim() || "setup";
  const firstOrderStage = String(body.first_order_stage || body.firstOrderStage || "not_started").trim() || "not_started";

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO opc_companies (id, name, industry, status, registration_mode, registration_stage, startup_stage, first_order_stage, owner_name, owner_contact, description, city_id, core_offer, target_customer_profile, customer_pain_point, delivery_model, revenue_strategy, monthly_revenue_target)
      VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `, [
      id, name, industry, registrationMode, registrationStage, startupStage, firstOrderStage,
      String(body.owner_name || ""),
      String(body.owner_contact || ""),
      String(body.description || ""),
      String(body.city_id || ""),
      String(body.core_offer || ""),
      String(body.target_customer_profile || ""),
      String(body.customer_pain_point || ""),
      String(body.delivery_model || ""),
      String(body.revenue_strategy || ""),
      Number(body.monthly_revenue_target || 0) || 0,
    ]);
    await client.query("INSERT INTO opc_user_companies (user_id, company_id, role) VALUES ($1, $2, 'owner')", [req.user!.userId, id]);
    const { rows: userRows } = await client.query(
      "SELECT onboarding_data FROM opc_users WHERE id = $1 FOR UPDATE",
      [req.user!.userId],
    );
    const userRow = userRows[0] as { onboarding_data?: string } | undefined;
    let onboardingData: Record<string, unknown> = {};
    try {
      onboardingData = JSON.parse(userRow?.onboarding_data || "{}");
    } catch {
      onboardingData = {};
    }
    onboardingData.registration_intent = registrationMode === "virtual" ? "virtual" : "real";
    onboardingData.updated_at = new Date().toISOString();
    await client.query(
      "UPDATE opc_users SET onboarding_data = $1 WHERE id = $2",
      [JSON.stringify(onboardingData), req.user!.userId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await markOnboardingDoneIfReady(db, req.user!.userId);

  const { rows } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [id]);
  const company = rows[0];
  sendJson(res, 201, { company });
}

// ─── 删除公司 ──────────────────────────────────────────────────────────

export async function handleDeleteCompany(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "owner"))) {
    sendJson(res, 403, { error: "仅公司所有者可删除公司" });
    return;
  }

  const { rows } = await db.query("SELECT id FROM opc_companies WHERE id = $1", [companyId]);
  if (!rows[0]) {
    sendJson(res, 404, { error: "公司不存在" });
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // 先删所有有外键引用的子表
    await client.query("DELETE FROM opc_transactions WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_employees WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_contacts WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_company_opportunities WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_invoices WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_contracts WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_projects WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_biz_models WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_alerts WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_todos WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_channel_config WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_closures WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_company_documents WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_company_autopilot_runs WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_staff_config WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_canvas WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_compass WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_chat_messages WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_chat_conversations WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_user_companies WHERE company_id = $1", [companyId]);
    await client.query("DELETE FROM opc_companies WHERE id = $1", [companyId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  sendJson(res, 200, { ok: true });
}

// ─── 更新公司 ──────────────────────────────────────────────────────────

export async function handleUpdateCompany(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "admin"))) {
    sendJson(res, 403, { error: "需要管理员以上权限" });
    return;
  }

  const body = await parseBody(req);
  const sets: string[] = [];
  const vals: unknown[] = [];

  const allowedFields = [
    "name",
    "industry",
    "status",
    "owner_name",
    "owner_contact",
    "registered_capital",
    "description",
    "city_id",
    "registration_mode",
    "registration_stage",
    "startup_stage",
    "first_order_stage",
    "core_offer",
    "target_customer_profile",
    "customer_pain_point",
    "delivery_model",
    "revenue_strategy",
    "monthly_revenue_target",
  ];
  for (const f of allowedFields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = $${vals.length + 1}`);
      vals.push(f === "monthly_revenue_target" ? (Number(body[f]) || 0) : String(body[f]));
    }
  }

  if (sets.length === 0) {
    sendJson(res, 400, { error: "无更新内容" });
    return;
  }

  sets.push("updated_at = NOW()");
  vals.push(companyId);

  await db.query(`UPDATE opc_companies SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  const { rows } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [companyId]);
  const company = rows[0];
  sendJson(res, 200, { company });
}

export async function handleCreateLifecycleTodoPack(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "member"))) {
    sendJson(res, 403, { error: "无权访问该公司" });
    return;
  }

  const { rows } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [companyId]);
  const company = rows[0] as Record<string, unknown> | undefined;
  if (!company) {
    sendJson(res, 404, { error: "公司不存在" });
    return;
  }

  const tasks = buildLifecycleTodoPack(company);
  let created = 0;
  let reused = 0;

  for (const task of tasks) {
    const { rows: existingRows } = await db.query(
      "SELECT id FROM opc_todos WHERE company_id = $1 AND title = $2 AND completed = 0 LIMIT 1",
      [companyId, task.title],
    );
    if (existingRows[0]) {
      reused += 1;
      continue;
    }
    await db.query(
      "INSERT INTO opc_todos (id, company_id, title, priority, category, due_date, description, completed, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,0,NOW())",
      [uuid(), companyId, task.title, task.priority, "lifecycle", task.due_date, task.description,],
    );
    created += 1;
  }

  const { rows: todoRows } = await db.query(
    "SELECT * FROM opc_todos WHERE company_id = $1 AND completed = 0 ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC LIMIT 10",
    [companyId],
  );

  sendJson(res, 200, {
    success: true,
    pack: { created, reused, total: tasks.length },
    todos: todoRows,
  });
}

export async function handleCreateLifecycleDocPack(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "member"))) {
    sendJson(res, 403, { error: "无权访问该公司" });
    return;
  }

  const { rows } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [companyId]);
  const company = rows[0] as Record<string, unknown> | undefined;
  if (!company) {
    sendJson(res, 404, { error: "公司不存在" });
    return;
  }

  const docs = buildLifecycleDocPack(company);
  let created = 0;
  let updated = 0;

  for (const doc of docs) {
    const { rows: existingRows } = await db.query(
      "SELECT id FROM opc_company_documents WHERE company_id = $1 AND doc_type = $2 LIMIT 1",
      [companyId, doc.doc_type],
    );
    if (existingRows[0]) {
      await db.query(
        "UPDATE opc_company_documents SET title = $1, content = $2, source = $3, updated_at = NOW() WHERE id = $4",
        [doc.title, doc.content, doc.source, (existingRows[0] as { id: string }).id],
      );
      updated += 1;
      continue;
    }
    await db.query(
      "INSERT INTO opc_company_documents (id, company_id, doc_type, title, content, source, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())",
      [uuid(), companyId, doc.doc_type, doc.title, doc.content, doc.source],
    );
    created += 1;
  }

  const { rows: docRows } = await db.query(
    "SELECT * FROM opc_company_documents WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 20",
    [companyId],
  );

  sendJson(res, 200, {
    success: true,
    pack: { created, updated, total: docs.length },
    documents: docRows,
  });
}

// ─── 仪表盘统计 ──────────────────────────────────────────────────────

export async function handleDashboard(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const cityFilter = url.searchParams.get("city_id") || "";

  let companySql = `
    SELECT c.id, c.name, c.status, c.industry, c.owner_name, c.registered_capital, c.created_at, c.city_id
    FROM opc_companies c
    JOIN opc_user_companies uc ON uc.company_id = c.id
    WHERE uc.user_id = $1
  `;
  const companyParams: unknown[] = [req.user!.userId];
  if (cityFilter) {
    companyParams.push(cityFilter);
    companySql += ` AND c.city_id = $${companyParams.length}`;
  }
  companySql += " ORDER BY c.created_at DESC";

  const { rows: companiesRows } = await db.query(companySql, companyParams);
  const companies = companiesRows as { id: string; name: string; status: string; industry: string; owner_name: string; registered_capital: number; created_at: string }[];

  let totalIncome = 0;
  let totalExpense = 0;
  let totalContacts = 0;
  let totalProjects = 0;
  let totalContracts = 0;
  let totalEmployees = 0;

  const companyIds = companies.map(c => c.id);
  const ph = companyIds.map((_, i) => "$" + (i + 1)).join(",");

  if (companyIds.length > 0) {
    const { rows: fin } = await db.query(`SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id IN (${ph}) GROUP BY type`, companyIds);
    const finTyped = fin as { type: string; total: number }[];
    for (const f of finTyped) {
      if (f.type === "income") totalIncome += Number(f.total) || 0;
      else totalExpense += Number(f.total) || 0;
    }
    const { rows: contactsRows } = await db.query(`SELECT COUNT(*) as c FROM opc_contacts WHERE company_id IN (${ph})`, companyIds);
    totalContacts = Number((contactsRows[0] as { c: number }).c) || 0;
    const { rows: projectsRows } = await db.query(`SELECT COUNT(*) as c FROM opc_projects WHERE company_id IN (${ph})`, companyIds);
    totalProjects = Number((projectsRows[0] as { c: number }).c) || 0;
    const { rows: contractsRows } = await db.query(`SELECT COUNT(*) as c FROM opc_contracts WHERE company_id IN (${ph})`, companyIds);
    totalContracts = Number((contractsRows[0] as { c: number }).c) || 0;
    const { rows: employeesRows } = await db.query(`SELECT COUNT(*) as c FROM opc_employees WHERE company_id IN (${ph})`, companyIds);
    totalEmployees = Number((employeesRows[0] as { c: number }).c) || 0;
  }
  const totalTransactions = companyIds.length > 0
    ? Number(((await db.query(`SELECT COUNT(*) as c FROM opc_transactions WHERE company_id IN (${ph})`, companyIds)).rows[0] as { c: number }).c) || 0
    : 0;

  // Monthly trends (last 6 months)
  const trends: { month: string; income: number; expense: number }[] = [];
  const startIdx = companyIds.length + 1;
  for (let i = -5; i <= 0; i++) {
    const d = new Date(); d.setMonth(d.getMonth() + i);
    const y = d.getFullYear(); const m = d.getMonth() + 1;
    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const label = `${m}月`;
    if (companyIds.length > 0) {
      const { rows: trendRows } = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) as inc, COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) as exp FROM opc_transactions WHERE company_id IN (${ph}) AND transaction_date >= $${startIdx} AND transaction_date < $${startIdx + 1}`,
        [...companyIds, start, end]
      );
      const row = trendRows[0] as { inc: number; exp: number };
      trends.push({ month: label, income: Number(row.inc) || 0, expense: Number(row.exp) || 0 });
    } else {
      trends.push({ month: label, income: 0, expense: 0 });
    }
  }

  // Recent transactions (last 10)
  const recentTransactions = companyIds.length > 0
    ? (await db.query(`SELECT t.*, c.name as company_name FROM opc_transactions t JOIN opc_companies c ON c.id = t.company_id WHERE t.company_id IN (${ph}) ORDER BY t.transaction_date DESC, t.created_at DESC LIMIT 10`, companyIds)).rows as Record<string, unknown>[]
    : [];

  // Alerts
  const alerts = companyIds.length > 0
    ? (await db.query(`SELECT a.*, c.name as company_name FROM opc_alerts a JOIN opc_companies c ON c.id = a.company_id WHERE a.company_id IN (${ph}) AND a.is_read = 0 ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 5`, companyIds)).rows as Record<string, unknown>[]
    : [];

  // AI config check
  const { rows: aiKeyRows } = await db.query("SELECT value FROM opc_tool_config WHERE key = 'ai_api_key'");
  const aiKeyRow = aiKeyRows[0] as { value: string } | undefined;
  const aiConfigured = !!(aiKeyRow && aiKeyRow.value) || !!process.env.AI_API_KEY;

  // MoM comparison
  const curD = new Date(); const curM = curD.getMonth() + 1; const curY = curD.getFullYear();
  const curStart = `${curY}-${String(curM).padStart(2, "0")}-01`;
  const curEnd = curM === 12 ? `${curY + 1}-01-01` : `${curY}-${String(curM + 1).padStart(2, "0")}-01`;
  const prevD = new Date(); prevD.setMonth(prevD.getMonth() - 1); const prevM = prevD.getMonth() + 1; const prevY = prevD.getFullYear();
  const prevStart = `${prevY}-${String(prevM).padStart(2, "0")}-01`;
  const prevEnd = prevM === 12 ? `${prevY + 1}-01-01` : `${prevY}-${String(prevM + 1).padStart(2, "0")}-01`;

  let curIncome = 0, prevIncome = 0, curExpense = 0, prevExpense = 0;
  if (companyIds.length > 0) {
    const { rows: curRows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) as inc, COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) as exp FROM opc_transactions WHERE company_id IN (${ph}) AND transaction_date >= $${startIdx} AND transaction_date < $${startIdx + 1}`,
      [...companyIds, curStart, curEnd]
    );
    const curRow = curRows[0] as { inc: number; exp: number };
    const { rows: prevRows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) as inc, COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) as exp FROM opc_transactions WHERE company_id IN (${ph}) AND transaction_date >= $${startIdx} AND transaction_date < $${startIdx + 1}`,
      [...companyIds, prevStart, prevEnd]
    );
    const prevRow = prevRows[0] as { inc: number; exp: number };
    curIncome = Number(curRow.inc) || 0; curExpense = Number(curRow.exp) || 0; prevIncome = Number(prevRow.inc) || 0; prevExpense = Number(prevRow.exp) || 0;
  }

  // Expense by category
  const expenseByCategory = companyIds.length > 0
    ? (await db.query(`SELECT category, SUM(amount) as total FROM opc_transactions WHERE company_id IN (${ph}) AND type='expense' GROUP BY category ORDER BY total DESC`, companyIds)).rows as { category: string; total: number }[]
    : [];

  sendJson(res, 200, {
    companies,
    summary: {
      company_count: companies.length,
      active_companies: companies.filter(c => c.status === "active").length,
      total_income: totalIncome,
      total_expense: totalExpense,
      total_contacts: totalContacts,
      total_projects: totalProjects,
      total_transactions: totalTransactions,
      total_contracts: totalContracts,
      total_employees: totalEmployees,
    },
    trends,
    recentTransactions,
    alerts,
    aiConfigured,
    mom: { curIncome, prevIncome, curExpense, prevExpense },
    expenseByCategory,
  });
}

// ─── 公司财务数据 ──────────────────────────────────────────────────────

export async function handleCompanyFinance(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId))) {
    sendJson(res, 403, { error: "无权访问该公司" });
    return;
  }

  const { rows: transactions } = await db.query("SELECT * FROM opc_transactions WHERE company_id = $1 ORDER BY transaction_date DESC LIMIT 50", [companyId]);
  const { rows: invoices } = await db.query("SELECT * FROM opc_invoices WHERE company_id = $1 ORDER BY issue_date DESC LIMIT 50", [companyId]);
  const { rows: summary } = await db.query(`
    SELECT type, SUM(amount) as total, COUNT(*) as count FROM opc_transactions
    WHERE company_id = $1 GROUP BY type
  `, [companyId]);

  sendJson(res, 200, { transactions, invoices, summary });
}

// ─── 公司联系人 ────────────────────────────────────────────────────────

export async function handleCompanyContacts(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId))) {
    sendJson(res, 403, { error: "无权访问" });
    return;
  }

  const { rows: contacts } = await db.query("SELECT * FROM opc_contacts WHERE company_id = $1 ORDER BY created_at DESC", [companyId]);
  sendJson(res, 200, { contacts });
}

export async function handleCompanyOpportunities(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId))) {
    sendJson(res, 403, { error: "无权访问" });
    return;
  }

  const { rows: opportunities } = await db.query(
    "SELECT * FROM opc_company_opportunities WHERE company_id = $1 ORDER BY updated_at DESC, created_at DESC",
    [companyId],
  );
  sendJson(res, 200, { opportunities });
}

export async function handleCreateCompanyOpportunity(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "member"))) {
    sendJson(res, 403, { error: "无权访问" });
    return;
  }

  const body = await parseBody(req);
  const title = String(body.title || "").trim();
  if (!title) {
    sendJson(res, 400, { error: "机会名称不能为空" });
    return;
  }

  const id = uuid();
  const stage = normalizeOpportunityStage(String(body.stage || "todo"));
  const fitScore = clampOpportunityFitScore(body.fit_score);
  const expectedAmount = Number(body.expected_amount || 0) || 0;
  const nextActionAt = body.next_action_at ? new Date(String(body.next_action_at)).toISOString() : null;

  await db.query(`
    INSERT INTO opc_company_opportunities (
      id, company_id, title, customer_name, customer_role, source_type, source_detail,
      fit_score, stage, expected_amount, next_action, next_action_at, owner_user_id, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  `, [
    id,
    companyId,
    title,
    String(body.customer_name || ""),
    String(body.customer_role || ""),
    String(body.source_type || "manual"),
    String(body.source_detail || ""),
    fitScore,
    stage,
    expectedAmount,
    String(body.next_action || ""),
    nextActionAt,
    String(body.owner_user_id || req.user!.userId),
    String(body.notes || ""),
  ]);

  const { rows } = await db.query("SELECT * FROM opc_company_opportunities WHERE id = $1", [id]);
  sendJson(res, 201, { opportunity: rows[0] });
}

export async function handleUpdateCompanyOpportunity(
  req: AuthRequest,
  res: ServerResponse,
  db: Db,
  companyId: string,
  opportunityId: string,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "member"))) {
    sendJson(res, 403, { error: "无权访问" });
    return;
  }

  const body = await parseBody(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const allowedFields = [
    "title",
    "customer_name",
    "customer_role",
    "source_type",
    "source_detail",
    "fit_score",
    "stage",
    "expected_amount",
    "next_action",
    "next_action_at",
    "owner_user_id",
    "notes",
  ];
  for (const field of allowedFields) {
    if (body[field] === undefined) continue;
    sets.push(`${field} = $${vals.length + 1}`);
    if (field === "fit_score") vals.push(clampOpportunityFitScore(body[field]));
    else if (field === "expected_amount") vals.push(Number(body[field] || 0) || 0);
    else if (field === "stage") vals.push(normalizeOpportunityStage(String(body[field] || "")));
    else if (field === "next_action_at") vals.push(body[field] ? new Date(String(body[field])).toISOString() : null);
    else vals.push(String(body[field] || ""));
  }
  if (!sets.length) {
    sendJson(res, 400, { error: "无更新内容" });
    return;
  }
  sets.push("updated_at = NOW()");
  vals.push(companyId, opportunityId);

  const result = await db.query(
    `UPDATE opc_company_opportunities SET ${sets.join(", ")} WHERE company_id = $${vals.length - 1} AND id = $${vals.length}`,
    vals,
  );
  if ((result as { rowCount?: number }).rowCount === 0) {
    sendJson(res, 404, { error: "机会不存在" });
    return;
  }

  const { rows } = await db.query("SELECT * FROM opc_company_opportunities WHERE id = $1", [opportunityId]);
  sendJson(res, 200, { opportunity: rows[0] });
}

export async function handleDeleteCompanyOpportunity(
  req: AuthRequest,
  res: ServerResponse,
  db: Db,
  companyId: string,
  opportunityId: string,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "admin"))) {
    sendJson(res, 403, { error: "需要管理员以上权限" });
    return;
  }

  const result = await db.query("DELETE FROM opc_company_opportunities WHERE company_id = $1 AND id = $2", [companyId, opportunityId]);
  if ((result as { rowCount?: number }).rowCount === 0) {
    sendJson(res, 404, { error: "机会不存在" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

export async function handleCompanyDeliveryOrders(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId))) {
    sendJson(res, 403, { error: "无权访问" });
    return;
  }

  const { rows: orders } = await db.query(
    "SELECT * FROM opc_delivery_orders WHERE company_id = $1 ORDER BY updated_at DESC, created_at DESC",
    [companyId],
  );
  sendJson(res, 200, { delivery_orders: orders });
}

export async function handleCreateDeliveryOrder(req: AuthRequest, res: ServerResponse, db: Db, companyId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "member"))) {
    sendJson(res, 403, { error: "无权访问" });
    return;
  }

  const body = await parseBody(req);
  const title = String(body.title || "").trim();
  if (!title) {
    sendJson(res, 400, { error: "交付单名称不能为空" });
    return;
  }

  const id = uuid();
  const dueDate = String(body.due_date || "").trim();
  const opportunityId = String(body.opportunity_id || "").trim();
  const milestones = normalizeDeliveryMilestones(body.milestones_json ?? body.milestones);

  await db.query(`
    INSERT INTO opc_delivery_orders (
      id, company_id, opportunity_id, title, customer_name, contract_amount, delivery_stage,
      invoice_status, payment_status, due_date, next_action, milestones_json, note, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
  `, [
    id,
    companyId,
    opportunityId,
    title,
    String(body.customer_name || ""),
    Number(body.contract_amount || 0) || 0,
    normalizeDeliveryStage(String(body.delivery_stage || "preparing")),
    normalizeInvoiceStatus(String(body.invoice_status || "not_started")),
    normalizePaymentStatus(String(body.payment_status || "pending")),
    dueDate,
    String(body.next_action || ""),
    JSON.stringify(milestones),
    String(body.note || ""),
    req.user!.userId,
  ]);

  const { rows } = await db.query("SELECT * FROM opc_delivery_orders WHERE id = $1", [id]);
  sendJson(res, 201, { delivery_order: rows[0] });
}

export async function handleUpdateDeliveryOrder(
  req: AuthRequest,
  res: ServerResponse,
  db: Db,
  companyId: string,
  orderId: string,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "member"))) {
    sendJson(res, 403, { error: "无权访问" });
    return;
  }

  const body = await parseBody(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const allowedFields = [
    "opportunity_id",
    "title",
    "customer_name",
    "contract_amount",
    "delivery_stage",
    "invoice_status",
    "payment_status",
    "due_date",
    "next_action",
    "milestones_json",
    "milestones",
    "note",
  ];
  for (const field of allowedFields) {
    if (body[field] === undefined) continue;
    const column = field === "milestones" ? "milestones_json" : field;
    sets.push(`${column} = $${vals.length + 1}`);
    if (field === "contract_amount") vals.push(Number(body[field] || 0) || 0);
    else if (field === "delivery_stage") vals.push(normalizeDeliveryStage(String(body[field] || "")));
    else if (field === "invoice_status") vals.push(normalizeInvoiceStatus(String(body[field] || "")));
    else if (field === "payment_status") vals.push(normalizePaymentStatus(String(body[field] || "")));
    else if (field === "milestones_json" || field === "milestones") vals.push(JSON.stringify(normalizeDeliveryMilestones(body[field])));
    else vals.push(String(body[field] || ""));
  }
  if (!sets.length) {
    sendJson(res, 400, { error: "无更新内容" });
    return;
  }
  sets.push("updated_at = NOW()");
  vals.push(companyId, orderId);

  const result = await db.query(
    `UPDATE opc_delivery_orders SET ${sets.join(", ")} WHERE company_id = $${vals.length - 1} AND id = $${vals.length}`,
    vals,
  );
  if ((result as { rowCount?: number }).rowCount === 0) {
    sendJson(res, 404, { error: "交付单不存在" });
    return;
  }

  const { rows } = await db.query("SELECT * FROM opc_delivery_orders WHERE id = $1", [orderId]);
  sendJson(res, 200, { delivery_order: rows[0] });
}

export async function handleDeleteDeliveryOrder(
  req: AuthRequest,
  res: ServerResponse,
  db: Db,
  companyId: string,
  orderId: string,
): Promise<void> {
  if (!requireAuth(req, res)) return;
  if (!(await checkCompanyAccess(db, req.user!.userId, companyId, "admin"))) {
    sendJson(res, 403, { error: "需要管理员以上权限" });
    return;
  }

  const result = await db.query("DELETE FROM opc_delivery_orders WHERE company_id = $1 AND id = $2", [companyId, orderId]);
  if ((result as { rowCount?: number }).rowCount === 0) {
    sendJson(res, 404, { error: "交付单不存在" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

// ─── Helpers ───────────────────────────────────────────────────────────

const ROLE_LEVELS: Record<string, number> = { owner: 3, admin: 2, member: 1 };

async function checkCompanyAccess(db: Db, userId: string, companyId: string, requiredRole: string = "member"): Promise<boolean> {
  const { rows } = await db.query("SELECT role FROM opc_user_companies WHERE user_id = $1 AND company_id = $2", [userId, companyId]);
  if (!rows[0]) return false;
  const role = (rows[0] as any).role || "member";
  return (ROLE_LEVELS[role] || 0) >= (ROLE_LEVELS[requiredRole] || 0);
}

type CompanyStatsShape = Record<string, unknown> & {
  opportunities?: unknown[];
  delivery_orders?: unknown[];
  alerts?: unknown[];
  todos?: unknown[];
  documents?: unknown[];
};

type AutopilotSummary = {
  created_rules: number;
  created_todos: number;
  created_alerts: number;
  created_documents: number;
  triggered_roles: string[];
  recent_rules: string[];
};

function toDate(value: unknown): Date | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hoursSince(value: unknown, now: Date): number | null {
  const date = toDate(value);
  if (!date) return null;
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60);
}

function daysUntil(value: unknown, now: Date): number | null {
  const date = toDate(value);
  if (!date) return null;
  return (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
}

function currentWeekKey(now: Date): string {
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const weekNo = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function ensureAutopilotRuleTriggered(
  db: Db,
  companyId: string,
  input: {
    ruleKey: string;
    relatedId: string;
    role: string;
    title: string;
    message: string;
    todoTitle: string;
    todoDescription: string;
    todoPriority?: string;
    todoCategory?: string;
    todoDueDate?: string;
    alertSeverity?: string;
    alertCategory?: string;
    document?: { title: string; content: string; docType?: string };
    payload?: Record<string, unknown>;
  },
): Promise<{ created: boolean; alertId?: string; todoId?: string; documentId?: string }> {
  const relatedId = String(input.relatedId || "").trim();
  const ruleKey = String(input.ruleKey || "").trim();
  if (!ruleKey || !relatedId) return { created: false };

  const existing = await db.query(
    "SELECT id FROM opc_company_autopilot_runs WHERE company_id = $1 AND rule_key = $2 AND related_id = $3 LIMIT 1",
    [companyId, ruleKey, relatedId],
  );
  if (existing.rows[0]) return { created: false };

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const todoId = uuid();
    await client.query(
      "INSERT INTO opc_todos (id, company_id, title, priority, category, due_date, description, completed, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,0,NOW())",
      [
        todoId,
        companyId,
        input.todoTitle,
        input.todoPriority || "medium",
        input.todoCategory || `autopilot_${input.role}`,
        input.todoDueDate || new Date().toISOString().slice(0, 10),
        input.todoDescription,
      ],
    );

    const alertId = uuid();
    await client.query(
      "INSERT INTO opc_alerts (id, company_id, title, severity, category, message, is_read, created_at) VALUES ($1,$2,$3,$4,$5,$6,0,NOW())",
      [
        alertId,
        companyId,
        input.title,
        input.alertSeverity || "warning",
        input.alertCategory || `autopilot_${input.role}`,
        input.message,
      ],
    );

    let documentId = "";
    if (input.document) {
      documentId = uuid();
      await client.query(
        "INSERT INTO opc_company_documents (id, company_id, doc_type, title, content, source, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())",
        [
          documentId,
          companyId,
          input.document.docType || "autopilot_report",
          input.document.title,
          input.document.content,
          "autopilot",
        ],
      );
    }

    await client.query(
      "INSERT INTO opc_company_autopilot_runs (id, company_id, rule_key, related_id, created_todo_id, created_alert_id, created_document_id, payload_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())",
      [
        uuid(),
        companyId,
        ruleKey,
        relatedId,
        todoId,
        alertId,
        documentId,
        JSON.stringify(input.payload || {}),
      ],
    );

    await client.query("COMMIT");
    return { created: true, alertId, todoId, documentId: documentId || undefined };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function runCompanyAutopilot(
  db: Db,
  companyId: string,
  company: Record<string, unknown>,
  stats: CompanyStatsShape,
): Promise<AutopilotSummary> {
  const now = new Date();
  const opportunities = (Array.isArray(stats.opportunities) ? stats.opportunities : []) as Array<Record<string, unknown>>;
  const deliveryOrders = (Array.isArray(stats.delivery_orders) ? stats.delivery_orders : []) as Array<Record<string, unknown>>;
  const alerts = (Array.isArray(stats.alerts) ? stats.alerts : []) as Array<Record<string, unknown>>;
  const todos = (Array.isArray(stats.todos) ? stats.todos : []) as Array<Record<string, unknown>>;
  const documents = (Array.isArray(stats.documents) ? stats.documents : []) as Array<Record<string, unknown>>;

  const summary: AutopilotSummary = {
    created_rules: 0,
    created_todos: 0,
    created_alerts: 0,
    created_documents: 0,
    triggered_roles: [],
    recent_rules: [],
  };
  const markTriggered = (role: string, label: string, result: { created: boolean; documentId?: string }) => {
    if (!result.created) return;
    summary.created_rules += 1;
    summary.created_todos += 1;
    summary.created_alerts += 1;
    if (result.documentId) summary.created_documents += 1;
    if (!summary.triggered_roles.includes(role)) summary.triggered_roles.push(role);
    summary.recent_rules.push(label);
  };

  for (const item of opportunities) {
    const stage = String(item.stage || "");
    if (!["todo", "contacted", "proposal", "quoted", "negotiating"].includes(stage)) continue;
    const staleHours = hoursSince(item.updated_at || item.created_at, now);
    if (staleHours === null || staleHours < 48) continue;
    const result = await ensureAutopilotRuleTriggered(db, companyId, {
      ruleKey: "opportunity_stale_48h",
      relatedId: `${String(item.id || "")}:${String(item.updated_at || item.created_at || "")}`,
      role: "sales",
      title: "销售 Agent：有机会 48 小时未推进",
      message: `机会「${String(item.title || "未命名机会")}」已经超过 48 小时没有推进，建议今天完成一次明确触达或推进动作。`,
      todoTitle: `跟进机会：${String(item.title || "未命名机会")}`,
      todoDescription: `销售 Agent 提醒：机会「${String(item.title || "未命名机会")}」已在阶段「${stage}」停留超过 48 小时。请确认客户状态、推进下一动作，并更新机会记录。`,
      todoPriority: "high",
      todoCategory: "autopilot_sales",
      alertSeverity: "warning",
      alertCategory: "autopilot_sales",
      payload: { opportunity_id: item.id, stage, stale_hours: Math.round(staleHours) },
    });
    markTriggered("sales", "销售跟进提醒", result);
  }

  for (const item of opportunities) {
    if (String(item.stage || "") !== "won") continue;
    const staleHours = hoursSince(item.updated_at || item.created_at, now);
    if (staleHours === null || staleHours < 24) continue;
    const hasDelivery = deliveryOrders.some((order) => String(order.opportunity_id || "") === String(item.id || ""));
    if (hasDelivery) continue;
    const result = await ensureAutopilotRuleTriggered(db, companyId, {
      ruleKey: "won_without_delivery_24h",
      relatedId: `${String(item.id || "")}:${String(item.updated_at || item.created_at || "")}`,
      role: "operations",
      title: "运营 Agent：已成交机会尚未转交付单",
      message: `已成交机会「${String(item.title || "未命名机会")}」超过 24 小时仍未转为交付单，交付和回款链路还没闭合。`,
      todoTitle: `转交付单：${String(item.title || "未命名机会")}`,
      todoDescription: `运营 Agent 提醒：机会「${String(item.title || "未命名机会")}」已经成交，但还没有生成交付单。请立即建立交付计划、里程碑和回款节点。`,
      todoPriority: "high",
      todoCategory: "autopilot_operations",
      alertSeverity: "warning",
      alertCategory: "autopilot_operations",
      payload: { opportunity_id: item.id, stage: item.stage, stale_hours: Math.round(staleHours) },
    });
    markTriggered("operations", "成交转交付提醒", result);
  }

  for (const order of deliveryOrders) {
    const stage = String(order.delivery_stage || "");
    if (["done", "cancelled"].includes(stage)) continue;
    const daysLeft = daysUntil(order.due_date, now);
    if (daysLeft === null || daysLeft < 0 || daysLeft > 2) continue;
    const result = await ensureAutopilotRuleTriggered(db, companyId, {
      ruleKey: "delivery_due_soon",
      relatedId: `${String(order.id || "")}:${String(order.due_date || "")}:${stage}`,
      role: "delivery",
      title: "交付 Agent：交付临近截止",
      message: `交付单「${String(order.title || "未命名交付单")}」距离截止只剩 ${Math.max(0, Math.ceil(daysLeft))} 天，请确认里程碑、验收物和客户对接节奏。`,
      todoTitle: `检查交付进度：${String(order.title || "未命名交付单")}`,
      todoDescription: `交付 Agent 提醒：交付单「${String(order.title || "未命名交付单")}」截止日期为 ${String(order.due_date || "")}，当前阶段为「${stage || "preparing"}」。请确认验收材料、客户反馈和剩余风险。`,
      todoPriority: daysLeft <= 1 ? "high" : "medium",
      todoCategory: "autopilot_delivery",
      alertSeverity: daysLeft <= 1 ? "critical" : "warning",
      alertCategory: "autopilot_delivery",
      payload: { order_id: order.id, due_date: order.due_date, days_left: Math.ceil(daysLeft), stage },
    });
    markTriggered("delivery", "交付临期提醒", result);
  }

  for (const order of deliveryOrders) {
    const invoiceStatus = String(order.invoice_status || "");
    const paymentStatus = String(order.payment_status || "");
    if (!["issued", "sent"].includes(invoiceStatus)) continue;
    if (!["pending", "partial", "overdue"].includes(paymentStatus)) continue;
    const result = await ensureAutopilotRuleTriggered(db, companyId, {
      ruleKey: "invoice_not_paid",
      relatedId: `${String(order.id || "")}:${invoiceStatus}:${paymentStatus}`,
      role: "finance",
      title: "财务 Agent：已开票但未回款",
      message: `交付单「${String(order.title || "未命名交付单")}」已进入开票阶段，但当前回款状态仍为「${paymentStatus}」。请尽快确认收款动作。`,
      todoTitle: `推进回款：${String(order.title || "未命名交付单")}`,
      todoDescription: `财务 Agent 提醒：交付单「${String(order.title || "未命名交付单")}」开票状态为「${invoiceStatus}」，回款状态为「${paymentStatus}」。请跟进开票发送、付款承诺和到账时间。`,
      todoPriority: paymentStatus === "overdue" ? "high" : "medium",
      todoCategory: "autopilot_finance",
      alertSeverity: paymentStatus === "overdue" ? "critical" : "warning",
      alertCategory: "autopilot_finance",
      payload: { order_id: order.id, invoice_status: invoiceStatus, payment_status: paymentStatus },
    });
    markTriggered("finance", "开票回款提醒", result);
  }

  const weekKey = currentWeekKey(now);
  const monthlyTarget = Number(company.monthly_revenue_target || 0) || 0;
  const totalIncome = Number(stats.total_income || 0) || 0;
  const totalExpense = Number(stats.total_expense || 0) || 0;
  const activeOpportunityCount = opportunities.filter((item) => !["won", "lost"].includes(String(item.stage || ""))).length;
  const wonOpportunityCount = opportunities.filter((item) => String(item.stage || "") === "won").length;
  const activeDeliveryCount = deliveryOrders.filter((item) => !["done", "cancelled"].includes(String(item.delivery_stage || ""))).length;
  const pendingPaymentCount = deliveryOrders.filter((item) => ["pending", "partial", "overdue"].includes(String(item.payment_status || ""))).length;
  const pendingTodoCount = todos.filter((item) => !item.completed).length;
  const unreadAlertCount = alerts.filter((item) => !item.is_read).length;
  const recentDocTitles = documents.slice(0, 3).map((item) => String(item.title || "")).filter(Boolean);
  const weeklyReviewContent = [
    `# ${String(company.name || "公司")} 本周经营复盘`,
    "",
    `- 时间周期：${weekKey}`,
    `- 主打产品：${String(company.core_offer || "待补充")}`,
    `- 目标客户：${String(company.target_customer_profile || "待补充")}`,
    `- 本月营收目标：${monthlyTarget ? `${monthlyTarget} 元` : "暂未设置"}`,
    `- 当前累计回款：${totalIncome} 元`,
    `- 当前累计支出：${totalExpense} 元`,
    `- 活跃机会：${activeOpportunityCount} 个`,
    `- 已成交机会：${wonOpportunityCount} 个`,
    `- 在执行交付单：${activeDeliveryCount} 个`,
    `- 待回款交付单：${pendingPaymentCount} 个`,
    `- 未完成待办：${pendingTodoCount} 个`,
    `- 未读告警：${unreadAlertCount} 条`,
    "",
    "## 本周最该看的问题",
    activeOpportunityCount === 0 ? "- 当前没有在推进的机会，销售面需要优先补线索和触达。" : `- 当前有 ${activeOpportunityCount} 个机会在推进，重点盯住最接近成交的 2 个。`,
    activeDeliveryCount > 0 ? `- 当前有 ${activeDeliveryCount} 个交付在执行，先保验收和回款。` : "- 当前交付压力不大，可以把更多精力投向新机会和报价。",
    pendingPaymentCount > 0 ? `- 待回款交付单有 ${pendingPaymentCount} 个，财务 Agent 需要盯紧到账节奏。` : "- 当前回款风险相对可控，但仍要保持节点清晰。",
    recentDocTitles.length ? `- 最近沉淀的文档：${recentDocTitles.join("、")}` : "- 建议继续沉淀报价模板、交付模板和复盘文档。",
  ].join("\n");
  const weeklyResult = await ensureAutopilotRuleTriggered(db, companyId, {
    ruleKey: "weekly_review",
    relatedId: weekKey,
    role: "ceo",
    title: "CEO Agent：本周经营复盘已生成",
    message: `系统已自动生成 ${weekKey} 的经营复盘，请检查目标、机会、交付和回款是否仍然聚焦在本周主线。`,
    todoTitle: `查看本周经营复盘（${weekKey}）`,
    todoDescription: `CEO Agent 提醒：本周经营复盘已经生成。请确认目标、瓶颈、回款和交付压力是否与当前决策一致。`,
    todoPriority: "medium",
    todoCategory: "autopilot_ceo",
    todoDueDate: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    alertSeverity: "info",
    alertCategory: "autopilot_ceo",
    document: {
      title: `经营复盘 ${weekKey}`,
      content: weeklyReviewContent,
      docType: "weekly_review",
    },
    payload: { week_key: weekKey },
  });
  markTriggered("ceo", "每周经营复盘", weeklyResult);

  return summary;
}

async function getCompanyStats(db: Db, companyId: string) {
  const { rows: incomeRows } = await db.query("SELECT COALESCE(SUM(amount),0) as v FROM opc_transactions WHERE company_id = $1 AND type = 'income'", [companyId]);
  const income = incomeRows[0] as { v: number };
  const { rows: expenseRows } = await db.query("SELECT COALESCE(SUM(amount),0) as v FROM opc_transactions WHERE company_id = $1 AND type = 'expense'", [companyId]);
  const expense = expenseRows[0] as { v: number };
  const { rows: contactsRows } = await db.query("SELECT COUNT(*) as c FROM opc_contacts WHERE company_id = $1", [companyId]);
  const contacts = contactsRows[0] as { c: number };
  const { rows: projectsRows } = await db.query("SELECT COUNT(*) as c FROM opc_projects WHERE company_id = $1", [companyId]);
  const projects = projectsRows[0] as { c: number };
  const { rows: employeesRows } = await db.query("SELECT COUNT(*) as c FROM opc_employees WHERE company_id = $1", [companyId]);
  const employees = employeesRows[0] as { c: number };
  const { rows: contractsRows } = await db.query("SELECT COUNT(*) as c FROM opc_contracts WHERE company_id = $1", [companyId]);
  const contracts = contractsRows[0] as { c: number };

  const { rows: transactions } = await db.query("SELECT * FROM opc_transactions WHERE company_id = $1 ORDER BY transaction_date DESC LIMIT 50", [companyId]);
  const { rows: invoices } = await db.query("SELECT * FROM opc_invoices WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50", [companyId]);
  const { rows: contactsList } = await db.query("SELECT * FROM opc_contacts WHERE company_id = $1 ORDER BY created_at DESC", [companyId]);
  let opportunitiesList: unknown[] = [];
  try {
    const { rows: opportunityRows } = await db.query("SELECT * FROM opc_company_opportunities WHERE company_id = $1 ORDER BY updated_at DESC, created_at DESC", [companyId]);
    opportunitiesList = opportunityRows;
  } catch {
    opportunitiesList = [];
  }
  const { rows: employeesList } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1 ORDER BY name", [companyId]);
  const { rows: projectsList } = await db.query("SELECT * FROM opc_projects WHERE company_id = $1 ORDER BY created_at DESC", [companyId]);
  const { rows: contractsList } = await db.query("SELECT * FROM opc_contracts WHERE company_id = $1 ORDER BY created_at DESC", [companyId]);
  let deliveryOrdersList: unknown[] = [];
  try {
    const { rows: deliveryRows } = await db.query("SELECT * FROM opc_delivery_orders WHERE company_id = $1 ORDER BY updated_at DESC, created_at DESC", [companyId]);
    deliveryOrdersList = deliveryRows;
  } catch {
    deliveryOrdersList = [];
  }
  const { rows: alerts } = await db.query("SELECT * FROM opc_alerts WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10", [companyId]);
  const { rows: todos } = await db.query("SELECT * FROM opc_todos WHERE company_id = $1 ORDER BY created_at DESC LIMIT 20", [companyId]);
  let documents: unknown[] = [];
  try {
    const { rows: documentRows } = await db.query("SELECT * FROM opc_company_documents WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 20", [companyId]);
    documents = documentRows;
  } catch {
    documents = [];
  }

  let staffConfig: unknown[] = [];
  try {
    const { rows: staffRows } = await db.query("SELECT * FROM opc_staff_config WHERE company_id = $1 ORDER BY role", [companyId]);
    staffConfig = staffRows;
  } catch {
    /* table may not exist */
  }

  const incomeVal = Number(income.v) || 0;
  const expenseVal = Number(expense.v) || 0;
  return {
    total_income: incomeVal,
    total_expense: expenseVal,
    net_profit: incomeVal - expenseVal,
    contact_count: Number(contacts.c) || 0,
    project_count: Number(projects.c) || 0,
    employee_count: Number(employees.c) || 0,
    contract_count: Number(contracts.c) || 0,
    transactions,
    invoices,
    contacts: contactsList,
    opportunities: opportunitiesList,
    employees: employeesList,
    projects: projectsList,
    contracts: contractsList,
    delivery_orders: deliveryOrdersList,
    alerts,
    todos,
    documents,
    staffConfig,
  };
}

function buildCompanyOperatingDashboard(
  company: Record<string, unknown>,
  stats: Record<string, unknown>,
): Record<string, unknown> {
  const registrationMode = String(company.registration_mode || "virtual");
  const registrationStage = normalizeRegistrationStage(company.registration_stage, registrationMode);
  const startupStage = normalizeStartupStage(company.startup_stage);
  const firstOrderStage = normalizeFirstOrderStage(company.first_order_stage);

  const contacts = Array.isArray(stats.contacts) ? stats.contacts as Array<Record<string, unknown>> : [];
  const opportunities = Array.isArray(stats.opportunities) ? stats.opportunities as Array<Record<string, unknown>> : [];
  const deliveryOrders = Array.isArray(stats.delivery_orders) ? stats.delivery_orders as Array<Record<string, unknown>> : [];
  const projects = Array.isArray(stats.projects) ? stats.projects as Array<Record<string, unknown>> : [];
  const contracts = Array.isArray(stats.contracts) ? stats.contracts as Array<Record<string, unknown>> : [];
  const invoices = Array.isArray(stats.invoices) ? stats.invoices as Array<Record<string, unknown>> : [];
  const todos = Array.isArray(stats.todos) ? stats.todos as Array<Record<string, unknown>> : [];
  const alerts = Array.isArray(stats.alerts) ? stats.alerts as Array<Record<string, unknown>> : [];
  const documents = Array.isArray(stats.documents) ? stats.documents as Array<Record<string, unknown>> : [];

  const totalIncome = Number(stats.total_income || 0) || 0;
  const totalExpense = Number(stats.total_expense || 0) || 0;
  const activeProjects = projects.filter((item) => ["active", "planning", "in_progress"].includes(String(item.status || ""))).length;
  const activeContracts = contracts.filter((item) => ["active", "pending", "draft"].includes(String(item.status || ""))).length;
  const overdueInvoices = invoices.filter((item) => ["overdue", "issued", "sent"].includes(String(item.status || ""))).length;
  const pendingTodos = todos.filter((item) => !item.completed).length;
  const highPriorityTodos = todos.filter((item) => !item.completed && String(item.priority || "") === "high").length;
  const autopilotAlerts = alerts.filter((item) => String(item.category || "").startsWith("autopilot_"));
  const autopilotTodos = todos.filter((item) => !item.completed && String(item.category || "").startsWith("autopilot_"));
  const weeklyReviewDocs = documents.filter((item) => String(item.doc_type || "") === "weekly_review");
  const leadPool = opportunities.length
    ? opportunities.filter((item) => ["todo", "contacted", "proposal", "quoted", "negotiating"].includes(String(item.stage || ""))).length
    : (contacts.filter((item) => {
      const stage = String(item.pipeline_stage || "").toLowerCase();
      return !stage || /lead|new|contacted|proposal|quoted|negotiating|follow/.test(stage);
    }).length || contacts.length);
  const activeOpportunityCount = opportunities.filter((item) => !["won", "lost"].includes(String(item.stage || ""))).length;
  const wonOpportunityCount = opportunities.filter((item) => String(item.stage || "") === "won").length;
  const activeDeliveryCount = deliveryOrders.filter((item) => !["done", "cancelled"].includes(String(item.delivery_stage || ""))).length;
  const pendingPaymentCount = deliveryOrders.filter((item) => ["pending", "partial"].includes(String(item.payment_status || ""))).length;

  const recentDocumentTitles = documents.slice(0, 3).map((doc) => String(doc.title || "").trim()).filter(Boolean);
  const ownerName = String(company.owner_name || "").trim();
  const industry = String(company.industry || "").trim();
  const description = String(company.description || "").trim();
  const primaryOffer = String(company.core_offer || "").trim() || inferPrimaryOffer(company, recentDocumentTitles);
  const targetCustomers = String(company.target_customer_profile || "").trim() || inferTargetCustomers(company, contracts, contacts);
  const customerPainPoint = String(company.customer_pain_point || "").trim();
  const deliveryModel = String(company.delivery_model || "").trim();
  const revenueStrategy = String(company.revenue_strategy || "").trim();
  const monthlyRevenueTarget = Number(company.monthly_revenue_target || 0) || 0;

  const currentPhase = totalIncome > 0
    ? "回款运营"
    : activeContracts > 0 || firstOrderStage === "won"
      ? "签单交付"
      : activeProjects > 0 || firstOrderStage === "negotiating" || firstOrderStage === "quoting"
        ? "方案成交"
        : "起盘获客";

  let bottleneck = "把线索、方案、成交、交付、回款串成稳定节奏。";
  if (leadPool === 0) bottleneck = "当前缺少有效线索池，先补目标客户名单和触达动作。";
  else if (activeProjects === 0 && activeContracts === 0) bottleneck = "线索有了，但还没转成明确项目和方案。";
  else if (activeContracts === 0 && totalIncome === 0) bottleneck = "项目推进中，但还没有真正形成合同和首笔回款。";
  else if (overdueInvoices > 0) bottleneck = "已经有单，但发票/回款节奏偏弱，现金流风险需要优先控制。";
  else if (pendingTodos > 5) bottleneck = "执行事项偏多但收口不够，建议压缩到本周最关键的 3 件事。";

  let nextFocus = "把主产品、目标客户和 7 天推进节奏固定下来。";
  if (currentPhase === "起盘获客") nextFocus = "补主产品、客户画像和首批 20 个线索名单。";
  if (currentPhase === "方案成交") nextFocus = "把在谈项目推进到报价、决策链和成交节点。";
  if (currentPhase === "签单交付") nextFocus = "锁定交付里程碑、验收物和回款节点。";
  if (currentPhase === "回款运营") nextFocus = "围绕交付复盘、复购和转介绍拉第二增长曲线。";

  const weeklyGoals = [
    {
      label: "线索目标",
      value: Math.max(leadPool + 10, 20),
      unit: "条",
      desc: "确保始终有可触达的客户池，不靠单点运气获客。",
    },
    {
      label: "推进动作",
      value: Math.max(contacts.length * 2, 12),
      unit: "次",
      desc: "每周至少完成一次明确跟进，不让线索长时间沉默。",
    },
    {
      label: "成交推进",
      value: activeProjects > 0 || activeContracts > 0 ? Math.max(activeProjects + activeContracts, 3) : 2,
      unit: "项",
      desc: "至少盯住 2 到 3 个最有概率成交/交付的核心项目。",
    },
    {
      label: "现金目标",
      value: Math.max(Math.round((totalIncome || 0) * 0.3), activeContracts > 0 ? 10000 : 3000),
      unit: "元",
      desc: "经营看现金，不只看签约；每周都要确认回款动作。",
    },
  ];

  const todayActions = [
    {
      title: leadPool === 0 ? "补 10 个首批目标客户" : "筛出最该推进的 3 个客户",
      reason: leadPool === 0 ? "当前线索池偏空，先补客户名单再谈成交。" : "让注意力集中在最可能成交的人和机会。",
      action: "switch_tab",
      target: "contacts",
    },
    {
      title: activeProjects === 0 ? "把意向需求转成项目卡" : "更新项目的下一推进节点",
      reason: activeProjects === 0 ? "没有项目卡，成交就无法被系统持续推进。" : "项目盘必须明确下一步，不然经营会卡在口头推进。",
      action: "switch_tab",
      target: "projects",
    },
    {
      title: totalIncome > 0 ? "复盘已成交项目并设计复购动作" : "生成首单成交方案",
      reason: totalIncome > 0 ? "回款后最值钱的是复购、转介绍和标准化沉淀。" : "当前核心目标还是把第一单真正拿下来。",
      action: "lifecycle",
      target: totalIncome > 0 ? "collection" : "first_order",
    },
  ];
  if (overdueInvoices > 0 || activeContracts > 0) {
    todayActions.push({
      title: "检查发票与回款节点",
      reason: overdueInvoices > 0 ? "已有待收款或逾期票据，现金流风险需要前置处理。" : "签单后要尽快把回款结构设计清楚。",
      action: "switch_tab",
      target: "finance",
    });
  }

  return {
    current_phase: currentPhase,
    current_phase_label: currentPhase,
    registration_mode_label: registrationModeLabel(registrationMode),
    registration_stage_label: registrationStageLabel(registrationStage),
    startup_stage_label: startupStageLabel(startupStage),
    first_order_stage_label: firstOrderStageLabel(firstOrderStage),
    primary_offer: primaryOffer,
    target_customers: targetCustomers,
    bottleneck,
    next_focus: nextFocus,
    weekly_goals: weeklyGoals,
    today_actions: todayActions.slice(0, 4),
    product_strategy: {
      core_offer: primaryOffer,
      target_customer_profile: targetCustomers,
      customer_pain_point: customerPainPoint,
      delivery_model: deliveryModel,
      revenue_strategy: revenueStrategy,
      monthly_revenue_target: monthlyRevenueTarget,
    },
    pipeline: {
      lead_pool: leadPool,
      active_opportunities: activeOpportunityCount,
      won_opportunities: wonOpportunityCount,
      active_projects: activeProjects,
      active_contracts: activeContracts,
      active_delivery_orders: activeDeliveryCount,
      overdue_invoices: overdueInvoices,
      pending_payments: pendingPaymentCount,
      pending_todos: pendingTodos,
      high_priority_todos: highPriorityTodos,
    },
    delivery: {
      project_count: projects.length,
      contract_count: contracts.length,
      delivery_order_count: deliveryOrders.length,
      document_count: documents.length,
      invoice_count: invoices.length,
      total_income: totalIncome,
      total_expense: totalExpense,
    },
    automation: {
      autopilot_alert_count: autopilotAlerts.length,
      autopilot_todo_count: autopilotTodos.length,
      weekly_review_count: weeklyReviewDocs.length,
      sales_alerts: autopilotAlerts.filter((item) => String(item.category || "") === "autopilot_sales").length,
      operations_alerts: autopilotAlerts.filter((item) => String(item.category || "") === "autopilot_operations").length,
      delivery_alerts: autopilotAlerts.filter((item) => String(item.category || "") === "autopilot_delivery").length,
      finance_alerts: autopilotAlerts.filter((item) => String(item.category || "") === "autopilot_finance").length,
      ceo_alerts: autopilotAlerts.filter((item) => String(item.category || "") === "autopilot_ceo").length,
      recent_titles: autopilotAlerts.slice(0, 4).map((item) => String(item.title || "")).filter(Boolean),
    },
    owner_summary: ownerName ? `${ownerName}${industry ? ` · ${industry}` : ""}` : industry,
    alerts_count: alerts.length,
    recent_document_titles: recentDocumentTitles,
    summary:
      `${String(company.name || "当前公司")} 当前处于${currentPhase}阶段，主打${primaryOffer}，重点服务${targetCustomers}。` +
      ` 现在最需要解决的是：${bottleneck}`,
    raw_description: description,
  };
}

function normalizeOpportunityStage(value: string): string {
  const stage = String(value || "").trim().toLowerCase();
  if (["todo", "contacted", "proposal", "quoted", "negotiating", "won", "lost"].includes(stage)) return stage;
  return "todo";
}

function clampOpportunityFitScore(value: unknown): number {
  const score = Number(value || 0) || 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeDeliveryStage(value: string): string {
  const stage = String(value || "").trim().toLowerCase();
  if (["preparing", "in_progress", "waiting_acceptance", "done", "cancelled"].includes(stage)) return stage;
  return "preparing";
}

function normalizeInvoiceStatus(value: string): string {
  const status = String(value || "").trim().toLowerCase();
  if (["not_started", "draft", "issued", "sent", "done"].includes(status)) return status;
  return "not_started";
}

function normalizePaymentStatus(value: string): string {
  const status = String(value || "").trim().toLowerCase();
  if (["pending", "partial", "paid", "overdue"].includes(status)) return status;
  return "pending";
}

function normalizeDeliveryMilestones(value: unknown): Array<Record<string, string>> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = String(value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({ title: line, status: "pending" }));
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => ({
      title: String((item as Record<string, unknown>).title || "").trim(),
      status: ["pending", "doing", "done"].includes(String((item as Record<string, unknown>).status || "pending"))
        ? String((item as Record<string, unknown>).status || "pending")
        : "pending",
    }))
    .filter((item) => item.title);
}

function inferPrimaryOffer(company: Record<string, unknown>, recentDocumentTitles: string[]): string {
  const desc = String(company.description || "").trim();
  if (desc) {
    const firstSentence = desc.split(/[。；;\n]/).map((item) => item.trim()).find(Boolean);
    if (firstSentence) return firstSentence.slice(0, 36);
  }
  const documentHint = recentDocumentTitles.find((title) => /方案|清单|服务|报价|交付/.test(title));
  if (documentHint) return documentHint;
  const industry = String(company.industry || "").trim();
  return industry ? `${industry}服务包` : "标准服务包";
}

function inferTargetCustomers(
  company: Record<string, unknown>,
  contracts: Array<Record<string, unknown>>,
  contacts: Array<Record<string, unknown>>,
): string {
  const firstContract = contracts.find((item) => String(item.counterparty || "").trim());
  if (firstContract) return String(firstContract.counterparty || "").trim();
  const companies = contacts
    .map((item) => String(item.company || item.organization || "").trim())
    .filter(Boolean);
  if (companies[0]) return companies[0];
  const industry = String(company.industry || "").trim();
  return industry ? `${industry}相关客户` : "本地高匹配客户";
}

async function syncCompanyOpportunityBattleStatus(
  db: Db,
  userId: string,
  companyId: string,
  company: Record<string, unknown>,
  stats: Record<string, unknown>,
): Promise<boolean> {
  const firstOrderStage = String(company.first_order_stage || "");
  const startupStage = String(company.startup_stage || "");
  const contractCount = Number(stats.contract_count || 0);
  const totalIncome = Number(stats.total_income || 0);
  const shouldMarkWon = firstOrderStage === "won" || startupStage === "delivering" || contractCount > 0 || totalIncome > 0;
  if (!shouldMarkWon) return false;

  const markers = new Set<string>();
  const addMarkersFromText = (value: unknown) => {
    const text = String(value || "");
    const regex = /\[机会ID:([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[1]) markers.add(match[1]);
    }
  };

  const documents = Array.isArray(stats.documents) ? stats.documents : [];
  const projects = Array.isArray(stats.projects) ? stats.projects : [];
  const todos = Array.isArray(stats.todos) ? stats.todos : [];
  const contacts = Array.isArray(stats.contacts) ? stats.contacts : [];
  const contracts = Array.isArray(stats.contracts) ? stats.contracts : [];
  const invoices = Array.isArray(stats.invoices) ? stats.invoices : [];
  const transactions = Array.isArray(stats.transactions) ? stats.transactions : [];
  documents.forEach((item) => addMarkersFromText((item as Record<string, unknown>).content));
  projects.forEach((item) => {
    addMarkersFromText((item as Record<string, unknown>).document);
    addMarkersFromText((item as Record<string, unknown>).description);
  });
  todos.forEach((item) => addMarkersFromText((item as Record<string, unknown>).description));
  contacts.forEach((item) => addMarkersFromText((item as Record<string, unknown>).notes));
  contracts.forEach((item) => {
    addMarkersFromText((item as Record<string, unknown>).title);
    addMarkersFromText((item as Record<string, unknown>).terms);
    addMarkersFromText((item as Record<string, unknown>).counterparty);
  });
  invoices.forEach((item) => addMarkersFromText((item as Record<string, unknown>).notes));
  transactions.forEach((item) => {
    addMarkersFromText((item as Record<string, unknown>).description);
    addMarkersFromText((item as Record<string, unknown>).counterparty);
  });

  let changed = false;
  const markerCount = markers.size;

  for (const opportunityId of markers) {
    const { rows } = await db.query(
      "SELECT * FROM opc_opportunity_battles WHERE opportunity_id = $1 AND owner_company_id = $2 LIMIT 1",
      [opportunityId, companyId],
    );
    if (!rows[0]) continue;
    const battle = rows[0] as Record<string, unknown>;
    const opportunityAmounts = collectOpportunityCommercialAmounts(opportunityId, {
      projects,
      contracts,
      invoices,
      transactions,
      markerCount,
      totalIncome,
    });
    const currentQuoteAmount = String(battle.quote_amount || "").trim();
    const normalizedExistingQuote = parseNumericText(currentQuoteAmount);
    const normalizedOpportunityAmount = opportunityAmounts.quoteAmount > 0
      ? formatOpportunityAmount(opportunityAmounts.quoteAmount)
      : currentQuoteAmount;
    const nextFollowStatus = totalIncome > 0 || contractCount > 0 || firstOrderStage === "won" ? "won" : String(battle.follow_status || "");
    const nextMonetizationStage = opportunityAmounts.dealAmount > 0 || totalIncome > 0 ? "deal" : String(battle.monetization_stage || "match");
    const nextNotes = mergeNotes(String(battle.notes || ""), totalIncome > 0
      ? "系统同步：公司侧已出现收入，机会自动推进为已成交/已回款阶段。"
      : "系统同步：公司侧已进入成交或交付阶段，机会自动推进为已成交。");
    if (
      nextFollowStatus === String(battle.follow_status || "") &&
      nextMonetizationStage === String(battle.monetization_stage || "") &&
      nextNotes === String(battle.notes || "") &&
      normalizedOpportunityAmount === currentQuoteAmount
    ) {
      continue;
    }
    await db.query(
      `UPDATE opc_opportunity_battles
       SET follow_status = $1,
           monetization_stage = $2,
           quote_amount = $3,
           notes = $4,
           updated_by_user_id = $5,
           updated_at = NOW()
       WHERE opportunity_id = $6 AND owner_company_id = $7`,
      [nextFollowStatus, nextMonetizationStage, normalizedOpportunityAmount, nextNotes, userId, opportunityId, companyId],
    );
    changed = true;
  }

  return changed;
}

function mergeNotes(existing: string, extra: string): string {
  const parts = [String(existing || "").trim(), String(extra || "").trim()].filter(Boolean);
  return parts.filter((line, idx) => parts.indexOf(line) === idx).join("\n");
}

function collectOpportunityCommercialAmounts(
  opportunityId: string,
  input: {
    projects: unknown[];
    contracts: unknown[];
    invoices: unknown[];
    transactions: unknown[];
    markerCount: number;
    totalIncome: number;
  },
): { quoteAmount: number; dealAmount: number } {
  const byMarker = (value: unknown) => String(value || "").includes(`[机会ID:${opportunityId}]`);
  let projectBudget = 0;
  let contractValue = 0;
  let invoiceAmount = 0;
  let incomeAmount = 0;

  input.projects.forEach((item) => {
    const row = item as Record<string, unknown>;
    if (byMarker(row.document) || byMarker(row.description)) {
      projectBudget += Number(row.budget || 0) || 0;
    }
  });
  input.contracts.forEach((item) => {
    const row = item as Record<string, unknown>;
    if (byMarker(row.title) || byMarker(row.terms) || byMarker(row.counterparty)) {
      contractValue += Number(row.value || 0) || 0;
    }
  });
  input.invoices.forEach((item) => {
    const row = item as Record<string, unknown>;
    if (byMarker(row.notes)) {
      invoiceAmount += Number(row.amount || 0) || 0;
    }
  });
  input.transactions.forEach((item) => {
    const row = item as Record<string, unknown>;
    if (String(row.type || "") === "income" && (byMarker(row.description) || byMarker(row.counterparty))) {
      incomeAmount += Number(row.amount || 0) || 0;
    }
  });

  const quoteAmount = Math.max(projectBudget, contractValue, invoiceAmount, incomeAmount, 0);
  const dealAmount = Math.max(contractValue, invoiceAmount, incomeAmount, 0);
  if (quoteAmount > 0 || dealAmount > 0) {
    return { quoteAmount, dealAmount };
  }
  if (input.markerCount === 1 && input.totalIncome > 0) {
    return { quoteAmount: input.totalIncome, dealAmount: input.totalIncome };
  }
  return { quoteAmount: 0, dealAmount: 0 };
}

function parseNumericText(value: string): number {
  const match = String(value || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) || 0 : 0;
}

function formatOpportunityAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(2).replace(/\.?0+$/, "");
}

function buildLifecycleTodoPack(company: Record<string, unknown>) {
  const registrationMode = String(company.registration_mode || "virtual");
  const registrationStage = normalizeRegistrationStage(company.registration_stage, registrationMode);
  const startupStage = normalizeStartupStage(company.startup_stage);
  const firstOrderStage = normalizeFirstOrderStage(company.first_order_stage);

  const today = new Date();
  function due(offsetDays: number) {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  const tasks: Array<{ title: string; priority: string; due_date: string; description: string }> = [];

  if (registrationMode !== "virtual" && registrationStage !== "registered") {
    tasks.push({
      title: "梳理公司注册办理清单",
      priority: "high",
      due_date: due(1),
      description: "把名称核准、注册地址、经营范围、刻章、银行开户、税务报到按顺序列清楚，并确认当前卡点。",
    });
  }

  if (startupStage === "setup") {
    tasks.push({
      title: "明确首个服务包和目标客户",
      priority: "high",
      due_date: due(1),
      description: "确定卖什么、卖给谁、交付边界是什么，形成可报价的一页纸服务包。",
    });
  }

  if (startupStage === "offer_ready") {
    tasks.push({
      title: "输出标准报价和成交话术",
      priority: "medium",
      due_date: due(2),
      description: "把报价结构、常见异议、首轮沟通话术写成可复用模板，避免每次临时发挥。",
    });
  }

  if (startupStage === "acquiring" || firstOrderStage === "not_started" || firstOrderStage === "prospecting") {
    tasks.push({
      title: "建立 20 个首批线索名单",
      priority: "high",
      due_date: due(2),
      description: "先拉一批可触达客户名单，包含联系人、来源、切入点和首轮联系动作。",
    });
  }

  if (firstOrderStage === "quoting" || firstOrderStage === "negotiating") {
    tasks.push({
      title: "推进在手报价到成交",
      priority: "high",
      due_date: due(1),
      description: "确认决策链、报价边界、可让步空间和下一次推进节点，避免报价后失联。",
    });
  }

  if (firstOrderStage === "won" || startupStage === "delivering") {
    tasks.push({
      title: "补齐交付与回款计划",
      priority: "high",
      due_date: due(1),
      description: "明确里程碑、验收物、开票节点、收款节点和催款动作，防止只成交不回款。",
    });
  }

  if (tasks.length === 0) {
    tasks.push({
      title: "复盘当前经营阶段并确定下一步",
      priority: "medium",
      due_date: due(2),
      description: "结合注册、起盘、成交、交付状态，确认本周最重要的 1 到 3 个动作。",
    });
  }

  return tasks;
}

function buildLifecycleDocPack(company: Record<string, unknown>) {
  const companyName = String(company.name || "这家公司");
  const registrationMode = String(company.registration_mode || "virtual");
  const registrationStage = normalizeRegistrationStage(company.registration_stage, registrationMode);
  const startupStage = normalizeStartupStage(company.startup_stage);
  const firstOrderStage = normalizeFirstOrderStage(company.first_order_stage);
  const registrationModeText = registrationModeLabel(registrationMode);
  const registrationStageText = registrationStageLabel(registrationStage);
  const startupStageText = startupStageLabel(startupStage);
  const firstOrderStageText = firstOrderStageLabel(firstOrderStage);

  return [
    {
      doc_type: "registration_checklist",
      title: `${companyName} · 线下注册办理清单`,
      source: "lifecycle_template",
      content:
        `# ${companyName} 线下注册办理清单\n\n` +
        `## 当前判断\n` +
        `- 当前经营模式：${registrationModeText}\n` +
        `- 当前注册阶段：${registrationStageText}\n` +
        `- 目标：把“是否注册、何时注册、先做什么”说清楚，避免边做边乱。\n\n` +
        `## 办理顺序\n` +
        `1. 明确公司名称、经营范围、注册地址。\n` +
        `2. 准备法人/股东/监事等基础材料。\n` +
        `3. 办理营业执照。\n` +
        `4. 刻章、银行开户、税务报到。\n` +
        `5. 建立发票、开票、回款的基本流程。\n\n` +
        `## 本周最该先做的事\n` +
        `- 如果当前还不准备真实注册，就先做服务包和获客动作。\n` +
        `- 如果已经准备真实注册，就优先补齐名称、地址、经营范围和材料清单。\n`,
    },
    {
      doc_type: "first_order_plan",
      title: `${companyName} · 第一单行动方案`,
      source: "lifecycle_template",
      content:
        `# ${companyName} 第一单行动方案\n\n` +
        `## 当前阶段\n` +
        `- 起盘阶段：${startupStageText}\n` +
        `- 第一单阶段：${firstOrderStageText}\n\n` +
        `## 方案结构\n` +
        `1. 明确首个可售服务包。\n` +
        `2. 选定最容易成交的一类客户。\n` +
        `3. 做出标准报价和交付边界。\n` +
        `4. 列出 20 个首批线索名单。\n` +
        `5. 设计 7 天推进节奏。\n\n` +
        `## 重点提醒\n` +
        `- 第一单不要追求大而全，先追求能成交、能交付、能回款。\n` +
        `- 先把成交路径跑通，再逐步扩产品和扩客群。\n`,
    },
    {
      doc_type: "delivery_plan",
      title: `${companyName} · 交付启动方案`,
      source: "lifecycle_template",
      content:
        `# ${companyName} 交付启动方案\n\n` +
        `## 目标\n` +
        `把成交后的项目快速拉进可控交付状态，避免只会签单不会履约。\n\n` +
        `## 启动清单\n` +
        `1. 写清交付范围和不交付范围。\n` +
        `2. 确认里程碑、责任人、验收物。\n` +
        `3. 明确与甲方的沟通节奏。\n` +
        `4. 提前识别风险和补救动作。\n\n` +
        `## 交付原则\n` +
        `- 所有承诺都要形成书面记录。\n` +
        `- 验收物和节点要前置，不要做到最后再补。\n`,
    },
    {
      doc_type: "collection_plan",
      title: `${companyName} · 回款设计方案`,
      source: "lifecycle_template",
      content:
        `# ${companyName} 回款设计方案\n\n` +
        `## 目标\n` +
        `让项目从一开始就带着回款设计推进，而不是做完再想怎么收钱。\n\n` +
        `## 回款结构\n` +
        `1. 首付款节点。\n` +
        `2. 中期里程碑付款节点。\n` +
        `3. 验收后尾款节点。\n` +
        `4. 开票节奏和催款动作。\n\n` +
        `## 风险提醒\n` +
        `- 没有节点就没有催款依据。\n` +
        `- 没有验收物就很难催尾款。\n` +
        `- 没有现金流预案，项目越多越危险。\n`,
    },
  ];
}

function normalizeRegistrationStage(value: unknown, registrationMode: string): string {
  const raw = String(value || "").trim();
  if (!raw || raw === "not_started") {
    return registrationMode === "virtual" ? "simulated" : "preparing";
  }
  return raw;
}

function normalizeStartupStage(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw || raw === "idea") return "setup";
  return raw;
}

function normalizeFirstOrderStage(value: unknown): string {
  return String(value || "").trim() || "not_started";
}

function registrationModeLabel(value: string): string {
  return value === "virtual" ? "先模拟运营" : value === "hybrid" ? "边跑业务边注册" : "准备真实注册";
}

function registrationStageLabel(value: string): string {
  return ({
    simulated: "模拟经营",
    preparing: "准备材料",
    filing: "办理中",
    registered: "已拿执照",
  } as Record<string, string>)[value] || value || "-";
}

function startupStageLabel(value: string): string {
  return ({
    setup: "定位/搭班子",
    offer_ready: "服务包成型",
    acquiring: "开始获客",
    delivering: "已在交付",
  } as Record<string, string>)[value] || value || "-";
}

function firstOrderStageLabel(value: string): string {
  return ({
    not_started: "还没开始",
    prospecting: "找线索",
    quoting: "报价沟通",
    negotiating: "推动成交",
    won: "已成交",
  } as Record<string, string>)[value] || value || "-";
}
