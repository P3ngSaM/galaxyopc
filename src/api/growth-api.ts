/**
 * 增长推广系统 API
 *
 * - 邀请码生成 / 查询
 * - 加群奖励
 * - 积分明细
 */

import { v4 as uuid } from "uuid";
import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, requireAuth, parseBody } from "../auth/middleware.js";

const SIGNUP_BONUS = 500;
const INVITE_BONUS = 500;
const GROUP_BONUS = 500;
const FEEDBACK_ACCEPTED_BONUS = 500;

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "OPC-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function addPoints(db: Db, userId: string, amount: number, reason: string, detail = ""): Promise<void> {
  await db.query("UPDATE opc_users SET bonus_points = bonus_points + $1 WHERE id = $2", [amount, userId]);
  await db.query(
    "INSERT INTO opc_points_log (id, user_id, amount, reason, detail) VALUES ($1, $2, $3, $4, $5)",
    [uuid(), userId, amount, reason, detail],
  );
}

// ── 获取/生成我的邀请码 ──
export async function handleGetInviteCode(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows } = await db.query("SELECT invite_code FROM opc_users WHERE id = $1", [userId]);
  let code = (rows[0] as any)?.invite_code || "";

  if (!code) {
    for (let i = 0; i < 5; i++) {
      code = generateInviteCode();
      try {
        await db.query("UPDATE opc_users SET invite_code = $1 WHERE id = $2 AND invite_code = ''", [code, userId]);
        const { rows: check } = await db.query("SELECT invite_code FROM opc_users WHERE id = $1", [userId]);
        code = (check[0] as any)?.invite_code || code;
        break;
      } catch { /* unique violation, retry */ }
    }
  }

  const { rows: stats } = await db.query(
    "SELECT COUNT(*)::int AS cnt FROM opc_users WHERE invited_by = $1",
    [userId],
  );
  const invitedCount = (stats[0] as any)?.cnt || 0;

  sendJson(res, 200, { invite_code: code, invited_count: invitedCount, bonus_per_invite: INVITE_BONUS });
}

// ── 密钥兑换积分 ──
export async function handleClaimGroupBonus(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const body = await parseBody(req) as { redeem_key?: string };
  const key = (body.redeem_key || "").trim().toUpperCase();

  if (!key) {
    sendJson(res, 400, { error: "请输入兑换密钥" });
    return;
  }

  const { rows: keyRows } = await db.query(
    "SELECT id, points FROM opc_redeem_keys WHERE key = $1 AND used_by IS NULL",
    [key],
  );
  if (!keyRows.length) {
    sendJson(res, 400, { error: "密钥无效或已被使用" });
    return;
  }
  const keyId = (keyRows[0] as any).id;
  const keyPoints = (keyRows[0] as any).points || 500;

  await db.query("UPDATE opc_redeem_keys SET used_by = $1, used_at = NOW() WHERE id = $2", [userId, keyId]);
  await addPoints(db, userId, keyPoints, "redeem_key", `密钥兑换 ${keyPoints} 积分`);

  sendJson(res, 200, { success: true, points: keyPoints, message: `兑换成功！已获得 ${keyPoints} 积分` });
}

// ── 管理员：批量生成兑换密钥 ──
export async function handleGenerateRedeemKeys(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req) as { count?: number; points?: number };
  const count = Math.min(Math.max(Number(body.count) || 5, 1), 50);
  const points = Math.min(Math.max(Number(body.points) || 500, 50), 50000);

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    let k = "RDM-";
    for (let j = 0; j < 8; j++) k += chars[Math.floor(Math.random() * chars.length)];
    await db.query(
      "INSERT INTO opc_redeem_keys (id, key, points, created_by) VALUES ($1, $2, $3, $4)",
      [uuid(), k, points, req.user!.userId],
    );
    keys.push(k);
  }
  sendJson(res, 200, { keys, count, points });
}

// ── 管理员：查看密钥列表 ──
export async function handleListRedeemKeys(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    `SELECT k.id, k.key, k.points, k.created_at, k.used_at, u.name AS used_by_name
     FROM opc_redeem_keys k LEFT JOIN opc_users u ON k.used_by = u.id
     ORDER BY k.created_at DESC LIMIT 200`,
  );
  sendJson(res, 200, { keys: rows });
}

// ── 积分明细 ──
export async function handleGetPointsLog(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;

  const { rows: userRows } = await db.query(
    "SELECT quota_total, quota_used, bonus_points, group_bonus_claimed, invite_code, invited_by FROM opc_users WHERE id = $1",
    [userId],
  );
  const u = userRows[0] as any;

  const { rows: logs } = await db.query(
    "SELECT id, amount, reason, detail, created_at FROM opc_points_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
    [userId],
  );

  const { rows: inviteStats } = await db.query(
    "SELECT COUNT(*)::int AS cnt FROM opc_users WHERE invited_by = $1",
    [userId],
  );

  sendJson(res, 200, {
    bonus_points: u?.bonus_points || 0,
    quota_total: u?.quota_total || 500,
    quota_used: u?.quota_used || 0,
    group_bonus_claimed: u?.group_bonus_claimed || false,
    invite_code: u?.invite_code || "",
    invited_count: (inviteStats[0] as any)?.cnt || 0,
    logs,
  });
}

// ── 注册时发放注册奖励 + 处理邀请码 (被 auth-api 调用) ──
export async function processSignupRewards(db: Db, newUserId: string, inviteCodeInput?: string): Promise<void> {
  console.log("[processSignupRewards] userId:", newUserId, "inviteCode:", inviteCodeInput);
  await addPoints(db, newUserId, SIGNUP_BONUS, "signup", "注册奖励");

  if (inviteCodeInput && inviteCodeInput.trim()) {
    const code = inviteCodeInput.trim().toUpperCase();
    console.log("[processSignupRewards] looking up invite_code:", code);
    const { rows } = await db.query(
      "SELECT id, name FROM opc_users WHERE UPPER(invite_code) = $1 AND id != $2",
      [code, newUserId],
    );
    console.log("[processSignupRewards] inviter lookup result:", rows.length, "rows");
    if (rows[0]) {
      const inviterId = (rows[0] as any).id;
      const inviterName = (rows[0] as any).name;
      console.log("[processSignupRewards] found inviter:", inviterId, inviterName);
      await db.query("UPDATE opc_users SET invited_by = $1 WHERE id = $2", [inviterId, newUserId]);
      await addPoints(db, newUserId, INVITE_BONUS, "invited", `通过邀请码 ${code} 注册`);
      await addPoints(db, inviterId, INVITE_BONUS, "referral", `邀请新用户 ${newUserId.slice(0, 8)} 注册`);
      console.log("[processSignupRewards] rewards distributed to both users");
    } else {
      console.log("[processSignupRewards] no inviter found for code:", code);
    }
  }
}

// ── 签到系统 ──

const CHECKIN_DAILY_REWARD = 100;
const CHECKIN_STREAK_BONUS = 100;
const CHECKIN_STREAK_DAYS = 7;

function getChinaDateStr(offset = 0): string {
  const now = new Date(Date.now() + offset * 86400000 + 8 * 3600000);
  return now.toISOString().slice(0, 10);
}

function toDateStr(d: any): string {
  if (d instanceof Date) {
    return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

export async function handleCheckinStatus(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const today = getChinaDateStr();

  const { rows: todayRow } = await db.query(
    "SELECT id FROM opc_checkins WHERE user_id = $1 AND checkin_date = $2", [userId, today]
  );
  const checkedToday = todayRow.length > 0;

  const { rows: recent } = await db.query(
    "SELECT checkin_date, streak, reward, bonus FROM opc_checkins WHERE user_id = $1 ORDER BY checkin_date DESC LIMIT 30",
    [userId]
  );

  let currentStreak = 0;
  if (recent.length > 0) {
    const todayStr = today;
    const yesterdayStr = getChinaDateStr(-1);
    const lastDate = toDateStr(recent[0].checkin_date);

    if (lastDate === todayStr || lastDate === yesterdayStr) {
      currentStreak = recent[0].streak || 1;
    }
  }

  const checkinDates = recent.map(function(r: any) {
    return toDateStr(r.checkin_date);
  });

  const totalCheckins = await db.query("SELECT COUNT(*)::int as cnt FROM opc_checkins WHERE user_id = $1", [userId]);

  sendJson(res, 200, {
    checked_today: checkedToday,
    current_streak: currentStreak,
    total_checkins: (totalCheckins.rows[0] as any)?.cnt || 0,
    checkin_dates: checkinDates,
    daily_reward: CHECKIN_DAILY_REWARD,
    streak_bonus: CHECKIN_STREAK_BONUS,
    streak_days: CHECKIN_STREAK_DAYS,
  });
}

export async function handleDoCheckin(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.userId;
  const today = getChinaDateStr();

  const { rows: exists } = await db.query(
    "SELECT id FROM opc_checkins WHERE user_id = $1 AND checkin_date = $2", [userId, today]
  );
  if (exists.length > 0) {
    sendJson(res, 400, { error: "今日已签到" });
    return;
  }

  const yesterday = getChinaDateStr(-1);
  const { rows: yRow } = await db.query(
    "SELECT streak FROM opc_checkins WHERE user_id = $1 AND checkin_date = $2", [userId, yesterday]
  );
  const prevStreak = yRow.length > 0 ? (yRow[0] as any).streak || 0 : 0;
  const newStreak = prevStreak + 1;

  let bonus = 0;
  if (newStreak > 0 && newStreak % CHECKIN_STREAK_DAYS === 0) {
    bonus = CHECKIN_STREAK_BONUS;
  }

  const totalReward = CHECKIN_DAILY_REWARD + bonus;
  const id = "ck_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);

  await db.query(
    "INSERT INTO opc_checkins (id, user_id, checkin_date, streak, reward, bonus) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, userId, today, newStreak, CHECKIN_DAILY_REWARD, bonus]
  );

  await db.query("UPDATE opc_users SET quota_total = quota_total + $1 WHERE id = $2", [totalReward, userId]);

  await addPoints(db, userId, totalReward, "checkin",
    "每日签到" + (bonus > 0 ? ` + 连续${newStreak}天额外奖励` : "")
  );

  sendJson(res, 200, {
    success: true,
    streak: newStreak,
    reward: CHECKIN_DAILY_REWARD,
    bonus: bonus,
    total_reward: totalReward,
    message: bonus > 0
      ? `签到成功！连续${newStreak}天，获得 ${CHECKIN_DAILY_REWARD} + ${bonus} = ${totalReward} 算力`
      : `签到成功！获得 ${CHECKIN_DAILY_REWARD} 算力`,
  });
}

export { SIGNUP_BONUS, INVITE_BONUS, GROUP_BONUS, FEEDBACK_ACCEPTED_BONUS, addPoints };
