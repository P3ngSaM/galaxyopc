import type { AuthRequest } from "../auth/middleware.js";
import { sendJson } from "../auth/middleware.js";
import { isLocalModeEnabled } from "../local-agent/security.js";
import { handleGetApprovals, handleResolveApproval, handleSetAutoApprove, handleCreateTask, handleListTasks, handleGetTask, handleCancelTask, handleGetAuditLog, handleSystemInfo, handleFeishuConnect, handleFeishuDisconnect, handleFeishuStatus, handleGetBackups, handleRestoreBackup } from "../local-agent/local-api.js";
import { handleCreateWorkflow, handleListWorkflows, handleGetWorkflow, handleToggleWorkflow, handleDeleteWorkflow, handleRunWorkflow, handleGetFocus, handleGenerateReport } from "../local-agent/enhanced-api.js";
import type { RouteContext } from "./route-context.js";

export async function handleLocalRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (!pathname.startsWith("/api/local/")) return false;

  if (!isLocalModeEnabled()) {
    sendJson(res, 404, { error: "该接口仅本地版可用" });
    return true;
  }

  if (pathname === "/api/local/approvals" && method === "GET") return await handled(handleGetApprovals(req as AuthRequest, res));
  if (pathname === "/api/local/auto-approve" && method === "POST") return await handled(handleSetAutoApprove(req as AuthRequest, res));

  const approvalResolveMatch = pathname.match(/^\/api\/local\/approvals\/([^/]+)$/);
  if (approvalResolveMatch && method === "POST") return await handled(handleResolveApproval(req as AuthRequest, res, db, approvalResolveMatch[1]));

  if (pathname === "/api/local/tasks" && method === "POST") return await handled(handleCreateTask(req as AuthRequest, res, db));
  if (pathname === "/api/local/tasks" && method === "GET") return await handled(handleListTasks(req as AuthRequest, res, db));

  const localTaskMatch = pathname.match(/^\/api\/local\/tasks\/([^/]+)$/);
  if (localTaskMatch && method === "GET") return await handled(handleGetTask(req as AuthRequest, res, db, localTaskMatch[1]));

  const localTaskCancelMatch = pathname.match(/^\/api\/local\/tasks\/([^/]+)\/cancel$/);
  if (localTaskCancelMatch && method === "POST") return await handled(handleCancelTask(req as AuthRequest, res, db, localTaskCancelMatch[1]));

  if (pathname === "/api/local/audit-log" && method === "GET") return await handled(handleGetAuditLog(req as AuthRequest, res, db));
  if (pathname === "/api/local/system-info" && method === "GET") return await handled(handleSystemInfo(req as AuthRequest, res));
  if (pathname === "/api/local/backups" && method === "GET") return await handled(handleGetBackups(req as AuthRequest, res));

  const backupRestoreMatch = pathname.match(/^\/api\/local\/backups\/([^/]+)\/restore$/);
  if (backupRestoreMatch && method === "POST") return await handled(handleRestoreBackup(req as AuthRequest, res, db, backupRestoreMatch[1]));

  if (pathname === "/api/local/feishu/connect" && method === "POST") return await handled(handleFeishuConnect(req as AuthRequest, res, db));
  if (pathname === "/api/local/feishu/disconnect" && method === "POST") return await handled(handleFeishuDisconnect(req as AuthRequest, res));
  if (pathname === "/api/local/feishu/status" && method === "GET") return await handled(handleFeishuStatus(req as AuthRequest, res));

  if (pathname === "/api/local/workflows" && method === "POST") return await handled(handleCreateWorkflow(req as AuthRequest, res, db));
  if (pathname === "/api/local/workflows" && method === "GET") return await handled(handleListWorkflows(req as AuthRequest, res, db));

  const workflowMatch = pathname.match(/^\/api\/local\/workflows\/([^/]+)$/);
  if (workflowMatch && method === "GET") return await handled(handleGetWorkflow(req as AuthRequest, res, db, workflowMatch[1]));
  if (workflowMatch && method === "DELETE") return await handled(handleDeleteWorkflow(req as AuthRequest, res, db, workflowMatch[1]));

  const workflowToggleMatch = pathname.match(/^\/api\/local\/workflows\/([^/]+)\/toggle$/);
  if (workflowToggleMatch && method === "PATCH") return await handled(handleToggleWorkflow(req as AuthRequest, res, db, workflowToggleMatch[1]));

  const workflowRunMatch = pathname.match(/^\/api\/local\/workflows\/([^/]+)\/run$/);
  if (workflowRunMatch && method === "POST") return await handled(handleRunWorkflow(req as AuthRequest, res, db, workflowRunMatch[1]));

  if (pathname === "/api/local/focus" && method === "GET") return await handled(handleGetFocus(req as AuthRequest, res, db));
  if (pathname === "/api/local/report" && method === "POST") return await handled(handleGenerateReport(req as AuthRequest, res, db));

  return false;
}

async function handled(result: void | Promise<void>): Promise<true> {
  await result;
  return true;
}
