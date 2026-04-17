import type { AuthRequest } from "../auth/middleware.js";
import { handleGetInviteCode, handleClaimGroupBonus, handleGetPointsLog, handleGenerateRedeemKeys, handleListRedeemKeys, handleCheckinStatus, handleDoCheckin } from "../api/growth-api.js";
import { handleCreateFeedback, handleListFeedback, handleVoteFeedback, handleAdoptFeedback, handleReplyFeedback } from "../api/feedback-api.js";
import type { RouteContext } from "./route-context.js";

export async function handleCommunityRoutes({ req, res, db, pathname, method }: RouteContext): Promise<boolean> {
  if (pathname === "/api/growth/invite-code" && method === "GET") return await handled(handleGetInviteCode(req as AuthRequest, res, db));
  if (pathname === "/api/growth/claim-group-bonus" && method === "POST") return await handled(handleClaimGroupBonus(req as AuthRequest, res, db));
  if (pathname === "/api/growth/redeem-keys" && method === "POST") return await handled(handleGenerateRedeemKeys(req as AuthRequest, res, db));
  if (pathname === "/api/growth/redeem-keys" && method === "GET") return await handled(handleListRedeemKeys(req as AuthRequest, res, db));
  if (pathname === "/api/growth/points-log" && method === "GET") return await handled(handleGetPointsLog(req as AuthRequest, res, db));

  if (pathname === "/api/checkin" && method === "GET") return await handled(handleCheckinStatus(req as AuthRequest, res, db));
  if (pathname === "/api/checkin" && method === "POST") return await handled(handleDoCheckin(req as AuthRequest, res, db));

  if (pathname === "/api/feedback" && method === "POST") return await handled(handleCreateFeedback(req as AuthRequest, res, db));
  if (pathname === "/api/feedback" && method === "GET") return await handled(handleListFeedback(req as AuthRequest, res, db));

  const feedbackVoteMatch = pathname.match(/^\/api\/feedback\/([^/]+)\/vote$/);
  if (feedbackVoteMatch && method === "POST") return await handled(handleVoteFeedback(req as AuthRequest, res, db, feedbackVoteMatch[1]));

  const feedbackAdoptMatch = pathname.match(/^\/api\/feedback\/([^/]+)\/adopt$/);
  if (feedbackAdoptMatch && method === "POST") return await handled(handleAdoptFeedback(req as AuthRequest, res, db, feedbackAdoptMatch[1]));

  const feedbackReplyMatch = pathname.match(/^\/api\/feedback\/([^/]+)\/reply$/);
  if (feedbackReplyMatch && method === "POST") return await handled(handleReplyFeedback(req as AuthRequest, res, db, feedbackReplyMatch[1]));

  return false;
}

async function handled(result: void | Promise<void>): Promise<true> {
  await result;
  return true;
}
