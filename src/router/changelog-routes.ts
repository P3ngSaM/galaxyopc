import {
  handleListChangelogs, handleCreateChangelog, handleUpdateChangelog,
  handleDeleteChangelog, handleGetUnreadChangelogs, handleMarkChangelogRead,
} from "../api/changelog-api.js";
import type { RouteContext } from "./route-context.js";
import type { AuthRequest } from "../auth/middleware.js";

export async function handleChangelogRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/changelogs" && method === "GET") return await h(handleListChangelogs(req as AuthRequest, res, db));
  if (pathname === "/api/changelogs" && method === "POST") return await h(handleCreateChangelog(req as AuthRequest, res, db));
  if (pathname === "/api/changelogs/unread" && method === "GET") return await h(handleGetUnreadChangelogs(req as AuthRequest, res, db));
  if (pathname === "/api/changelogs/mark-read" && method === "POST") return await h(handleMarkChangelogRead(req as AuthRequest, res, db));

  const idMatch = pathname.match(/^\/api\/changelogs\/([^/]+)$/);
  if (idMatch && method === "PUT") return await h(handleUpdateChangelog(req as AuthRequest, res, db, idMatch[1]));
  if (idMatch && method === "DELETE") return await h(handleDeleteChangelog(req as AuthRequest, res, db, idMatch[1]));

  return false;
}

async function h(p: Promise<void>): Promise<true> { await p; return true; }
