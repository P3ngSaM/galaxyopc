/**
 * 增强功能 API — 工作流 + 今日焦点 + 自动报告 + 语音
 * 仅 LOCAL_MODE 下启用
 */

import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, parseBody, requireAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { isLocalModeEnabled } from "./security.js";
import {
  createWorkflowFromNL, createWorkflowDirect, listWorkflows, getWorkflow,
  toggleWorkflow, deleteWorkflow, getWorkflowLogs, executeWorkflow,
} from "./workflow-engine.js";
import { generateDailyFocus, generateAutoReport } from "./focus-engine.js";

function guardLocal(req: AuthRequest, res: ServerResponse): boolean {
  if (!isLocalModeEnabled()) { sendJson(res, 403, { error: "仅本地版可用" }); return false; }
  if (!requireAuth(req, res)) return false;
  return true;
}

// ─── 工作流 ───────────────────────────────────────────────────────

export async function handleCreateWorkflow(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  const body = await parseBody(req);
  const instruction = String(body.instruction || "").trim();
  if (!instruction) { sendJson(res, 400, { error: "instruction 为必填项" }); return; }
  try {
    let wf;
    // 如果前端直接传了完整 workflow_json（可视化构建器），跳过 AI 解析
    if (body.workflow_json && typeof body.workflow_json === "object") {
      wf = await createWorkflowDirect(db, req.user!.userId, body.workflow_json as Record<string, unknown>, String(body.company_id || ""));
    } else {
      wf = await createWorkflowFromNL(db, req.user!.userId, instruction, String(body.company_id || ""));
    }
    sendJson(res, 201, { workflow: wf });
  } catch (e: any) {
    sendJson(res, 500, { error: e.message });
  }
}

export async function handleListWorkflows(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  const wfs = await listWorkflows(db, req.user!.userId);
  sendJson(res, 200, { workflows: wfs });
}

export async function handleGetWorkflow(req: AuthRequest, res: ServerResponse, db: Db, wfId: string) {
  if (!guardLocal(req, res)) return;
  const wf = await getWorkflow(db, wfId, req.user!.userId);
  if (!wf) { sendJson(res, 404, { error: "工作流不存在" }); return; }
  const logs = await getWorkflowLogs(db, wfId, 10);
  sendJson(res, 200, { workflow: wf, logs });
}

export async function handleToggleWorkflow(req: AuthRequest, res: ServerResponse, db: Db, wfId: string) {
  if (!guardLocal(req, res)) return;
  const body = await parseBody(req);
  const ok = await toggleWorkflow(db, wfId, req.user!.userId, body.enabled === true);
  sendJson(res, 200, { success: ok });
}

export async function handleDeleteWorkflow(req: AuthRequest, res: ServerResponse, db: Db, wfId: string) {
  if (!guardLocal(req, res)) return;
  const ok = await deleteWorkflow(db, wfId, req.user!.userId);
  sendJson(res, 200, { success: ok });
}

export async function handleRunWorkflow(req: AuthRequest, res: ServerResponse, db: Db, wfId: string) {
  if (!guardLocal(req, res)) return;
  const wf = await getWorkflow(db, wfId, req.user!.userId);
  if (!wf) { sendJson(res, 404, { error: "工作流不存在" }); return; }
  sendJson(res, 200, { message: "工作流已触发" });
  executeWorkflow(db, wf).catch(e => console.error("[RunWorkflow]", e));
}

// ─── 今日焦点 ─────────────────────────────────────────────────────

export async function handleGetFocus(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  try {
    const focus = await generateDailyFocus(db, req.user!.userId);
    sendJson(res, 200, focus);
  } catch (e: any) {
    sendJson(res, 500, { error: e.message });
  }
}

// ─── 自动报告 ─────────────────────────────────────────────────────

export async function handleGenerateReport(req: AuthRequest, res: ServerResponse, db: Db) {
  if (!guardLocal(req, res)) return;
  const body = await parseBody(req);
  const reportType = body.type === "weekly" ? "weekly" as const : "daily" as const;
  const companyId = String(body.company_id || "");
  try {
    const report = await generateAutoReport(db, req.user!.userId, companyId, reportType);
    sendJson(res, 200, { report, type: reportType });
  } catch (e: any) {
    sendJson(res, 500, { error: e.message });
  }
}
