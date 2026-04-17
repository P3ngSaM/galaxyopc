import type { AuthRequest } from "../auth/middleware.js";
import { parseBody, requireAdmin, sendJson } from "../auth/middleware.js";
import * as AdminApi from "../api/admin-api.js";
import { getAllPendingApprovals, resolveApproval } from "../local-agent/security.js";
import type { RouteContext } from "./route-context.js";

export async function handleAdminRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/cities" && method === "GET") return await handled(AdminApi.handlePublicCities(req as AuthRequest, res, db));
  if (pathname === "/api/map-data" && method === "GET") return await handled(AdminApi.handleMapData(req as AuthRequest, res, db));
  if (pathname === "/api/parks" && method === "GET") return await handled(AdminApi.handleUserListParks(req as AuthRequest, res, db));
  if (pathname === "/api/parks" && method === "POST") return await handled(AdminApi.handleUserCreatePark(req as AuthRequest, res, db));

  const parkMatch = pathname.match(/^\/api\/parks\/([^/]+)$/);
  if (parkMatch && method === "PUT") return await handled(AdminApi.handleUserUpdatePark(req as AuthRequest, res, db, parkMatch[1]));
  if (parkMatch && method === "DELETE") return await handled(AdminApi.handleUserDeletePark(req as AuthRequest, res, db, parkMatch[1]));

  if (pathname === "/api/geocode" && method === "GET") return await handled(AdminApi.handleGeocode(req as AuthRequest, res, db));
  if (pathname === "/api/park-images/upload" && method === "POST") return await handled(AdminApi.handleUploadParkImages(req as AuthRequest, res));
  if (pathname === "/api/user/location" && method === "POST") return await handled(AdminApi.handleUpdateUserLocation(req as AuthRequest, res, db));
  if (pathname === "/api/my-applications" && method === "GET") return await handled(AdminApi.handleGetMyApplications(req as AuthRequest, res, db));

  const applyMatch = pathname.match(/^\/api\/parks\/([^/]+)\/apply$/);
  if (applyMatch && method === "POST") return await handled(AdminApi.handleApplyPark(req as AuthRequest, res, db, applyMatch[1]));

  const communityMatch = pathname.match(/^\/api\/parks\/([^/]+)\/community$/);
  if (communityMatch && method === "GET") return await handled(AdminApi.handleGetParkCommunity(req as AuthRequest, res, db, communityMatch[1]));

  const appListMatch = pathname.match(/^\/api\/parks\/([^/]+)\/applications$/);
  if (appListMatch && method === "GET") return await handled(AdminApi.handleGetParkApplications(req as AuthRequest, res, db, appListMatch[1]));

  const resourceListMatch = pathname.match(/^\/api\/parks\/([^/]+)\/resources$/);
  if (resourceListMatch && method === "GET") return await handled(AdminApi.handleGetParkResources(req as AuthRequest, res, db, resourceListMatch[1]));
  if (resourceListMatch && method === "POST") return await handled(AdminApi.handleSaveParkResource(req as AuthRequest, res, db, resourceListMatch[1]));

  const bookingMatch = pathname.match(/^\/api\/parks\/([^/]+)\/bookings$/);
  if (bookingMatch && method === "POST") return await handled(AdminApi.handleCreateParkBooking(req as AuthRequest, res, db, bookingMatch[1]));

  const resourceMatch = pathname.match(/^\/api\/park-resources\/([^/]+)$/);
  if (resourceMatch && method === "PUT") return await handled(AdminApi.handleSaveParkResource(req as AuthRequest, res, db, "", resourceMatch[1]));
  if (resourceMatch && method === "DELETE") return await handled(AdminApi.handleDeleteParkResource(req as AuthRequest, res, db, resourceMatch[1]));

  const reviewMatch = pathname.match(/^\/api\/applications\/([^/]+)\/review$/);
  if (reviewMatch && method === "POST") return await handled(AdminApi.handleReviewApplication(req as AuthRequest, res, db, reviewMatch[1]));

  if (pathname === "/api/admin/stats" && method === "GET") return await handled(AdminApi.handleAdminStats(req as AuthRequest, res, db));
  if (pathname === "/api/admin/tool-audit" && method === "GET") return await handled(AdminApi.handleGetToolAuditLog(req as AuthRequest, res, db));
  if (pathname === "/api/admin/tool-approvals" && method === "GET") {
    const handler = typeof AdminApi.handleGetToolApprovals === "function"
      ? AdminApi.handleGetToolApprovals
      : handleToolApprovalsFallback;
    return await handled(handler(req as AuthRequest, res));
  }
  if (pathname === "/api/admin/province-intel/jobs" && method === "GET") return await handled(AdminApi.handleListProvinceIntelJobs(req as AuthRequest, res));
  if (pathname === "/api/admin/province-intel/start" && method === "POST") return await handled(AdminApi.handleStartProvinceIntel(req as AuthRequest, res));
  if (pathname === "/api/admin/users" && method === "GET") return await handled(AdminApi.handleListUsers(req as AuthRequest, res, db));

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && method === "PUT") return await handled(AdminApi.handleUpdateUser(req as AuthRequest, res, db, adminUserMatch[1]));
  if (adminUserMatch && method === "DELETE") return await handled(AdminApi.handleDeleteUser(req as AuthRequest, res, db, adminUserMatch[1]));

  if (pathname === "/api/admin/cities" && method === "GET") return await handled(AdminApi.handleListCities(req as AuthRequest, res, db));
  if (pathname === "/api/admin/cities" && method === "POST") return await handled(AdminApi.handleCreateCity(req as AuthRequest, res, db));

  const adminCityMatch = pathname.match(/^\/api\/admin\/cities\/([^/]+)$/);
  if (adminCityMatch && method === "PUT") return await handled(AdminApi.handleUpdateCity(req as AuthRequest, res, db, adminCityMatch[1]));

  const toolApprovalMatch = pathname.match(/^\/api\/admin\/tool-approvals\/([^/]+)$/);
  if (toolApprovalMatch && method === "POST") {
    const handler = typeof AdminApi.handleResolveToolApproval === "function"
      ? AdminApi.handleResolveToolApproval
      : handleResolveToolApprovalFallback;
    return await handled(handler(req as AuthRequest, res, toolApprovalMatch[1]));
  }

  return false;
}

async function handled(result: void | Promise<void>): Promise<true> {
  await result;
  return true;
}

async function handleToolApprovalsFallback(req: AuthRequest, res: any): Promise<void> {
  if (!requireAdmin(req, res)) return;
  sendJson(res, 200, { approvals: getAllPendingApprovals() });
}

async function handleResolveToolApprovalFallback(req: AuthRequest, res: any, approvalId: string): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const body = await parseBody(req);
  const approved = body.approved === true;
  const ok = resolveApproval(approvalId, approved);
  if (!ok) {
    sendJson(res, 404, { error: "审批请求不存在或已处理" });
    return;
  }
  sendJson(res, 200, { success: true, approved });
}
