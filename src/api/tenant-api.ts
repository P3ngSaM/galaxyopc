/**
 * 租户白标配置 API — 用户可自定义品牌、主题色、Logo 生成专属 OPC 页面
 */
import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, parseBody, requireAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, basename, extname } from "node:path";

const UPLOAD_DIR = resolve(process.cwd(), basename(process.cwd()) === "opc-server" ? "uploads" : "opc-server/uploads", "tenant-logos");

const PRESET_THEMES: Record<string, {
  accent: string; accent2: string; bg: string; panel: string;
  text: string; secondaryText: string; border: string;
  fontFamily?: string; fontScale?: number; fontWeight?: number;
}> = {
  // ─── 原生基础主题 ───
  "dark-indigo": {
    accent: "#5E6AD2", accent2: "#7C86E8", bg: "#080A12", panel: "#0D101C",
    text: "#F5F7FF", secondaryText: "#98A2C6", border: "rgba(45,55,84,0.7)",
    fontFamily: "'Inter','Noto Sans SC',system-ui,sans-serif",
  },
  "dark-emerald": {
    accent: "#10B981", accent2: "#34D399", bg: "#060D0A", panel: "#0A1510",
    text: "#F0FDF4", secondaryText: "#86EFAC", border: "rgba(34,84,61,0.7)",
    fontFamily: "'JetBrains Mono','Noto Sans SC',monospace",
  },
  "dark-amber": {
    accent: "#F59E0B", accent2: "#FBBF24", bg: "#0C0A04", panel: "#14110A",
    text: "#FFFBEB", secondaryText: "#FCD34D", border: "rgba(120,80,20,0.7)",
    fontFamily: "'DM Sans','Noto Sans SC',system-ui,sans-serif", fontWeight: 500,
  },
  "dark-rose": {
    accent: "#F43F5E", accent2: "#FB7185", bg: "#0C0406", panel: "#14080B",
    text: "#FFF1F2", secondaryText: "#FDA4AF", border: "rgba(100,30,50,0.7)",
    fontFamily: "'Playfair Display','Noto Serif SC',Georgia,serif", fontScale: 1.02,
  },
  "dark-cyan": {
    accent: "#06B6D4", accent2: "#22D3EE", bg: "#040C0E", panel: "#081416",
    text: "#ECFEFF", secondaryText: "#67E8F9", border: "rgba(20,70,90,0.7)",
  },
  "light-blue": {
    accent: "#2563EB", accent2: "#3B82F6", bg: "#FFFFFF", panel: "#F8FAFC",
    text: "#0F172A", secondaryText: "#64748B", border: "rgba(226,232,240,1)",
  },
  "light-orange": {
    accent: "#F97316", accent2: "#FB923C", bg: "#FFFFFF", panel: "#FFF7ED",
    text: "#1C1917", secondaryText: "#78716C", border: "rgba(231,229,228,1)",
  },
  "light-violet": {
    accent: "#8B5CF6", accent2: "#A78BFA", bg: "#FFFFFF", panel: "#F5F3FF",
    text: "#1E1B4B", secondaryText: "#6D28D9", border: "rgba(221,214,254,1)",
  },
  // ─── 品牌级主题（源自 awesome-design-md，66 个品牌） ───
  "brand-airbnb":     { accent: "#ff385c", accent2: "#e00b41", bg: "#222222", panel: "#3f3f3f", text: "#ffffff", secondaryText: "#6a6a6a", border: "rgba(0,0,0,0.08)" },
  "brand-airtable":   { accent: "#1b61c9", accent2: "#254fad", bg: "#181d26", panel: "#333333", text: "#ffffff", secondaryText: "#888888", border: "rgba(15,48,106,0.35)" },
  "brand-apple":      { accent: "#0071e3", accent2: "#2997ff", bg: "#000000", panel: "#272729", text: "#ffffff", secondaryText: "rgba(255,255,255,0.8)", border: "rgba(255,255,255,0.15)" },
  "brand-binance":    { accent: "#F0B90B", accent2: "#FFD000", bg: "#222126", panel: "#2B2F36", text: "#FFFFFF", secondaryText: "#848E9C", border: "rgba(230,232,234,0.5)" },
  "brand-bmw":        { accent: "#1c69d4", accent2: "#0653b6", bg: "#000000", panel: "#1a1a1a", text: "#ffffff", secondaryText: "#bbbbbb", border: "rgba(255,255,255,0.2)" },
  "brand-bugatti":    { accent: "#ffffff", accent2: "#999999", bg: "#000000", panel: "#0a0a0a", text: "#ffffff", secondaryText: "#999999", border: "rgba(255,255,255,0.5)" },
  "brand-cal":        { accent: "#0099ff", accent2: "#242424", bg: "#000000", panel: "#242424", text: "#ffffff", secondaryText: "#898989", border: "rgba(34,42,53,0.35)" },
  "brand-claude":     { accent: "#c96442", accent2: "#d97757", bg: "#141413", panel: "#30302e", text: "#faf9f5", secondaryText: "#b0aea5", border: "rgba(48,48,46,1)" },
  "brand-clay":       { accent: "#078a52", accent2: "#3bd3fd", bg: "#02492a", panel: "#078a52", text: "#ffffff", secondaryText: "#9f9b93", border: "rgba(0,0,0,0.1)" },
  "brand-clickhouse": { accent: "#faff69", accent2: "#166534", bg: "#000000", panel: "#141414", text: "#ffffff", secondaryText: "#a0a0a0", border: "rgba(65,65,65,0.8)" },
  "brand-cohere":     { accent: "#1863dc", accent2: "#9b60aa", bg: "#17171c", panel: "#212121", text: "#ffffff", secondaryText: "#93939f", border: "rgba(217,217,221,0.3)" },
  "brand-coinbase":   { accent: "#0052ff", accent2: "#578bfa", bg: "#0a0b0d", panel: "#282b31", text: "#ffffff", secondaryText: "#5b616e", border: "rgba(91,97,110,0.2)" },
  "brand-composio":   { accent: "#0007cd", accent2: "#00ffff", bg: "#0f0f0f", panel: "#000000", text: "#ffffff", secondaryText: "rgba(255,255,255,0.6)", border: "rgba(255,255,255,0.1)" },
  "brand-cursor":     { accent: "#f54e00", accent2: "#c08532", bg: "#1c1b18", panel: "#26251e", text: "#f2f1ed", secondaryText: "#a8a69e", border: "rgba(38,37,30,0.2)" },
  "brand-elevenlabs": { accent: "#000000", accent2: "#777169", bg: "#000000", panel: "#4e4e4e", text: "#ffffff", secondaryText: "#a0a0a0", border: "rgba(0,0,0,0.35)" },
  "brand-expo":       { accent: "#0d74ce", accent2: "#47c2ff", bg: "#171717", panel: "#1a1a1a", text: "#ffffff", secondaryText: "#60646c", border: "rgba(224,225,230,0.35)" },
  "brand-ferrari":    { accent: "#DA291C", accent2: "#B01E0A", bg: "#000000", panel: "#303030", text: "#FFFFFF", secondaryText: "#8F8F8F", border: "rgba(204,204,204,0.35)" },
  "brand-figma":      { accent: "#a259ff", accent2: "#1abcfe", bg: "#000000", panel: "#0e0e0e", text: "#ffffff", secondaryText: "rgba(255,255,255,0.72)", border: "rgba(255,255,255,0.16)" },
  "brand-framer":     { accent: "#0099ff", accent2: "#0077cc", bg: "#000000", panel: "#090909", text: "#ffffff", secondaryText: "#a6a6a6", border: "rgba(0,153,255,0.15)" },
  "brand-hashicorp":  { accent: "#1060ff", accent2: "#2b89ff", bg: "#0d0e12", panel: "#15181e", text: "#efeff1", secondaryText: "#d5d7db", border: "rgba(178,182,189,0.4)" },
  "brand-ibm":        { accent: "#0f62fe", accent2: "#78a9ff", bg: "#161616", panel: "#262626", text: "#f4f4f4", secondaryText: "#c6c6c6", border: "rgba(255,255,255,0.08)" },
  "brand-intercom":   { accent: "#ff5600", accent2: "#fe4c02", bg: "#111111", panel: "#313130", text: "#ffffff", secondaryText: "#7b7b78", border: "rgba(222,219,214,0.35)" },
  "brand-kraken":     { accent: "#7132f5", accent2: "#5741d8", bg: "#101114", panel: "#1a1a20", text: "#ffffff", secondaryText: "#9497a9", border: "rgba(104,107,130,0.24)" },
  "brand-lamborghini":{ accent: "#FFC000", accent2: "#917300", bg: "#000000", panel: "#202020", text: "#FFFFFF", secondaryText: "#7D7D7D", border: "rgba(255,255,255,0.5)" },
  "brand-linear":     { accent: "#5e6ad2", accent2: "#7170ff", bg: "#08090a", panel: "#0f1011", text: "#f7f8f8", secondaryText: "#8a8f98", border: "rgba(255,255,255,0.05)" },
  "brand-lovable":    { accent: "#1c1c1c", accent2: "#5f5f5d", bg: "#1c1c1c", panel: "#2d2b27", text: "#fcfbf8", secondaryText: "#5f5f5d", border: "rgba(28,28,28,0.4)" },
  "brand-meta":       { accent: "#0064E0", accent2: "#0143B5", bg: "#1C1E21", panel: "#181A1B", text: "#ffffff", secondaryText: "#5D6C7B", border: "rgba(255,255,255,0.08)" },
  "brand-minimax":    { accent: "#1456f0", accent2: "#2563eb", bg: "#181e25", panel: "#222831", text: "#ffffff", secondaryText: "#45515e", border: "rgba(229,231,235,0.35)" },
  "brand-mintlify":   { accent: "#18E299", accent2: "#0fa76e", bg: "#0d0d0d", panel: "#141414", text: "#ededed", secondaryText: "#a0a0a0", border: "rgba(255,255,255,0.08)" },
  "brand-miro":       { accent: "#5b76fe", accent2: "#2a41b6", bg: "#000000", panel: "#1c1c1e", text: "#ffffff", secondaryText: "#a5a8b5", border: "rgba(224,226,232,0.35)" },
  "brand-mistral":    { accent: "#fa520f", accent2: "#fb6424", bg: "#1f1f1f", panel: "#262626", text: "#ffffff", secondaryText: "rgba(255,255,255,0.65)", border: "rgba(255,255,255,0.12)" },
  "brand-mongodb":    { accent: "#00ed64", accent2: "#1eaedb", bg: "#001e2b", panel: "#1c2d38", text: "#ffffff", secondaryText: "#5c6c75", border: "rgba(61,79,88,0.65)" },
  "brand-nike":       { accent: "#ffffff", accent2: "#e5e5e5", bg: "#111111", panel: "#28282A", text: "#ffffff", secondaryText: "#707072", border: "rgba(255,255,255,0.15)" },
  "brand-notion":     { accent: "#0075de", accent2: "#62aef0", bg: "#31302e", panel: "#3d3c3a", text: "#f6f5f4", secondaryText: "#a39e98", border: "rgba(255,255,255,0.1)" },
  "brand-nvidia":     { accent: "#76b900", accent2: "#bff230", bg: "#000000", panel: "#1a1a1a", text: "#ffffff", secondaryText: "#a7a7a7", border: "rgba(94,94,94,1)" },
  "brand-ollama":     { accent: "#ffffff", accent2: "#e5e5e5", bg: "#090909", panel: "#262626", text: "#ffffff", secondaryText: "#737373", border: "rgba(255,255,255,0.12)" },
  "brand-opencode":   { accent: "#007aff", accent2: "#0056b3", bg: "#201d1d", panel: "#302c2c", text: "#fdfcfc", secondaryText: "#9a9898", border: "rgba(15,0,0,0.12)" },
  "brand-pinterest":  { accent: "#e60023", accent2: "#bcbcb3", bg: "#33332e", panel: "#3d3d38", text: "#ffffff", secondaryText: "#91918c", border: "rgba(255,255,255,0.12)" },
  "brand-playstation":{ accent: "#0070cc", accent2: "#1eaedb", bg: "#000000", panel: "#121314", text: "#ffffff", secondaryText: "#6b6b6b", border: "rgba(0,0,0,0.16)" },
  "brand-posthog":    { accent: "#F54E00", accent2: "#F7A501", bg: "#1e1f23", panel: "#2a2c2e", text: "#fdfdf8", secondaryText: "#9ea096", border: "rgba(191,193,183,0.4)" },
  "brand-raycast":    { accent: "#FF6363", accent2: "#55b3ff", bg: "#07080a", panel: "#101111", text: "#f9f9f9", secondaryText: "#9c9c9d", border: "rgba(255,255,255,0.06)" },
  "brand-renault":    { accent: "#EFDF00", accent2: "#1883FD", bg: "#000000", panel: "#222222", text: "#ffffff", secondaryText: "#D9D9D6", border: "rgba(255,255,255,0.15)" },
  "brand-replicate":  { accent: "#ea2804", accent2: "#dd4425", bg: "#202020", panel: "#242424", text: "#fcfcfc", secondaryText: "#8d8d8d", border: "rgba(255,255,255,0.12)" },
  "brand-resend":     { accent: "#ff801f", accent2: "#3b9eff", bg: "#000000", panel: "#0a0a0a", text: "#f0f0f0", secondaryText: "#a1a4a5", border: "rgba(214,235,253,0.19)" },
  "brand-revolut":    { accent: "#494fdf", accent2: "#4f55f1", bg: "#191c1f", panel: "#25282c", text: "#ffffff", secondaryText: "#8d969e", border: "rgba(255,255,255,0.12)" },
  "brand-runway":     { accent: "#ffffff", accent2: "#767d88", bg: "#000000", panel: "#1a1a1a", text: "#ffffff", secondaryText: "#767d88", border: "rgba(39,39,42,0.9)" },
  "brand-sanity":     { accent: "#f36458", accent2: "#0052ef", bg: "#0b0b0b", panel: "#212121", text: "#ffffff", secondaryText: "#b9b9b9", border: "rgba(53,53,53,0.85)" },
  "brand-sentry":     { accent: "#c2ef4e", accent2: "#6a5fc1", bg: "#150f23", panel: "#1f1633", text: "#ffffff", secondaryText: "#e5e7eb", border: "rgba(54,45,89,0.55)" },
  "brand-shopify":    { accent: "#36F4A4", accent2: "#ffffff", bg: "#000000", panel: "#02090A", text: "#ffffff", secondaryText: "#A1A1AA", border: "rgba(30,44,49,0.85)" },
  "brand-spacex":     { accent: "#f0f0fa", accent2: "#aaaacc", bg: "#000000", panel: "#0a0a0a", text: "#f0f0fa", secondaryText: "rgba(240,240,250,0.7)", border: "rgba(240,240,250,0.2)" },
  "brand-spotify":    { accent: "#1ed760", accent2: "#1db954", bg: "#121212", panel: "#181818", text: "#ffffff", secondaryText: "#b3b3b3", border: "rgba(77,77,77,1)" },
  "brand-stripe":     { accent: "#533afd", accent2: "#4434d4", bg: "#0d253d", panel: "#1c1e54", text: "#ffffff", secondaryText: "#64748d", border: "rgba(50,50,93,0.25)" },
  "brand-supabase":   { accent: "#3ecf8e", accent2: "#00c573", bg: "#0f0f0f", panel: "#171717", text: "#fafafa", secondaryText: "#b4b4b4", border: "rgba(62,207,142,0.3)" },
  "brand-superhuman": { accent: "#cbb7fb", accent2: "#714cb6", bg: "#1b1938", panel: "#24223a", text: "rgba(255,255,255,0.95)", secondaryText: "rgba(255,255,255,0.8)", border: "rgba(255,255,255,0.2)" },
  "brand-tesla":      { accent: "#3E6AE1", accent2: "#3E6AE1", bg: "#171A20", panel: "#393C41", text: "#FFFFFF", secondaryText: "#8E8E8E", border: "rgba(255,255,255,0.15)" },
  "brand-theverge":   { accent: "#3cffd0", accent2: "#5200ff", bg: "#131313", panel: "#2d2d2d", text: "#ffffff", secondaryText: "#949494", border: "rgba(0,0,0,0.33)" },
  "brand-together":   { accent: "#ef2cc1", accent2: "#fc4c02", bg: "#010120", panel: "#0a0a35", text: "#ffffff", secondaryText: "#8888aa", border: "rgba(255,255,255,0.12)" },
  "brand-uber":       { accent: "#ffffff", accent2: "#e2e2e2", bg: "#000000", panel: "#1a1a1a", text: "#ffffff", secondaryText: "#afafaf", border: "rgba(255,255,255,0.12)" },
  "brand-vercel":     { accent: "#0072f5", accent2: "#0a72ef", bg: "#171717", panel: "#1f1f1f", text: "#ffffff", secondaryText: "#808080", border: "rgba(255,255,255,0.12)" },
  "brand-voltagent":  { accent: "#00d992", accent2: "#2fd6a1", bg: "#050507", panel: "#101010", text: "#f2f2f2", secondaryText: "#b8b3b0", border: "rgba(61,58,57,0.65)" },
  "brand-warp":       { accent: "#353534", accent2: "#afaeac", bg: "#1a1a1a", panel: "#262626", text: "#faf9f6", secondaryText: "#868584", border: "rgba(226,226,226,0.35)" },
  "brand-webflow":    { accent: "#146ef5", accent2: "#0055d4", bg: "#080808", panel: "#222222", text: "#ffffff", secondaryText: "#ababab", border: "rgba(0,0,0,0.08)" },
  "brand-wired":      { accent: "#057dbc", accent2: "#057dbc", bg: "#1a1a1a", panel: "#0a0a0a", text: "#ffffff", secondaryText: "#757575", border: "rgba(226,232,240,0.35)" },
  "brand-wise":       { accent: "#9fe870", accent2: "#cdffad", bg: "#0e0f0c", panel: "#454745", text: "#ffffff", secondaryText: "#868685", border: "rgba(14,15,12,0.12)" },
  "brand-xai":        { accent: "#ffffff", accent2: "#3b82f6", bg: "#1f2228", panel: "#2a2d33", text: "#ffffff", secondaryText: "rgba(255,255,255,0.7)", border: "rgba(255,255,255,0.1)" },
  "brand-zapier":     { accent: "#ff4f00", accent2: "#c5c0b1", bg: "#201515", panel: "#36342e", text: "#fffefb", secondaryText: "#939084", border: "rgba(45,45,46,0.5)" },
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function handleListTenants(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    "SELECT * FROM opc_tenant_configs WHERE user_id = $1 ORDER BY updated_at DESC",
    [req.user!.userId]
  );
  sendJson(res, 200, { tenants: rows });
}

export async function handleGetTenant(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query("SELECT * FROM opc_tenant_configs WHERE id = $1 AND user_id = $2", [id, req.user!.userId]);
  if (!rows.length) return sendJson(res, 404, { error: "配置不存在" });
  sendJson(res, 200, rows[0]);
}

export async function handleGetTenantBySlug(_req: AuthRequest, res: ServerResponse, db: Db, slug: string): Promise<void> {
  const { rows } = await db.query("SELECT * FROM opc_tenant_configs WHERE slug = $1 AND is_published = true", [slug]);
  if (!rows.length) return sendJson(res, 404, { error: "页面不存在" });
  sendJson(res, 200, rows[0]);
}

export async function handleCreateTenant(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows: existing } = await db.query("SELECT 1 FROM opc_tenant_configs WHERE user_id = $1", [req.user!.userId]);
  if (existing.length > 0) return sendJson(res, 400, { error: "每位用户仅可创建一个专属页面，请编辑现有页面" });

  const body = await parseBody(req);
  const companyName = String(body.company_name || "").trim();
  if (!companyName) return sendJson(res, 400, { error: "公司名称不能为空" });

  const themeStyle = String(body.theme_style || "dark-indigo");
  const preset = PRESET_THEMES[themeStyle] || PRESET_THEMES["dark-indigo"];
  const meta = THEME_META[themeStyle];
  const fontFamily = meta?.font || preset.fontFamily || "Inter, Noto Sans SC, system-ui, sans-serif";

  let slug = slugify(body.slug ? String(body.slug) : companyName);
  if (!slug) slug = randomUUID().slice(0, 8);

  const { rows: slugExists } = await db.query("SELECT 1 FROM opc_tenant_configs WHERE slug = $1", [slug]);
  if (slugExists.length) slug = slug + "-" + randomUUID().slice(0, 4);

  const id = randomUUID();
  await db.query(
    `INSERT INTO opc_tenant_configs
      (id, user_id, slug, company_name, theme_style,
       accent_color, accent_color_2, bg_color, panel_color, text_color, secondary_text_color, border_color,
       font_family, topbar_title, topbar_subtitle, login_badge, login_slogan)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, req.user!.userId, slug, companyName, themeStyle,
     preset.accent, preset.accent2, preset.bg, preset.panel, preset.text, preset.secondaryText, preset.border,
     fontFamily, companyName, String(body.topbar_subtitle || ""), String(body.login_badge || "内测中"), String(body.login_slogan || "")]
  );

  const { rows } = await db.query("SELECT * FROM opc_tenant_configs WHERE id = $1", [id]);
  sendJson(res, 201, rows[0]);
}

export async function handleUpdateTenant(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows: existing } = await db.query("SELECT * FROM opc_tenant_configs WHERE id = $1 AND user_id = $2", [id, req.user!.userId]);
  if (!existing.length) return sendJson(res, 404, { error: "配置不存在" });

  const body = await parseBody(req);
  const fields: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;

  const allowedFields = [
    "company_name", "slug", "theme_style", "accent_color", "accent_color_2",
    "bg_color", "panel_color", "text_color", "secondary_text_color", "border_color",
    "font_family", "topbar_title", "topbar_subtitle", "login_badge", "login_slogan",
    "login_tag1", "login_tag2", "login_tag3",
    "custom_css", "enabled_modules", "is_published",
  ];

  for (const f of allowedFields) {
    if (body[f] !== undefined) {
      fields.push(`${f} = $${idx++}`);
      vals.push(f === "is_published" ? Boolean(body[f]) : String(body[f]));
    }
  }

  if (body.theme_style && PRESET_THEMES[String(body.theme_style)]) {
    const preset = PRESET_THEMES[String(body.theme_style)];
    const meta = THEME_META[String(body.theme_style)];
    if (body.accent_color === undefined) { fields.push(`accent_color = $${idx++}`); vals.push(preset.accent); }
    if (body.accent_color_2 === undefined) { fields.push(`accent_color_2 = $${idx++}`); vals.push(preset.accent2); }
    if (body.bg_color === undefined) { fields.push(`bg_color = $${idx++}`); vals.push(preset.bg); }
    if (body.panel_color === undefined) { fields.push(`panel_color = $${idx++}`); vals.push(preset.panel); }
    if (body.text_color === undefined) { fields.push(`text_color = $${idx++}`); vals.push(preset.text); }
    if (body.secondary_text_color === undefined) { fields.push(`secondary_text_color = $${idx++}`); vals.push(preset.secondaryText); }
    if (body.border_color === undefined) { fields.push(`border_color = $${idx++}`); vals.push(preset.border); }
    if (body.font_family === undefined) {
      const ff = meta?.font || preset.fontFamily || "Inter, Noto Sans SC, system-ui, sans-serif";
      fields.push(`font_family = $${idx++}`); vals.push(ff);
    }
  }

  if (!fields.length) return sendJson(res, 400, { error: "无可更新字段" });

  fields.push(`updated_at = NOW()`);
  vals.push(id, req.user!.userId);
  await db.query(`UPDATE opc_tenant_configs SET ${fields.join(", ")} WHERE id = $${idx++} AND user_id = $${idx}`, vals);

  const { rows } = await db.query("SELECT * FROM opc_tenant_configs WHERE id = $1", [id]);
  sendJson(res, 200, rows[0]);
}

export async function handleDeleteTenant(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  await db.query("DELETE FROM opc_tenant_configs WHERE id = $1 AND user_id = $2", [id, req.user!.userId]);
  sendJson(res, 200, { success: true });
}

export async function handleUploadTenantLogo(req: AuthRequest, res: ServerResponse, db: Db, id: string, mode?: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows: existing } = await db.query("SELECT 1 FROM opc_tenant_configs WHERE id = $1 AND user_id = $2", [id, req.user!.userId]);
  if (!existing.length) return sendJson(res, 404, { error: "配置不存在" });

  const isLight = mode === "light";

  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > 2 * 1024 * 1024) return sendJson(res, 400, { error: "Logo 文件不能超过 2MB" });
    chunks.push(chunk as Buffer);
  }
  const buf = Buffer.concat(chunks);

  const header = buf.slice(0, 8);
  let ext = ".png";
  if (header[0] === 0xFF && header[1] === 0xD8) ext = ".jpg";
  else if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") ext = ".webp";
  else if (header.toString("ascii", 1, 4) === "PNG") ext = ".png";
  else if (header.toString("ascii", 0, 3) === "GIF") ext = ".gif";
  else if (header.toString("ascii", 0, 4) === "<svg") ext = ".svg";

  const suffix = isLight ? "-light" : "";
  const fileName = `${id}${suffix}${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(resolve(UPLOAD_DIR, fileName), buf);

  const logoUrl = `/tenant-logos/${fileName}`;
  const col = isLight ? "logo_url_light" : "logo_url";
  await db.query(`UPDATE opc_tenant_configs SET ${col} = $1, updated_at = NOW() WHERE id = $2`, [logoUrl, id]);
  sendJson(res, 200, { [col]: logoUrl });
}

const THEME_META: Record<string, { label: string; category: string; desc: string; font?: string; fontScale?: number; fontWeight?: number }> = {
  "dark-indigo":      { label: "深色靛蓝", category: "基础", desc: "冷靛紫调，精密暗黑", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "dark-emerald":     { label: "深色翡翠", category: "基础", desc: "翠绿点缀，开发者风", font: "'JetBrains Mono','Noto Sans SC',monospace", fontScale: 0.95 },
  "dark-amber":       { label: "深色琥珀", category: "基础", desc: "暖金琥珀，沉稳商务", font: "'DM Sans','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "dark-rose":        { label: "深色玫瑰", category: "基础", desc: "玫红强调，精致优雅", font: "'Playfair Display','Noto Serif SC',Georgia,serif", fontScale: 1.02 },
  "dark-cyan":        { label: "深色青色", category: "基础", desc: "科技青蓝，清冷未来", font: "'Space Grotesk','Noto Sans SC',system-ui,sans-serif" },
  "light-blue":       { label: "浅色蓝", category: "基础", desc: "经典商务蓝，明亮简洁", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "light-orange":     { label: "浅色橙", category: "基础", desc: "活力暖橙，清新明快", font: "'Plus Jakarta Sans','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "light-violet":     { label: "浅色紫", category: "基础", desc: "创意紫调，优雅灵动", font: "'Outfit','Noto Sans SC',system-ui,sans-serif" },
  "brand-airbnb":     { label: "爱彼迎", category: "民宿", desc: "温暖影像留白", font: "'Nunito Sans','Noto Sans SC',sans-serif" },
  "brand-airtable":   { label: "Airtable", category: "协作", desc: "深蓝清爽企业", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-apple":      { label: "苹果", category: "品牌", desc: "苹果蓝极致留白", font: "-apple-system,'SF Pro Display','Noto Sans SC',sans-serif", fontWeight: 400 },
  "brand-binance":    { label: "币安", category: "金融", desc: "黑金交易风", font: "'IBM Plex Sans','Noto Sans SC',sans-serif", fontWeight: 500 },
  "brand-bmw":        { label: "宝马", category: "汽车", desc: "宝马蓝德系精工", font: "'DM Sans','Noto Sans SC',sans-serif", fontWeight: 500 },
  "brand-bugatti":    { label: "布加迪", category: "汽车", desc: "纯黑极简戏剧", font: "'Cormorant Garamond','Noto Serif SC',serif", fontScale: 1.05, fontWeight: 300 },
  "brand-cal":        { label: "Cal.com", category: "协作", desc: "黑白极简日程", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-claude":     { label: "Claude", category: "AI", desc: "陶土暖色人文", font: "'Söhne','Noto Sans SC',system-ui,sans-serif" },
  "brand-clay":       { label: "Clay", category: "协作", desc: "暖色块活泼", font: "'Plus Jakarta Sans','Noto Sans SC',sans-serif", fontWeight: 600 },
  "brand-clickhouse": { label: "ClickHouse", category: "数据", desc: "黑底霓虹速度", font: "'JetBrains Mono','Noto Sans SC',monospace", fontScale: 0.95 },
  "brand-cohere":     { label: "Cohere", category: "AI", desc: "冷静企业克制", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-coinbase":   { label: "Coinbase", category: "金融", desc: "蓝白可信加密", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "brand-composio":   { label: "Composio", category: "开发", desc: "钴蓝青电极客", font: "'Space Grotesk','Noto Sans SC',sans-serif" },
  "brand-cursor":     { label: "Cursor", category: "AI", desc: "暖纸橙标代码", font: "'Berkeley Mono','JetBrains Mono','Noto Sans SC',monospace", fontScale: 0.95 },
  "brand-elevenlabs": { label: "ElevenLabs", category: "AI", desc: "暖白轻音质感", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 300 },
  "brand-expo":       { label: "Expo", category: "开发", desc: "冷灰单色圆润", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-ferrari":    { label: "法拉利", category: "汽车", desc: "红黑意式超跑", font: "'DM Sans','Noto Sans SC',sans-serif", fontWeight: 700 },
  "brand-figma":      { label: "Figma", category: "设计", desc: "纯黑彩虹渐变", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-framer":     { label: "Framer", category: "设计", desc: "纯黑电蓝沉浸", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "brand-hashicorp":  { label: "HashiCorp", category: "科技", desc: "暗色基建多云", font: "'Poppins','Noto Sans SC',sans-serif" },
  "brand-ibm":        { label: "IBM", category: "科技", desc: "碳灰蓝矩企业", font: "'IBM Plex Sans','Noto Sans SC',sans-serif" },
  "brand-intercom":   { label: "Intercom", category: "协作", desc: "暖米橙锐交互", font: "'Plus Jakarta Sans','Noto Sans SC',sans-serif", fontWeight: 500 },
  "brand-kraken":     { label: "Kraken", category: "金融", desc: "紫系可信加密", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "brand-lamborghini":{ label: "兰博基尼", category: "汽车", desc: "黑金棱角夜行", font: "'Oswald','Noto Sans SC',sans-serif", fontWeight: 500, fontScale: 1.03 },
  "brand-linear":     { label: "Linear", category: "协作", desc: "靛紫暗黑工程", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-lovable":    { label: "Lovable", category: "开发", desc: "奶油炭笔人文", font: "'Lora','Noto Serif SC',Georgia,serif", fontScale: 1.02 },
  "brand-meta":       { label: "Meta", category: "品牌", desc: "蓝丸零售画廊", font: "'Optimistic Display','Noto Sans SC',sans-serif" },
  "brand-minimax":    { label: "MiniMax", category: "AI", desc: "白底多彩模型", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-mintlify":   { label: "Mintlify", category: "开发", desc: "文档薄荷清新", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-miro":       { label: "Miro", category: "协作", desc: "蓝紫交互白板", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-mistral":    { label: "Mistral AI", category: "AI", desc: "暖橙琥珀风", font: "'Source Sans 3','Noto Sans SC',sans-serif" },
  "brand-mongodb":    { label: "MongoDB", category: "开发", desc: "深林霓虹绿", font: "'Source Code Pro','Noto Sans SC',monospace", fontScale: 0.96 },
  "brand-nike":       { label: "Nike", category: "品牌", desc: "黑白运动极简", font: "'Futura','DM Sans','Noto Sans SC',sans-serif", fontWeight: 700, fontScale: 1.03 },
  "brand-notion":     { label: "Notion", category: "协作", desc: "暖灰纸感笔记", font: "'Lyon Text','Georgia','Noto Serif SC',serif", fontScale: 1.01 },
  "brand-nvidia":     { label: "英伟达", category: "科技", desc: "黑底电绿算力", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 600 },
  "brand-ollama":     { label: "Ollama", category: "AI", desc: "灰阶极简风", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-opencode":   { label: "OpenCode", category: "开发", desc: "暖黑终端风", font: "'Fira Code','Noto Sans SC',monospace", fontScale: 0.95 },
  "brand-pinterest":  { label: "Pinterest", category: "媒体", desc: "暖白灵感红", font: "'Nunito Sans','Noto Sans SC',sans-serif" },
  "brand-playstation":{ label: "PlayStation", category: "科技", desc: "蓝黑电玩风", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 600 },
  "brand-posthog":    { label: "PostHog", category: "开发", desc: "橄榄暖纸风", font: "'Plus Jakarta Sans','Noto Sans SC',sans-serif" },
  "brand-raycast":    { label: "Raycast", category: "开发", desc: "深蓝工具红", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-renault":    { label: "雷诺", category: "汽车", desc: "黄黑法式风", font: "'Poppins','Noto Sans SC',sans-serif", fontWeight: 500 },
  "brand-replicate":  { label: "Replicate", category: "AI", desc: "红橙极客风", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-resend":     { label: "Resend", category: "开发", desc: "黑底霜蓝边", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-revolut":    { label: "Revolut", category: "金融", desc: "蓝紫金融科技", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "brand-runway":     { label: "Runway", category: "媒体", desc: "暗黑电影风", font: "'DM Sans','Noto Sans SC',sans-serif", fontWeight: 300 },
  "brand-sanity":     { label: "Sanity", category: "开发", desc: "暗夜珊瑚红", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-sentry":     { label: "Sentry", category: "开发", desc: "紫夜荧光绿", font: "'Rubik','Noto Sans SC',sans-serif" },
  "brand-shopify":    { label: "Shopify", category: "电商", desc: "森林霓虹绿", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "brand-spacex":     { label: "SpaceX", category: "科技", desc: "航天影像极简", font: "'DM Sans','Noto Sans SC',sans-serif", fontWeight: 300 },
  "brand-spotify":    { label: "Spotify", category: "媒体", desc: "沉浸黑绿音乐", font: "'Montserrat','Noto Sans SC',sans-serif", fontWeight: 600 },
  "brand-stripe":     { label: "Stripe", category: "金融", desc: "紫靛金融优雅", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-supabase":   { label: "Supabase", category: "开发", desc: "墨绿开发者云", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-superhuman": { label: "Superhuman", category: "协作", desc: "紫暮奢华风", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 300 },
  "brand-tesla":      { label: "特斯拉", category: "汽车", desc: "碳黑电蓝展厅", font: "'Gotham','DM Sans','Noto Sans SC',sans-serif", fontWeight: 400 },
  "brand-theverge":   { label: "The Verge", category: "媒体", desc: "霓虹暗黑科技", font: "'Space Grotesk','Noto Sans SC',sans-serif", fontWeight: 700 },
  "brand-together":   { label: "Together AI", category: "AI", desc: "午夜洋红橙", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-uber":       { label: "Uber", category: "出行", desc: "黑白胶囊风", font: "'Inter','Noto Sans SC',system-ui,sans-serif", fontWeight: 500 },
  "brand-vercel":     { label: "Vercel", category: "开发", desc: "黑白灰基础设施", font: "'Geist','Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-voltagent":  { label: "VoltAgent", category: "开发", desc: "黑底翡翠电", font: "'Space Grotesk','Noto Sans SC',sans-serif" },
  "brand-warp":       { label: "Warp", category: "开发", desc: "温暖暗色终端", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-webflow":    { label: "Webflow", category: "设计", desc: "白底工具蓝", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-wired":      { label: "WIRED", category: "媒体", desc: "纸媒黑白蓝", font: "'Playfair Display','Noto Serif SC',Georgia,serif", fontScale: 1.03 },
  "brand-wise":       { label: "Wise", category: "金融", desc: "青柠金融科技", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
  "brand-xai":        { label: "xAI", category: "AI", desc: "极简黑白终端", font: "'JetBrains Mono','Noto Sans SC',monospace", fontScale: 0.95 },
  "brand-zapier":     { label: "Zapier", category: "协作", desc: "奶油暖橙自动化", font: "'Inter','Noto Sans SC',system-ui,sans-serif" },
};

export async function handleGetPresetThemes(_req: AuthRequest, res: ServerResponse): Promise<void> {
  const list = Object.entries(PRESET_THEMES).map(([key, val]) => {
    const meta = THEME_META[key] || { label: key, category: "其他", desc: "" };
    return {
      key,
      label: meta.label,
      category: meta.category,
      description: meta.desc,
      font: meta.font || val.fontFamily || "",
      fontScale: meta.fontScale ?? val.fontScale ?? 1,
      fontWeight: meta.fontWeight ?? val.fontWeight ?? 0,
      preview: { accent: val.accent, bg: val.bg, panel: val.panel, text: val.text },
    };
  });
  sendJson(res, 200, { themes: list });
}
