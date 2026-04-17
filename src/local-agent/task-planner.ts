/**
 * 任务编排引擎 — AI 拆解复杂任务为 TODO 列表，逐步执行
 * 仅 LOCAL_MODE 下启用
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import { callAi } from "../chat/ai-client.js";
import { executeLocalTool } from "./local-tools.js";
import { executeTool } from "../chat/tool-executor.js";

export interface TaskStep {
  id: string;
  description: string;
  tool?: string;
  args?: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  result?: string;
  error?: string;
}

export interface LocalTask {
  id: string;
  userId: string;
  title: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  steps: TaskStep[];
  summary?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

const LOCAL_TOOLS = new Set([
  "local_shell", "local_read_file", "local_write_file",
  "local_list_dir", "local_move_file", "local_delete_file",
  "local_search_files", "local_open_app", "local_screenshot", "local_clipboard",
]);

const activeTasks = new Map<string, { cancel: boolean }>();

export async function planTask(
  db: Db, userId: string, instruction: string, companyId: string, source = "web",
): Promise<LocalTask> {
  const planPrompt = `你是星环OPC的任务规划专家。用户给了一个指令，你需要将它拆解为可执行的步骤列表。

可用工具分两类：
1. 本地电脑操作工具：local_shell, local_read_file, local_write_file, local_list_dir, local_move_file, local_delete_file, local_search_files, local_open_app, local_screenshot, local_clipboard
2. 业务管理工具：opc_manage, opc_finance, opc_legal, opc_hr, opc_project, opc_search, opc_email, opc_report, opc_document, opc_schedule, opc_data_analysis, opc_webpage

请将任务拆解为 JSON 数组，每个步骤包含：
- description: 步骤描述
- tool: 要使用的工具名（可选，有些步骤是纯思考/总结不需要工具）
- args: 工具参数对象（可选）

要求：
- 步骤尽量具体，每步只做一件事
- 如果需要前一步的结果才能确定后续参数，args 可以先写占位，后续动态调整
- 最后一步应该是总结报告
- 最多 10 个步骤

只返回 JSON 数组，不要其他文字。

用户指令：${instruction}`;

  let steps: TaskStep[] = [];
  try {
    const aiResp = await callAi([{ role: "user", content: planPrompt }]);
    const aiResult = aiResp.content || "";
    const parsed = JSON.parse(aiResult.replace(/```json?\s*/g, "").replace(/```/g, "").trim());
    if (Array.isArray(parsed)) {
      steps = parsed.slice(0, 10).map((s: any) => ({
        id: uuid(),
        description: String(s.description || ""),
        tool: s.tool || undefined,
        args: s.args || undefined,
        status: "pending" as const,
      }));
    }
  } catch (e) {
    steps = [{
      id: uuid(),
      description: instruction,
      status: "pending",
    }];
  }

  if (steps.length === 0) {
    steps = [{ id: uuid(), description: instruction, status: "pending" }];
  }

  const task: LocalTask = {
    id: uuid(),
    userId,
    title: instruction.slice(0, 100),
    status: "pending",
    steps,
    source,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.query(
    `INSERT INTO opc_local_tasks (id, user_id, title, status, steps, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [task.id, userId, task.title, task.status, JSON.stringify(task.steps), source, task.createdAt, task.updatedAt],
  );

  return task;
}

export async function executeTaskSteps(
  db: Db, task: LocalTask, companyId: string,
  onProgress?: (task: LocalTask) => void,
): Promise<LocalTask> {
  const ctrl = { cancel: false };
  activeTasks.set(task.id, ctrl);

  task.status = "running";
  await updateTask(db, task);
  onProgress?.(task);

  for (const step of task.steps) {
    if (ctrl.cancel) {
      step.status = "skipped";
      continue;
    }

    step.status = "running";
    await updateTask(db, task);
    onProgress?.(task);

    try {
      if (step.tool) {
        let result: string;
        if (LOCAL_TOOLS.has(step.tool)) {
          result = await executeLocalTool(step.tool, step.args || {}, db, task.userId);
        } else {
          result = await executeTool(step.tool, step.args || {}, db, companyId, task.userId);
        }
        step.result = result;

        const parsed = JSON.parse(result);
        if (parsed.error) {
          step.status = "failed";
          step.error = parsed.error;
        } else {
          step.status = "done";
        }
      } else {
        step.status = "done";
        step.result = JSON.stringify({ message: step.description });
      }
    } catch (e: any) {
      step.status = "failed";
      step.error = e.message;
    }

    await updateTask(db, task);
    onProgress?.(task);

    if (step.status === "failed") {
      break;
    }
  }

  const allDone = task.steps.every(s => s.status === "done" || s.status === "skipped");
  const anyFailed = task.steps.some(s => s.status === "failed");
  task.status = ctrl.cancel ? "cancelled" : anyFailed ? "failed" : allDone ? "done" : "failed";

  try {
    const summaryPrompt = `任务: "${task.title}"\n\n执行步骤结果:\n${task.steps.map((s, i) =>
      `${i + 1}. [${s.status}] ${s.description}${s.result ? '\n   结果: ' + s.result.slice(0, 300) : ''}${s.error ? '\n   错误: ' + s.error : ''}`
    ).join('\n')}\n\n请用中文简要总结任务执行结果（2-3句话）。`;
    const summaryResp = await callAi([{ role: "user", content: summaryPrompt }]);
    task.summary = summaryResp.content || "任务已完成";
  } catch {
    task.summary = task.status === "done" ? "任务已完成" : "任务执行过程中遇到错误";
  }

  await updateTask(db, task);
  onProgress?.(task);
  activeTasks.delete(task.id);
  return task;
}

export function cancelTask(taskId: string): boolean {
  const ctrl = activeTasks.get(taskId);
  if (ctrl) {
    ctrl.cancel = true;
    return true;
  }
  return false;
}

async function updateTask(db: Db, task: LocalTask): Promise<void> {
  task.updatedAt = new Date().toISOString();
  await db.query(
    `UPDATE opc_local_tasks SET status = $1, steps = $2, summary = $3, updated_at = $4 WHERE id = $5`,
    [task.status, JSON.stringify(task.steps), task.summary || null, task.updatedAt, task.id],
  );
}

export async function getTask(db: Db, taskId: string, userId: string): Promise<LocalTask | null> {
  const { rows } = await db.query(
    "SELECT * FROM opc_local_tasks WHERE id = $1 AND user_id = $2",
    [taskId, userId],
  );
  if (!rows[0]) return null;
  const r = rows[0] as any;
  return {
    id: r.id, userId: r.user_id, title: r.title,
    status: r.status, steps: r.steps || [],
    summary: r.summary, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listTasks(db: Db, userId: string, limit = 20): Promise<LocalTask[]> {
  const { rows } = await db.query(
    "SELECT * FROM opc_local_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit],
  );
  return (rows as any[]).map(r => ({
    id: r.id, userId: r.user_id, title: r.title,
    status: r.status, steps: r.steps || [],
    summary: r.summary, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}
