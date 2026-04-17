import type { AuthRequest } from "../auth/middleware.js";
import { handleSearchUsers, handleSendFriendRequest, handleGetFriendRequests, handleAcceptFriendRequest, handleRejectFriendRequest, handleGetFriends, handleDeleteFriend, handleGetPendingRequestCount } from "../api/friend-api.js";
import { handleListRooms, handleCreateRoom, handleGetRoom, handleDeleteRoom, handleInviteToRoom, handleRemoveFromRoom, handleGetRoomMessages, handleSendRoomMessage, handleUpdateShareScope, handleGetMyInvites, handleAcceptInvite, handleRejectInvite } from "../api/agent-room-api.js";
import { handleStartDialogue, handleStopDialogue, handleGetDialogueHistory } from "../api/agent-dialogue.js";
import type { RouteContext } from "./route-context.js";

export async function handleCollaborationRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/friends" && method === "GET") return await handled(handleGetFriends(req as AuthRequest, res, db));
  if (pathname === "/api/friends/search" && method === "POST") return await handled(handleSearchUsers(req as AuthRequest, res, db));
  if (pathname === "/api/friends/request" && method === "POST") return await handled(handleSendFriendRequest(req as AuthRequest, res, db));
  if (pathname === "/api/friends/requests" && method === "GET") return await handled(handleGetFriendRequests(req as AuthRequest, res, db));
  if (pathname === "/api/friends/requests/count" && method === "GET") return await handled(handleGetPendingRequestCount(req as AuthRequest, res, db));

  const friendAcceptMatch = pathname.match(/^\/api\/friends\/requests\/([^/]+)\/accept$/);
  if (friendAcceptMatch && method === "POST") return await handled(handleAcceptFriendRequest(req as AuthRequest, res, db, friendAcceptMatch[1]));

  const friendRejectMatch = pathname.match(/^\/api\/friends\/requests\/([^/]+)\/reject$/);
  if (friendRejectMatch && method === "POST") return await handled(handleRejectFriendRequest(req as AuthRequest, res, db, friendRejectMatch[1]));

  const friendDeleteMatch = pathname.match(/^\/api\/friends\/([^/]+)$/);
  if (friendDeleteMatch && method === "DELETE") return await handled(handleDeleteFriend(req as AuthRequest, res, db, friendDeleteMatch[1]));

  if (pathname === "/api/agent-rooms" && method === "GET") return await handled(handleListRooms(req as AuthRequest, res, db));
  if (pathname === "/api/agent-rooms" && method === "POST") return await handled(handleCreateRoom(req as AuthRequest, res, db));
  if (pathname === "/api/agent-rooms/invites" && method === "GET") return await handled(handleGetMyInvites(req as AuthRequest, res, db));

  const roomAcceptMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/accept$/);
  if (roomAcceptMatch && method === "POST") return await handled(handleAcceptInvite(req as AuthRequest, res, db, roomAcceptMatch[1]));

  const roomRejectMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/reject$/);
  if (roomRejectMatch && method === "POST") return await handled(handleRejectInvite(req as AuthRequest, res, db, roomRejectMatch[1]));

  const roomMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)$/);
  if (roomMatch && method === "GET") return await handled(handleGetRoom(req as AuthRequest, res, db, roomMatch[1]));
  if (roomMatch && method === "DELETE") return await handled(handleDeleteRoom(req as AuthRequest, res, db, roomMatch[1]));

  const roomInviteMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/invite$/);
  if (roomInviteMatch && method === "POST") return await handled(handleInviteToRoom(req as AuthRequest, res, db, roomInviteMatch[1]));

  const roomMemberRemoveMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/members\/([^/]+)$/);
  if (roomMemberRemoveMatch && method === "DELETE") return await handled(handleRemoveFromRoom(req as AuthRequest, res, db, roomMemberRemoveMatch[1], roomMemberRemoveMatch[2]));

  const roomMsgMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/messages$/);
  if (roomMsgMatch && method === "GET") return await handled(handleGetRoomMessages(req as AuthRequest, res, db, roomMsgMatch[1]));
  if (roomMsgMatch && method === "POST") return await handled(handleSendRoomMessage(req as AuthRequest, res, db, roomMsgMatch[1]));

  const roomScopeMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/sharing-rules$/);
  if (roomScopeMatch && method === "PUT") return await handled(handleUpdateShareScope(req as AuthRequest, res, db, roomScopeMatch[1]));

  const dialogueMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/dialogue$/);
  if (dialogueMatch && method === "POST") return await handled(handleStartDialogue(req as AuthRequest, res, db, dialogueMatch[1]));

  const dialogueStopMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/dialogue\/stop$/);
  if (dialogueStopMatch && method === "POST") return await handled(handleStopDialogue(req as AuthRequest, res, db, dialogueStopMatch[1]));

  const dialogueHistoryMatch = pathname.match(/^\/api\/agent-rooms\/([^/]+)\/dialogue\/history$/);
  if (dialogueHistoryMatch && method === "GET") return await handled(handleGetDialogueHistory(req as AuthRequest, res, db, dialogueHistoryMatch[1]));

  return false;
}

async function handled(result: void | Promise<void>): Promise<true> {
  await result;
  return true;
}
