import type { AuthRequest } from "../auth/middleware.js";
import {
  handleListTenants, handleGetTenant, handleCreateTenant, handleUpdateTenant,
  handleDeleteTenant, handleUploadTenantLogo, handleGetPresetThemes, handleGetTenantBySlug,
} from "../api/tenant-api.js";
import type { RouteContext } from "./route-context.js";

export async function handleTenantRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/tenant-configs" && method === "GET") return await handled(handleListTenants(req as AuthRequest, res, db));
  if (pathname === "/api/tenant-configs" && method === "POST") return await handled(handleCreateTenant(req as AuthRequest, res, db));
  if (pathname === "/api/tenant-themes" && method === "GET") return await handled(handleGetPresetThemes(req as AuthRequest, res));

  const tenantMatch = pathname.match(/^\/api\/tenant-configs\/([^/]+)$/);
  if (tenantMatch && method === "GET") return await handled(handleGetTenant(req as AuthRequest, res, db, tenantMatch[1]));
  if (tenantMatch && method === "PUT") return await handled(handleUpdateTenant(req as AuthRequest, res, db, tenantMatch[1]));
  if (tenantMatch && method === "DELETE") return await handled(handleDeleteTenant(req as AuthRequest, res, db, tenantMatch[1]));

  const logoMatch = pathname.match(/^\/api\/tenant-configs\/([^/]+)\/logo$/);
  if (logoMatch && method === "POST") return await handled(handleUploadTenantLogo(req as AuthRequest, res, db, logoMatch[1]));

  const logoLightMatch = pathname.match(/^\/api\/tenant-configs\/([^/]+)\/logo-light$/);
  if (logoLightMatch && method === "POST") return await handled(handleUploadTenantLogo(req as AuthRequest, res, db, logoLightMatch[1], "light"));

  const slugMatch = pathname.match(/^\/api\/tenant\/([^/]+)$/);
  if (slugMatch && method === "GET") return await handled(handleGetTenantBySlug(req as AuthRequest, res, db, slugMatch[1]));

  return false;
}

async function handled(p: Promise<void>): Promise<true> { await p; return true; }
