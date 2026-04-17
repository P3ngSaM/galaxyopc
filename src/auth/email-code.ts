/**
 * 邮箱验证码：发送 + 校验
 * SMTP 配置从环境变量读取，内存存储验证码（5 分钟有效）
 */

import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.163.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

const CODE_TTL = 5 * 60 * 1000;
const CODE_LEN = 6;
const SEND_COOLDOWN = 60 * 1000;

interface CodeEntry {
  code: string;
  expiresAt: number;
  sentAt: number;
}

const codeStore = new Map<string, CodeEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of codeStore) {
    if (now > entry.expiresAt) codeStore.delete(email);
  }
}, 60_000);

function generateCode(): string {
  let c = "";
  for (let i = 0; i < CODE_LEN; i++) c += Math.floor(Math.random() * 10);
  return c;
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

export async function sendVerifyCode(email: string): Promise<{ ok: boolean; error?: string }> {
  if (!SMTP_USER || !SMTP_PASS) {
    return { ok: false, error: "邮件服务未配置，请联系管理员设置 SMTP_USER / SMTP_PASS" };
  }
  const existing = codeStore.get(email);
  if (existing && Date.now() - existing.sentAt < SEND_COOLDOWN) {
    const wait = Math.ceil((SEND_COOLDOWN - (Date.now() - existing.sentAt)) / 1000);
    return { ok: false, error: `请 ${wait} 秒后再试` };
  }

  const code = generateCode();
  const now = Date.now();

  try {
    await transporter.sendMail({
      from: `"星环OPC" <${SMTP_USER}>`,
      to: email,
      subject: `【星环OPC】您的验证码：${code}`,
      html: `
        <div style="max-width:480px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="text-align:center;margin-bottom:24px;">
            <h2 style="color:#f97316;margin:0;">星环OPC</h2>
            <p style="color:#888;font-size:13px;margin:4px 0 0;">一人公司 AI 运营平台</p>
          </div>
          <div style="background:#f9fafb;border-radius:12px;padding:24px;text-align:center;">
            <p style="color:#333;font-size:14px;margin:0 0 16px;">您的邮箱验证码为：</p>
            <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#f97316;padding:12px 0;">${code}</div>
            <p style="color:#999;font-size:12px;margin:16px 0 0;">验证码 5 分钟内有效，请勿泄露给他人</p>
          </div>
          <p style="color:#ccc;font-size:11px;text-align:center;margin-top:24px;">如非本人操作，请忽略此邮件</p>
        </div>
      `,
    });

    codeStore.set(email, { code, expiresAt: now + CODE_TTL, sentAt: now });
    return { ok: true };
  } catch (err: any) {
    console.error("[EmailCode] send failed:", err.message);
    return { ok: false, error: "邮件发送失败，请稍后再试" };
  }
}

export function verifyCode(email: string, code: string): { ok: boolean; error?: string } {
  const entry = codeStore.get(email);
  if (!entry) return { ok: false, error: "请先获取验证码" };
  if (Date.now() > entry.expiresAt) {
    codeStore.delete(email);
    return { ok: false, error: "验证码已过期，请重新获取" };
  }
  if (entry.code !== code.trim()) return { ok: false, error: "验证码错误" };
  codeStore.delete(email);
  return { ok: true };
}
