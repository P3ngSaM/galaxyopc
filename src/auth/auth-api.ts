/**
 * 用户注册 / 登录 / 个人信息 API
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { AuthRequest } from "./middleware.js";
import type { ServerResponse } from "node:http";
import { hashPassword, verifyPassword } from "./password.js";
import { signToken } from "./jwt.js";
import { sendJson, requireAuth, parseBody } from "./middleware.js";
import { sendVerifyCode, verifyCode } from "./email-code.js";
import { processSignupRewards } from "../api/growth-api.js";
import { getClientIp, hitRateLimit } from "./rate-limit.js";

function isLocalMode(): boolean {
  return process.env.LOCAL_MODE === "true"
    || process.env.OPC_LOCAL_MODE === "1" || process.env.OPC_LOCAL_MODE === "true"
    || process.env.DB_TYPE === "sqlite";
}

export async function handleSendCode(req: AuthRequest, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const email = String(body.email || "").trim().toLowerCase();
  const clientIp = getClientIp(req);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(res, 400, { error: "请输入有效的邮箱地址" });
    return;
  }
  if (hitRateLimit("auth:send-code:ip", clientIp, 10, 10 * 60_000) || hitRateLimit("auth:send-code:email", email, 3, 10 * 60_000)) {
    sendJson(res, 429, { error: "发送过于频繁，请稍后再试" });
    return;
  }
  const result = await sendVerifyCode(email);
  if (!result.ok) {
    sendJson(res, 429, { error: result.error });
    return;
  }
  sendJson(res, 200, { message: "验证码已发送" });
}

export async function handleRegister(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  const body = await parseBody(req);
  const password = String(body.password || "");
  const name = String(body.name || "").trim();
  const isLocal = isLocalMode();
  const clientIp = getClientIp(req);

  if (hitRateLimit("auth:register:ip", clientIp, 20, 60 * 60_000)) {
    sendJson(res, 429, { error: "注册过于频繁，请稍后再试" });
    return;
  }

  if (isLocal) {
    // 本地模式：只需用户名+密码，无需邮箱和验证码
    if (!name || !password) {
      sendJson(res, 400, { error: "用户名和密码不能为空" });
      return;
    }
    if (password.length < 6) {
      sendJson(res, 400, { error: "密码至少6位" });
      return;
    }
    const { rows: existingRows } = await db.query(
      "SELECT id FROM opc_users WHERE LOWER(name) = $1",
      [name.toLowerCase()],
    );
    if (existingRows[0]) {
      sendJson(res, 409, { error: "该用户名已被注册" });
      return;
    }
    const id = uuid();
    const passwordHash = hashPassword(password);
    await db.query(
      "INSERT INTO opc_users (id, phone, email, password_hash, name) VALUES ($1, $2, $3, $4, $5)",
      [id, null, "", passwordHash, name],
    );
    const inviteCode = String(body.invite_code || "").trim();
    await processSignupRewards(db, id, inviteCode).catch(e => console.error("[processSignupRewards error]", e));
    const token = signToken({ userId: id, phone: "", role: "user" });
    sendJson(res, 201, { token, user: { id, phone: "", name, role: "user", avatar: "", email: "" } });
    return;
  }

  // 线上模式：原有邮箱+验证码逻辑
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim();

  if (!email || !code || !password || !name) {
    sendJson(res, 400, { error: "邮箱、验证码、密码、姓名不能为空" });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(res, 400, { error: "请输入有效的邮箱地址" });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: "密码至少6位" });
    return;
  }

  const codeResult = verifyCode(email, code);
  if (!codeResult.ok) {
    sendJson(res, 400, { error: codeResult.error });
    return;
  }

  const { rows: existingRows } = await db.query(
    "SELECT id FROM opc_users WHERE email = $1 AND email != ''",
    [email],
  );
  if (existingRows[0]) {
    sendJson(res, 409, { error: "该邮箱已注册" });
    return;
  }

  const id = uuid();
  const passwordHash = hashPassword(password);

  await db.query(
    "INSERT INTO opc_users (id, phone, email, password_hash, name) VALUES ($1, $2, $3, $4, $5)",
    [id, null, email, passwordHash, name],
  );

  const inviteCode = String(body.invite_code || "").trim();
  await processSignupRewards(db, id, inviteCode).catch(e => console.error("[processSignupRewards error]", e));

  const token = signToken({ userId: id, phone: "", role: "user" });

  sendJson(res, 201, {
    token,
    user: { id, phone: "", name, role: "user", avatar: "", email },
  });
}

export async function handleLogin(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  const body = await parseBody(req);
  const loginType = String(body.login_type || "");
  const cols = "id, phone, name, password_hash, role, avatar, email, status";
  const clientIp = getClientIp(req);

  let user: { id: string; phone: string; name: string; password_hash: string; role: string; avatar: string; email: string; status: string } | undefined;

  if (loginType === "code") {
    const email = String(body.email || "").trim().toLowerCase();
    const code = String(body.code || "").trim();
    if (!email || !code) {
      sendJson(res, 400, { error: "请输入邮箱和验证码" });
      return;
    }
    if (hitRateLimit("auth:login-code:ip", clientIp, 20, 15 * 60_000) || hitRateLimit("auth:login-code:email", email, 8, 15 * 60_000)) {
      sendJson(res, 429, { error: "登录尝试过于频繁，请稍后再试" });
      return;
    }
    const codeResult = verifyCode(email, code);
    if (!codeResult.ok) {
      sendJson(res, 401, { error: codeResult.error || "验证码错误" });
      return;
    }
    const { rows } = await db.query(`SELECT ${cols} FROM opc_users WHERE LOWER(email) = $1`, [email]);
    user = rows[0] as typeof user;
    if (!user) {
      sendJson(res, 401, { error: "该邮箱尚未注册" });
      return;
    }
  } else {
    const account = String(body.phone || body.email || body.account || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!account || !password) {
      sendJson(res, 400, { error: "请输入邮箱/用户名和密码" });
      return;
    }
    if (hitRateLimit("auth:login-password:ip", clientIp, 30, 15 * 60_000) || hitRateLimit("auth:login-password:account", account, 10, 15 * 60_000)) {
      sendJson(res, 429, { error: "登录尝试过于频繁，请稍后再试" });
      return;
    }
    const isEmail = account.includes("@");
    let sql: string;
    if (isEmail) {
      sql = `SELECT ${cols} FROM opc_users WHERE LOWER(email) = $1`;
    } else if (/^\d+$/.test(account)) {
      sql = `SELECT ${cols} FROM opc_users WHERE phone = $1`;
    } else {
      sql = `SELECT ${cols} FROM opc_users WHERE LOWER(name) = $1`;
    }
    const { rows: userRows } = await db.query(sql, [account]);
    user = userRows[0] as typeof user;
    if (!user) {
      sendJson(res, 401, { error: "账号或密码错误" });
      return;
    }
    if (!verifyPassword(password, user.password_hash)) {
      sendJson(res, 401, { error: "账号或密码错误" });
      return;
    }
  }

  if (user.status !== "active") {
    sendJson(res, 403, { error: "账户已被禁用，请联系管理员" });
    return;
  }

  await db.query("UPDATE opc_users SET last_login = NOW() WHERE id = $1", [user.id]);

  const token = signToken({ userId: user.id, phone: user.phone, role: user.role });

  sendJson(res, 200, {
    token,
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      avatar: user.avatar,
      email: user.email,
    },
  });
}

export async function handleGetProfile(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows: userRows } = await db.query(
    "SELECT id, phone, name, email, avatar, role, city_id, status, created_at, last_login, user_province, user_city, user_district, lat, lng FROM opc_users WHERE id = $1",
    [req.user!.userId],
  );
  const user = userRows[0];

  if (!user) {
    sendJson(res, 404, { error: "用户不存在" });
    return;
  }

  sendJson(res, 200, { user });
}

export async function handleUpdateProfile(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const body = await parseBody(req);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  if (body.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(String(body.name)); }
  if (body.email !== undefined) { sets.push(`email = $${idx++}`); vals.push(String(body.email)); }
  if (body.avatar !== undefined) { sets.push(`avatar = $${idx++}`); vals.push(String(body.avatar)); }

  if (sets.length === 0) {
    sendJson(res, 400, { error: "无更新内容" });
    return;
  }

  vals.push(req.user!.userId);
  await db.query(`UPDATE opc_users SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

  const { rows: userRows } = await db.query(
    "SELECT id, phone, name, email, avatar, role, city_id, status, created_at, last_login FROM opc_users WHERE id = $1",
    [req.user!.userId],
  );
  const user = userRows[0];

  sendJson(res, 200, { user });
}

export async function handleChangePassword(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const body = await parseBody(req);
  const newPwd = String(body.new_password || "");

  if (!newPwd || newPwd.length < 8) {
    sendJson(res, 400, { error: "新密码至少8位" });
    return;
  }

  // 方式一：邮箱验证码（个人中心修改密码）
  if (body.email && body.code) {
    const email = String(body.email).trim().toLowerCase();
    const code = String(body.code).trim();
    const ok = verifyCode(email, code);
    if (!ok) {
      sendJson(res, 400, { error: "验证码错误或已过期" });
      return;
    }
    await db.query("UPDATE opc_users SET password_hash = $1 WHERE id = $2", [hashPassword(newPwd), req.user!.userId]);
    sendJson(res, 200, { message: "密码修改成功" });
    return;
  }

  // 方式二：旧密码验证（兼容旧逻辑）
  const oldPwd = String(body.old_password || "");
  if (!oldPwd) {
    sendJson(res, 400, { error: "请提供邮箱验证码或旧密码" });
    return;
  }
  const { rows: userRows } = await db.query("SELECT password_hash FROM opc_users WHERE id = $1", [req.user!.userId]);
  const user = userRows[0] as { password_hash: string } | undefined;
  if (!user || !verifyPassword(oldPwd, user.password_hash)) {
    sendJson(res, 401, { error: "旧密码错误" });
    return;
  }
  await db.query("UPDATE opc_users SET password_hash = $1 WHERE id = $2", [hashPassword(newPwd), req.user!.userId]);
  sendJson(res, 200, { message: "密码修改成功" });
}
