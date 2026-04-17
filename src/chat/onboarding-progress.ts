import type { Db } from "../db.js";

export interface OnboardingData {
  ai_name?: string;
  user_background?: string;
  communication_style?: string;
  startup_goal?: string;
  registration_intent?: string;
  updated_at?: string;
}

const STYLE_RULES = [
  { value: "direct", patterns: [/直接犀利/, /\bA\b/, /^A[.。 、]?/, /直接点/, /少废话/] },
  { value: "gentle", patterns: [/温和耐心/, /\bB\b/, /^B[.。 、]?/, /耐心点/, /慢一点/] },
  { value: "humor", patterns: [/幽默轻松/, /\bC\b/, /^C[.。 、]?/, /幽默/, /轻松一点/] },
  { value: "professional", patterns: [/严谨专业/, /\bD\b/, /^D[.。 、]?/, /专业一点/, /严谨点/] },
];

const REGISTRATION_RULES = [
  { value: "real", patterns: [/真实注册/, /线下/, /营业执照/, /工商/, /政务大厅/, /银行开户/, /税务报到/, /对公账户/, /刻章/] },
  { value: "virtual", patterns: [/先模拟/, /先跑业务/, /先测试市场/, /先不注册/, /不真实注册/, /虚拟公司/, /先做业务/] },
];

const COMMON_SHORT_REPLIES = new Set(["好的", "可以", "行", "嗯", "好", "收到", "继续"]);

export async function updateOnboardingProgress(db: Db, userId: string, userMessage: string): Promise<OnboardingData> {
  const current = await getOnboardingData(db, userId);
  const next: OnboardingData = { ...current };
  const msg = String(userMessage || "").trim();
  const isRenameOnly = /^(?:叫你|你叫|以后叫你?|名字叫|就叫)\s*[「"'【《]?\s*[A-Za-z\u4e00-\u9fff]{1,12}\s*[」"'】》]?$/i.test(msg);
  const isStyleOnly = msg.length <= 16 && STYLE_RULES.some((rule) => rule.patterns.some((pattern) => pattern.test(msg)));
  const isRegistrationOnly = msg.length <= 24 && REGISTRATION_RULES.some((rule) => rule.patterns.some((pattern) => pattern.test(msg)));

  if (!msg) return next;

  if (!next.ai_name) {
    const renameMatched = msg.match(/(?:叫你|你叫|以后叫你?|名字叫|就叫)\s*[「"'【《]?\s*([A-Za-z\u4e00-\u9fff]{1,12})\s*[」"'】》]?/i);
    const shortNameCandidate = /^[A-Za-z\u4e00-\u9fff]{1,12}$/.test(msg) && !COMMON_SHORT_REPLIES.has(msg);
    if (renameMatched?.[1]) next.ai_name = renameMatched[1];
    else if (shortNameCandidate) next.ai_name = msg;
  }

  if (!next.communication_style) {
    for (const rule of STYLE_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(msg))) {
        next.communication_style = rule.value;
        break;
      }
    }
  }

  if (!next.registration_intent) {
    for (const rule of REGISTRATION_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(msg))) {
        next.registration_intent = rule.value;
        break;
      }
    }
  }

  if (!next.startup_goal && /创业|公司|业务|客户|服务|产品|订单|项目|招标|获客|报价|注册|开单|变现/.test(msg) && msg.length >= 6) {
    next.startup_goal = msg.slice(0, 240);
  }

  if (!next.user_background && msg.length >= 6 && !isRenameOnly && !isStyleOnly && !isRegistrationOnly) {
    next.user_background = msg.slice(0, 240);
  }

  next.updated_at = new Date().toISOString();
  await saveOnboardingData(db, userId, next);
  return next;
}

export async function markOnboardingDoneIfReady(db: Db, userId: string): Promise<boolean> {
  const data = await getOnboardingData(db, userId);
  const { rows: companyRows } = await db.query(
    "SELECT COUNT(*) AS cnt FROM opc_user_companies WHERE user_id = $1",
    [userId],
  );
  const companyCount = Number((companyRows[0] as { cnt: string }).cnt || 0);
  const ready = Boolean(
    data.ai_name &&
    data.communication_style &&
    data.startup_goal &&
    data.registration_intent &&
    (data.user_background || companyCount > 0)
  );
  if (ready) {
    await db.query(
      "UPDATE opc_users SET onboarding_done = true WHERE id = $1 AND onboarding_done = false",
      [userId],
    );
  }
  return ready;
}

async function getOnboardingData(db: Db, userId: string): Promise<OnboardingData> {
  const { rows } = await db.query("SELECT onboarding_data FROM opc_users WHERE id = $1", [userId]);
  const raw = (rows[0] as { onboarding_data?: string } | undefined)?.onboarding_data || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveOnboardingData(db: Db, userId: string, data: OnboardingData): Promise<void> {
  await db.query(
    "UPDATE opc_users SET onboarding_data = $1 WHERE id = $2",
    [JSON.stringify(data), userId],
  );
}
