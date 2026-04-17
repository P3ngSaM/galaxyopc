import type { AuthRequest } from "../auth/middleware.js";
import { handleListCompanies, handleGetCompany, handleCreateCompany, handleUpdateCompany, handleDeleteCompany, handleDashboard, handleCompanyFinance, handleCompanyContacts, handleCompanyOpportunities, handleCreateCompanyOpportunity, handleUpdateCompanyOpportunity, handleDeleteCompanyOpportunity, handleCompanyDeliveryOrders, handleCreateDeliveryOrder, handleUpdateDeliveryOrder, handleDeleteDeliveryOrder, handleCreateLifecycleTodoPack, handleCreateLifecycleDocPack } from "../api/company-api.js";
import { handleListMembers, handleInviteMember, handlePendingInvites, handleAcceptInvite as handleAcceptTeamInvite, handleRejectInvite as handleRejectTeamInvite, handleChangeRole, handleRemoveMember, handleLeaveCompany, handleSearchUsersForTeam } from "../api/team-api.js";
import { handleExportContract } from "../api/contract-export.js";
import { handleExportProject } from "../api/project-export.js";
import { handleExportInvoice } from "../api/invoice-export.js";
import type { RouteContext } from "./route-context.js";

export async function handleCompanyRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/dashboard" && method === "GET") return await handled(handleDashboard(req as AuthRequest, res, db));
  if (pathname === "/api/companies" && method === "GET") return await handled(handleListCompanies(req as AuthRequest, res, db));
  if (pathname === "/api/companies" && method === "POST") return await handled(handleCreateCompany(req as AuthRequest, res, db));

  const companyMatch = pathname.match(/^\/api\/companies\/([^/]+)$/);
  if (companyMatch && method === "GET") return await handled(handleGetCompany(req as AuthRequest, res, db, companyMatch[1]));
  if (companyMatch && method === "PUT") return await handled(handleUpdateCompany(req as AuthRequest, res, db, companyMatch[1]));
  if (companyMatch && method === "DELETE") return await handled(handleDeleteCompany(req as AuthRequest, res, db, companyMatch[1]));

  const financeMatch = pathname.match(/^\/api\/companies\/([^/]+)\/finance$/);
  if (financeMatch && method === "GET") return await handled(handleCompanyFinance(req as AuthRequest, res, db, financeMatch[1]));

  const contactsMatch = pathname.match(/^\/api\/companies\/([^/]+)\/contacts$/);
  if (contactsMatch && method === "GET") return await handled(handleCompanyContacts(req as AuthRequest, res, db, contactsMatch[1]));

  const opportunitiesMatch = pathname.match(/^\/api\/companies\/([^/]+)\/opportunities$/);
  if (opportunitiesMatch && method === "GET") return await handled(handleCompanyOpportunities(req as AuthRequest, res, db, opportunitiesMatch[1]));
  if (opportunitiesMatch && method === "POST") return await handled(handleCreateCompanyOpportunity(req as AuthRequest, res, db, opportunitiesMatch[1]));

  const opportunityMatch = pathname.match(/^\/api\/companies\/([^/]+)\/opportunities\/([^/]+)$/);
  if (opportunityMatch && method === "PUT") return await handled(handleUpdateCompanyOpportunity(req as AuthRequest, res, db, opportunityMatch[1], opportunityMatch[2]));
  if (opportunityMatch && method === "DELETE") return await handled(handleDeleteCompanyOpportunity(req as AuthRequest, res, db, opportunityMatch[1], opportunityMatch[2]));

  const deliveryOrdersMatch = pathname.match(/^\/api\/companies\/([^/]+)\/delivery-orders$/);
  if (deliveryOrdersMatch && method === "GET") return await handled(handleCompanyDeliveryOrders(req as AuthRequest, res, db, deliveryOrdersMatch[1]));
  if (deliveryOrdersMatch && method === "POST") return await handled(handleCreateDeliveryOrder(req as AuthRequest, res, db, deliveryOrdersMatch[1]));

  const deliveryOrderMatch = pathname.match(/^\/api\/companies\/([^/]+)\/delivery-orders\/([^/]+)$/);
  if (deliveryOrderMatch && method === "PUT") return await handled(handleUpdateDeliveryOrder(req as AuthRequest, res, db, deliveryOrderMatch[1], deliveryOrderMatch[2]));
  if (deliveryOrderMatch && method === "DELETE") return await handled(handleDeleteDeliveryOrder(req as AuthRequest, res, db, deliveryOrderMatch[1], deliveryOrderMatch[2]));

  const lifecycleTodoPackMatch = pathname.match(/^\/api\/companies\/([^/]+)\/lifecycle-todo-pack$/);
  if (lifecycleTodoPackMatch && method === "POST") return await handled(handleCreateLifecycleTodoPack(req as AuthRequest, res, db, lifecycleTodoPackMatch[1]));

  const lifecycleDocPackMatch = pathname.match(/^\/api\/companies\/([^/]+)\/lifecycle-doc-pack$/);
  if (lifecycleDocPackMatch && method === "POST") return await handled(handleCreateLifecycleDocPack(req as AuthRequest, res, db, lifecycleDocPackMatch[1]));

  const membersMatch = pathname.match(/^\/api\/companies\/([^/]+)\/members$/);
  if (membersMatch && method === "GET") return await handled(handleListMembers(req as AuthRequest, res, db, membersMatch[1]));

  const inviteMemberMatch = pathname.match(/^\/api\/companies\/([^/]+)\/members\/invite$/);
  if (inviteMemberMatch && method === "POST") return await handled(handleInviteMember(req as AuthRequest, res, db, inviteMemberMatch[1]));

  if (pathname === "/api/company-invites/pending" && method === "GET") return await handled(handlePendingInvites(req as AuthRequest, res, db));

  const teamInviteAcceptMatch = pathname.match(/^\/api\/company-invites\/([^/]+)\/accept$/);
  if (teamInviteAcceptMatch && method === "POST") return await handled(handleAcceptTeamInvite(req as AuthRequest, res, db, teamInviteAcceptMatch[1]));

  const teamInviteRejectMatch = pathname.match(/^\/api\/company-invites\/([^/]+)\/reject$/);
  if (teamInviteRejectMatch && method === "POST") return await handled(handleRejectTeamInvite(req as AuthRequest, res, db, teamInviteRejectMatch[1]));

  const memberRoleMatch = pathname.match(/^\/api\/companies\/([^/]+)\/members\/([^/]+)\/role$/);
  if (memberRoleMatch && method === "PUT") return await handled(handleChangeRole(req as AuthRequest, res, db, memberRoleMatch[1], memberRoleMatch[2]));

  const removeMemberMatch = pathname.match(/^\/api\/companies\/([^/]+)\/members\/([^/]+)$/);
  if (removeMemberMatch && method === "DELETE") return await handled(handleRemoveMember(req as AuthRequest, res, db, removeMemberMatch[1], removeMemberMatch[2]));

  const leaveCompanyMatch = pathname.match(/^\/api\/companies\/([^/]+)\/members\/leave$/);
  if (leaveCompanyMatch && method === "POST") return await handled(handleLeaveCompany(req as AuthRequest, res, db, leaveCompanyMatch[1]));

  const searchUsersTeamMatch = pathname.match(/^\/api\/companies\/([^/]+)\/search-users$/);
  if (searchUsersTeamMatch && method === "GET") return await handled(handleSearchUsersForTeam(req as AuthRequest, res, db, searchUsersTeamMatch[1]));

  const contractExportMatch = pathname.match(/^\/api\/contracts\/([^/]+)\/export$/);
  if (contractExportMatch && method === "POST") return await handled(handleExportContract(req as AuthRequest, res, db, contractExportMatch[1]));

  const projectExportMatch = pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
  if (projectExportMatch && method === "POST") return await handled(handleExportProject(req as AuthRequest, res, db, projectExportMatch[1]));

  const invoiceExportMatch = pathname.match(/^\/api\/invoices\/([^/]+)\/export$/);
  if (invoiceExportMatch && method === "POST") return await handled(handleExportInvoice(req as AuthRequest, res, db, invoiceExportMatch[1]));

  return false;
}

async function handled(result: void | Promise<void>): Promise<true> {
  await result;
  return true;
}
