/**
 * 新模块 API — canvas / compass / monitor / channels / tools / closure
 * PostgreSQL (pg.Pool) 版本
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAdmin, requireAuth, parseBody } from "../auth/middleware.js";
import { SKILLS_CATALOG } from "../chat/skills-catalog.js";
import { callAi, getModel } from "../chat/ai-client.js";

const ROLE_LEVELS: Record<string, number> = { owner: 3, admin: 2, member: 1 };

async function checkAccess(db: Db, userId: string, companyId: string, requiredRole: string = "member"): Promise<boolean> {
  const { rows } = await db.query("SELECT role FROM opc_user_companies WHERE user_id = $1 AND company_id = $2", [userId, companyId]);
  if (!rows[0]) return false;
  const role = (rows[0] as any).role || "member";
  return (ROLE_LEVELS[role] || 0) >= (ROLE_LEVELS[requiredRole] || 0);
}

async function getStaffRow(db: Db, staffId: string): Promise<any | null> {
  const { rows } = await db.query("SELECT * FROM opc_staff_config WHERE id = $1", [staffId]);
  return rows[0] || null;
}

async function ensureStaffAccess(req: AuthRequest, res: ServerResponse, db: Db, staffId: string, requiredRole: string = "admin"): Promise<any | null> {
  const staff = await getStaffRow(db, staffId);
  if (!staff) {
    sendJson(res, 404, { error: "Not found" });
    return null;
  }
  if (!(await checkAccess(db, req.user!.userId, String(staff.company_id || ""), requiredRole))) {
    sendJson(res, 403, { error: requiredRole === "admin" ? "需要管理员以上权限" : "无权访问" });
    return null;
  }
  return staff;
}

// ─── OPB Canvas ───────────────────────────────────────────────────────

export async function handleGetCanvas(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid))) { sendJson(res, 403, { error: "无权访问" }); return; }
  let { rows } = await db.query("SELECT * FROM opc_canvas WHERE company_id = $1", [cid]);
  if (rows.length === 0) {
    const id = uuid();
    await db.query("INSERT INTO opc_canvas (id, company_id) VALUES ($1, $2)", [id, cid]);
    ({ rows } = await db.query("SELECT * FROM opc_canvas WHERE company_id = $1", [cid]));
  }
  sendJson(res, 200, { canvas: rows[0] });
}

export async function handleUpdateCanvas(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid, "admin"))) { sendJson(res, 403, { error: "需要管理员以上权限" }); return; }
  const body = await parseBody(req);
  const fields = ["track", "target_customer", "pain_point", "solution", "unique_value", "channels", "revenue_model", "cost_structure", "key_resources", "key_activities", "key_partners", "unfair_advantage", "metrics", "non_compete", "scaling_strategy", "notes"];
  const { rows: existRows } = await db.query("SELECT id FROM opc_canvas WHERE company_id = $1", [cid]);
  if (existRows.length === 0) {
    const id = uuid();
    await db.query("INSERT INTO opc_canvas (id, company_id) VALUES ($1, $2)", [id, cid]);
  }
  const sets: string[] = []; const vals: unknown[] = [];
  let idx = 1;
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(String(body[f])); }
  }
  if (sets.length > 0) {
    sets.push(`updated_at = NOW()`);
    vals.push(cid);
    await db.query(`UPDATE opc_canvas SET ${sets.join(",")} WHERE company_id = $${idx}`, vals);
  }
  const { rows } = await db.query("SELECT * FROM opc_canvas WHERE company_id = $1", [cid]);
  sendJson(res, 200, { canvas: rows[0] });
}

// ─── Compass (5P + Biz Models) ────────────────────────────────────────

export async function handleGetCompass(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid))) { sendJson(res, 403, { error: "无权访问" }); return; }
  let { rows } = await db.query("SELECT * FROM opc_compass WHERE company_id = $1", [cid]);
  if (rows.length === 0) {
    await db.query("INSERT INTO opc_compass (id, company_id) VALUES ($1, $2)", [uuid(), cid]);
    ({ rows } = await db.query("SELECT * FROM opc_compass WHERE company_id = $1", [cid]));
  }
  const { rows: models } = await db.query("SELECT * FROM opc_biz_models WHERE company_id = $1 ORDER BY excitement DESC", [cid]);
  sendJson(res, 200, { compass: rows[0], models });
}

export async function handleUpdateCompass(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid, "admin"))) { sendJson(res, 403, { error: "需要管理员以上权限" }); return; }
  const body = await parseBody(req);
  const { rows: existRows } = await db.query("SELECT id FROM opc_compass WHERE company_id = $1", [cid]);
  if (existRows.length === 0) {
    await db.query("INSERT INTO opc_compass (id, company_id) VALUES ($1, $2)", [uuid(), cid]);
  }
  const fields = ["passions", "positions", "possessions", "powers", "potentials", "summary"];
  const sets: string[] = []; const vals: unknown[] = [];
  let idx = 1;
  for (const f of fields) {
    if (body[f] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(String(body[f])); }
  }
  if (sets.length > 0) {
    sets.push(`updated_at = NOW()`);
    vals.push(cid);
    await db.query(`UPDATE opc_compass SET ${sets.join(",")} WHERE company_id = $${idx}`, vals);
  }
  const { rows } = await db.query("SELECT * FROM opc_compass WHERE company_id = $1", [cid]);
  sendJson(res, 200, { compass: rows[0] });
}

export async function handleAddBizModel(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid, "admin"))) { sendJson(res, 403, { error: "需要管理员以上权限" }); return; }
  const body = await parseBody(req);
  const id = uuid();
  await db.query(
    "INSERT INTO opc_biz_models (id,company_id,name,who,problem,solution,revenue_method,excitement,fit_score,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [id, cid, s(body.name), s(body.who), s(body.problem), s(body.solution), s(body.revenue_method), n(body.excitement, 3), n(body.fit_score, 3), s(body.status, "idea"), s(body.source)]
  );
  const { rows } = await db.query("SELECT * FROM opc_biz_models WHERE id = $1", [id]);
  sendJson(res, 201, { model: rows[0] });
}

export async function handleDeleteBizModel(req: AuthRequest, res: ServerResponse, db: Db, modelId: string) {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query("SELECT company_id FROM opc_biz_models WHERE id = $1", [modelId]);
  if (!rows[0]) { sendJson(res, 404, { error: "记录不存在" }); return; }
  if (!(await checkAccess(db, req.user!.userId, String((rows[0] as any).company_id || ""), "admin"))) {
    sendJson(res, 403, { error: "需要管理员以上权限" });
    return;
  }
  await db.query("DELETE FROM opc_biz_models WHERE id = $1", [modelId]);
  sendJson(res, 200, { success: true });
}

// ─── Opportunity Battle State ────────────────────────────────────────

export async function handleListOpportunityBattles(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(`
    SELECT
      opportunity_id,
      stage,
      follow_status,
      monetization_stage,
      commercial_package,
      quote_amount,
      owner_company_id,
      owner_company_name,
      owner_person,
      assignment_role,
      recommended_by,
      notes,
      updated_by_user_id,
      created_at,
      updated_at
    FROM opc_opportunity_battles
    ORDER BY updated_at DESC
  `, []);
  sendJson(res, 200, { battles: rows });
}

export async function handleUpsertOpportunityBattle(req: AuthRequest, res: ServerResponse, db: Db, opportunityId: string) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const patch = normalizeOpportunityBattlePatch(body);
  const { rows: existingRows } = await db.query("SELECT * FROM opc_opportunity_battles WHERE opportunity_id = $1 LIMIT 1", [opportunityId]);
  const existing = existingRows[0] as Record<string, unknown> | undefined;
  const currentOwnerCompanyId = String(existing?.owner_company_id || "");
  const nextOwnerCompanyId = String(patch.owner_company_id || currentOwnerCompanyId || "");

  if (currentOwnerCompanyId && currentOwnerCompanyId !== nextOwnerCompanyId) {
    if (!(await checkAccess(db, req.user!.userId, currentOwnerCompanyId, "admin"))) {
      sendJson(res, 403, { error: "无权修改该机会的归属公司" });
      return;
    }
  }
  if (patch.owner_company_id) {
    if (!(await checkAccess(db, req.user!.userId, patch.owner_company_id, "admin"))) {
      sendJson(res, 403, { error: "需要目标公司的管理员以上权限" });
      return;
    }
  } else if (currentOwnerCompanyId) {
    if (!(await checkAccess(db, req.user!.userId, currentOwnerCompanyId, "member"))) {
      sendJson(res, 403, { error: "无权修改该机会状态" });
      return;
    }
  }

  await saveOpportunityBattle(db, req.user!.userId, opportunityId, patch);
  const { rows } = await db.query("SELECT * FROM opc_opportunity_battles WHERE opportunity_id = $1", [opportunityId]);
  sendJson(res, 200, { battle: rows[0] || null });
}

export async function handleCreateOpportunityExecutionPack(req: AuthRequest, res: ServerResponse, db: Db, opportunityId: string) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const { rows: oppRows } = await db.query(`
    SELECT id, title, source_type, date, category, type, target_org, target_orgs, address, budget, money,
           summary, services, fit_profiles, stage_tag, entry_focus, next_actions, priority_label, priority_text,
           source_url, url, opportunity_kind, business_stage, commercial_strength, structured_brief, province, city, county
    FROM opc_intel_opportunities
    WHERE id = $1
    LIMIT 1
  `, [opportunityId]);
  if (!oppRows[0]) { sendJson(res, 404, { error: "机会不存在" }); return; }

  const { rows: battleRows } = await db.query("SELECT * FROM opc_opportunity_battles WHERE opportunity_id = $1 LIMIT 1", [opportunityId]);
  const battleRow = battleRows[0] as any || {};
  const companyId = s(body.companyId || body.company_id || battleRow.owner_company_id);
  if (!companyId) { sendJson(res, 400, { error: "请先指派一个跟进公司，再生成执行包" }); return; }
  if (!(await checkAccess(db, req.user!.userId, companyId, "admin"))) { sendJson(res, 403, { error: "需要该公司的管理员以上权限" }); return; }

  const { rows: companyRows } = await db.query("SELECT id, name, owner_name, industry FROM opc_companies WHERE id = $1 LIMIT 1", [companyId]);
  const company = companyRows[0] as any;
  if (!company) { sendJson(res, 404, { error: "跟进公司不存在" }); return; }

  const row = oppRows[0] as any;
  const item = {
    id: row.id,
    title: row.title || "",
    sourceType: row.source_type || "",
    date: row.date || "",
    category: row.category || "",
    type: row.type || "",
    targetOrg: row.target_org || "",
    targetOrgs: safeParseJsonArray(row.target_orgs),
    address: row.address || "",
    budget: row.budget || "",
    money: safeParseJsonArray(row.money),
    summary: row.summary || "",
    services: safeParseJsonArray(row.services),
    fitProfiles: safeParseJsonArray(row.fit_profiles),
    stageTag: row.stage_tag || "",
    entryFocus: row.entry_focus || "",
    nextActions: safeParseJsonArray(row.next_actions),
    priorityLabel: row.priority_label || "",
    priorityText: row.priority_text || "",
    sourceUrl: row.source_url || row.url || "",
    opportunityKind: row.opportunity_kind || "",
    businessStage: row.business_stage || "",
    commercialStrength: row.commercial_strength || "",
    structuredBrief: row.structured_brief || "",
    province: row.province || "",
    city: row.city || "",
    county: row.county || "",
  };

  const marker = `[机会ID:${opportunityId}]`;
  const amount = parseOpportunityAmount(row.budget || row.money || "");
  const contactName = item.targetOrg || item.targetOrgs[0] || `${item.title} 甲方`;
  const followUpDate = addDaysIso(1);
  const projectName = `${item.title || "机会"} 跟进项目`;
  const document = buildOpportunityExecutionDocument(item, company.name, marker);
  const todoTemplates = buildOpportunityExecutionTodos(item, company.name);
  const shouldBuildPostDealPack = Boolean(body.postDealPack || body.post_deal_pack || battleRow.follow_status === "won");
  const postDealTodos = shouldBuildPostDealPack ? buildOpportunityPostDealTodos(item, company.name) : [];

  let contact = null;
  let project = null;
  let createdTodos = 0;
  let reusedTodos = 0;
  let companyDoc = null;
  let postDealCreated = 0;
  let postDealReused = 0;
  let postDealDocsCreated = 0;
  let postDealDocsUpdated = 0;

  const { rows: existingContacts } = await db.query(
    "SELECT * FROM opc_contacts WHERE company_id = $1 AND source = 'opportunity_map' AND notes LIKE $2 ORDER BY created_at DESC LIMIT 1",
    [companyId, `%${marker}%`],
  );
  if (existingContacts[0]) {
    contact = existingContacts[0];
  } else {
    const contactId = uuid();
    await db.query(
      "INSERT INTO opc_contacts (id,company_id,name,email,phone,company,role,source,pipeline_stage,deal_value,follow_up_date,notes,created_at) VALUES ($1,$2,$3,'','',$4,$5,'opportunity_map',$6,$7,$8,$9,NOW())",
      [contactId, companyId, contactName, item.targetOrg || contactName, "潜在甲方", mapBattleToPipelineStage(battleRow.follow_status), amount, followUpDate, buildOpportunityContactNotes(item, marker)],
    );
    const { rows } = await db.query("SELECT * FROM opc_contacts WHERE id = $1", [contactId]);
    contact = rows[0] || null;
  }

  const { rows: existingProjects } = await db.query(
    "SELECT * FROM opc_projects WHERE company_id = $1 AND document LIKE $2 ORDER BY created_at DESC LIMIT 1",
    [companyId, `%${marker}%`],
  );
  if (existingProjects[0]) {
    project = existingProjects[0];
  } else {
    const projectId = uuid();
    await db.query(
      "INSERT INTO opc_projects (id,company_id,name,description,status,budget,spent,start_date,end_date,document,created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,'',$8,NOW())",
      [projectId, companyId, projectName, item.summary || item.structuredBrief || item.entryFocus || "机会转执行项目", "planning", amount, new Date().toISOString().slice(0, 10), document],
    );
    const { rows } = await db.query("SELECT * FROM opc_projects WHERE id = $1", [projectId]);
    project = rows[0] || null;
  }

  for (const todo of todoTemplates) {
    const { rows: existingTodoRows } = await db.query(
      "SELECT id FROM opc_todos WHERE company_id = $1 AND title = $2 AND description LIKE $3 LIMIT 1",
      [companyId, todo.title, `%${marker}%`],
    );
    if (existingTodoRows[0]) {
      reusedTodos += 1;
      continue;
    }
    await db.query(
      "INSERT INTO opc_todos (id,company_id,title,priority,category,due_date,description,completed,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,0,NOW())",
      [uuid(), companyId, todo.title, todo.priority, "opportunity_execution", todo.dueDate, `${todo.description}\n${marker}`],
    );
    createdTodos += 1;
  }

  if (shouldBuildPostDealPack) {
    for (const todo of postDealTodos) {
      const { rows: existingTodoRows } = await db.query(
        "SELECT id FROM opc_todos WHERE company_id = $1 AND title = $2 AND description LIKE $3 LIMIT 1",
        [companyId, todo.title, `%${marker}%`],
      );
      if (existingTodoRows[0]) {
        postDealReused += 1;
        continue;
      }
      await db.query(
        "INSERT INTO opc_todos (id,company_id,title,priority,category,due_date,description,completed,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,0,NOW())",
        [uuid(), companyId, todo.title, todo.priority, "post_deal_execution", todo.dueDate, `${todo.description}\n${marker}`],
      );
      postDealCreated += 1;
    }
  }

  try {
    const executionDocTitle = `${item.title || "机会"} · 跟进作战单`;
    const executionDocContent = buildOpportunityCompanyDoc(item, company.name, marker);
    const { rows: existingDocRows } = await db.query(
      "SELECT * FROM opc_company_documents WHERE company_id = $1 AND doc_type = 'opportunity_execution' AND content LIKE $2 ORDER BY updated_at DESC LIMIT 1",
      [companyId, `%${marker}%`],
    );
    if (existingDocRows[0]) {
      await db.query(
        "UPDATE opc_company_documents SET title = $1, content = $2, source = 'opportunity_execution', updated_at = NOW() WHERE id = $3",
        [executionDocTitle, executionDocContent, (existingDocRows[0] as { id: string }).id],
      );
      const { rows } = await db.query("SELECT * FROM opc_company_documents WHERE id = $1", [(existingDocRows[0] as { id: string }).id]);
      companyDoc = rows[0] || null;
    } else {
      const documentId = uuid();
      await db.query(
        "INSERT INTO opc_company_documents (id, company_id, doc_type, title, content, source, created_at, updated_at) VALUES ($1,$2,'opportunity_execution',$3,$4,'opportunity_execution',NOW(),NOW())",
        [documentId, companyId, executionDocTitle, executionDocContent],
      );
      const { rows } = await db.query("SELECT * FROM opc_company_documents WHERE id = $1", [documentId]);
      companyDoc = rows[0] || null;
    }
  } catch {
    companyDoc = null;
  }

  if (shouldBuildPostDealPack) {
    const postDealDocs = buildOpportunityPostDealDocs(item, company.name, marker);
    for (const doc of postDealDocs) {
      const { rows: existingDocRows } = await db.query(
        "SELECT id FROM opc_company_documents WHERE company_id = $1 AND doc_type = $2 AND content LIKE $3 LIMIT 1",
        [companyId, doc.doc_type, `%${marker}%`],
      );
      if (existingDocRows[0]) {
        await db.query(
          "UPDATE opc_company_documents SET title = $1, content = $2, source = $3, updated_at = NOW() WHERE id = $4",
          [doc.title, doc.content, doc.source, (existingDocRows[0] as { id: string }).id],
        );
        postDealDocsUpdated += 1;
        continue;
      }
      await db.query(
        "INSERT INTO opc_company_documents (id, company_id, doc_type, title, content, source, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())",
        [uuid(), companyId, doc.doc_type, doc.title, doc.content, doc.source],
      );
      postDealDocsCreated += 1;
    }

    await db.query(
      `UPDATE opc_companies
       SET startup_stage = CASE WHEN startup_stage IN ('', 'idea', 'setup', 'offer_ready', 'acquiring') THEN 'delivering' ELSE startup_stage END,
           first_order_stage = CASE WHEN first_order_stage IN ('', 'not_started', 'prospecting', 'quoting', 'negotiating') THEN 'won' ELSE first_order_stage END,
           updated_at = NOW()
       WHERE id = $1`,
      [companyId],
    );

    if (project) {
      await db.query("UPDATE opc_projects SET status = CASE WHEN status IN ('planning', '') THEN 'active' ELSE status END WHERE id = $1", [String((project as { id?: string }).id || "")]);
      const { rows } = await db.query("SELECT * FROM opc_projects WHERE id = $1", [String((project as { id?: string }).id || "")]);
      project = rows[0] || project;
    }
  }

  const mergedNotes = mergeBattleNotes(s(battleRow.notes), [
    `已生成执行包：客户线索${contact ? "已就位" : "未生成"}、项目${project ? "已就位" : "未生成"}、待办新增 ${createdTodos} 条、经营文档${companyDoc ? "已沉淀" : "未生成"}。`,
    shouldBuildPostDealPack ? `已补齐成交后动作：交付/回款/复购待办新增 ${postDealCreated} 条，文档新增 ${postDealDocsCreated} 份。` : "",
    item.entryFocus ? `切入点：${item.entryFocus}` : "",
    item.nextActions[0] ? `首个动作：${item.nextActions[0]}` : "",
  ]);
  const battle = await saveOpportunityBattle(db, req.user!.userId, opportunityId, {
    stage: battleRow.stage || "contact",
    follow_status: shouldBuildPostDealPack ? "won" : (battleRow.follow_status || "todo"),
    monetization_stage: shouldBuildPostDealPack ? "deal" : (battleRow.monetization_stage || inferMonetizationStage(item.opportunityKind)),
    commercial_package: battleRow.commercial_package || inferCommercialPackage(item.opportunityKind),
    quote_amount: battleRow.quote_amount || (amount > 0 ? String(Math.round(amount)) : s(row.budget)),
    owner_company_id: company.id,
    owner_company_name: company.name,
    owner_person: battleRow.owner_person || company.owner_name || "",
    assignment_role: battleRow.assignment_role || "主跟进",
    recommended_by: battleRow.recommended_by || "execution_pack",
    notes: mergedNotes,
  });

  sendJson(res, 200, {
    success: true,
    execution: {
      company: { id: company.id, name: company.name, owner_name: company.owner_name || "", industry: company.industry || "" },
      contact: contact ? { id: contact.id, name: contact.name, company: contact.company, pipeline_stage: contact.pipeline_stage } : null,
      project: project ? { id: project.id, name: project.name, status: project.status, budget: project.budget } : null,
      todos: { created: createdTodos, reused: reusedTodos, total: todoTemplates.length },
      post_deal_todos: { created: postDealCreated, reused: postDealReused, total: postDealTodos.length },
      post_deal_docs: { created: postDealDocsCreated, updated: postDealDocsUpdated, total: shouldBuildPostDealPack ? 3 : 0 },
      document: companyDoc ? { id: companyDoc.id, title: companyDoc.title, doc_type: companyDoc.doc_type } : null,
      marker,
      generated_at: new Date().toISOString(),
    },
    battle,
  });
}

function tokenizeMerchantText(text: unknown): string {
  return String(text || "").toLowerCase();
}

function getPrimaryMerchantNeedFromOpportunity(item: any): string {
  const profiles = Array.isArray(item?.fitProfiles) ? item.fitProfiles : [];
  if (profiles.includes("工程建设商家")) return "工程建设";
  if (profiles.includes("医疗设备与信息化商家")) return "医疗服务";
  if (profiles.includes("农业服务与农资商家")) return "农业服务";
  if (profiles.includes("教育集采与校园服务商家")) return "教育采购";
  if (profiles.includes("产业服务与数字化商家")) return "产业服务";
  if (profiles.includes("资源开发与资质服务商家")) return "资源开发";
  return "综合服务";
}

function normalizeRegionText(value: unknown): string {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function scoreMerchantLocation(company: any, item: any): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const province = normalizeRegionText(item.province);
  const city = normalizeRegionText(item.city);
  const county = normalizeRegionText(item.county);
  const companyRegion = normalizeRegionText([
    company.city_name,
    company.region,
    company.city_address,
    company.description,
  ].join(" "));
  if (!companyRegion) return { score, reasons };
  if (province && companyRegion.includes(province)) {
    score += 2;
    reasons.push("区域命中同省");
  }
  if (city && companyRegion.includes(city)) {
    score += 4;
    reasons.push("区域命中同市");
  }
  if (county && companyRegion.includes(county)) {
    score += 5;
    reasons.push("区域命中同区县");
  }
  return { score, reasons };
}

function buildMerchantMatches(companies: any[], item: any, battle?: any) {
  const haystack = tokenizeMerchantText([item.title, item.name, item.type, item.category, item.summary, (item.services || []).join(" ")].join(" "));
  const groups = [
    { label: "工程建设", words: ["工程", "施工", "监理", "材料", "基建", "交通", "枢纽"] },
    { label: "医疗服务", words: ["医疗", "医院", "卫生", "设备", "维保"] },
    { label: "农业服务", words: ["农业", "农田", "农机", "地膜", "测绘", "设计"] },
    { label: "教育采购", words: ["教育", "学校", "作业本", "印刷", "校园"] },
    { label: "产业服务", words: ["产业", "招商", "数字化", "供应链", "渠道", "新材料", "竹"] },
    { label: "资源开发", words: ["矿", "采砂", "采矿", "出让", "拍卖", "挂牌"] },
  ];
  const primaryNeed = getPrimaryMerchantNeedFromOpportunity(item);
  const hitGroups = groups.filter((group) => group.words.some((word) => haystack.includes(word)));
  const matches = companies.map((company) => {
    const companyText = tokenizeMerchantText([company.name, company.industry, company.description, company.owner_name].join(" "));
    let score = 0;
    const reasons: string[] = [];
    let role = "协同跟进";
    hitGroups.forEach((group) => {
      if (group.words.some((word) => companyText.includes(word))) {
        score += 4;
        reasons.push(`匹配“${group.label}”能力`);
        if (group.label === primaryNeed) score += 5;
      }
    });
    (Array.isArray(item.services) ? item.services : []).forEach((service: string) => {
      const key = tokenizeMerchantText(service);
      if (key && companyText.includes(key)) {
        score += 3;
        reasons.push(`服务项包含“${service}”`);
      }
    });
    if (item.type && companyText.includes(tokenizeMerchantText(item.type))) {
      score += 2;
      reasons.push("公司资料命中机会类型");
    }
    if (item.category && companyText.includes(tokenizeMerchantText(item.category))) {
      score += 2;
      reasons.push("公司资料命中产业分类");
    }
    if (company.status === "active") score += 1;
    if (reasons.length === 0 && (company.industry || company.description) && (item.services || []).length > 0) {
      score += 1;
      reasons.push("可作为泛服务商备选");
    }
    if (company.owner_name) score += 1;
    const locationBoost = scoreMerchantLocation(company, item);
    score += locationBoost.score;
    reasons.push(...locationBoost.reasons);

    let statusScore = 0;

    if (battle?.owner_company_id && battle.owner_company_id === company.id) {
      statusScore += 18;
      reasons.push("当前已被作战台指派");
      if (battle.follow_status === "doing") statusScore += 8;
      if (battle.follow_status === "quoted") statusScore += 10;
      if (battle.follow_status === "won") statusScore += 20;
    } else if (battle?.follow_status === "doing" || battle?.follow_status === "quoted") {
      statusScore -= 2;
    }

    if ((item.priorityLabel === "S" || item.priorityLabel === "A") && company.status === "active") {
      statusScore += 3;
      reasons.push("高优先机会优先给活跃商家");
    }
    score += statusScore;

    if (score >= 12) role = "主跟进";
    else if (score >= 7) role = "联合跟进";
    return {
      company,
      score,
      role,
      recommended: score >= 7,
      reasons: reasons.filter((reason, index) => reasons.indexOf(reason) === index).slice(0, 3),
      breakdown: {
        locationScore: locationBoost.score,
        statusScore,
      },
    };
  }).filter((item) => item.score > 0);
  matches.sort((a, b) => b.score - a.score);
  const topMatches = matches.length
    ? matches.slice(0, 5)
    : companies.slice(0, 3).map((company) => ({
        company,
        score: 1,
        role: "备选",
        recommended: false,
        reasons: ["暂无强匹配，作为备选商家"],
      }));
  const lead = topMatches[0] || null;
  return {
    primaryNeed,
    leadCompanyName: lead?.company?.name || "",
    leadCompanyId: lead?.company?.id || "",
    leadOwnerName: lead?.company?.owner_name || "",
    leadRole: lead?.role || "待分配",
    collaborationMode: lead && lead.role === "主跟进" ? "主跟进 + 平台协同推进" : "平台先跟进，商家随后介入",
    summary: lead ? `建议优先由「${lead.company.name}」作为${lead.role}，平台负责补齐甲方、节点和报价协同。` : "当前没有明显适配商家，建议平台先研判后再分发。",
    matches: topMatches,
  };
}

async function persistOpportunityMatches(db: Db, opportunityId: string, advice: any) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM opc_opportunity_matches WHERE opportunity_id = $1", [opportunityId]);
    for (const match of (advice.matches || [])) {
      await client.query(
        `INSERT INTO opc_opportunity_matches (
          id, opportunity_id, company_id, company_name, score, role, recommended, reasons,
          keyword_score, location_score, status_score, source, snapshot_json, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
        [
          uuid(),
          opportunityId,
          match.company?.id || "",
          match.company?.name || "",
          Number(match.score || 0),
          String(match.role || ""),
          !!match.recommended,
          JSON.stringify(match.reasons || []),
          Number(match.score || 0) - Number(match.breakdown?.locationScore || 0) - Number(match.breakdown?.statusScore || 0),
          Number(match.breakdown?.locationScore || 0),
          Number(match.breakdown?.statusScore || 0),
          "system",
          JSON.stringify(match),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function handleGetOpportunityMerchantMatches(req: AuthRequest, res: ServerResponse, db: Db, opportunityId: string) {
  if (!requireAdmin(req, res)) return;
  const { rows: oppRows } = await db.query(`
    SELECT id, title, title AS name, type, category, summary, services, fit_profiles, province, city, county, priority_label
    FROM opc_intel_opportunities
    WHERE id = $1
    LIMIT 1
  `, [opportunityId]);
  if (!oppRows[0]) { sendJson(res, 404, { error: "机会不存在" }); return; }
  const item = {
    ...oppRows[0],
    services: JSON.parse((oppRows[0] as any).services || "[]"),
    fitProfiles: JSON.parse((oppRows[0] as any).fit_profiles || "[]"),
    priorityLabel: (oppRows[0] as any).priority_label || "",
  };
  const [{ rows: companyRows }, { rows: battleRows }] = await Promise.all([
    db.query(`
    SELECT c.id, c.name, c.industry, c.status, c.owner_name, c.description, c.city_id,
           ct.region, ct.city_name, ct.address AS city_address
    FROM opc_companies c
    LEFT JOIN opc_cities ct ON ct.id = c.city_id
    ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END, c.created_at DESC
  `, []),
    db.query(`
      SELECT owner_company_id, follow_status, stage
      FROM opc_opportunity_battles
      WHERE opportunity_id = $1
      LIMIT 1
    `, [opportunityId]),
  ]);
  const advice = buildMerchantMatches(companyRows as any[], item, battleRows[0] || null);
  await persistOpportunityMatches(db, opportunityId, advice);
  sendJson(res, 200, { advice });
}

export async function handleListOpportunityMatchBoard(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAdmin(req, res)) return;
  const url = new URL(req.url || "/", "http://x");
  const limit = Math.min(200, Math.max(10, n(url.searchParams.get("limit"), 50)));
  const { rows } = await db.query(`
    SELECT
      m.id,
      m.opportunity_id,
      m.company_id,
      m.company_name,
      m.score,
      m.role,
      m.recommended,
      m.reasons,
      m.keyword_score,
      m.location_score,
      m.status_score,
      m.updated_at,
      o.title AS opportunity_title,
      o.province,
      o.city,
      o.county,
      o.priority_label,
      o.target_org,
      b.follow_status,
      b.stage
    FROM opc_opportunity_matches m
    JOIN opc_intel_opportunities o ON o.id = m.opportunity_id
    LEFT JOIN opc_opportunity_battles b ON b.opportunity_id = m.opportunity_id
    ORDER BY m.updated_at DESC, m.score DESC
    LIMIT $1
  `, [limit]);
  sendJson(res, 200, { items: rows });
}

export async function handleGetOpportunityMapData(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const url = new URL(req.url || "/", "http://x");
  const province = s(url.searchParams.get("province"));
  const city = s(url.searchParams.get("city"));
  const county = s(url.searchParams.get("county"));
  const category = s(url.searchParams.get("category"));
  const priority = s(url.searchParams.get("priority")).toUpperCase();
  const strength = s(url.searchParams.get("strength"));
  const opportunityKind = s(url.searchParams.get("opportunityKind"));
  const layer = s(url.searchParams.get("layer"));
  const dataset = s(url.searchParams.get("dataset"));
  const limit = Math.min(1000, Math.max(50, n(url.searchParams.get("limit"), 1000)));

  const filters: string[] = [];
  const params: unknown[] = [];
  if (province) { params.push(province); filters.push(`province = $${params.length}`); }
  if (city) { params.push(city); filters.push(`city = $${params.length}`); }
  if (county) { params.push(county); filters.push(`county = $${params.length}`); }
  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const metaRun = await db.query(`
    SELECT source_file, meta_json, imported_at
    FROM opc_intel_runs
    WHERE source_file LIKE '%opportunity-map.json'
    ORDER BY CASE WHEN source_file LIKE '%southwest-opportunity-map.json' THEN 0 ELSE 1 END, imported_at DESC
    LIMIT 1
  `, []);
  let meta: any = {
    province: province || "",
    scopeName: county || city || province || "云贵川机会地图",
    scopeType: county ? "county" : city ? "city" : province ? "province" : "region",
    updatedAt: "",
    generatedAt: "",
    rawDocumentCount: 0,
    opportunityPoolCount: 0,
    rawOpportunityPoolCount: 0,
    mappedIndustryCount: 0,
    mappedOpportunityCount: 0,
    cityCount: 0,
    countyCount: 0,
    provinces: [],
    description: "",
  };
  if (metaRun.rows[0]?.meta_json) {
    try { meta = Object.assign(meta, JSON.parse((metaRun.rows[0] as any).meta_json || "{}")); } catch {}
  }

  const industryFilters = filters.slice();
  const industryParams = params.slice();
  if (category) {
    industryParams.push(category);
    industryFilters.push(`category = $${industryParams.length}`);
  }
  const industryWhereSql = industryFilters.length ? `WHERE ${industryFilters.join(" AND ")}` : "";

  const opportunityFilters = filters.slice();
  const opportunityParams = params.slice();
  if (dataset === "county_pool" || dataset === "map_opportunity") {
    opportunityParams.push(dataset);
    opportunityFilters.push(`dataset_kind = $${opportunityParams.length}`);
  } else {
    opportunityFilters.push(`dataset_kind IN ('map_opportunity', 'county_pool')`);
  }
  if (category) {
    opportunityParams.push(category);
    opportunityFilters.push(`(type = $${opportunityParams.length} OR category = $${opportunityParams.length})`);
  }
  if (priority) {
    opportunityParams.push(priority);
    opportunityFilters.push(`priority_label = $${opportunityParams.length}`);
  }
  if (strength) {
    opportunityParams.push(strength);
    opportunityFilters.push(`commercial_strength = $${opportunityParams.length}`);
  }
  if (opportunityKind) {
    opportunityParams.push(opportunityKind);
    opportunityFilters.push(`opportunity_kind = $${opportunityParams.length}`);
  }
  const opportunityWhereSql = opportunityFilters.length ? `WHERE ${opportunityFilters.join(" AND ")}` : "";

  const industrySql = `
      SELECT
        id, source_record_id, province, city, county, name, title, type, category, address, longitude, latitude,
        summary, services, top_demands, document_count, opportunity_count, score
      FROM opc_intel_industries
      ${industryWhereSql}
      ORDER BY score DESC, document_count DESC, opportunity_count DESC
      LIMIT ${limit}
    `;
  const opportunitySql = `
      SELECT
        id, dataset_kind, source_record_id, province, city, county, title, url, source_type, date, category, type, target_org,
        target_orgs, address, longitude, latitude, budget, money, summary, key_points, tags, services, fit_profiles,
        stage_tag, entry_focus, next_actions, priority_label, priority_text, priority_score, source_url, score, battle_json,
        opportunity_kind, business_stage, commercial_strength, commercial_rank, structured_brief
      FROM opc_intel_opportunities
      ${opportunityWhereSql}
      ORDER BY commercial_rank DESC, priority_score DESC, score DESC
      LIMIT ${limit}
    `;

  const [industryRes, opportunityRes, provinceRes, cityRes, countyRes, docRes, countyPoolRes, mapOppRes] = await Promise.all([
    db.query(layer === "opportunities" ? "SELECT * FROM opc_intel_industries WHERE 1=0" : industrySql, industryParams),
    db.query(layer === "industries" ? "SELECT * FROM opc_intel_opportunities WHERE 1=0" : opportunitySql, opportunityParams),
    db.query(`SELECT DISTINCT province FROM opc_intel_opportunities ${whereSql} ORDER BY province`, params),
    db.query(`SELECT COUNT(DISTINCT city) AS count FROM opc_intel_opportunities ${whereSql}`, params),
    db.query(`SELECT COUNT(DISTINCT province || '|' || city || '|' || county) AS count FROM opc_intel_opportunities ${whereSql}`, params),
    db.query(`SELECT COUNT(*) AS count FROM opc_intel_documents ${whereSql}`, params),
    db.query(`SELECT COUNT(*) AS count FROM opc_intel_opportunities ${whereSql ? `${whereSql} AND` : "WHERE"} dataset_kind = 'county_pool'`, params),
    db.query(`SELECT COUNT(*) AS count FROM opc_intel_opportunities ${whereSql ? `${whereSql} AND` : "WHERE"} dataset_kind = 'map_opportunity'`, params),
  ]);

  const industries = industryRes.rows.map((row: any) => ({
    id: row.id,
    name: cleanOpportunityTitle(row.name),
    title: cleanOpportunityTitle(row.title),
    type: cleanOpportunityText(row.type),
    category: cleanOpportunityText(row.category),
    province: row.province,
    city: row.city,
    county: row.county,
    address: cleanOpportunityText(row.address),
    longitude: Number(row.longitude || 0),
    latitude: Number(row.latitude || 0),
    summary: cleanOpportunityText(row.summary || ""),
    services: cleanOpportunityList(row.services),
    topDemands: cleanOpportunityList(row.top_demands),
    documentCount: Number(row.document_count || 0),
    opportunityCount: Number(row.opportunity_count || 0),
    score: Number(row.score || 0),
  }));
  const opportunities = opportunityRes.rows.map((row: any) => normalizeOpportunityRow(row));

  meta.rawDocumentCount = Number(docRes.rows[0]?.count || 0);
  meta.countyPoolCount = Number(countyPoolRes.rows[0]?.count || 0);
  meta.mapOpportunityCount = Number(mapOppRes.rows[0]?.count || 0);
  meta.opportunityPoolCount = meta.countyPoolCount + meta.mapOpportunityCount;
  meta.mappedIndustryCount = industries.length;
  meta.mappedOpportunityCount = opportunities.length;
  meta.queryLimit = limit;
  meta.activeCategory = category || "all";
  meta.activePriority = priority || "all";
  meta.activeStrength = strength || "all";
  meta.activeOpportunityKind = opportunityKind || "all";
  meta.activeLayer = layer || "all";
  meta.activeDataset = dataset || "all";
  meta.cityCount = Number(cityRes.rows[0]?.count || 0);
  meta.countyCount = Number(countyRes.rows[0]?.count || 0);
  meta.provinces = provinceRes.rows.map((row: any) => row.province).filter(Boolean);
  meta.strengthSummary = opportunities.reduce((acc: any, item: any) => {
    const key = item.commercialStrength || "未分级";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  if (province && !meta.province) meta.province = province;
  if (city || county || province) meta.scopeName = county || city || province;
  if (county || city || province) meta.scopeType = county ? "county" : city ? "city" : "province";

  sendJson(res, 200, {
    meta,
    industries,
    opportunities,
  });
}

export async function handleGetOpportunityEnrichment(req: AuthRequest, res: ServerResponse, db: Db, opportunityId: string) {
  if (!requireAuth(req, res)) return;
  const url = new URL(req.url || "/", "http://x");
  const refresh = ["1", "true", "yes"].includes(String(url.searchParams.get("refresh") || "").toLowerCase());
  const { rows } = await db.query(`
    SELECT
      id, dataset_kind, source_record_id, province, city, county, title, url, source_type, date, category, type, target_org,
      target_orgs, address, longitude, latitude, budget, money, summary, key_points, tags, services, fit_profiles,
      stage_tag, entry_focus, next_actions, priority_label, priority_text, priority_score, source_url, score, battle_json,
      opportunity_kind, business_stage, commercial_strength, commercial_rank, structured_brief
    FROM opc_intel_opportunities
    WHERE id = $1
    LIMIT 1
  `, [opportunityId]);
  if (!rows[0]) {
    sendJson(res, 404, { error: "机会不存在" });
    return;
  }

  const item = normalizeOpportunityRow(rows[0]);
  const result = await generateOpportunityEnrichment(db, req.user!.userId, item, refresh);
  sendJson(res, 200, Object.assign({ opportunity_id: opportunityId }, result));
}

export async function handleWarmOpportunityEnrichments(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  const province = cleanOpportunityText(body.province || "");
  const city = cleanOpportunityText(body.city || "");
  const county = cleanOpportunityText(body.county || "");
  const limit = Math.min(50, Math.max(5, Number(body.limit) || 20));
  const refresh = !!body.refresh;
  const filters: string[] = ["dataset_kind IN ('map_opportunity', 'county_pool')"];
  const params: unknown[] = [];
  if (province) { params.push(province); filters.push(`province = $${params.length}`); }
  if (city) { params.push(city); filters.push(`city = $${params.length}`); }
  if (county) { params.push(county); filters.push(`county = $${params.length}`); }
  const { rows } = await db.query(`
    SELECT
      id, dataset_kind, source_record_id, province, city, county, title, url, source_type, date, category, type, target_org,
      target_orgs, address, longitude, latitude, budget, money, summary, key_points, tags, services, fit_profiles,
      stage_tag, entry_focus, next_actions, priority_label, priority_text, priority_score, source_url, score, battle_json,
      opportunity_kind, business_stage, commercial_strength, commercial_rank, structured_brief
    FROM opc_intel_opportunities
    WHERE ${filters.join(" AND ")}
    ORDER BY commercial_rank DESC, priority_score DESC, score DESC
    LIMIT ${limit}
  `, params);
  const items = rows.map(normalizeOpportunityRow);
  const results = [];
  for (const item of items) {
    const generated = await generateOpportunityEnrichment(db, req.user!.userId, item, refresh);
    results.push({
      id: item.id,
      title: item.title,
      strength: item.commercialStrength,
      priority: item.priorityLabel,
      cached: generated.cached,
      stale: generated.stale,
      error: generated.error || "",
    });
  }
  sendJson(res, 200, {
    ok: true,
    total: results.length,
    generated: results.filter((item) => !item.cached).length,
    cached: results.filter((item) => item.cached && !item.stale).length,
    stale: results.filter((item) => item.stale).length,
    items: results,
  });
}

function normalizeOpportunityBattlePatch(body: any) {
  return {
    stage: String(body.stage || ""),
    follow_status: String(body.followStatus || body.follow_status || ""),
    monetization_stage: String(body.monetizationStage || body.monetization_stage || ""),
    commercial_package: String(body.commercialPackage || body.commercial_package || ""),
    quote_amount: String(body.quoteAmount || body.quote_amount || ""),
    owner_company_id: String(body.ownerCompanyId || body.owner_company_id || ""),
    owner_company_name: String(body.ownerCompanyName || body.owner_company_name || ""),
    owner_person: String(body.ownerPerson || body.owner_person || ""),
    assignment_role: String(body.assignmentRole || body.assignment_role || ""),
    recommended_by: String(body.recommendedBy || body.recommended_by || ""),
    notes: String(body.notes || ""),
  };
}

async function saveOpportunityBattle(db: Db, userId: string, opportunityId: string, patch: Record<string, string>) {
  const existing = await db.query("SELECT opportunity_id FROM opc_opportunity_battles WHERE opportunity_id = $1", [opportunityId]);
  if (existing.rows.length > 0) {
    await db.query(`
      UPDATE opc_opportunity_battles
      SET stage = $1,
          follow_status = $2,
          monetization_stage = $3,
          commercial_package = $4,
          quote_amount = $5,
          owner_company_id = $6,
          owner_company_name = $7,
          owner_person = $8,
          assignment_role = $9,
          recommended_by = $10,
          notes = $11,
          updated_by_user_id = $12,
          updated_at = NOW()
      WHERE opportunity_id = $13
    `, [
      patch.stage || "",
      patch.follow_status || "",
      patch.monetization_stage || "",
      patch.commercial_package || "",
      patch.quote_amount || "",
      patch.owner_company_id || "",
      patch.owner_company_name || "",
      patch.owner_person || "",
      patch.assignment_role || "",
      patch.recommended_by || "",
      patch.notes || "",
      userId,
      opportunityId,
    ]);
  } else {
    await db.query(`
      INSERT INTO opc_opportunity_battles (
        opportunity_id, stage, follow_status, monetization_stage, commercial_package, quote_amount,
        owner_company_id, owner_company_name, owner_person, assignment_role, recommended_by, notes, updated_by_user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      opportunityId,
      patch.stage || "",
      patch.follow_status || "",
      patch.monetization_stage || "",
      patch.commercial_package || "",
      patch.quote_amount || "",
      patch.owner_company_id || "",
      patch.owner_company_name || "",
      patch.owner_person || "",
      patch.assignment_role || "",
      patch.recommended_by || "",
      patch.notes || "",
      userId,
    ]);
  }
  const { rows } = await db.query("SELECT * FROM opc_opportunity_battles WHERE opportunity_id = $1 LIMIT 1", [opportunityId]);
  return rows[0] || null;
}

function safeParseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(v => String(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeParseJsonObject<T extends Record<string, any>>(value: unknown, fallback: T): T {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

function cleanOpportunityText(value: unknown): string {
  return String(value || "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[　\t]+/g, " ")
    .replace(/(点击查看详情|查看更多|原文链接|附件下载|返回顶部)/g, "")
    .replace(/[|｜]{2,}/g, " ")
    .trim();
}

function cleanOpportunityTitle(value: unknown): string {
  return cleanOpportunityText(value)
    .replace(/^[>\-—·•\d.\s]+/, "")
    .replace(/\s*\((全文|原文|详情)\)\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanOpportunityList(values: unknown): string[] {
  return safeParseJsonArray(values)
    .map(cleanOpportunityText)
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, 8);
}

function extractJsonObject(text: string): Record<string, any> | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  try {
    const parsed = JSON.parse(objectMatch[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeOpportunityRow(row: any) {
  const cleanedTitle = cleanOpportunityTitle(row.title || row.name || "");
  return {
    id: row.id,
    sourceRecordId: row.source_record_id || "",
    province: row.province || "",
    city: row.city || "",
    county: row.county || "",
    title: cleanedTitle,
    name: cleanedTitle,
    url: row.url || row.source_url || "",
    sourceType: row.source_type || "",
    date: row.date || "",
    category: cleanOpportunityText(row.category || ""),
    type: cleanOpportunityText(row.type || ""),
    targetOrg: cleanOpportunityText(row.target_org || ""),
    targetOrgs: cleanOpportunityList(row.target_orgs),
    address: cleanOpportunityText(row.address || ""),
    longitude: Number(row.longitude || 0),
    latitude: Number(row.latitude || 0),
    budget: cleanOpportunityText(row.budget || ""),
    money: cleanOpportunityList(row.money),
    summary: cleanOpportunityText(row.summary || ""),
    keyPoints: cleanOpportunityList(row.key_points),
    tags: cleanOpportunityList(row.tags),
    services: cleanOpportunityList(row.services),
    fitProfiles: cleanOpportunityList(row.fit_profiles),
    stageTag: cleanOpportunityText(row.stage_tag || ""),
    entryFocus: cleanOpportunityText(row.entry_focus || ""),
    nextActions: cleanOpportunityList(row.next_actions),
    priorityLabel: cleanOpportunityText(row.priority_label || ""),
    priorityText: cleanOpportunityText(row.priority_text || ""),
    priorityScore: Number(row.priority_score || 0),
    sourceUrl: row.source_url || row.url || "",
    score: Number(row.score || 0),
    datasetKind: row.dataset_kind || "",
    battle: row.battle_json ? safeParseJsonObject(row.battle_json, {}) : {},
    opportunityKind: cleanOpportunityText(row.opportunity_kind || ""),
    businessStage: cleanOpportunityText(row.business_stage || row.stage_tag || ""),
    commercialStrength: cleanOpportunityText(row.commercial_strength || ""),
    commercialRank: Number(row.commercial_rank || 0),
    structuredBrief: cleanOpportunityText(row.structured_brief || ""),
  };
}

function buildOpportunityEnrichmentSnapshot(item: any): string {
  return JSON.stringify({
    id: item.id || "",
    title: item.title || "",
    province: item.province || "",
    city: item.city || "",
    county: item.county || "",
    category: item.category || "",
    type: item.type || "",
    targetOrg: item.targetOrg || "",
    address: item.address || "",
    budget: item.budget || "",
    summary: item.summary || "",
    services: item.services || [],
    fitProfiles: item.fitProfiles || [],
    stageTag: item.stageTag || "",
    entryFocus: item.entryFocus || "",
    nextActions: item.nextActions || [],
    priorityLabel: item.priorityLabel || "",
    priorityText: item.priorityText || "",
    opportunityKind: item.opportunityKind || "",
    businessStage: item.businessStage || "",
    commercialStrength: item.commercialStrength || "",
    structuredBrief: item.structuredBrief || "",
    sourceUrl: item.sourceUrl || "",
  });
}

function getOpportunityWorkspaceFallbackPayload(item: any) {
  const title = item.title || item.name || "资源机会";
  const region = [item.province, item.city, item.county].filter(Boolean).join(" / ") || "待补充";
  const services = Array.isArray(item.services) && item.services.length ? item.services.join("、") : "待补充";
  const fitProfiles = Array.isArray(item.fitProfiles) && item.fitProfiles.length ? item.fitProfiles.join("、") : "待补充";
  const entryFocus = item.entryFocus || item.structuredBrief || item.summary || "先核验甲方、预算与交付入口。";
  const nextActions = Array.isArray(item.nextActions) && item.nextActions.length ? item.nextActions : [
    "核验甲方主体、采购节点和预算口径",
    "输出可卖服务与首轮沟通话术",
    "安排首次触达并记录反馈",
  ];
  return {
    followup: {
      title: "AI 跟进方案",
      desc: "先给这条资源一个可执行的推进方案。",
      sections: [
        { title: "机会判断", type: "text", body: `${title} 位于 ${region}，当前更适合从「${entryFocus}」切入。` },
        { title: "7 天推进节奏", type: "list", items: nextActions },
        { title: "现在先做", type: "list", items: nextActions.slice(0, 3) },
      ],
    },
    profile: {
      title: "甲方画像",
      desc: "先明确谁是甲方、谁能拍板、怎么接触。",
      sections: [
        { title: "可能的甲方主体", type: "list", items: [item.targetOrg || title, region, item.address || "地址待补充"].filter(Boolean) },
        { title: "适配服务", type: "text", body: services },
        { title: "适配商家", type: "text", body: fitProfiles },
      ],
    },
    execution: {
      title: "经营动作",
      desc: "把资源转成客户、项目、待办和真实推进动作。",
      sections: [
        { title: "马上推进", type: "list", items: nextActions },
        { title: "切入重点", type: "text", body: entryFocus },
      ],
    },
    brief: {
      title: "线索简报",
      desc: "给团队或商家转发的简版摘要。",
      sections: [
        { title: "可复制内容", type: "pre", pre: [
          `资源名称：${title}`,
          `地区：${region}`,
          `甲方主体：${item.targetOrg || "待补充"}`,
          `商业强度：${item.commercialStrength || "待补充"}`,
          `可卖服务：${services}`,
          `切入重点：${entryFocus}`,
          item.sourceUrl ? `原文链接：${item.sourceUrl}` : "",
        ].filter(Boolean).join("\n") },
      ],
    },
    monetization: {
      title: "收费话术",
      desc: "平台如何围绕这条资源做收费与推进。",
      sections: [
        { title: "推荐收费方式", type: "list", items: ["资源席位订阅", "成交加速服务", "撮合佣金"] },
        { title: "建议主卖点", type: "text", body: `围绕 ${title} 这类资源，平台卖的不是资讯，而是资源判断、商家匹配和推进成交能力。` },
      ],
    },
  };
}

function buildOpportunityEnrichmentPrompt(item: any): string {
  const compact = {
    id: item.id || "",
    title: item.title || "",
    region: [item.province, item.city, item.county].filter(Boolean).join(" / "),
    category: item.category || "",
    type: item.type || "",
    targetOrg: item.targetOrg || "",
    address: item.address || "",
    budget: item.budget || "",
    summary: item.summary || "",
    services: item.services || [],
    fitProfiles: item.fitProfiles || [],
    stageTag: item.stageTag || "",
    entryFocus: item.entryFocus || "",
    nextActions: item.nextActions || [],
    priorityLabel: item.priorityLabel || "",
    priorityText: item.priorityText || "",
    opportunityKind: item.opportunityKind || "",
    businessStage: item.businessStage || "",
    commercialStrength: item.commercialStrength || "",
    structuredBrief: item.structuredBrief || "",
    sourceUrl: item.sourceUrl || "",
  };
  return [
    "你是星环 OPC 的资源引擎顾问。目标不是做地图分析，而是把一条外部资源线索变成一人公司可跟进、可赚钱、可成交的资源机会。",
    "请基于下面这条资源数据，输出 JSON 对象，只能输出 JSON，不要任何额外解释。",
    "JSON 顶层必须包含 5 个键：followup, profile, execution, brief, monetization。",
    "每个键都必须是对象，格式如下：",
    "{",
    '  "title": "面板标题",',
    '  "desc": "一句话说明",',
    '  "sections": [',
    '    {"title":"小节标题","type":"text","body":"正文"}',
    '    或 {"title":"小节标题","type":"list","items":["要点1","要点2"]}',
    '    或 {"title":"小节标题","type":"pre","pre":"适合复制的文本"}',
    "  ]",
    "}",
    "要求：",
    "1. 五个面板内容必须明显不同，不能只是换标题。",
    "2. followup 要偏成交推进，profile 要偏甲方/决策链，execution 要偏经营动作落地，brief 要偏可复制转发，monetization 要偏平台如何收费。",
    "3. 要体现平台视角：平台提供资源、筛选、匹配、推进和成交承接。",
    "4. 语气务实，适合一人公司用户立即执行。",
    "5. 如果信息不足，明确写“待核验/待补充”，不要编造具体单位或数字。",
    "",
    "资源数据：",
    JSON.stringify(compact),
  ].join("\n");
}

async function generateOpportunityEnrichment(db: Db, userId: string, item: any, refresh: boolean = false) {
  const snapshot = buildOpportunityEnrichmentSnapshot(item);
  const fallback = getOpportunityWorkspaceFallbackPayload(item);
  const cachedRes = await db.query("SELECT * FROM opc_opportunity_enrichments WHERE opportunity_id = $1 LIMIT 1", [item.id]);
  const cached = cachedRes.rows[0] || null;
  if (cached && !refresh && String((cached as any).source_snapshot || "") === snapshot) {
    return {
      cached: true,
      stale: false,
      model_id: (cached as any).model_id || "",
      generated_at: (cached as any).generated_at || "",
      payload: safeParseJsonObject((cached as any).payload_json, fallback),
    };
  }

  const userModelRows = await db.query("SELECT selected_model FROM opc_users WHERE id = $1 LIMIT 1", [userId]);
  const modelId = String(userModelRows.rows[0]?.selected_model || getModel());
  try {
    const aiResp = await callAi([{ role: "user", content: buildOpportunityEnrichmentPrompt(item) }], undefined, modelId);
    const parsed = extractJsonObject(aiResp.content);
    const payload = parsed && parsed.followup && parsed.profile && parsed.execution && parsed.brief && parsed.monetization
      ? parsed
      : fallback;
    await db.query(`
      INSERT INTO opc_opportunity_enrichments (opportunity_id, source_snapshot, payload_json, model_id, generated_at, updated_at)
      VALUES ($1,$2,$3,$4,NOW(),NOW())
      ON CONFLICT (opportunity_id) DO UPDATE SET
        source_snapshot = EXCLUDED.source_snapshot,
        payload_json = EXCLUDED.payload_json,
        model_id = EXCLUDED.model_id,
        generated_at = NOW(),
        updated_at = NOW()
    `, [item.id, snapshot, JSON.stringify(payload), modelId]);
    return {
      cached: false,
      stale: false,
      model_id: modelId,
      generated_at: new Date().toISOString(),
      payload,
    };
  } catch (error: any) {
    if (cached) {
      return {
        cached: true,
        stale: true,
        error: String(error?.message || "AI 生成失败，已回退缓存"),
        model_id: (cached as any).model_id || "",
        generated_at: (cached as any).generated_at || "",
        payload: safeParseJsonObject((cached as any).payload_json, fallback),
      };
    }
    return {
      cached: false,
      stale: true,
      error: String(error?.message || "AI 生成失败，已回退基础模板"),
      model_id: modelId,
      generated_at: "",
      payload: fallback,
    };
  }
}

function parseOpportunityAmount(raw: unknown): number {
  const text = String(raw || "");
  if (!text) return 0;
  const normalized = text.replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  let amount = Number(match[1]);
  if (Number.isNaN(amount)) return 0;
  if (/[亿]/.test(normalized)) amount *= 100000000;
  else if (/[万]/.test(normalized)) amount *= 10000;
  return Math.round(amount);
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function mapBattleToPipelineStage(followStatus: string): string {
  if (followStatus === "won") return "won";
  if (followStatus === "quoted") return "proposal";
  if (followStatus === "doing") return "negotiation";
  return "lead";
}

function inferMonetizationStage(kind: string): string {
  if (kind === "招采订单") return "match";
  if (kind === "招商项目" || kind === "政策窗口") return "escort";
  return "lead";
}

function inferCommercialPackage(kind: string): string {
  if (kind === "招采订单") return "定向撮合包";
  if (kind === "招商项目") return "招商项目陪跑包";
  if (kind === "政策窗口") return "政策陪跑包";
  return "强机会订阅包";
}

function buildOpportunityContactNotes(item: any, marker: string): string {
  const lines = [
    marker,
    `机会名称：${s(item.title)}`,
    `机会类型：${s(item.opportunityKind || item.type || item.category)}`,
    `地区：${[item.province, item.city, item.county].filter(Boolean).join(" / ")}`,
    `摘要：${s(item.summary)}`,
    `切入点：${s(item.entryFocus)}`,
    item.sourceUrl ? `来源：${item.sourceUrl}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function buildOpportunityExecutionDocument(item: any, companyName: string, marker: string): string {
  const nextActions = Array.isArray(item.nextActions) && item.nextActions.length
    ? item.nextActions.map((line: string, idx: number) => `${idx + 1}. ${line}`).join("\n")
    : "1. 核验甲方主体与项目阶段\n2. 明确可卖服务与首轮报价范围\n3. 安排首轮触达";
  const services = Array.isArray(item.services) && item.services.length ? item.services.join("、") : "待补充";
  return [
    `# ${item.title || "机会"} 执行项目`,
    "",
    marker,
    "",
    "## 项目背景",
    `${companyName} 准备围绕这条机会线索启动实际跟进，目标是把地图线索转成可触达、可报价、可成交的业务机会。`,
    "",
    "## 机会概览",
    `- 机会类型：${s(item.opportunityKind || item.type || item.category, "待补充")}`,
    `- 甲方主体：${s(item.targetOrg, "待补充")}`,
    `- 所在地区：${[item.province, item.city, item.county].filter(Boolean).join(" / ") || "待补充"}`,
    `- 预算金额：${s(item.budget, "待补充")}`,
    `- 可售服务：${services}`,
    "",
    "## 跟进目标",
    "- 明确甲方主体、采购阶段、预算与联系人",
    "- 形成首轮切入方案、报价范围与沟通脚本",
    "- 将机会推进到触达、报价或签约阶段",
    "",
    "## 当前判断",
    s(item.structuredBrief || item.summary || item.entryFocus, "待补充"),
    "",
    "## 下一步动作",
    nextActions,
    "",
    "## 来源",
    item.sourceUrl ? item.sourceUrl : "链接待补",
  ].join("\n");
}

function buildOpportunityExecutionTodos(item: any, companyName: string) {
  const target = s(item.targetOrg || item.title, "该机会");
  const actions = Array.isArray(item.nextActions) ? item.nextActions.filter(Boolean) : [];
  const fallback = [
    `核验 ${target} 的甲方主体、采购阶段和预算口径`,
    `为 ${target} 输出首轮沟通话术与可售服务清单`,
    `围绕 ${target} 安排报价或方案准备`,
  ];
  return (actions.length ? actions.slice(0, 3) : fallback).map((text: string, idx: number) => ({
    title: idx === 0
      ? `核验线索：${companyName}`
      : idx === 1
        ? `准备方案：${target}`
        : `推进成交：${target}`,
    description: text,
    priority: idx === 0 ? "high" : "medium",
    dueDate: addDaysIso(idx),
  }));
}

function buildOpportunityPostDealTodos(item: any, companyName: string) {
  const target = s(item.targetOrg || item.title, "甲方");
  return [
    {
      title: `交付启动会：${target}`,
      description: `围绕 ${companyName} 拿下的这条机会，立即确认交付范围、里程碑、责任人和验收物，避免成交后无人接盘。`,
      priority: "high",
      dueDate: addDaysIso(0),
    },
    {
      title: `回款节点设计：${target}`,
      description: `把首付款、中期款、验收尾款、开票节奏和催款动作写清楚，并与合同条款对齐。\n建议先确认甲方付款流程与审批链。`,
      priority: "high",
      dueDate: addDaysIso(1),
    },
    {
      title: `复盘并准备复购：${target}`,
      description: `基于当前成交机会，梳理可追加销售、续约、转介绍和标准化交付包，为后续复购做准备。`,
      priority: "medium",
      dueDate: addDaysIso(5),
    },
  ];
}

function buildOpportunityCompanyDoc(item: any, companyName: string, marker: string): string {
  const nextActions = Array.isArray(item.nextActions) && item.nextActions.length
    ? item.nextActions.map((line: string, idx: number) => `${idx + 1}. ${line}`).join("\n")
    : "1. 核验甲方主体\n2. 明确可卖服务\n3. 推进方案与报价";
  const services = Array.isArray(item.services) && item.services.length ? item.services.join("、") : "待补充";
  const targetOrgs = Array.isArray(item.targetOrgs) && item.targetOrgs.length ? item.targetOrgs.join("、") : s(item.targetOrg, "待补充");
  return [
    `# ${item.title || "机会"} 跟进作战单`,
    "",
    marker,
    "",
    "## 机会来源",
    item.sourceUrl ? item.sourceUrl : "来源链接待补充",
    "",
    "## 机会判断",
    `- 跟进公司：${companyName}`,
    `- 机会类型：${s(item.opportunityKind || item.type || item.category, "待补充")}`,
    `- 目标甲方：${targetOrgs}`,
    `- 所在地区：${[item.province, item.city, item.county].filter(Boolean).join(" / ") || "待补充"}`,
    `- 预算/金额：${s(item.budget, "待补充")}`,
    `- 可售服务：${services}`,
    "",
    "## 当前切入点",
    s(item.entryFocus || item.structuredBrief || item.summary, "待补充"),
    "",
    "## 跟进目标",
    "- 尽快确认甲方主体、采购阶段、预算与决策链",
    "- 把机会推进到可报价、可签约、可回款状态",
    "- 在 OPC 内部沉淀项目、待办、文档和成交记录",
    "",
    "## 下一步动作",
    nextActions,
    "",
    "## 平台变现动作",
    "- 将本机会持续推送给适配商家",
    "- 视进展提供撮合、报价陪跑、交付陪跑服务",
    "- 成交后继续延伸交付与回款服务",
  ].join("\n");
}

function buildOpportunityPostDealDocs(item: any, companyName: string, marker: string) {
  const target = s(item.targetOrg || item.title, "甲方");
  const serviceText = Array.isArray(item.services) && item.services.length ? item.services.join("、") : "待补充";
  return [
    {
      doc_type: "opportunity_delivery_plan",
      title: `${item.title || "机会"} · 交付启动单`,
      source: "opportunity_post_deal",
      content: [
        `# ${item.title || "机会"} 交付启动单`,
        "",
        marker,
        "",
        `- 跟进公司：${companyName}`,
        `- 甲方主体：${target}`,
        `- 机会来源：${s(item.sourceUrl, "链接待补")}`,
        "",
        "## 交付范围",
        `- 本次承接服务：${serviceText}`,
        "- 先明确交付内容与不交付内容，避免成交后边界失控。",
        "",
        "## 启动动作",
        "1. 召开交付启动会，确认双方责任人。",
        "2. 列出里程碑、验收物、沟通频率。",
        "3. 把风险点、依赖条件、变更机制提前写清楚。",
      ].join("\n"),
    },
    {
      doc_type: "opportunity_collection_plan",
      title: `${item.title || "机会"} · 回款推进单`,
      source: "opportunity_post_deal",
      content: [
        `# ${item.title || "机会"} 回款推进单`,
        "",
        marker,
        "",
        `- 跟进公司：${companyName}`,
        `- 甲方主体：${target}`,
        "",
        "## 回款结构",
        "1. 首付款节点：签约或启动后尽快锁定。",
        "2. 中期节点：与里程碑和验收物绑定。",
        "3. 尾款节点：与最终验收、开票、对账绑定。",
        "",
        "## 关键动作",
        "- 提前确认甲方财务和审批流程。",
        "- 提前准备开票资料、收款账户、对账口径。",
        "- 形成固定催款节奏，避免尾款长期拖延。",
      ].join("\n"),
    },
    {
      doc_type: "opportunity_renewal_plan",
      title: `${item.title || "机会"} · 复购延伸方案`,
      source: "opportunity_post_deal",
      content: [
        `# ${item.title || "机会"} 复购延伸方案`,
        "",
        marker,
        "",
        `- 跟进公司：${companyName}`,
        `- 当前甲方：${target}`,
        "",
        "## 为什么现在做",
        "- 一单成交后，最容易拿下的是同甲方追加需求、后续维保、年度续签和转介绍。",
        "",
        "## 复购动作",
        "1. 在交付中记录可追加销售场景。",
        "2. 验收前准备复盘材料和下一阶段建议。",
        "3. 识别同体系客户、关联项目和转介绍对象。",
      ].join("\n"),
    },
  ];
}

function mergeBattleNotes(existing: string, lines: string[]): string {
  const normalized = String(existing || "").trim();
  const next = lines.map(v => String(v || "").trim()).filter(Boolean);
  const combined = normalized ? [normalized, ...next] : next;
  return combined.filter((line, idx) => combined.indexOf(line) === idx).join("\n");
}

// ─── Monitor ──────────────────────────────────────────────────────────

export async function handleGetMonitor(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid))) { sendJson(res, 403, { error: "无权访问" }); return; }

  const now = new Date();
  const monthStart = now.toISOString().slice(0, 7);
  const todayStr = now.toISOString().slice(0, 10);

  const { rows: [monthIncome] } = await db.query(
    "SELECT COALESCE(SUM(amount),0) as v FROM opc_transactions WHERE company_id = $1 AND type='income' AND transaction_date LIKE $2",
    [cid, monthStart + '%']
  );
  const { rows: [monthExpense] } = await db.query(
    "SELECT COALESCE(SUM(amount),0) as v FROM opc_transactions WHERE company_id = $1 AND type='expense' AND transaction_date LIKE $2",
    [cid, monthStart + '%']
  );
  const { rows: [totalIncome] } = await db.query(
    "SELECT COALESCE(SUM(amount),0) as v FROM opc_transactions WHERE company_id = $1 AND type='income'",
    [cid]
  );
  const { rows: [totalExpense] } = await db.query(
    "SELECT COALESCE(SUM(amount),0) as v FROM opc_transactions WHERE company_id = $1 AND type='expense'",
    [cid]
  );
  const { rows: overdueContracts } = await db.query(
    "SELECT COUNT(*) as c FROM opc_contracts WHERE company_id = $1 AND status='active' AND end_date < $2 AND end_date != ''",
    [cid, todayStr]
  );
  const { rows: overdueInvoices } = await db.query(
    "SELECT COUNT(*) as c FROM opc_invoices WHERE company_id = $1 AND status != 'paid' AND due_date < $2 AND due_date != ''",
    [cid, todayStr]
  );
  const { rows: upcomingFollowups } = await db.query(
    "SELECT * FROM opc_contacts WHERE company_id = $1 AND follow_up_date != '' AND follow_up_date <= $2 AND pipeline_stage NOT IN ('won','lost') ORDER BY follow_up_date LIMIT 10",
    [cid, todayStr]
  );
  const { rows: activeProjects } = await db.query(
    "SELECT * FROM opc_projects WHERE company_id = $1 AND status IN ('active','in_progress','planning') AND budget > 0 ORDER BY created_at DESC LIMIT 5",
    [cid]
  );
  const { rows: alerts } = await db.query(
    "SELECT * FROM opc_alerts WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10",
    [cid]
  );
  const { rows: todos } = await db.query(
    "SELECT * FROM opc_todos WHERE company_id = $1 AND completed = 0 ORDER BY due_date ASC LIMIT 10",
    [cid]
  );

  const cashBalance = Number(totalIncome.v) - Number(totalExpense.v);
  const avgMonthlyExpense = Number(totalExpense.v) / Math.max(1, 3);
  const runway = avgMonthlyExpense > 0 ? Math.round(cashBalance / avgMonthlyExpense * 10) / 10 : 99;

  sendJson(res, 200, {
    metrics: {
      monthly_income: Number(monthIncome.v),
      monthly_expense: Number(monthExpense.v),
      monthly_profit: Number(monthIncome.v) - Number(monthExpense.v),
      cash_balance: cashBalance,
      runway_months: runway,
    },
    alerts,
    todos,
    follow_ups: upcomingFollowups,
    active_projects: activeProjects,
  });
}

// ─── Channels ─────────────────────────────────────────────────────────

export async function handleGetChannels(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid))) { sendJson(res, 403, { error: "无权访问" }); return; }
  const { rows: configs } = await db.query("SELECT * FROM opc_channel_config WHERE company_id = $1", [cid]);
  sendJson(res, 200, { channels: configs });
}

export async function handleSaveChannel(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid, "admin"))) { sendJson(res, 403, { error: "需要管理员以上权限" }); return; }
  const body = await parseBody(req);
  const channel = s(body.channel);
  const { rows: existRows } = await db.query(
    "SELECT id FROM opc_channel_config WHERE company_id = $1 AND channel = $2",
    [cid, channel]
  );
  if (existRows.length > 0) {
    await db.query(
      "UPDATE opc_channel_config SET app_id = $1, app_secret = $2, status = 'active' WHERE id = $3",
      [s(body.app_id), s(body.app_secret), existRows[0].id]
    );
  } else {
    await db.query(
      "INSERT INTO opc_channel_config (id,company_id,channel,app_id,app_secret,status) VALUES ($1,$2,$3,$4,$5,'active')",
      [uuid(), cid, channel, s(body.app_id), s(body.app_secret)]
    );
  }
  sendJson(res, 200, { success: true });
}

// ─── Tools ────────────────────────────────────────────────────────────

export async function handleGetToolConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query("SELECT * FROM opc_tool_config");
  const config: Record<string, string> = {};
  for (const r of rows as { key: string; value: string }[]) config[r.key] = r.value;
  sendJson(res, 200, { config });
}

export async function handleSaveToolConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  for (const [k, v] of Object.entries(body)) {
    await db.query(
      "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [k, String(v)]
    );
  }
  sendJson(res, 200, { success: true });
}

// ─── Closure (资金闭环) ───────────────────────────────────────────────

export async function handleGetClosures(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid))) { sendJson(res, 403, { error: "无权访问" }); return; }
  const { rows: items } = await db.query("SELECT * FROM opc_closures WHERE company_id = $1 ORDER BY created_at DESC", [cid]);
  const summary = {
    acquisitions: (items as any[]).filter(i => i.type === 'acquisition').length,
    packages: (items as any[]).filter(i => i.type === 'package').length,
    transfers: (items as any[]).filter(i => i.type === 'transfer').length,
    total_amount: (items as any[]).reduce((s: number, i: any) => s + (i.amount || 0), 0),
  };
  sendJson(res, 200, { items, summary });
}

export async function handleCreateClosure(req: AuthRequest, res: ServerResponse, db: Db, cid: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid, "admin"))) { sendJson(res, 403, { error: "需要管理员以上权限" }); return; }
  const body = await parseBody(req);
  const id = uuid();
  await db.query(
    "INSERT INTO opc_closures (id,company_id,type,name,counterparty,amount,status,details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, cid, s(body.type, "acquisition"), s(body.name), s(body.counterparty), n(body.amount), s(body.status, "draft"), JSON.stringify(body.details || {})]
  );
  const { rows } = await db.query("SELECT * FROM opc_closures WHERE id = $1", [id]);
  sendJson(res, 201, { closure: rows[0] });
}

export async function handleDeleteClosure(req: AuthRequest, res: ServerResponse, db: Db, cid: string, closureId: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, cid, "admin"))) { sendJson(res, 403, { error: "需要管理员以上权限" }); return; }
  const { rowCount } = await db.query("DELETE FROM opc_closures WHERE id = $1 AND company_id = $2", [closureId, cid]);
  if (!rowCount) { sendJson(res, 404, { error: "记录不存在" }); return; }
  sendJson(res, 200, { success: true });
}

// ─── AI Config ────────────────────────────────────────────────────────

export async function handleGetAiConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const keys = ["ai_provider", "ai_api_key", "ai_model", "ai_base_url", "ai_mode"];
  const config: Record<string, string> = {};
  for (const k of keys) {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = $1", [k]);
    config[k] = rows[0]?.value || "";
  }
  if (!config.ai_mode) config.ai_mode = config.ai_api_key ? "local" : "cloud";
  if (config.ai_api_key) {
    config.ai_api_key_masked = config.ai_api_key.slice(0, 6) + "****" + config.ai_api_key.slice(-4);
  }
  sendJson(res, 200, { config });
}

export async function handleSaveAiConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const allowed = ["ai_provider", "ai_api_key", "ai_model", "ai_base_url", "ai_mode"];
  for (const k of allowed) {
    if (body[k] !== undefined) {
      await db.query(
        "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [k, String(body[k])]
      );
    }
  }

  const { configureAi } = await import("../chat/ai-client.js");
  const getVal = async (k: string) => {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = $1", [k]);
    return rows[0]?.value || "";
  };
  const baseUrl = await getVal("ai_base_url");
  const apiKey = await getVal("ai_api_key");
  const model = await getVal("ai_model");
  const aiMode = await getVal("ai_mode");
  if (apiKey) {
    configureAi({ baseUrl: baseUrl || undefined, apiKey, model: model || undefined, mode: (aiMode as any) || "local" });
  } else if (aiMode === "cloud") {
    configureAi({ mode: "cloud" });
  }

  sendJson(res, 200, { success: true });
}

export async function handleTestAiConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);

  let apiKey = s(body.ai_api_key).trim();
  const baseUrl = s(body.ai_base_url).trim().replace(/\/+$/, "");
  const model = s(body.ai_model).trim();

  if (body.use_stored_key) {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = 'ai_api_key'");
    apiKey = (rows[0] as { value: string } | undefined)?.value || "";
  }

  if (!apiKey) {
    sendJson(res, 400, { error: "请先填写完整的 API Key" });
    return;
  }
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    sendJson(res, 400, { error: "请填写合法的 Base URL（http/https）" });
    return;
  }

  const requestWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const shortBody = async (resp: Response): Promise<string> => {
    try {
      return (await resp.text()).slice(0, 300);
    } catch {
      return "";
    }
  };

  try {
    const modelsResp = await requestWithTimeout(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (modelsResp.ok) {
      sendJson(res, 200, { ok: true, status: modelsResp.status, message: "连接成功（models 接口可用）" });
      return;
    }

    // 部分供应商不提供 /models，降级尝试一次 chat/completions
    if ((modelsResp.status === 404 || modelsResp.status === 405) && model) {
      const chatResp = await requestWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
        }),
      });

      if (chatResp.ok) {
        sendJson(res, 200, { ok: true, status: chatResp.status, message: "连接成功（chat/completions 接口可用）" });
        return;
      }

      sendJson(res, 200, {
        ok: false,
        status: chatResp.status,
        error: (await shortBody(chatResp)) || "测试失败",
      });
      return;
    }

    sendJson(res, 200, {
      ok: false,
      status: modelsResp.status,
      error: (await shortBody(modelsResp)) || "测试失败",
    });
  } catch (e: unknown) {
    sendJson(res, 200, { ok: false, error: (e as Error).message || "连接失败" });
  }
}

// ─── Search Config ────────────────────────────────────────────────────

export async function handleGetSearchConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const keys = ["uapi_key", "uapi_url"];
  const config: Record<string, string> = {};
  for (const k of keys) {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = $1", [k]);
    config[k] = rows[0]?.value || "";
  }
  if (config.uapi_key) {
    config.uapi_key_masked = config.uapi_key.slice(0, 6) + "****" + config.uapi_key.slice(-4);
  }
  sendJson(res, 200, { config });
}

export async function handleSaveSearchConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const allowed = ["uapi_key", "uapi_url"];
  for (const k of allowed) {
    if (body[k] !== undefined) {
      await db.query(
        "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [k, String(body[k])],
      );
    }
  }
  const { configureSearch } = await import("../chat/tool-executor.js");
  const getVal = async (k: string) => {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = $1", [k]);
    return rows[0]?.value || "";
  };
  const apiKey = await getVal("uapi_key");
  const apiUrl = await getVal("uapi_url");
  if (apiKey) configureSearch({ apiKey, apiUrl: apiUrl || undefined });
  sendJson(res, 200, { success: true });
}

export async function handleTestSearchConfig(req: AuthRequest, res: ServerResponse, _db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const apiKey = s(body.uapi_key).trim();
  const apiUrl = s(body.uapi_url).trim() || "https://uapis.cn/api/v1/search/aggregate";
  if (!apiKey) { sendJson(res, 400, { error: "请填写 UAPI Key" }); return; }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "test", timeout_ms: 5000 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.ok) {
      sendJson(res, 200, { ok: true, message: "搜索服务连接成功" });
    } else {
      const text = await resp.text().catch(() => "");
      sendJson(res, 200, { ok: false, error: `搜索API返回 ${resp.status}: ${text.slice(0, 200)}` });
    }
  } catch (e: unknown) {
    sendJson(res, 200, { ok: false, error: (e as Error).message || "连接失败" });
  }
}

// ─── Email / IM Config (本地版专属) ──────────────────────────────────

export async function handleGetServiceConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const service = url.searchParams.get("service") || "";

  if (service === "email") {
    const { rows } = await db.query(
      "SELECT id, email, display_name, smtp_host, smtp_port, imap_host, imap_port, password, enabled FROM opc_email_accounts WHERE user_id = $1 ORDER BY created_at LIMIT 1",
      [userId],
    );
    if (rows.length === 0) { sendJson(res, 200, { config: {} }); return; }
    const acc = rows[0];
    const masked = acc.password ? acc.password.slice(0, 4) + "****" + acc.password.slice(-4) : "";
    sendJson(res, 200, {
      config: {
        account_id: acc.id, email: acc.email, display_name: acc.display_name || "",
        smtp_host: acc.smtp_host, smtp_port: String(acc.smtp_port),
        imap_host: acc.imap_host, imap_port: String(acc.imap_port),
        password_masked: masked,
      },
    });
    return;
  }

  const prefixes: Record<string, string[]> = {
    feishu: ["feishu_app_id", "feishu_app_secret", "feishu_webhook"],
    wecom:  ["wecom_corpid", "wecom_secret", "wecom_agent_id", "wecom_webhook"],
    dingtalk: ["dingtalk_app_key", "dingtalk_app_secret", "dingtalk_webhook"],
  };
  const keys = prefixes[service];
  if (!keys) { sendJson(res, 400, { error: "未知服务: " + service }); return; }
  const config: Record<string, string> = {};
  for (const k of keys) {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = $1", [k]);
    config[k] = rows[0]?.value || "";
  }
  const masked = { ...config };
  for (const k of keys) {
    if ((k.includes("secret") || k.includes("webhook")) && masked[k]) {
      masked[k + "_masked"] = masked[k].slice(0, 6) + "****" + masked[k].slice(-4);
      delete masked[k];
    }
  }
  sendJson(res, 200, { config: masked });
}

export async function handleSaveServiceConfig(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);
  const service = s(body.service);

  if (service === "email") {
    const email = s(body.email);
    const password = s(body.password);
    if (!email) { sendJson(res, 400, { error: "邮箱地址不能为空" }); return; }

    const auto = autoDetectMailServer(email);
    const smtpHost = s(body.smtp_host) || auto.smtp;
    const smtpPort = Number(body.smtp_port) || auto.smtpPort;
    const imapHost = s(body.imap_host) || auto.imap;
    const imapPort = Number(body.imap_port) || auto.imapPort;

    if (!password || password.includes("****")) {
      const { rows: ex } = await db.query("SELECT id FROM opc_email_accounts WHERE user_id = $1 AND email = $2", [userId, email]);
      if (ex.length > 0) {
        sendJson(res, 200, { success: true, message: "邮箱已配置，如需更新授权码请重新填写" });
        return;
      }
      sendJson(res, 400, { error: "请填写授权码" }); return;
    }

    const { rows: existing } = await db.query("SELECT id FROM opc_email_accounts WHERE user_id = $1 AND email = $2", [userId, email]);
    if (existing.length > 0) {
      await db.query(
        "UPDATE opc_email_accounts SET imap_host=$1, imap_port=$2, smtp_host=$3, smtp_port=$4, password=$5, enabled=true WHERE id=$6",
        [imapHost, imapPort, smtpHost, smtpPort, password, existing[0].id],
      );
    } else {
      const { v4: uuidv4 } = await import("uuid");
      await db.query(
        `INSERT INTO opc_email_accounts (id, user_id, email, imap_host, imap_port, smtp_host, smtp_port, password, enabled, last_uid, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,0,NOW())`,
        [uuidv4(), userId, email, imapHost, imapPort, smtpHost, smtpPort, password],
      );
    }
    syncSmtpFromAccount(db, userId);
    sendJson(res, 200, { success: true, message: "邮箱配置已保存，系统将自动拉取邮件" });
    return;
  }

  const allowed: Record<string, string[]> = {
    feishu: ["feishu_app_id", "feishu_app_secret", "feishu_webhook"],
    wecom:  ["wecom_corpid", "wecom_secret", "wecom_agent_id", "wecom_webhook"],
    dingtalk: ["dingtalk_app_key", "dingtalk_app_secret", "dingtalk_webhook"],
  };
  const keys = allowed[service];
  if (!keys) { sendJson(res, 400, { error: "未知服务" }); return; }
  for (const k of keys) {
    if (body[k] !== undefined && !String(body[k]).includes("****")) {
      await db.query(
        "INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [k, String(body[k])],
      );
    }
  }
  sendJson(res, 200, { success: true });
}

function autoDetectMailServer(email: string): { smtp: string; smtpPort: number; imap: string; imapPort: number } {
  const domain = (email.split("@")[1] || "").toLowerCase();
  const map: Record<string, { smtp: string; smtpPort: number; imap: string; imapPort: number }> = {
    "163.com":     { smtp: "smtp.163.com",         smtpPort: 465, imap: "imap.163.com",             imapPort: 993 },
    "126.com":     { smtp: "smtp.126.com",         smtpPort: 465, imap: "imap.126.com",             imapPort: 993 },
    "yeah.net":    { smtp: "smtp.yeah.net",        smtpPort: 465, imap: "imap.yeah.net",            imapPort: 993 },
    "qq.com":      { smtp: "smtp.qq.com",          smtpPort: 465, imap: "imap.qq.com",              imapPort: 993 },
    "foxmail.com": { smtp: "smtp.qq.com",          smtpPort: 465, imap: "imap.qq.com",              imapPort: 993 },
    "gmail.com":   { smtp: "smtp.gmail.com",       smtpPort: 465, imap: "imap.gmail.com",           imapPort: 993 },
    "outlook.com": { smtp: "smtp.office365.com",   smtpPort: 587, imap: "outlook.office365.com",    imapPort: 993 },
    "hotmail.com": { smtp: "smtp.office365.com",   smtpPort: 587, imap: "outlook.office365.com",    imapPort: 993 },
    "sina.com":    { smtp: "smtp.sina.com",        smtpPort: 465, imap: "imap.sina.com",            imapPort: 993 },
    "sohu.com":    { smtp: "smtp.sohu.com",        smtpPort: 465, imap: "imap.sohu.com",            imapPort: 993 },
    "aliyun.com":  { smtp: "smtp.aliyun.com",      smtpPort: 465, imap: "imap.aliyun.com",          imapPort: 993 },
  };
  return map[domain] || { smtp: "smtp." + domain, smtpPort: 465, imap: "imap." + domain, imapPort: 993 };
}

async function syncSmtpFromAccount(db: Db, userId: string) {
  try {
    const { rows } = await db.query(
      "SELECT email, smtp_host, smtp_port, password FROM opc_email_accounts WHERE user_id = $1 AND enabled = true ORDER BY created_at LIMIT 1",
      [userId],
    );
    if (rows.length > 0) {
      const { configureSmtp } = await import("../chat/tool-executor.js");
      configureSmtp({ host: rows[0].smtp_host, port: rows[0].smtp_port, user: rows[0].email, pass: rows[0].password });
    }
  } catch (e) { console.error("[syncSmtp]", e); }
}

// ─── AI Staff Config ──────────────────────────────────────────────────

const DEFAULT_STAFF_ROLES: { role: string; role_name: string; icon: string; color: string; desc: string; system_prompt: string }[] = [
  {
    role: "ceo_assistant", role_name: "CEO 助理 · 战略执行官", icon: "🎯", color: "#f97316",
    desc: "全局战略规划、OKR拆解、日程编排、决策支撑",
    system_prompt: `你是一位顶级 CEO 助理（Chief of Staff），具备战略思维和极强的执行力。
核心职责：
1. 接收用户的战略意图，将其拆解为可执行的 OKR / 任务清单
2. 协调各部门（财务、法务、HR、市场、技术）的工作优先级
3. 每日生成"CEO日报"，汇总关键指标、待办事项、风险预警
4. 辅助决策：提供数据驱动的分析和多方案对比
工作风格：高效、精准、善于抓重点。回答应结构化，先结论后论据。
输出格式偏好：使用 Markdown 表格、清单、时间线。`,
  },
  {
    role: "cfo", role_name: "财务总监 · AI 财税专家", icon: "💰", color: "#16a34a",
    desc: "日常账务处理、税务管理、报表编制、资金管理、成本核算、财务档案",
    system_prompt: `你是一位资深 CFO / 财务总监，精通中国中小企业财税管理，按月度SOP标准化流程执行财务工作。

## 一、日常账务处理（每日持续）
- 自动识别发票类型（增值税专票/普票/电子发票）、金额、日期，按科目归类
- 根据业务单据自动生成记账凭证草稿（需人工复核确认）
- 自动下载银行流水进行智能对账匹配，标记异常交易（大额/非工作时间/摘要不规范）
- 账务调整需基于业务实质做专业判断

## 二、税务管理（月初1-3日准备，月中10-15日申报）
- 发票验真与归档：验证发票真伪，检测电子发票重复报销
- 进项税抵扣计算：自动计算可抵扣进项税额，关注抵扣时效
- 纳税申报：根据账务数据自动生成增值税/所得税申报表，校验表间勾稽关系
- 税务风险扫描：识别潜在税务风险点，按风险等级排序
- 税务筹划：结合业务战略制定税务优化方案

## 三、报表编制（月末25-31日）
- 自动汇总科目余额表（期初、本期、期末）
- 自动生成资产负债表、利润表、现金流量表
- 报表勾稽校验（基础勾稽+业务逻辑+异常波动三层校验）
- 管理报表定制：按需求生成管理分析报表
- 数据洞察：核心指标分析、趋势判断、同环比对比

## 四、资金管理（全月持续）
- 资金流水汇总：归集各账户收支明细
- 资金余额监控：实时监控账户余额，预警提示
- 付款审核：核对付款信息，校验资金安全红线
- 资金计划：预测现金流，编制资金使用计划
- 大额支付需分级审批确认

## 五、成本核算（月末20-28日）
- 成本数据归集：自动归集料工费等成本要素
- 成本分配计算：按预设规则分配间接成本
- 成本报表生成：成本结构分析、料工费占比
- 成本差异分析：实际vs预算差异，标注原因
- 成本控制建议：目标设定、降本增效措施

## 六、财务档案管理
- 电子档案按年/月/类别自动归档
- 档案索引建立，支持快速检索
- 完整性检查：检测缺失档案并提醒补充

## 月度工作节奏
| 时间段 | 重点工作 |
|--------|----------|
| 月初1-3日 | 上月结账、报表生成、纳税申报准备 |
| 月中10-15日 | 纳税申报、税款缴纳、资金计划执行 |
| 月末25-31日 | 成本核算、账务结转、档案归档 |
| 全月持续 | 日常账务处理、资金收付、凭证审核 |

## 专业能力
- 熟悉小规模/一般纳税人政策、专票/普票区别、季度申报流程
- 精通银企对账、应收应付管理、现金流预测
- 掌握成本分配规则（作业成本法/标准成本法）
- AI定位为"辅助工具"，最终审核责任在财务人员

## 回答风格
严谨但易懂，复杂概念用类比解释。每次回答给出：
1. 当前状态判断
2. 具体可执行的下一步操作
3. 风险提示（如有）
关键数字用加粗标注，风险用 ⚠️ 标记。`,
  },
  {
    role: "legal_counsel", role_name: "法务顾问 · AI 合规专家", icon: "⚖️", color: "#7c3aed",
    desc: "合同审查、风险评估、知识产权保护、合规咨询",
    system_prompt: `你是一位经验丰富的企业法务顾问，专注于中小企业合规与风险管理。
核心职责：
1. 合同审查：识别合同中的关键条款、潜在风险、不合理条款
2. 合同起草：根据业务场景生成标准合同模板（服务协议、保密协议、劳动合同等）
3. 风险评估：对商业决策进行法律风险评级（低/中/高）
4. 知识产权：商标注册建议、软件著作权、竞业限制
5. 合规提醒：劳动法、数据安全法、反垄断等合规要求
工作原则：风险提示必须明确等级和应对方案，不做模糊的"建议咨询律师"。
输出偏好：关键风险用 ⚠️ 标注，建议按紧急程度排序。`,
  },
  {
    role: "hr_director", role_name: "人力总监 · AI 组织专家", icon: "👥", color: "#0ea5e9",
    desc: "考勤管理、薪资核算、员工关系、招聘配置、培训发展、社保公积金、人事报表",
    system_prompt: `你是一位专业的 HR 总监 / 组织发展专家，按月度SOP标准化流程管理人力资源。

## 一、月度考勤管理（每月1-5日核算确认）
### AI自动执行（每月1-2日）
- 同步考勤数据（打卡机/企业微信/飞书），统计全员出勤
- 生成基础考勤报表：迟到、早退、旷工、请假、加班时长明细
- 识别考勤异常（未打卡/重复打卡/地点异常），标注异常人员
- 自动核算月度应出勤vs实际出勤，关联请假、加班数据
- 发送考勤异常提醒给对应员工（截止每月2日17:00）
### 需要协同确认（每月3-4日）
- 确认异常明细：核对补签、请假手续是否齐全
- 核对考勤报表：出勤天数、加班时长、请假天数
- 确认核算结果：同步给财务作为薪资核算依据（截止每月5日17:00）
### 仅人工处理
- 特殊考勤：公出、外勤未打卡、紧急情况处理
- 异常申诉处理（截止每月4日17:00）
- 月末考勤总结与优化建议（每月28-29日）

## 二、月度薪资核算（每月5-12日）
### AI自动执行（每月5-6日）
- 同步考勤+基础薪资信息，生成核算框架
- 核算明细：基本工资、岗位工资、绩效工资、加班费、请假扣款、社保公积金扣缴、个税
- 生成薪资条初稿（按员工维度整理）
- 校验薪资公式（加班比例、个税起征点、社保比例）
### 需要协同确认（每月7-8日）
- 确认绩效数据、核对薪资明细
- 确认个税与社保公积金扣缴金额
- 薪资条全量审核（截止每月8日17:00）
### 仅人工处理
- 特殊薪资项录入（奖金/罚款/带薪休假补贴/离职结算）
- 薪资异常处理（试用期/调薪/离职结算）
- 协调财务发放薪资（每月10-12日）
- 薪资资料归档（每月13日）

## 三、员工关系管理（每月10-15日处理变动，25-28日总结）
### AI自动执行
- 统计月度员工变动（入职/离职/调岗/转正），生成变动报表
- 员工关怀：自动识别生日、入职周年发送祝福；提醒合同到期（30天前）、试用期到期（7天前）
- 收集整理员工月度反馈，分类汇总高频问题
- 统计离职率、转正率、调岗率
### 需要协同确认
- 确认变动信息：手续齐全性检查
- 核对关怀覆盖：补充遗漏员工
- 确认反馈汇总的真实有效性
### 仅人工处理
- 入职办理：合同签订、信息录入、制度讲解、物品领取
- 离职办理：工作交接、薪资结清、物品收回、面谈记录
- 试用期跟踪考核、转正评审
- 员工冲突/投诉处理（24小时内响应）

## 四、招聘与配置（每月5日前定计划，28日总结）
### AI自动执行
- 简历筛选：按岗位要求自动匹配（学历/经验/技能）
- 发送面试邀请/笔试通知（筛选通过后24小时内）
- 统计招聘进度报表（岗位数/简历数/面试数/录用数）
- 优化招聘文案，突出岗位亮点和薪资福利
### 仅人工处理
- 制定月度招聘计划（岗位/人数/优先级/渠道）
- 组织面试/笔试，评估候选人
- 录用决策、薪酬谈判、发放offer
- 招聘渠道管理与效果评估

## 五、培训与发展（每月10日前定计划，25日前评估归档）
### AI自动执行
- 收集培训需求（问卷/部门提交），分类汇总
- 生成培训计划初稿（主题/时间/对象/形式）
- 发送培训通知（培训前3个工作日）
- 统计培训出勤数据
### 仅人工处理
- 联系讲师、准备物料、布置场地
- 主持培训现场
- 培训效果评估（培训后3个工作日内）
- 培训资料归档（每月23-25日）

## 六、社保公积金管理（每月1-10日申报缴纳，25-28日核对归档）
### AI自动执行（每月1-3日）
- 同步员工变动信息，更新参保人员名单（新增/停缴/基数调整）
- 核算月度社保公积金缴纳基数和金额（个人+公司）
- 校验缴纳比例（养老/医疗/失业/工伤/生育/公积金），匹配当地政策
- 发送基数调整/停缴提醒（截止每月3日17:00）
### 需要协同确认（每月4-6日）
- 确认参保人员变动、缴纳基数与金额
- 确认政策匹配性
### 仅人工处理
- 登录官网完成申报（每月7-8日）
- 缴纳跟进与核对（每月9-10日）
- 补缴/基数调整/异地转移/提取审核
- 员工社保咨询（24小时内响应）
- 月末核对归档（每月25-28日）

## 七、月度人事报表与总结（每月28-31日）
- 整合月度考勤/薪资/变动/招聘/培训/社保数据
- 生成核心报表：花名册/考勤/薪资/招聘/培训/社保报表
- 计算核心指标：离职率/转正率/到岗率/培训参与率/社保合规率
- 生成人事工作总结初稿

## 专业能力
- 熟悉中国劳动法、社保政策、个税计算、竞业限制
- 掌握薪酬体系设计（宽带薪酬/岗位评估/市场对标）
- 精通绩效管理（KPI/OKR/BSC）
- 熟悉招聘全流程（JD撰写/面试设计/薪酬定级）

## 回答风格
温暖但专业，在效率和人文关怀间取得平衡。每次回答：
1. 明确当前处于月度哪个节点
2. 给出具体的执行步骤和时间节点
3. 区分AI可自动完成 vs 需要人工确认的工作
关键截止日期用 ⏰ 标注，风险用 ⚠️ 标记。`,
  },
  {
    role: "cmo", role_name: "市场总监 · AI 增长专家", icon: "📢", color: "#ec4899",
    desc: "品牌策略、内容营销、社交媒体运营、SEO/SEM、用户增长",
    system_prompt: `你是一位精通数字营销的 CMO / 增长专家，借鉴 Growth Hacker 理念。
核心职责：
1. 品牌策略：品牌定位、视觉识别、品牌故事撰写
2. 内容营销：公众号/知乎/小红书/抖音多平台内容规划
3. 用户增长：获客漏斗分析、转化率优化、病毒传播机制
4. SEO/SEM：关键词策略、着陆页优化、广告投放建议
5. 竞品分析：市场格局、竞争对手动态、差异化策略
工作风格：数据驱动、创意优先。每个建议都附带预期效果和衡量指标。
灵感来源：雷军的营销智慧——用户口碑 > 硬广，做爆品思维。`,
  },
  {
    role: "cto", role_name: "技术总监 · AI 架构师", icon: "🛠️", color: "#2563eb",
    desc: "技术选型、架构设计、DevOps、安全审计、技术债务管理",
    system_prompt: `你是一位全栈技术总监 / 架构师，拥有丰富的工程管理经验。
核心职责：
1. 技术选型：根据业务规模和预算推荐最优技术栈
2. 架构设计：系统架构、数据库设计、API 规范
3. DevOps：CI/CD流程、部署策略、监控告警
4. 安全审计：代码安全、数据加密、权限管理
5. 技术债务：识别、量化并制定偿还计划
工作原则：简单优于复杂，可靠优于花哨。始终考虑成本与可维护性。
回答风格：给出明确的技术方案，附带架构图（Markdown/Mermaid）、代码示例、预估工时。`,
  },
  {
    role: "product_manager", role_name: "产品经理 · AI 需求分析师", icon: "🎨", color: "#a855f7",
    desc: "需求分析、产品规划、用户研究、原型设计、Sprint管理",
    system_prompt: `你是一位资深产品经理，擅长将模糊需求转化为清晰的产品方案。
核心职责：
1. 需求分析：用户访谈提纲、需求优先级矩阵（RICE/MoSCoW）
2. 产品规划：路线图制定、版本迭代计划、MVP定义
3. 用户研究：用户画像、使用场景、痛点分析
4. PRD撰写：功能需求文档、交互说明、验收标准
5. Sprint管理：任务拆解、工作量评估、进度跟踪
工作风格：以用户价值为导向，用数据说话，善于在多方需求中找到平衡。
输出偏好：用户故事格式（As a..., I want..., So that...）、流程图、线框图描述。`,
  },
  {
    role: "operations", role_name: "运营总监 · AI 效率专家", icon: "⚡", color: "#f59e0b",
    desc: "流程优化、项目管理、供应链协调、数据运营、客户成功",
    system_prompt: `你是一位运营总监 / 项目交付专家，擅长让团队高效运转。
核心职责：
1. 流程优化：识别瓶颈、设计 SOP、自动化建议
2. 项目管理：甘特图、里程碑跟踪、风险管理
3. 数据运营：关键指标仪表盘、日报/周报/月报模板
4. 客户成功：客户生命周期管理、续约策略、NPS提升
5. 供应链：供应商管理、采购流程、库存优化
工作风格：结果导向，用"完成比完美"的哲学推动项目前进。
输出偏好：清单式、时间节点明确、责任到人。`,
  },
];

export async function handleInitStaff(req: AuthRequest, res: ServerResponse, db: Db, companyId: string) {
  if (!requireAuth(req, res)) return;
  if (!(await checkAccess(db, req.user!.userId, companyId, "admin"))) { sendJson(res, 403, { error: "需要管理员以上权限" }); return; }
  let created = 0;
  for (const r of DEFAULT_STAFF_ROLES) {
    const { rows } = await db.query("SELECT 1 FROM opc_staff_config WHERE company_id = $1 AND role = $2", [companyId, r.role]);
    if (rows.length === 0) {
      await db.query(
        "INSERT INTO opc_staff_config (id, company_id, role, role_name, system_prompt, notes) VALUES ($1, $2, $3, $4, $5, $6)",
        [uuid(), companyId, r.role, r.role_name, r.system_prompt, r.desc]
      );
      created++;
    }
  }
  sendJson(res, 200, { ok: true, created });
}

export async function handleToggleStaff(req: AuthRequest, res: ServerResponse, db: Db, staffId: string) {
  if (!requireAuth(req, res)) return;
  const staff = await ensureStaffAccess(req, res, db, staffId, "admin");
  if (!staff) return;
  const body = await parseBody(req);
  if (body.swarm_enabled !== undefined) {
    await db.query("UPDATE opc_staff_config SET swarm_enabled = $1, updated_at = NOW() WHERE id = $2", [body.swarm_enabled ? 1 : 0, staffId]);
  } else {
    await db.query("UPDATE opc_staff_config SET enabled = $1, updated_at = NOW() WHERE id = $2", [body.enabled ? 1 : 0, staffId]);
  }
  sendJson(res, 200, { ok: true });
}

export async function handleEditStaff(req: AuthRequest, res: ServerResponse, db: Db, staffId: string) {
  if (!requireAuth(req, res)) return;
  const staff = await ensureStaffAccess(req, res, db, staffId, "admin");
  if (!staff) return;
  const body = await parseBody(req);
  const sets: string[] = ["updated_at = NOW()"];
  const vals: unknown[] = [];
  let idx = 1;
  if (body.role_name !== undefined) { sets.push(`role_name = $${idx++}`); vals.push(String(body.role_name)); }
  if (body.system_prompt !== undefined) { sets.push(`system_prompt = $${idx++}`); vals.push(String(body.system_prompt)); }
  if (body.notes !== undefined) { sets.push(`notes = $${idx++}`); vals.push(String(body.notes)); }
  vals.push(staffId);
  await db.query(`UPDATE opc_staff_config SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
  sendJson(res, 200, { ok: true });
}

export async function handleGetStaff(req: AuthRequest, res: ServerResponse, db: Db, staffId: string) {
  if (!requireAuth(req, res)) return;
  const staff = await ensureStaffAccess(req, res, db, staffId, "admin");
  if (!staff) return;
  sendJson(res, 200, staff);
}

// ─── Skills ───────────────────────────────────────────────────────────

const PRESET_SKILLS = [
  { name: "竞品分析师", category: "business", description: "深入分析行业竞争格局，找出差异化竞争策略",
    prompt: "你是一位专业的竞品分析师。当用户提到竞争对手或市场竞争时，请从以下维度进行分析：\n1. 竞品的核心产品/服务\n2. 定价策略\n3. 目标客户群体\n4. 营销渠道\n5. 优势与劣势\n6. 差异化机会\n\n输出格式为结构化报告，包含可执行的建议。" },
  { name: "商业模式设计师", category: "business", description: "帮助设计和优化一人公司的商业模式",
    prompt: "你是一位商业模式设计专家，熟悉 OPB（One Person Business）画布的 16 个模块。当用户讨论商业模式时，请用 OPB 框架分析：\n- 客户层：目标客户、痛点、解决方案、独特价值\n- 价值层：渠道、收入模式、成本结构、关键资源\n- 运营层：关键活动、关键伙伴、非竞争优势、核心指标\n- 战略层：规模化策略、笔记\n帮助用户填充每个模块，给出具体建议。" },
  { name: "税务顾问", category: "finance", description: "提供税务策划和纳税申报指导",
    prompt: "你是一位精通中国税法的税务顾问。当用户咨询税务问题时，请：\n1. 明确公司类型和纳税人资格\n2. 分析适用的税收优惠政策（小微企业、小规模纳税人等）\n3. 计算应缴税额\n4. 提醒纳税申报截止日期\n5. 给出合规的税务策划建议\n\n重要：始终强调合规经营，不提供任何避税建议。" },
  { name: "合同审查助手", category: "legal", description: "审查合同条款，识别风险点",
    prompt: "你是一位合同法务专家。当用户讨论合同时，请重点关注：\n1. 合同主体资质\n2. 权利义务对等性\n3. 违约责任条款\n4. 争议解决机制\n5. 知识产权条款\n6. 保密条款\n7. 终止条件\n\n标记风险等级（高/中/低），给出修改建议。" },
  { name: "内容营销策划师", category: "marketing", description: "策划内容营销方案，提升品牌影响力",
    prompt: "你是一位内容营销专家。当用户需要营销建议时，请：\n1. 分析目标受众\n2. 制定内容日历\n3. 针对不同平台优化内容\n4. 写作吸引人的标题和文案\n5. 建议 SEO 关键词\n6. 设计转化漏斗\n\n输出可直接使用的内容方案。" },
  { name: "商业报告写手", category: "writing", description: "撰写专业的商业报告和文档",
    prompt: "你是一位专业的商业写作顾问。当用户需要写报告时，请：\n1. 用清晰的结构和逻辑\n2. 配合数据支撑观点\n3. 根据读者调整语气\n4. 提供执行摘要\n5. 包含可视化建议\n\n支持的文档类型：商业计划书、投资提案、市场分析报告、周/月报、邮件。" },
  { name: "公司注册顾问", category: "legal", description: "指导一人公司注册流程和合规要求",
    prompt: "你是一位精通中国公司注册法规的顾问。帮助用户了解一人有限责任公司的注册流程：\n1. 核名规则和技巧\n2. 注册资本建议（认缴制说明）\n3. 经营范围选择\n4. 所需材料清单\n5. 注册地址要求\n6. 银行开户流程\n7. 税务登记和发票申请\n8. 社保开户\n\n特别提醒一人公司的法律责任和财务审计要求。" },
  { name: "财务分析师", category: "finance", description: "分析公司财务数据，提供经营建议",
    prompt: "你是一位专业的财务分析师。当用户提供财务数据时，请：\n1. 分析收支结构和趋势\n2. 计算关键财务指标（毛利率、净利率、现金流等）\n3. 与行业平均水平对比\n4. 识别成本优化空间\n5. 预测现金流状况\n6. 给出具体的改善建议\n\n用简明扼要的语言呈现分析结果，附带直观的数据对比。" },
  { name: "客户开发专家", category: "marketing", description: "帮助制定客户获取和留存策略",
    prompt: "你是一位客户开发专家，擅长帮助一人公司拓展客户。请帮助用户：\n1. 定义理想客户画像\n2. 设计客户获取漏斗\n3. 制定冷启动策略\n4. 设计客户留存方案\n5. 建立转介绍机制\n6. 优化客户沟通话术\n7. 制定定价策略\n\n注重低成本、高效率的获客方式，适合一人公司的资源条件。" },
  { name: "周报月报助手", category: "writing", description: "快速生成结构化的工作周报和月报",
    prompt: "你是一位高效的工作汇报助手。帮助用户整理工作成果：\n1. 本周/月完成的关键任务\n2. 取得的成果和数据\n3. 遇到的问题和解决方案\n4. 下周/月计划\n5. 需要的支持和资源\n\n格式要求：条理清晰、重点突出、数据说话。可根据不同汇报对象调整风格。" },
  { name: "网页清洗抓取师", category: "tech", description: "定向抓取网页正文并清洗成可分析文本",
    prompt: "你是一位网页内容清洗与提取专家。请把给定网页整理成可分析材料：\n1. 保留标题、来源、发布时间、正文主体\n2. 去掉导航、广告、版权、推荐阅读和脚本样式等噪声\n3. 如果正文质量差、乱码多或只有列表页，要明确指出\n4. 输出优先使用结构化格式：标题、链接、来源、发布时间、摘要、正文、质量等级\n\n适用场景：政策公告、招标公告、新闻详情、园区动态、企业官网介绍页。原则：不编造时间、不补造正文。" },
  { name: "政采机会分析师", category: "business", description: "把政策、招投标、园区动态提炼成可跟进机会",
    prompt: "你是一位面向政府政策、招投标和园区招商的机会分析师。你的目标是把原始网页内容提炼成可销售、可撮合、可跟进的机会对象，而不是简单复述原文。\n请重点输出：\n1. 机会类型\n2. 地区（省、市、区县）\n3. 关键主体（甲方、代理机构、主管部门）\n4. 预算或金额线索\n5. 当前阶段（线索发现/招采报名/结果公示/可拜访/长期培育）\n6. 可售服务切口\n7. 下一步动作\n\n如果信息缺失或页面质量差，要明确写出风险和不确定性。" },
  { name: "定向搜站助手", category: "tech", description: "在政府站、招投标站、园区站中搜索高价值候选链接",
    prompt: "你是一位定向站点搜索助手，擅长在可信站点中寻找少量高价值候选链接。适用站点包括政府门户、主管部门、交易中心、政府采购网、园区官网、平台公司公告页。\n工作原则：\n1. 先按地区、主题、机会类型收窄搜索范围\n2. 优先返回3到8条高价值候选链接，宁少勿滥\n3. 优先保留标题清晰、来源可信、时间较新、具备商业机会属性的页面\n4. 剔除乱码页、转载页、纯列表页、聚合噪声页\n\n输出格式优先包含：搜索词、站点范围、候选结果、推荐继续抓取的原因、下一步建议。" },
];

async function seedPresetSkills(db: Db, userId: string) {
  const { rows } = await db.query("SELECT COUNT(*) as c FROM opc_skills WHERE user_id = $1", [userId]);
  if (Number(rows[0].c) > 0) return;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const sk of PRESET_SKILLS) {
      await client.query(
        "INSERT INTO opc_skills (id, user_id, name, description, category, prompt, enabled) VALUES ($1, $2, $3, $4, $5, $6, 1)",
        [uuid(), userId, sk.name, sk.description, sk.category, sk.prompt]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function handleListSkills(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  await seedPresetSkills(db, req.user!.userId);
  const { rows } = await db.query("SELECT * FROM opc_skills WHERE user_id = $1 ORDER BY created_at DESC", [req.user!.userId]);
  sendJson(res, 200, rows);
}

export async function handleGetMemoryCenter(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const [memoryResult, reflectionResult, skillResult, recentSkillUsageResult] = await Promise.all([
    db.query(
      `SELECT id, company_id, category, content, importance, source_conv_id, created_at, updated_at, is_active
       FROM opc_user_memories
       WHERE user_id = $1
       ORDER BY is_active DESC, importance DESC, updated_at DESC
       LIMIT 120`,
      [userId],
    ),
    db.query(
      `SELECT id, company_id, source_conv_id, summary, lessons_json, style_adjustments_json, tools_json, created_at, updated_at, is_active
       FROM opc_agent_reflections
       WHERE user_id = $1
       ORDER BY is_active DESC, updated_at DESC
       LIMIT 60`,
      [userId],
    ),
    db.query(
      `SELECT s.*,
              COALESCE(u.usage_count, 0) AS usage_count,
              u.last_used_at
       FROM opc_skills s
       LEFT JOIN (
         SELECT skill_name, COUNT(*) AS usage_count, MAX(created_at) AS last_used_at
         FROM opc_skill_usage
         WHERE user_id = $1
         GROUP BY skill_name
       ) u ON u.skill_name = s.name
       WHERE s.user_id = $1
       ORDER BY COALESCE(u.usage_count, 0) DESC, s.updated_at DESC`,
      [userId],
    ),
    db.query(
      `SELECT skill_name, category, task, status, output_preview, created_at
       FROM opc_skill_usage
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [userId],
    ),
  ]);

  const memories = (memoryResult.rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    is_active: row.is_active === true || row.is_active === 1,
  }));

  const reflections = (reflectionResult.rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    lessons: safeParseJsonArray(row.lessons_json),
    style_adjustments: safeParseJsonArray(row.style_adjustments_json),
    tools: safeParseJsonArray(row.tools_json),
    is_active: row.is_active === true || row.is_active === 1,
  }));

  const skills = (skillResult.rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    enabled: row.enabled === true || row.enabled === 1,
    usage_count: Number(row.usage_count || 0),
  }));

  const recentSkillUsage = (recentSkillUsageResult.rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    task: String(row.task || ""),
    output_preview: String(row.output_preview || ""),
  }));

  sendJson(res, 200, {
    stats: {
      active_memories: memories.filter((item) => item.is_active).length,
      active_reflections: reflections.filter((item) => item.is_active).length,
      installed_skills: skills.length,
      active_skills: skills.filter((item) => item.enabled).length,
      total_skill_runs: recentSkillUsage.reduce((sum, item) => sum + 1, 0),
    },
    memories,
    reflections,
    skills,
    recent_skill_usage: recentSkillUsage,
  });
}

export async function handleUpdateMemory(req: AuthRequest, res: ServerResponse, db: Db, memoryId: string) {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows: existing } = await db.query(
    "SELECT id FROM opc_user_memories WHERE id = $1 AND user_id = $2 LIMIT 1",
    [memoryId, userId],
  );
  if (!existing[0]) {
    sendJson(res, 404, { error: "记忆不存在" });
    return;
  }
  const body = await parseBody(req);
  const sets: string[] = ["updated_at = NOW()"];
  const vals: unknown[] = [];
  let idx = 1;
  if (body.content !== undefined) { sets.push(`content = $${idx++}`); vals.push(String(body.content || "").trim()); }
  if (body.category !== undefined) { sets.push(`category = $${idx++}`); vals.push(String(body.category || "fact")); }
  if (body.importance !== undefined) { sets.push(`importance = $${idx++}`); vals.push(Math.max(1, Math.min(10, Number(body.importance || 5)))); }
  if (body.is_active !== undefined) { sets.push(`is_active = $${idx++}`); vals.push(!!body.is_active); }
  vals.push(memoryId, userId);
  await db.query(`UPDATE opc_user_memories SET ${sets.join(", ")} WHERE id = $${idx++} AND user_id = $${idx}`, vals);
  const { rows } = await db.query("SELECT * FROM opc_user_memories WHERE id = $1", [memoryId]);
  sendJson(res, 200, rows[0] || { ok: true });
}

export async function handleUpdateReflection(req: AuthRequest, res: ServerResponse, db: Db, reflectionId: string) {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows: existing } = await db.query(
    "SELECT id FROM opc_agent_reflections WHERE id = $1 AND user_id = $2 LIMIT 1",
    [reflectionId, userId],
  );
  if (!existing[0]) {
    sendJson(res, 404, { error: "复盘不存在" });
    return;
  }
  const body = await parseBody(req);
  const sets: string[] = ["updated_at = NOW()"];
  const vals: unknown[] = [];
  let idx = 1;
  if (body.summary !== undefined) { sets.push(`summary = $${idx++}`); vals.push(String(body.summary || "").trim()); }
  if (body.lessons !== undefined) { sets.push(`lessons_json = $${idx++}`); vals.push(JSON.stringify(Array.isArray(body.lessons) ? body.lessons : [])); }
  if (body.style_adjustments !== undefined) { sets.push(`style_adjustments_json = $${idx++}`); vals.push(JSON.stringify(Array.isArray(body.style_adjustments) ? body.style_adjustments : [])); }
  if (body.is_active !== undefined) { sets.push(`is_active = $${idx++}`); vals.push(!!body.is_active); }
  vals.push(reflectionId, userId);
  await db.query(`UPDATE opc_agent_reflections SET ${sets.join(", ")} WHERE id = $${idx++} AND user_id = $${idx}`, vals);
  const { rows } = await db.query("SELECT * FROM opc_agent_reflections WHERE id = $1", [reflectionId]);
  sendJson(res, 200, rows[0] || { ok: true });
}

export async function handlePromoteReflectionToSkill(req: AuthRequest, res: ServerResponse, db: Db, reflectionId: string) {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query(
    `SELECT id, summary, lessons_json, style_adjustments_json, tools_json
     FROM opc_agent_reflections
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [reflectionId, userId],
  );
  const reflection = rows[0] as {
    id: string;
    summary: string;
    lessons_json: string;
    style_adjustments_json: string;
    tools_json: string;
  } | undefined;
  if (!reflection) {
    sendJson(res, 404, { error: "复盘不存在" });
    return;
  }

  const body = await parseBody(req);
  const requestedName = String(body.name || "").trim();
  const requestedDescription = String(body.description || "").trim();
  const requestedCategory = String(body.category || "efficiency").trim();
  const name = (requestedName || reflection.summary || "复盘技能").slice(0, 24);
  const lessons = safeParseJsonArray(reflection.lessons_json);
  const styleAdjustments = safeParseJsonArray(reflection.style_adjustments_json);
  const tools = safeParseJsonArray(reflection.tools_json);
  const description = (requestedDescription || reflection.summary || "从复盘经验沉淀出的可复用工作流").slice(0, 120);
  const prompt = [
    `你是专项执行技能「${name}」。`,
    description,
    lessons.length ? `执行原则：\n${lessons.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}` : "",
    styleAdjustments.length ? `风格要求：\n${styleAdjustments.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}` : "",
    tools.length ? `优先结合这些工具或能力：${tools.join("、")}` : "",
    "输出时先给结论，再给行动步骤，避免空泛复述。若信息不足，明确指出缺口并给出下一步收集建议。",
  ].filter(Boolean).join("\n\n");

  const { rows: existing } = await db.query(
    "SELECT id FROM opc_skills WHERE user_id = $1 AND name = $2 LIMIT 1",
    [userId, name],
  );

  let skillId = "";
  if (existing[0]) {
    skillId = String((existing[0] as { id: string }).id);
    await db.query(
      `UPDATE opc_skills
       SET description = $1, category = $2, prompt = $3, enabled = 1, updated_at = NOW()
       WHERE id = $4`,
      [description, requestedCategory || "efficiency", prompt, skillId],
    );
  } else {
    skillId = uuid();
    await db.query(
      `INSERT INTO opc_skills (id, user_id, name, description, category, prompt, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, NOW(), NOW())`,
      [skillId, userId, name, description, requestedCategory || "efficiency", prompt],
    );
  }

  const { rows: skillRows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [skillId]);
  sendJson(res, 200, {
    ok: true,
    skill: skillRows[0],
    created: !existing[0],
    message: existing[0] ? "已更新同名 Skill" : "已沉淀为新 Skill",
  });
}

export async function handleCreateSkill(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const id = uuid();
  await db.query(
    "INSERT INTO opc_skills (id, user_id, name, description, category, prompt, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, req.user!.userId, s(body.name), s(body.description), s(body.category, "general"), s(body.prompt), body.enabled !== false ? 1 : 0]
  );
  const { rows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [id]);
  sendJson(res, 201, rows[0]);
}

export async function handleUpdateSkill(req: AuthRequest, res: ServerResponse, db: Db, skillId: string) {
  if (!requireAuth(req, res)) return;
  const { rows: existRows } = await db.query("SELECT * FROM opc_skills WHERE id = $1 AND user_id = $2", [skillId, req.user!.userId]);
  if (existRows.length === 0) { sendJson(res, 404, { error: "Skill not found" }); return; }
  const body = await parseBody(req);
  const sets: string[] = ["updated_at = NOW()"];
  const vals: unknown[] = [];
  let idx = 1;
  if (body.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(String(body.name)); }
  if (body.description !== undefined) { sets.push(`description = $${idx++}`); vals.push(String(body.description)); }
  if (body.category !== undefined) { sets.push(`category = $${idx++}`); vals.push(String(body.category)); }
  if (body.prompt !== undefined) { sets.push(`prompt = $${idx++}`); vals.push(String(body.prompt)); }
  if (body.enabled !== undefined) { sets.push(`enabled = $${idx++}`); vals.push(body.enabled ? 1 : 0); }
  vals.push(skillId);
  await db.query(`UPDATE opc_skills SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
  const { rows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [skillId]);
  sendJson(res, 200, rows[0]);
}

export async function handleDeleteSkill(req: AuthRequest, res: ServerResponse, db: Db, skillId: string) {
  if (!requireAuth(req, res)) return;
  const { rows: existRows } = await db.query("SELECT * FROM opc_skills WHERE id = $1 AND user_id = $2", [skillId, req.user!.userId]);
  if (existRows.length === 0) { sendJson(res, 404, { error: "Skill not found" }); return; }
  await db.query("DELETE FROM opc_skills WHERE id = $1", [skillId]);
  sendJson(res, 200, { ok: true });
}

export async function handleToggleSkill(req: AuthRequest, res: ServerResponse, db: Db, skillId: string) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  await db.query(
    "UPDATE opc_skills SET enabled = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3",
    [body.enabled ? 1 : 0, skillId, req.user!.userId]
  );
  sendJson(res, 200, { ok: true });
}

export async function handleInstallCatalogSkill(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const name = String(body.name || "").trim();
  if (!name) { sendJson(res, 400, { error: "须提供 name" }); return; }

  const skill = SKILLS_CATALOG.find(s => s.name === name);
  if (!skill) { sendJson(res, 404, { error: `技能「${name}」不在内置目录中` }); return; }

  const { rows: existing } = await db.query(
    "SELECT id FROM opc_skills WHERE user_id = $1 AND name = $2 LIMIT 1",
    [req.user!.userId, name]
  );
  if (existing.length > 0) {
    await db.query(
      "UPDATE opc_skills SET enabled = 1, updated_at = NOW() WHERE user_id = $1 AND name = $2",
      [req.user!.userId, name]
    );
    const { rows } = await db.query("SELECT * FROM opc_skills WHERE user_id = $1 AND name = $2", [req.user!.userId, name]);
    sendJson(res, 200, { skill: rows[0], installed: false, message: "已重新激活" });
    return;
  }

  const id = uuid();
  await db.query(
    "INSERT INTO opc_skills (id, user_id, name, description, category, prompt, enabled) VALUES ($1,$2,$3,$4,$5,$6,1)",
    [id, req.user!.userId, skill.name, skill.description, skill.category, skill.prompt]
  );
  const { rows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [id]);
  sendJson(res, 201, { skill: rows[0], installed: true });
}

type ImportedSkillDraft = {
  name: string;
  description: string;
  category: string;
  prompt: string;
  sourceUrl: string;
  normalizedUrl: string;
  body: string;
};

type RemoteSkillCatalogItem = {
  name: string;
  repo: string;
  path: string;
  url: string;
  source: string;
  description: string;
  category: string;
};

let REMOTE_SKILL_CATALOG_CACHE: { expiresAt: number; items: RemoteSkillCatalogItem[] } = { expiresAt: 0, items: [] };

type EcosystemSkillHit = {
  package: string;
  owner: string;
  repo: string;
  skill: string;
  url: string;
  installs: string;
  title: string;
};

function normalizeSkillSourceUrl(rawUrl: string): string {
  let normalized = rawUrl.trim();
  if (!normalized) throw new Error("请提供 Skill 地址");
  if (!/^https?:\/\//i.test(normalized)) normalized = "https://" + normalized;
  const url = new URL(normalized);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("仅支持 http/https 地址");

  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 5 && parts[2] === "blob") {
      const owner = parts[0];
      const repo = parts[1];
      const ref = parts[3];
      const filePath = parts.slice(4).join("/");
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
    }
    if (parts.length >= 4 && parts[2] === "tree") {
      const owner = parts[0];
      const repo = parts[1];
      const ref = parts[3];
      const dirPath = parts.slice(4).join("/");
      const skillPath = dirPath ? `${dirPath.replace(/\/+$/, "")}/SKILL.md` : "SKILL.md";
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${skillPath}`;
    }
  }

  if (url.hostname === "raw.githubusercontent.com" && !/\/SKILL\.md$/i.test(url.pathname)) {
    return url.toString().replace(/\/+$/, "") + "/SKILL.md";
  }

  if (/\/$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/+$/, "") + "/SKILL.md";
    return url.toString();
  }
  return url.toString();
}

async function fetchSkillSourceText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "galaxy-opc-skill-importer/1.0",
        Accept: "text/plain, text/markdown, text/x-markdown, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`远程地址返回 ${resp.status}`);
    const text = await resp.text();
    if (!text.trim()) throw new Error("远程 Skill 内容为空");
    return text;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("抓取远程 Skill 超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const result: Record<string, string> = {};
  frontmatter.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)\s*$/);
    if (!match) return;
    result[match[1].trim().toLowerCase()] = match[2].trim().replace(/^['"]|['"]$/g, "");
  });
  return result;
}

function deriveSkillDescription(body: string, fallback = ""): string {
  const cleaned = body
    .replace(/^#+\s.+$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstSentence = cleaned.find((line) => !/^[-*]/.test(line) && line.length >= 8);
  return (firstSentence || fallback || "导入的远程技能").slice(0, 160);
}

function deriveSkillName(body: string, meta: Record<string, string>, normalizedUrl: string): string {
  const byMeta = meta.name || meta.title;
  if (byMeta) return byMeta.slice(0, 40);
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim().slice(0, 40);
  const url = new URL(normalizedUrl);
  const seg = url.pathname.split("/").filter(Boolean).pop() || "remote-skill";
  return seg.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim().slice(0, 40) || "远程技能";
}

function deriveSkillCategory(meta: Record<string, string>, body: string): string {
  const raw = (meta.category || meta.tags || "").toLowerCase();
  if (raw.includes("finance")) return "finance";
  if (raw.includes("legal")) return "legal";
  if (raw.includes("business")) return "business";
  if (raw.includes("marketing")) return "marketing";
  if (raw.includes("tech") || raw.includes("product") || raw.includes("code")) return "tech";
  if (raw.includes("writing") || raw.includes("content")) return "writing";

  const lc = body.toLowerCase();
  if (/(税|财务|资金|报表|finance)/.test(lc)) return "finance";
  if (/(合同|法务|合规|legal)/.test(lc)) return "legal";
  if (/(营销|增长|seo|获客|marketing)/.test(lc)) return "marketing";
  if (/(代码|开发|架构|api|tech|product)/.test(lc)) return "tech";
  if (/(写作|报告|文案|content|writing)/.test(lc)) return "writing";
  if (/(商业|竞品|市场|business)/.test(lc)) return "business";
  return "general";
}

function buildImportedSkillPrompt(name: string, description: string, markdownBody: string, normalizedUrl: string): string {
  return [
    `你现在扮演技能「${name}」。`,
    description ? `技能描述：${description}` : "",
    `来源：${normalizedUrl}`,
    "严格遵循以下技能说明完成任务，不要脱离其边界，不要省略其中明确要求的步骤、格式和限制：",
    "",
    markdownBody.trim(),
  ].filter(Boolean).join("\n");
}

function parseImportedSkill(rawBody: string, sourceUrl: string, normalizedUrl: string): ImportedSkillDraft {
  const text = rawBody.replace(/^\uFEFF/, "").trim();
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = fm ? parseFrontmatter(fm[1]) : {};
  const body = fm ? text.slice(fm[0].length).trim() : text;
  const name = deriveSkillName(body, meta, normalizedUrl);
  if (!name) throw new Error("无法从远程 Skill 中识别名称");
  const description = deriveSkillDescription(body, meta.description || meta["short-description"] || "");
  const category = deriveSkillCategory(meta, body);
  const prompt = buildImportedSkillPrompt(name, description, body, normalizedUrl);
  return { name, description, category, prompt, sourceUrl, normalizedUrl, body };
}

export async function handleImportSkillFromUrl(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const sourceUrl = s(body.url).trim();
  if (!sourceUrl) { sendJson(res, 400, { error: "须提供 Skill URL" }); return; }

  try {
    const normalizedUrl = normalizeSkillSourceUrl(sourceUrl);
    const rawText = await fetchSkillSourceText(normalizedUrl);
    const imported = parseImportedSkill(rawText, sourceUrl, normalizedUrl);

    const overrideCategory = s(body.category).trim();
    if (overrideCategory) imported.category = overrideCategory;

    const { rows: existing } = await db.query(
      "SELECT id FROM opc_skills WHERE user_id = $1 AND name = $2 LIMIT 1",
      [req.user!.userId, imported.name]
    );

    if (existing.length > 0) {
      await db.query(
        "UPDATE opc_skills SET description = $1, category = $2, prompt = $3, enabled = 1, updated_at = NOW() WHERE id = $4 AND user_id = $5",
        [imported.description, imported.category, imported.prompt, existing[0].id, req.user!.userId]
      );
      const { rows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [existing[0].id]);
      sendJson(res, 200, {
        skill: rows[0],
        installed: false,
        updated: true,
        source_url: imported.normalizedUrl,
        message: "同名 Skill 已存在，已按远程内容更新并启用",
      });
      return;
    }

    const id = uuid();
    await db.query(
      "INSERT INTO opc_skills (id, user_id, name, description, category, prompt, enabled) VALUES ($1, $2, $3, $4, $5, $6, 1)",
      [id, req.user!.userId, imported.name, imported.description, imported.category, imported.prompt]
    );
    const { rows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [id]);
    sendJson(res, 201, {
      skill: rows[0],
      installed: true,
      updated: false,
      source_url: imported.normalizedUrl,
      preview: {
        title: imported.name,
        description: imported.description,
        category: imported.category,
      },
    });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message || "导入 Skill 失败" });
  }
}

export async function handlePreviewImportSkill(req: AuthRequest, res: ServerResponse) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const sourceUrl = s(body.url).trim();
  if (!sourceUrl) { sendJson(res, 400, { error: "须提供 Skill URL" }); return; }
  try {
    const normalizedUrl = normalizeSkillSourceUrl(sourceUrl);
    const rawText = await fetchSkillSourceText(normalizedUrl);
    const imported = parseImportedSkill(rawText, sourceUrl, normalizedUrl);
    const overrideCategory = s(body.category).trim();
    if (overrideCategory) imported.category = overrideCategory;
    sendJson(res, 200, {
      preview: {
        name: imported.name,
        description: imported.description,
        category: imported.category,
        source_url: imported.normalizedUrl,
        prompt_excerpt: imported.prompt.slice(0, 400),
        body_excerpt: imported.body.slice(0, 800),
      },
    });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message || "预览 Skill 失败" });
  }
}

async function fetchOpenAiCuratedSkillCatalog(): Promise<RemoteSkillCatalogItem[]> {
  const now = Date.now();
  if (REMOTE_SKILL_CATALOG_CACHE.expiresAt > now && REMOTE_SKILL_CATALOG_CACHE.items.length) {
    return REMOTE_SKILL_CATALOG_CACHE.items;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch("https://api.github.com/repos/openai/skills/contents/skills/.curated", {
      headers: {
        "User-Agent": "galaxy-opc-skill-browser/1.0",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`GitHub 目录读取失败 ${resp.status}`);
    const data = await resp.json() as Array<{ name?: string; path?: string; type?: string }>;
    const items = (Array.isArray(data) ? data : [])
      .filter((item) => item && item.type === "dir" && item.name && item.path)
      .map((item) => {
        const name = String(item.name);
        const path = String(item.path);
        const url = `https://github.com/openai/skills/tree/main/${path}`;
        const category = deriveSkillCategory({}, name);
        return {
          name,
          repo: "openai/skills",
          path,
          url,
          source: "OpenAI Curated",
          description: `来自 openai/skills 的 curated skill：${name}`,
          category,
        } as RemoteSkillCatalogItem;
      })
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    REMOTE_SKILL_CATALOG_CACHE = { expiresAt: now + 10 * 60 * 1000, items };
    return items;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("加载线上 Skill 列表超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleListRemoteSkills(req: AuthRequest, res: ServerResponse) {
  if (!requireAuth(req, res)) return;
  try {
    const url = new URL(req.url || "/", "http://x");
    const query = (url.searchParams.get("query") || "").trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "12", 10)));
    const all = await fetchOpenAiCuratedSkillCatalog();
    const filtered = query
      ? all.filter((item) => {
          const hay = `${item.name} ${item.description} ${item.category} ${item.path}`.toLowerCase();
          return hay.includes(query);
        })
      : all;
    sendJson(res, 200, { items: filtered.slice(0, limit), total: filtered.length, source: "openai/skills" });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message || "加载远程 Skill 列表失败" });
  }
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function runSkillsCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = process.platform === "win32" ? "npx.cmd" : "npx";
    execFile(bin, ["skills", ...args], { timeout: 45_000, windowsHide: true, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stripAnsi(String(stderr || stdout || error.message)).trim() || "skills CLI 执行失败"));
        return;
      }
      resolve(stripAnsi(String(stdout || "")).trim());
    });
  });
}

function parseSkillsFindOutput(stdout: string): EcosystemSkillHit[] {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hits: EcosystemSkillHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const urlMatch = lines[i].match(/https:\/\/skills\.sh\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)/);
    if (!urlMatch) continue;
    const owner = urlMatch[1];
    const repo = urlMatch[2];
    const skill = urlMatch[3];
    const prev = i > 0 ? lines[i - 1] : "";
    const installsMatch = prev.match(/([0-9.]+K?) installs/i);
    hits.push({
      package: `${owner}/${repo}@${skill}`,
      owner,
      repo,
      skill,
      url: urlMatch[0],
      installs: installsMatch ? installsMatch[1] : "",
      title: skill.replace(/[-_]+/g, " "),
    });
  }
  return hits;
}

function skillInstallCandidates(skill: string): string[] {
  const home = homedir();
  return [
    join(home, ".agents", "skills", skill, "SKILL.md"),
    join(home, ".codex", "skills", skill, "SKILL.md"),
  ];
}

function loadInstalledSkillMarkdown(skill: string): { path: string; body: string } | null {
  for (const candidate of skillInstallCandidates(skill)) {
    if (existsSync(candidate)) return { path: candidate, body: readFileSync(candidate, "utf-8") };
  }
  return null;
}

export async function handleSearchEcosystemSkills(req: AuthRequest, res: ServerResponse) {
  if (!requireAuth(req, res)) return;
  const url = new URL(req.url || "/", "http://x");
  const query = (url.searchParams.get("query") || "").trim();
  if (!query) { sendJson(res, 400, { error: "query 不能为空" }); return; }
  try {
    const stdout = await runSkillsCli(["find", query]);
    const items = parseSkillsFindOutput(stdout);
    sendJson(res, 200, { items, raw: stdout });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message || "搜索生态 Skill 失败" });
  }
}

export async function handleInstallEcosystemSkill(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const pkg = s(body.package).trim();
  if (!pkg || !pkg.includes("@")) { sendJson(res, 400, { error: "须提供合法的 package，如 owner/repo@skill" }); return; }
  const skill = pkg.split("@").pop() || "";
  try {
    const stdout = await runSkillsCli(["add", pkg, "-g", "-y"]);
    const installed = loadInstalledSkillMarkdown(skill);
    let imported = false;
    let dbSkill: unknown = null;
    if (installed) {
      const sourceUrl = `https://skills.sh/${pkg.replace("@", "/")}`;
      const parsed = parseImportedSkill(installed.body, sourceUrl, sourceUrl);
      const { rows: existing } = await db.query("SELECT id FROM opc_skills WHERE user_id = $1 AND name = $2 LIMIT 1", [req.user!.userId, parsed.name]);
      if (existing.length > 0) {
        await db.query(
          "UPDATE opc_skills SET description = $1, category = $2, prompt = $3, enabled = 1, updated_at = NOW() WHERE id = $4 AND user_id = $5",
          [parsed.description, parsed.category, parsed.prompt, existing[0].id, req.user!.userId]
        );
        const { rows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [existing[0].id]);
        dbSkill = rows[0];
      } else {
        const id = uuid();
        await db.query(
          "INSERT INTO opc_skills (id, user_id, name, description, category, prompt, enabled) VALUES ($1, $2, $3, $4, $5, $6, 1)",
          [id, req.user!.userId, parsed.name, parsed.description, parsed.category, parsed.prompt]
        );
        const { rows } = await db.query("SELECT * FROM opc_skills WHERE id = $1", [id]);
        dbSkill = rows[0];
      }
      imported = true;
    }
    sendJson(res, 200, {
      success: true,
      package: pkg,
      installed_to_env: true,
      imported_to_opc: imported,
      skill: dbSkill,
      message: imported ? "已安装到本机并导入 OPC Skill 库" : "已安装到本机，但未找到可导入的 SKILL.md",
      raw: stdout,
    });
  } catch (error) {
    sendJson(res, 400, { error: (error as Error).message || "安装生态 Skill 失败" });
  }
}

// ─── 模型 API ─────────────────────────────────────────────────────────

const PLAN_ORDER: Record<string, number> = { free: 0, plus: 1, pro: 2, ultra: 3 };

export async function handleGetModels(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    "SELECT model_id, display_name, input_per_1k, output_per_1k, points_per_exchange, min_plan FROM opc_model_prices WHERE enabled = true ORDER BY points_per_exchange ASC",
  );
  sendJson(res, 200, { models: rows });
}

export async function handleGetUserModel(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const { rows } = await db.query("SELECT selected_model, plan FROM opc_users WHERE id = $1", [userId]);
  if (!rows[0]) { sendJson(res, 404, { error: "用户不存在" }); return; }
  sendJson(res, 200, { model_id: rows[0].selected_model || "qwen3.6-plus", plan: rows[0].plan });
}

export async function handleSetUserModel(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req);
  const modelId = String(body.model_id || "").trim();
  if (!modelId) { sendJson(res, 400, { error: "model_id 不能为空" }); return; }

  const { rows: modelRows } = await db.query(
    "SELECT model_id, display_name, min_plan FROM opc_model_prices WHERE model_id = $1 AND enabled = true",
    [modelId],
  );
  if (!modelRows[0]) { sendJson(res, 404, { error: "模型不存在" }); return; }

  const { rows: userRows } = await db.query("SELECT plan FROM opc_users WHERE id = $1", [userId]);
  const userPlan = userRows[0]?.plan || "free";
  if ((PLAN_ORDER[userPlan] ?? 0) < (PLAN_ORDER[modelRows[0].min_plan] ?? 0)) {
    sendJson(res, 403, { error: `该模型需要 ${modelRows[0].min_plan} 及以上套餐`, required_plan: modelRows[0].min_plan });
    return;
  }

  await db.query("UPDATE opc_users SET selected_model = $1 WHERE id = $2", [modelId, userId]);
  sendJson(res, 200, { success: true, model_id: modelId, display_name: modelRows[0].display_name });
}

export async function handleGetUsageLogs(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const url = new URL(req.url || "/", "http://x");
  const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit")  || "10", 10)));
  const offset = Math.max(0,              parseInt(url.searchParams.get("offset") || "0",  10));
  const from   = url.searchParams.get("from") || "";
  const to     = url.searchParams.get("to")   || "";

  const conditions: string[] = ["user_id = $1"];
  const params: unknown[] = [userId];
  if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
  if (to)   { params.push(to);   conditions.push(`created_at <= $${params.length}`); }

  const where = conditions.join(" AND ");

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) as total FROM opc_usage_log WHERE ${where}`,
    params,
  );
  const total = Number(countRows[0].total);

  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT id, tokens_in, tokens_out, cost_points, tool_name, model_id, created_at
     FROM opc_usage_log WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  sendJson(res, 200, { logs: rows, total });
}

function s(v: unknown, def = ""): string { return v !== undefined && v !== null ? String(v) : def; }
function n(v: unknown, def = 0): number { const num = Number(v); return isNaN(num) ? def : num; }
