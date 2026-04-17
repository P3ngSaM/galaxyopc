/**
 * 简洁的手动路由——不依赖 Express，纯 Node.js http 模块。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Db } from "./db.js";
import type { AuthRequest } from "./auth/middleware.js";
import { sendJson, parseBody, requireAdmin } from "./auth/middleware.js";
import { handleRegister, handleLogin, handleGetProfile, handleUpdateProfile, handleChangePassword, handleSendCode } from "./auth/auth-api.js";
import { handleListCompanies, handleGetCompany, handleCreateCompany, handleUpdateCompany, handleDeleteCompany, handleDashboard, handleCompanyFinance, handleCompanyContacts } from "./api/company-api.js";
import { handleChat, handleChatStream, handleSimpleChat, handleListConversations, handleGetMessages, handleCreateConversation, handleDeleteConversation, handleGetQuota } from "./chat/chat-api.js";
import { handleListUsers, handleUpdateUser, handleDeleteUser, handleListCities, handleCreateCity, handleUpdateCity, handleAdminStats, handlePublicCities, handleMapData, handleUserListParks, handleUserCreatePark, handleUserUpdatePark, handleUserDeletePark, handleUpdateUserLocation, handleGeocode, handleApplyPark, handleGetParkApplications, handleReviewApplication, handleGetMyApplications } from "./api/admin-api.js";
import { handleGetCanvas, handleUpdateCanvas, handleGetCompass, handleUpdateCompass, handleAddBizModel, handleDeleteBizModel, handleGetMonitor, handleGetChannels, handleSaveChannel, handleGetToolConfig, handleSaveToolConfig, handleGetClosures, handleCreateClosure, handleDeleteClosure, handleGetAiConfig, handleSaveAiConfig, handleTestAiConfig, handleGetSearchConfig, handleSaveSearchConfig, handleTestSearchConfig, handleGetServiceConfig, handleSaveServiceConfig, handleInitStaff, handleToggleStaff, handleEditStaff, handleGetStaff, handleListSkills, handleCreateSkill, handleUpdateSkill, handleDeleteSkill, handleToggleSkill, handleInstallCatalogSkill, handleGetModels, handleGetUserModel, handleSetUserModel, handleGetUsageLogs } from "./api/module-api.js";
import { handleChatProxy, handleChatProxyQuota } from "./api/chat-proxy-api.js";
import { handleExportContract } from "./api/contract-export.js";
import { handleExportProject } from "./api/project-export.js";
import { handleExportInvoice } from "./api/invoice-export.js";
import { handleGetScheduledTasks, handleDeleteScheduledTask } from "./api/scheduler-api.js";
import { handleCreateEmailAccount, handleGetEmailAccounts, handleDeleteEmailAccount, handleGetEmailInbox, handleGetEmailDetail, handleConfirmReply, handleConfirmTask, handleArchiveEmail } from "./api/email-api.js";
import { handleCreateOrder, handleGetOrder, handleConfirmOrder, handleListOrders, handleListUserOrders, handleCancelOrder, handleDeleteOrder } from "./api/order-api.js";
import { handleSwarmStream, handleGetSwarmQuota, handleGetSwarmSessions, handleGetSwarmTurns, handleGetSwarmAudit } from "./api/swarm-api.js";
import { handleSearchUsers, handleSendFriendRequest, handleGetFriendRequests, handleAcceptFriendRequest, handleRejectFriendRequest, handleGetFriends, handleDeleteFriend, handleGetPendingRequestCount } from "./api/friend-api.js";
import { handleListRooms, handleCreateRoom, handleGetRoom, handleDeleteRoom, handleInviteToRoom, handleRemoveFromRoom, handleGetRoomMessages, handleSendRoomMessage, handleUpdateShareScope, handleGetMyInvites, handleAcceptInvite, handleRejectInvite } from "./api/agent-room-api.js";
import { handleStartDialogue, handleStopDialogue, handleGetDialogueHistory } from "./api/agent-dialogue.js";
import { handleListSchedules, handleCreateSchedule, handleUpdateSchedule, handleDeleteSchedule } from "./api/schedule-api.js";
import { handleGetInviteCode, handleClaimGroupBonus, handleGetPointsLog, handleGenerateRedeemKeys, handleListRedeemKeys, handleCheckinStatus, handleDoCheckin } from "./api/growth-api.js";
import { handleCreateFeedback, handleListFeedback, handleVoteFeedback, handleAdoptFeedback, handleReplyFeedback } from "./api/feedback-api.js";
import { handleListMembers, handleInviteMember, handlePendingInvites, handleAcceptInvite as handleAcceptTeamInvite, handleRejectInvite as handleRejectTeamInvite, handleChangeRole, handleRemoveMember, handleLeaveCompany, handleSearchUsersForTeam } from "./api/team-api.js";
import { handleLocalRoutes } from "./router/local-routes.js";
import { handlePublicRoutes } from "./router/public-routes.js";
import { handleCommunityRoutes } from "./router/community-routes.js";
import { handleCollaborationRoutes } from "./router/collaboration-routes.js";
import { handleCommerceRoutes } from "./router/commerce-routes.js";
import { handleAdminRoutes } from "./router/admin-routes.js";
import { handleCompanyRoutes } from "./router/company-routes.js";
import { handleModuleRoutes } from "./router/module-routes.js";
import { handleTenantRoutes } from "./router/tenant-routes.js";
import { handleIotRoutes } from "./router/iot-routes.js";
import { handleChangelogRoutes } from "./router/changelog-routes.js";
import { proxyToCloud, shouldProxyToCloud, forwardAuthToCloud, getCloudApiUrl } from "./router/cloud-proxy.js";
import { isLocalModeEnabled } from "./local-agent/security.js";
import { signToken } from "./auth/jwt.js";
import { hashPassword } from "./auth/password.js";
import { getClientIp } from "./auth/rate-limit.js";
import { handleSubscriptionSendCode, handleSubscriptionVerify, handleSubscriptionCreate, handleSubscriptionActivate, handleGetPlans, handleWxPayNotify, handleSubscriptionStatus, handleMySubscriptions, handleAdminSubscriptionOrders, handleAdminDeleteSubscriptionOrder, handleGetPlanConfig, handleUpdatePlanConfig, handleAddPlan, handleDeletePlan, loadPlansFromDb } from "./api/subscription-api.js";

const RUST_PROXY_URL = (process.env.OPC_RUST_PROXY_URL || "").trim().replace(/\/+$/, "");
const RUST_PROXY_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/api\/auth\/login$/ },
  { method: "GET", pattern: /^\/api\/user\/profile$/ },
  { method: "GET", pattern: /^\/api\/user\/quota$/ },
  { method: "GET", pattern: /^\/api\/dashboard$/ },
  { method: "POST", pattern: /^\/api\/companies$/ },
  { method: "GET", pattern: /^\/api\/companies\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/chat$/ },
  { method: "POST", pattern: /^\/api\/chat\/simple$/ },
  { method: "POST", pattern: /^\/api\/chat\/stream$/ },
  { method: "GET", pattern: /^\/api\/conversations$/ },
  { method: "POST", pattern: /^\/api\/conversations$/ },
  { method: "GET", pattern: /^\/api\/conversations\/[^/]+\/messages$/ },
  { method: "DELETE", pattern: /^\/api\/conversations\/[^/]+$/ },
];

function shouldProxyToRust(pathname: string, method: string): boolean {
  return !!RUST_PROXY_URL && RUST_PROXY_ROUTES.some((route) => route.method === method && route.pattern.test(pathname));
}

let _cachedAiMode = "local";
let _aiModeCacheTs = 0;
async function getAiModeFromDb(db: Db): Promise<string> {
  if (Date.now() - _aiModeCacheTs < 10_000) return _cachedAiMode;
  try {
    const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = 'ai_mode'");
    _cachedAiMode = rows[0]?.value || "local";
  } catch { _cachedAiMode = "local"; }
  _aiModeCacheTs = Date.now();
  return _cachedAiMode;
}
export function invalidateAiModeCache(): void { _aiModeCacheTs = 0; }

/**
 * 将云端用户同步到本地 SQLite（upsert）。
 * 保持云端 id 一致，使得本地 token 和云端用户数据可以对应。
 */
async function syncCloudUserToLocal(
  db: Db,
  cloudUser: { id: string; name?: string; email?: string; phone?: string; role?: string; avatar?: string; plan?: string },
  rawPassword: string,
): Promise<void> {
  try {
    const { rows } = await db.query("SELECT id FROM opc_users WHERE id = $1", [cloudUser.id]);
    const pwHash = rawPassword ? hashPassword(rawPassword) : hashPassword("cloud-user-" + Date.now());

    if (rows[0]) {
      await db.query(
        `UPDATE opc_users SET name = $1, email = $2, phone = $3, role = $4, avatar = $5 WHERE id = $6`,
        [cloudUser.name || "", cloudUser.email || "", cloudUser.phone || "", cloudUser.role || "user", cloudUser.avatar || "", cloudUser.id],
      );
    } else {
      await db.query(
        `INSERT INTO opc_users (id, name, email, phone, role, avatar, password_hash, onboarding_done)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [cloudUser.id, cloudUser.name || "", cloudUser.email || "", cloudUser.phone || "", cloudUser.role || "user", cloudUser.avatar || "", pwHash],
      );
    }
    console.log("[CloudAuth] synced cloud user to local:", cloudUser.id, cloudUser.name);
  } catch (e) {
    console.error("[CloudAuth] sync user failed:", (e as Error).message);
  }
}

async function proxyToRust(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!shouldProxyToRust(url.pathname, req.method || "GET")) return false;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  headers.set("host", new URL(RUST_PROXY_URL).host);

  const requestInit: any = {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : (req as any),
    duplex: "half",
  };

  const upstream = await fetch(`${RUST_PROXY_URL}${url.pathname}${url.search}`, requestInit);

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  res.writeHead(upstream.status, responseHeaders);

  if (!upstream.body) {
    res.end();
    return true;
  }

  Readable.fromWeb(upstream.body as any).pipe(res);
  return true;
}

export function createRouter(db: Db) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const method = req.method || "GET";

    if (method === "OPTIONS") {
      sendJson(res, 204, null);
      return;
    }

    try {
      if (await proxyToRust(req, res, url)) return;

      // ── 桌面本地版：将全局数据接口代理到云端 ──
      if (isLocalModeEnabled() && shouldProxyToCloud(pathname)) {
        if (await proxyToCloud(req, res, url)) return;
      }

      // ── Auth API ──
      // 本地版：认证请求转发到云端，同步用户到本地 SQLite
      if (isLocalModeEnabled() && getCloudApiUrl()) {
        if (pathname === "/api/auth/send-code" && method === "POST") {
          const body = await parseBody(req);
          const result = await forwardAuthToCloud("POST", "/api/auth/send-code", body, getClientIp(req));
          if (result) { sendJson(res, result.status, result.data); return; }
          sendJson(res, 502, { error: "无法连接云端服务，请检查网络" }); return;
        }
        if (pathname === "/api/auth/register" && method === "POST") {
          const body = await parseBody(req);
          const result = await forwardAuthToCloud("POST", "/api/auth/register", body, getClientIp(req));
          if (result && result.status < 300 && result.data.token && result.data.user) {
            const cu = result.data.user;
            await syncCloudUserToLocal(db, cu, String(body.password || ""));
            const localToken = signToken({ userId: cu.id, phone: cu.phone || "", role: cu.role || "user" });
            sendJson(res, result.status, { token: localToken, user: cu });
            return;
          }
          if (result) { sendJson(res, result.status, result.data); return; }
          sendJson(res, 502, { error: "无法连接云端服务，请检查网络" }); return;
        }
        if (pathname === "/api/auth/login" && method === "POST") {
          const body = await parseBody(req);
          const result = await forwardAuthToCloud("POST", "/api/auth/login", body, getClientIp(req));
          if (result && result.status === 200 && result.data.token && result.data.user) {
            const cu = result.data.user;
            await syncCloudUserToLocal(db, cu, String(body.password || ""));
            const localToken = signToken({ userId: cu.id, phone: cu.phone || "", role: cu.role || "user" });
            sendJson(res, 200, { token: localToken, user: cu });
            return;
          }
          if (result && result.status >= 400) { sendJson(res, result.status, result.data); return; }
          sendJson(res, 502, { error: "无法连接云端服务，请检查网络" }); return;
        }
      }
      if (pathname === "/api/auth/send-code" && method === "POST") {
        return await handleSendCode(req as AuthRequest, res);
      }
      if (pathname === "/api/auth/register" && method === "POST") {
        return await handleRegister(req as AuthRequest, res, db);
      }
      if (pathname === "/api/auth/login" && method === "POST") {
        return await handleLogin(req as AuthRequest, res, db);
      }
      if (pathname === "/api/user/profile" && method === "GET") {
        return await handleGetProfile(req as AuthRequest, res, db);
      }
      if (pathname === "/api/user/profile" && method === "PUT") {
        return await handleUpdateProfile(req as AuthRequest, res, db);
      }
      if (pathname === "/api/user/password" && method === "PUT") {
        return await handleChangePassword(req as AuthRequest, res, db);
      }
      if (pathname === "/api/user/quota" && method === "GET") {
        return await handleGetQuota(req as AuthRequest, res, db);
      }

      // ── Subscription API ──
      if (pathname === "/api/subscription/send-code" && method === "POST") {
        return await handleSubscriptionSendCode(req as AuthRequest, res);
      }
      if (pathname === "/api/subscription/verify" && method === "POST") {
        return await handleSubscriptionVerify(req as AuthRequest, res);
      }
      if (pathname === "/api/subscription/create" && method === "POST") {
        return await handleSubscriptionCreate(req as AuthRequest, res, db);
      }
      if (pathname === "/api/subscription/activate" && method === "POST") {
        return await handleSubscriptionActivate(req as AuthRequest, res, db);
      }
      if (pathname === "/api/subscription/plans" && method === "GET") {
        return await handleGetPlans(req as AuthRequest, res);
      }
      if (pathname === "/api/subscription/notify" && method === "POST") {
        return await handleWxPayNotify(req, res, db);
      }
      if (pathname === "/api/subscription/status" && method === "GET") {
        return await handleSubscriptionStatus(req as AuthRequest, res, db);
      }
      if (pathname === "/api/subscription/my" && method === "GET") {
        return await handleMySubscriptions(req as AuthRequest, res, db);
      }

      // ── Admin Subscription Orders ──
      if (pathname === "/api/admin/subscription-orders" && method === "GET") {
        return await handleAdminSubscriptionOrders(req as AuthRequest, res, db);
      }
      {
        const m = pathname.match(/^\/api\/admin\/subscription-orders\/([^/]+)$/);
        if (m && method === "DELETE") {
          return await handleAdminDeleteSubscriptionOrder(req as AuthRequest, res, db, m[1]);
        }
      }

      // ── Admin Plan Config (CRUD) ──
      if (pathname === "/api/admin/plan-config" && method === "GET") {
        return await handleGetPlanConfig(req as AuthRequest, res);
      }
      if (pathname === "/api/admin/plan-config" && method === "POST") {
        return await handleUpdatePlanConfig(req as AuthRequest, res, db);
      }
      if (pathname === "/api/admin/plan-config/add" && method === "POST") {
        return await handleAddPlan(req as AuthRequest, res, db);
      }
      {
        const m = pathname.match(/^\/api\/admin\/plan-config\/([^/]+)$/);
        if (m && method === "DELETE") {
          return await handleDeletePlan(req as AuthRequest, res, db, m[1]);
        }
      }

      if (await handleCompanyRoutes({ req, res, db, pathname, method })) return;

      // ── Chat API ──
      // 本地模式 + 星环套餐(ai_mode=cloud)：AI 对话代理到云端
      if (isLocalModeEnabled() && getCloudApiUrl() && (pathname === "/api/chat/stream" || pathname === "/api/chat") && method === "POST") {
        const aiMode = await getAiModeFromDb(db);
        if (aiMode === "cloud") {
          if (await proxyToCloud(req, res, url, true)) return;
        }
      }
      if (pathname === "/api/chat" && method === "POST") {
        return await handleChat(req as AuthRequest, res, db);
      }
      if (pathname === "/api/chat/stream" && method === "POST") {
        return await handleChatStream(req as AuthRequest, res, db);
      }
      if (pathname === "/api/chat/simple" && method === "POST") {
        return await handleSimpleChat(req as AuthRequest, res, db);
      }
      // ── 套餐代理端点（供桌面本地版通过云端调用）──
      if (pathname === "/api/chat/proxy" && method === "POST") {
        return await handleChatProxy(req as AuthRequest, res, db);
      }
      if (pathname === "/api/chat/proxy/quota" && method === "GET") {
        return await handleChatProxyQuota(req as AuthRequest, res, db);
      }
      if (pathname === "/api/conversations" && method === "GET") {
        return await handleListConversations(req as AuthRequest, res, db);
      }
      if (pathname === "/api/conversations" && method === "POST") {
        return await handleCreateConversation(req as AuthRequest, res, db);
      }

      const convMsgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (convMsgMatch && method === "GET") {
        return await handleGetMessages(req as AuthRequest, res, db, convMsgMatch[1]);
      }

      const convDeleteMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (convDeleteMatch && method === "DELETE") {
        return await handleDeleteConversation(req as AuthRequest, res, db, convDeleteMatch[1]);
      }

      if (await handleAdminRoutes({ req, res, db, pathname, method })) return;

      if (await handleModuleRoutes({ req, res, db, pathname, method })) return;
      if (await handleCommerceRoutes({ req, res, db, pathname, method })) return;
      if (await handleCollaborationRoutes({ req, res, db, pathname, method })) return;
      if (await handleCommunityRoutes({ req, res, db, pathname, method })) return;
      if (await handleTenantRoutes({ req, res, db, pathname, method })) return;
      if (await handleIotRoutes({ req, res, db, pathname, method })) return;
      if (await handleChangelogRoutes({ req, res, db, pathname, method })) return;
      if (await handleLocalRoutes({ req, res, db, pathname, method })) return;
      if (await handlePublicRoutes({ req, res, db, pathname, method })) return;

      // ── 静态文件：/public/videos/ ──
      if (pathname.startsWith("/public/videos/")) {
        const { servePublicVideo } = await import("./static-files.js");
        if (await servePublicVideo(req, res, pathname)) return;
      }

      // ── 404 ──
      sendJson(res, 404, { error: "Not Found" });
    } catch (err: unknown) {
      console.error("[Router Error]", err);
      sendJson(res, 500, { error: "服务器内部错误" });
    }
  };
}
