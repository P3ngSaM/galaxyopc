import type { AuthRequest } from "../auth/middleware.js";
import { handleCreateEmailAccount, handleGetEmailAccounts, handleDeleteEmailAccount, handleGetEmailInbox, handleGetEmailDetail, handleConfirmReply, handleConfirmTask, handleArchiveEmail } from "../api/email-api.js";
import { handleCreateOrder, handleGetOrder, handleConfirmOrder, handleListOrders, handleListUserOrders, handleCancelOrder, handleDeleteOrder } from "../api/order-api.js";
import { handleSwarmStream, handleGetSwarmQuota, handleGetSwarmSessions, handleGetSwarmTurns, handleGetSwarmAudit } from "../api/swarm-api.js";
import type { RouteContext } from "./route-context.js";

export async function handleCommerceRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/orders" && method === "POST") return await handled(handleCreateOrder(req as AuthRequest, res, db));
  if (pathname === "/api/orders" && method === "GET") return await handled(handleListUserOrders(req as AuthRequest, res, db));
  if (pathname === "/api/admin/orders" && method === "GET") return await handled(handleListOrders(req as AuthRequest, res, db));

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && method === "GET") return await handled(handleGetOrder(req as AuthRequest, res, db, orderMatch[1]));
  if (orderMatch && method === "DELETE") return await handled(handleDeleteOrder(req as AuthRequest, res, db, orderMatch[1]));

  const orderConfirmMatch = pathname.match(/^\/api\/orders\/([^/]+)\/confirm$/);
  if (orderConfirmMatch && method === "POST") return await handled(handleConfirmOrder(req as AuthRequest, res, db, orderConfirmMatch[1]));

  const orderCancelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
  if (orderCancelMatch && method === "POST") return await handled(handleCancelOrder(req as AuthRequest, res, db, orderCancelMatch[1]));

  if (pathname === "/api/email/accounts" && method === "GET") return await handled(handleGetEmailAccounts(req as AuthRequest, res, db));
  if (pathname === "/api/email/accounts" && method === "POST") return await handled(handleCreateEmailAccount(req as AuthRequest, res, db));

  const emailAccountDelMatch = pathname.match(/^\/api\/email\/accounts\/([^/]+)$/);
  if (emailAccountDelMatch && method === "DELETE") return await handled(handleDeleteEmailAccount(req as AuthRequest, res, db, emailAccountDelMatch[1]));

  if (pathname === "/api/email/inbox" && method === "GET") return await handled(handleGetEmailInbox(req as AuthRequest, res, db));

  const emailDetailMatch = pathname.match(/^\/api\/email\/inbox\/([^/]+)$/);
  if (emailDetailMatch && method === "GET") return await handled(handleGetEmailDetail(req as AuthRequest, res, db, emailDetailMatch[1]));

  const emailConfirmReplyMatch = pathname.match(/^\/api\/email\/inbox\/([^/]+)\/confirm-reply$/);
  if (emailConfirmReplyMatch && method === "POST") return await handled(handleConfirmReply(req as AuthRequest, res, db, emailConfirmReplyMatch[1]));

  const emailConfirmTaskMatch = pathname.match(/^\/api\/email\/inbox\/([^/]+)\/confirm-task$/);
  if (emailConfirmTaskMatch && method === "POST") return await handled(handleConfirmTask(req as AuthRequest, res, db, emailConfirmTaskMatch[1]));

  const emailArchiveMatch = pathname.match(/^\/api\/email\/inbox\/([^/]+)\/archive$/);
  if (emailArchiveMatch && method === "POST") return await handled(handleArchiveEmail(req as AuthRequest, res, db, emailArchiveMatch[1]));

  if (pathname === "/api/chat/swarm" && method === "POST") return await handled(handleSwarmStream(req as AuthRequest, res, db));
  if (pathname === "/api/swarm/quota" && method === "GET") return await handled(handleGetSwarmQuota(req as AuthRequest, res, db));
  if (pathname === "/api/swarm-sessions" && method === "GET") return await handled(handleGetSwarmSessions(req as AuthRequest, res, db));

  const swarmTurnsMatch = pathname.match(/^\/api\/swarm-sessions\/([^/]+)\/turns$/);
  if (swarmTurnsMatch && method === "GET") return await handled(handleGetSwarmTurns(req as AuthRequest, res, db, swarmTurnsMatch[1]));

  const swarmAuditMatch = pathname.match(/^\/api\/swarm-sessions\/([^/]+)\/audit$/);
  if (swarmAuditMatch && method === "GET") return await handled(handleGetSwarmAudit(req as AuthRequest, res, db, swarmAuditMatch[1]));

  return false;
}

async function handled(result: void | Promise<void>): Promise<true> {
  await result;
  return true;
}
