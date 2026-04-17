import type { AuthRequest } from "../auth/middleware.js";
import {
  handleListSpaces, handleGetSpace, handleCreateSpace, handleUpdateSpace,
  handleDeleteSpace, handleUploadSpacePhoto, handleListRooms, handleCreateRoom,
  handleUpdateRoom, handleDeleteRoom, handleGetRecommendations, handleAutoLayout,
  handleGetProductCatalog, handleGetRoomTypes, handleAiGenerateSpace, handleAiChatLayout,
} from "../api/iot-api.js";
import type { RouteContext } from "./route-context.js";

export async function handleIotRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/iot/spaces" && method === "GET") return await handled(handleListSpaces(req as AuthRequest, res, db));
  if (pathname === "/api/iot/spaces" && method === "POST") return await handled(handleCreateSpace(req as AuthRequest, res, db));
  if (pathname === "/api/iot/products" && method === "GET") return await handled(handleGetProductCatalog(req as AuthRequest, res, db));
  if (pathname === "/api/iot/room-types" && method === "GET") return await handled(handleGetRoomTypes(req as AuthRequest, res));
  if (pathname === "/api/iot/recommend" && method === "POST") return await handled(handleGetRecommendations(req as AuthRequest, res, db));
  if (pathname === "/api/iot/ai-generate" && method === "POST") return await handled(handleAiGenerateSpace(req as AuthRequest, res, db));
  if (pathname === "/api/iot/ai-chat-layout" && method === "POST") return await handled(handleAiChatLayout(req as AuthRequest, res, db));

  const spaceMatch = pathname.match(/^\/api\/iot\/spaces\/([^/]+)$/);
  if (spaceMatch && method === "GET") return await handled(handleGetSpace(req as AuthRequest, res, db, spaceMatch[1]));
  if (spaceMatch && method === "PUT") return await handled(handleUpdateSpace(req as AuthRequest, res, db, spaceMatch[1]));
  if (spaceMatch && method === "DELETE") return await handled(handleDeleteSpace(req as AuthRequest, res, db, spaceMatch[1]));

  const photoMatch = pathname.match(/^\/api\/iot\/spaces\/([^/]+)\/photo$/);
  if (photoMatch && method === "POST") return await handled(handleUploadSpacePhoto(req as AuthRequest, res, db, photoMatch[1]));

  const autoLayoutMatch = pathname.match(/^\/api\/iot\/spaces\/([^/]+)\/auto-layout$/);
  if (autoLayoutMatch && method === "POST") return await handled(handleAutoLayout(req as AuthRequest, res, db, autoLayoutMatch[1]));

  const roomsMatch = pathname.match(/^\/api\/iot\/spaces\/([^/]+)\/rooms$/);
  if (roomsMatch && method === "GET") return await handled(handleListRooms(req as AuthRequest, res, db, roomsMatch[1]));
  if (roomsMatch && method === "POST") return await handled(handleCreateRoom(req as AuthRequest, res, db, roomsMatch[1]));

  const roomMatch = pathname.match(/^\/api\/iot\/rooms\/([^/]+)$/);
  if (roomMatch && method === "PUT") return await handled(handleUpdateRoom(req as AuthRequest, res, db, roomMatch[1]));
  if (roomMatch && method === "DELETE") return await handled(handleDeleteRoom(req as AuthRequest, res, db, roomMatch[1]));

  return false;
}

async function handled(p: Promise<void>): Promise<true> { await p; return true; }
