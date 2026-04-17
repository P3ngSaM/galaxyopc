/**
 * AI 蜂群引擎 — Conductor 模式多 Agent 协作
 *
 * 流程：
 * 1. Conductor 分析用户意图，决定需要哪些 Staff Agent 参与
 * 2. 根据模式（parallel / sequential）分发子任务
 * 3. 每个 Agent 独立执行（角色 system_prompt + 角色工具子集 + 角色专属模型）
 * 4. 审计专家审阅 Agent 输出，质量不足的退回修订（最多 1 轮）
 * 5. 智能压缩过长输出，保留关键结论
 * 6. Conductor 汇总所有 Agent 输出（可调用工具），生成统一回复
 * 7. 全流程审计日志落库
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { ChatMessage, ToolDef } from "./ai-client.js";
import { callAi, callAiStreamWithTools, getModel } from "./ai-client.js";
import { executeTool, getToolDefinitions } from "./tool-executor.js";
import { buildSystemPrompt } from "./context-builder.js";
import type { ToolCapability } from "./tool-registry.js";

const COMPRESS_THRESHOLD = 6000;
const MAX_PREVIOUS_OUTPUTS_CHARS = 4000;
const MAX_PREVIOUS_OUTPUTS_SOFT = 2800;

function sanitizeToolCalls(tcs: any[]): any[] {
  return tcs.map(tc => {
    const args = tc.function?.arguments ?? "{}";
    let safe: string;
    try { JSON.parse(args); safe = args; } catch { safe = "{}"; }
    return { ...tc, function: { ...tc.function, arguments: safe } };
  });
}
const PARALLEL_CONCURRENCY = 3;
const MAX_REVISION_ROUNDS = 0;
const MAX_SUMMARY_TOOL_ROUNDS = 2;
const MAX_AGENT_TOOL_ROUNDS = 4;
const AGENT_TIMEOUT_MS = 90_000;
const SUMMARY_TIMEOUT_MS = 90_000;

// 龙宫多模型分配 — dashscope 统一网关，同一 API Key 调用不同基座模型
const CONDUCTOR_MODEL = "qwen3.6-plus";

const ROLE_MODEL: Record<string, string> = {
  researcher: "qwen3.6-plus",
  assistant:  "qwen3.6-plus",
  cfo:        "kimi-k2.5",
  legal:      "glm-5",
  hr:         "minimax-m2.5",
  cmo:        "qwen3.6-plus",
  cto:        "kimi-k2.5",
  product:    "glm-5",
  operation:  "minimax-m2.5",
};

function getAgentModel(role: string): string {
  return ROLE_MODEL[role] || CONDUCTOR_MODEL;
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const forwardAbort = () => ac.abort();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (parent) {
    if (parent.aborted) ac.abort();
    else parent.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    signal: ac.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}

function needsResearcher(userMessage: string): boolean {
  const text = (userMessage || "").trim();
  if (!text) return false;
  if (text.length >= 80) return true;
  return /最新|最近|今天|近期|政策|招标|投标|中标|采购|公告|新闻|市场|行业|调研|数据|趋势|法规|联网|搜索|查一下|搜一下|看看最新/i.test(text);
}

function shouldReview(results: SwarmTurnResult[], plan: SwarmPlan): boolean {
  return MAX_REVISION_ROUNDS > 0 && results.length >= 3 && plan.agents.length >= 3;
}

function fastCompress(text: string): string {
  if (text.length <= COMPRESS_THRESHOLD) return text;
  const head = text.slice(0, 2200).trim();
  const tail = text.slice(-1200).trim();
  return `${head}\n\n[中间内容已省略，为加快蜂群汇总保留首尾关键信息]\n\n${tail}`;
}

interface StaffAgent {
  role: string;
  role_name: string;
  system_prompt: string;
}

interface SwarmPlan {
  mode: "parallel" | "sequential";
  agents: Array<{ role: string; task: string; model?: string }>;
  reasoning: string;
}

interface SwarmTurnResult {
  role: string;
  role_name: string;
  model: string;
  output: string;
  compressed: string;
  tokens_in: number;
  tokens_out: number;
  compress_tokens_in: number;
  compress_tokens_out: number;
  tool_calls_json: string;
}

interface TaskBoardItem {
  role: string;
  role_name: string;
  task: string;
  status: "pending" | "running" | "done" | "skipped";
  summary: string;
  updated_at: string;
}

interface SwarmTaskBoard {
  user_goal: string;
  mode: "parallel" | "sequential";
  researcher_enabled: boolean;
  plan_reasoning: string;
  facts: string[];
  risks: string[];
  actions: string[];
  pending_questions: string[];
  agents: TaskBoardItem[];
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function extractBoardBullets(text: string, limit: number, patterns: RegExp[]): string[] {
  if (!text) return [];
  const rough = text
    .replace(/\r/g, "\n")
    .split(/\n|[。！？!?；;]/)
    .map(s => s.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter(Boolean);

  const picked: string[] = [];
  for (const line of rough) {
    if (patterns.some((pattern) => pattern.test(line))) {
      picked.push(line);
    }
    if (picked.length >= limit) break;
  }

  if (picked.length >= limit) return picked.slice(0, limit);
  for (const line of rough) {
    if (picked.includes(line)) continue;
    picked.push(line);
    if (picked.length >= limit) break;
  }
  return picked.slice(0, limit);
}

function mergeUnique(existing: string[], incoming: string[], limit: number): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const item of [...existing, ...incoming]) {
    const normalized = item.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(normalized);
    if (next.length >= limit) break;
  }
  return next;
}

function buildInitialTaskBoard(
  userGoal: string,
  plan: SwarmPlan,
  includeResearcher: boolean,
  agents: StaffAgent[],
): SwarmTaskBoard {
  const timestamp = nowIso();
  return {
    user_goal: userGoal,
    mode: plan.mode,
    researcher_enabled: includeResearcher,
    plan_reasoning: plan.reasoning,
    facts: [],
    risks: [],
    actions: [],
    pending_questions: [],
    agents: plan.agents.map((agentPlan, index) => ({
      role: agentPlan.role,
      role_name: agents[index]?.role_name || agentPlan.role,
      task: agentPlan.task,
      status: "pending",
      summary: "",
      updated_at: timestamp,
    })),
    updated_at: timestamp,
  };
}

function renderTaskBoardContext(board: SwarmTaskBoard | undefined): string {
  if (!board) return "";
  const agentSummary = board.agents
    .map((agent) => `- ${agent.role_name}(${agent.role}) [${agent.status}]：${agent.task}${agent.summary ? `；摘要：${agent.summary}` : ""}`)
    .join("\n");
  const facts = board.facts.length ? board.facts.map((item) => `- ${item}`).join("\n") : "- 暂无";
  const risks = board.risks.length ? board.risks.map((item) => `- ${item}`).join("\n") : "- 暂无";
  const actions = board.actions.length ? board.actions.map((item) => `- ${item}`).join("\n") : "- 暂无";
  const pending = board.pending_questions.length ? board.pending_questions.map((item) => `- ${item}`).join("\n") : "- 暂无";

  return `\n共享任务板（所有 Agent 共同维护，请基于它继续工作，不要重复劳动）：
用户目标：${board.user_goal}
执行模式：${board.mode}
协调原因：${board.plan_reasoning}

当前任务分工：
${agentSummary}

已知事实：
${facts}

风险/阻塞：
${risks}

建议动作：
${actions}

待确认问题：
${pending}
`;
}

function updateTaskBoardForAgent(
  board: SwarmTaskBoard,
  role: string,
  status: TaskBoardItem["status"],
  summary: string,
  output: string,
): void {
  const timestamp = nowIso();
  const agent = board.agents.find((item) => item.role === role);
  if (agent) {
    agent.status = status;
    agent.summary = summary.trim().slice(0, 220);
    agent.updated_at = timestamp;
  }
  board.facts = mergeUnique(
    board.facts,
    extractBoardBullets(output, 3, [/数据|事实|显示|发布|时间|金额|预算|中标|政策|公告|企业|项目/i]),
    10,
  );
  board.risks = mergeUnique(
    board.risks,
    extractBoardBullets(output, 2, [/风险|注意|难点|阻塞|不确定|合规|预算不足|周期长/i]),
    8,
  );
  board.actions = mergeUnique(
    board.actions,
    extractBoardBullets(output, 3, [/建议|行动|下一步|优先|先做|推进|联系|报价|落地/i]),
    10,
  );
  board.pending_questions = mergeUnique(
    board.pending_questions,
    extractBoardBullets(output, 2, [/待确认|需要确认|未知|缺少|需补充|是否/i]),
    8,
  );
  board.updated_at = timestamp;
}

async function persistTaskBoard(db: Db, sessionId: string, board: SwarmTaskBoard): Promise<void> {
  try {
    await db.query("UPDATE opc_swarm_sessions SET task_board_json = $1 WHERE id = $2", [JSON.stringify(board), sessionId]);
  } catch {
    /* 非关键字段，不阻塞主流程 */
  }
}

function inferSupplementAgent(
  board: SwarmTaskBoard,
  results: SwarmTurnResult[],
  staffList: StaffAgent[],
): { role: string; task: string } | null {
  if (results.length >= 4) return null;

  const completedRoles = new Set(results.map((item) => item.role));
  const textPool = [...board.risks, ...board.pending_questions, ...board.actions].join("\n");
  if (!textPool.trim()) return null;

  const candidates: Array<{ role: string; task: string; hit: boolean }> = [
    {
      role: "legal",
      task: "补充梳理当前问题涉及的合规、合同、政策约束和法律风险，给出明确边界与避坑建议",
      hit: /合规|合同|政策|法律|风险|条款|资质|监管/i.test(textPool),
    },
    {
      role: "cfo",
      task: "补充评估预算、成本、报价、ROI 和资金风险，给出更可执行的财务判断",
      hit: /预算|报价|成本|回款|ROI|财务|资金|佣金|金额/i.test(textPool),
    },
    {
      role: "cmo",
      task: "补充判断市场切入、用户价值、销售话术和获客路径，让方案更容易成交",
      hit: /用户|市场|销售|获客|推广|话术|品牌|切入/i.test(textPool),
    },
    {
      role: "operation",
      task: "补充梳理执行流程、推进节奏、负责人动作和落地节点，避免方案停留在分析层",
      hit: /推进|执行|落地|流程|节点|协同|跟进|动作/i.test(textPool),
    },
    {
      role: "product",
      task: "补充拆解产品方案、需求结构和优先级，明确最小可交付路径",
      hit: /产品|需求|功能|交付|方案|优先级/i.test(textPool),
    },
  ];

  const picked = candidates.find((item) => item.hit && !completedRoles.has(item.role) && staffList.some((staff) => staff.role === item.role));
  return picked ? { role: picked.role, task: picked.task } : null;
}

function updateTaskBoardFromSummary(board: SwarmTaskBoard, summary: string): void {
  board.facts = mergeUnique(board.facts, extractBoardBullets(summary, 3, [/结论|事实|显示|数据|判断|现状/i]), 12);
  board.risks = mergeUnique(board.risks, extractBoardBullets(summary, 2, [/风险|注意|难点|阻塞|不确定/i]), 10);
  board.actions = mergeUnique(board.actions, extractBoardBullets(summary, 4, [/建议|行动|下一步|优先|先做|推进|联系|落地/i]), 12);
  board.pending_questions = mergeUnique(board.pending_questions, extractBoardBullets(summary, 2, [/待确认|需要确认|未知|后续可补/i]), 8);
  board.updated_at = nowIso();
}

export interface SwarmStreamCallbacks {
  onPlanStart?: () => void;
  onPlanReady: (plan: SwarmPlan, agents: StaffAgent[]) => void;
  onAgentStart: (role: string, roleName: string, task: string, model?: string) => void;
  onAgentChunk: (role: string, delta: string) => void;
  onAgentDone: (role: string, output: string) => void;
  onReviewStart?: () => void;
  onSummaryChunk: (delta: string) => void;
  onDone: (summary: string, swarmSessionId: string) => void;
  onError: (error: string) => void;
  onAgentReview?: (role: string, score: "pass" | "revise", feedback: string) => void;
  onAgentRevise?: (role: string, roleName: string) => void;
  onAuditEntry?: (entry: { phase: string; role?: string; duration_ms: number; tokens_in: number; tokens_out: number }) => void;
}

const ROLE_TOOLS: Record<string, string[]> = {
  researcher: ["opc_search", "opc_webpage", "opc_manage", "native_web_search", "native_web_extract", "native_code_interpreter"],
  cfo:        ["opc_finance", "opc_manage", "opc_data_analysis"],
  legal:      ["opc_legal", "opc_manage"],
  hr:         ["opc_hr", "opc_manage"],
  cmo:        ["opc_manage", "opc_search", "opc_report", "opc_document", "native_web_search", "native_web_extract"],
  cto:        ["opc_project", "opc_manage", "opc_search", "opc_document", "native_code_interpreter"],
  product:    ["opc_project", "opc_manage", "opc_document"],
  operation:  ["opc_manage", "opc_data_analysis", "opc_report", "opc_email"],
  assistant:  ["opc_manage", "opc_search", "opc_email", "opc_schedule", "opc_report", "opc_document", "opc_data_analysis", "native_web_search", "native_web_extract", "native_code_interpreter"],
};

const ROLE_CAPABILITIES: Record<string, ToolCapability[]> = {
  researcher: ["research", "core_business"],
  cfo: ["core_business", "research"],
  legal: ["core_business", "document"],
  hr: ["core_business"],
  cmo: ["research", "document", "core_business"],
  cto: ["research", "document", "core_business", "automation"],
  product: ["document", "core_business"],
  operation: ["core_business", "research", "communication", "document"],
  assistant: ["core_business", "research", "communication", "document", "automation"],
};

function filterToolsForRole(role: string): ToolDef[] {
  const capabilityFilteredTools = getToolDefinitions({
    capabilities: ROLE_CAPABILITIES[role] || ROLE_CAPABILITIES["assistant"],
  });
  const allowed = ROLE_TOOLS[role] || ROLE_TOOLS["assistant"];
  return capabilityFilteredTools.filter((tool) => allowed.includes(tool.function.name));
}

// 情报专家 — 强制首发，搜集最新数据注入后续 Agent
const RESEARCHER_AGENT: StaffAgent = {
  role: "researcher",
  role_name: "情报专家",
  system_prompt: `你是情报搜集专家，负责为团队收集最新的信息和数据。

核心职责：
- 使用 opc_search 工具搜索与用户问题相关的最新资讯、行业数据、政策法规、市场动态
- 使用 opc_webpage 工具抓取关键网页的详细内容
- 整理搜集到的信息，提炼关键数据和事实

工作规则：
- 必须至少调用 2 次 opc_search 搜索不同维度的信息
- 优先搜索最近的数据（使用 time_range 参数限定 week 或 month）
- 对重要搜索结果，用 opc_webpage 获取完整内容
- 输出格式：按主题分类整理，标注信息来源和时间
- 只做信息搜集和整理，不做分析判断或给出建议
- 用中文输出`,
};

const DEFAULT_STAFF: StaffAgent[] = [
  { role: "assistant", role_name: "综合助理", system_prompt: "你是一位综合助理，擅长信息整合、任务分解和文档撰写。" },
  { role: "cfo", role_name: "财务顾问", system_prompt: "你是财务顾问，擅长财务分析、预算规划、成本控制和投资评估。" },
  { role: "legal", role_name: "法务顾问", system_prompt: "你是法务顾问，擅长合同审查、合规分析和风险评估。" },
  { role: "cmo", role_name: "营销顾问", system_prompt: "你是营销顾问，擅长市场分析、品牌策略和用户增长。" },
  { role: "cto", role_name: "技术顾问", system_prompt: "你是技术顾问，擅长技术选型、架构设计和技术可行性评估。" },
  { role: "product", role_name: "产品顾问", system_prompt: "你是产品顾问，擅长产品规划、需求分析和竞品调研。" },
  { role: "hr", role_name: "人事顾问", system_prompt: "你是人事顾问，擅长团队管理、招聘策略和组织架构优化。" },
  { role: "operation", role_name: "运营顾问", system_prompt: "你是运营顾问，擅长流程优化、数据运营和效率提升。" },
];

async function getEnabledStaff(db: Db, companyId: string): Promise<StaffAgent[]> {
  if (!companyId) return DEFAULT_STAFF;
  const { rows } = await db.query(
    "SELECT role, role_name, system_prompt FROM opc_staff_config WHERE company_id = $1 AND enabled = 1 AND swarm_enabled = 1",
    [companyId],
  );
  if (rows.length === 0) return DEFAULT_STAFF;
  return rows as StaffAgent[];
}

// ── 审计日志 ──

async function writeAuditLog(
  db: Db,
  sessionId: string,
  phase: string,
  role: string | null,
  detail: string,
  tokensIn: number,
  tokensOut: number,
  durationMs: number,
): Promise<void> {
  try {
    await db.query(
      "INSERT INTO opc_swarm_audit_log (id, swarm_session_id, phase, agent_role, detail, tokens_in, tokens_out, duration_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())",
      [uuid(), sessionId, phase, role, detail, tokensIn, tokensOut, durationMs],
    );
  } catch { /* 审计非关键，不阻塞主流程 */ }
}

// ── 智能压缩 ──

async function compressOutput(
  text: string,
  role: string,
  roleName: string,
  agentModel: string,
  signal?: AbortSignal,
): Promise<{ compressed: string; tokens_in: number; tokens_out: number }> {
  if (text.length <= COMPRESS_THRESHOLD) {
    return { compressed: text, tokens_in: 0, tokens_out: 0 };
  }

  if (text.length <= 12_000) {
    return { compressed: fastCompress(text), tokens_in: 0, tokens_out: 0 };
  }

  const compressPrompt = `你是信息压缩专家。将以下「${roleName}」的输出压缩到约 1600 字以内。

规则：
- 保留所有关键数据、数字、结论和行动建议
- 删除冗余解释、重复表述、客套话
- 保持原文的结构层次
- 不要添加新内容
- 用中文输出

原文：
${text}`;

  try {
    const resp = await callAi(
      [{ role: "system", content: compressPrompt }],
      undefined,
      agentModel,
      signal,
    );
    return {
      compressed: resp.content,
      tokens_in: resp.usage?.prompt_tokens || 0,
      tokens_out: resp.usage?.completion_tokens || 0,
    };
  } catch {
    return { compressed: text, tokens_in: 0, tokens_out: 0 };
  }
}

// ── 审计专家审阅 ──

interface ReviewResult {
  role: string;
  score: "pass" | "revise";
  feedback: string;
}

async function reviewAgentOutputs(
  results: SwarmTurnResult[],
  userMessage: string,
  plan: SwarmPlan,
  signal?: AbortSignal,
): Promise<{ reviews: ReviewResult[]; tokens_in: number; tokens_out: number }> {
  const agentSummaries = results.map(r => {
    const taskDesc = plan.agents.find(a => a.role === r.role)?.task || "";
    return `角色: ${r.role} (${r.role_name}) [模型: ${r.model}]\n分配任务: ${taskDesc}\n输出:\n${r.compressed || r.output}`;
  }).join("\n\n---\n\n");

  const reviewPrompt = `你是蜂群审计专家，负责审核各 Agent 的工作质量。

用户的原始需求：「${userMessage}」

以下是各 Agent 的输出：

${agentSummaries}

请逐个审核每个 Agent 的输出质量，返回 JSON 数组（不要 markdown 代码块）：
[
  {"role": "角色key", "score": "pass 或 revise", "feedback": "如果 revise，说明需要改进的具体方向；如果 pass，留空字符串"}
]

评分标准：
- pass：输出切题、有实质内容、有结论或建议
- revise：输出跑题、过于笼统空洞、缺少关键分析、未完成任务

注意：
- 最多标记 2 个 revise（避免大面积重做）
- 如果所有 Agent 输出都合格，全部给 pass`;

  try {
    const resp = await callAi(
      [{ role: "system", content: reviewPrompt }, { role: "user", content: userMessage }],
      undefined,
      CONDUCTOR_MODEL,
      signal,
    );
    const cleaned = resp.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned) as ReviewResult[];

    const reviews: ReviewResult[] = [];
    let reviseCount = 0;
    for (const r of parsed) {
      if (!r.role || !r.score) continue;
      if (r.score === "revise") {
        if (reviseCount >= 2) {
          reviews.push({ role: r.role, score: "pass", feedback: "" });
          continue;
        }
        reviseCount++;
      }
      reviews.push({ role: r.role, score: r.score === "revise" ? "revise" : "pass", feedback: r.feedback || "" });
    }

    return {
      reviews,
      tokens_in: resp.usage?.prompt_tokens || 0,
      tokens_out: resp.usage?.completion_tokens || 0,
    };
  } catch {
    return {
      reviews: results.map(r => ({ role: r.role, score: "pass" as const, feedback: "" })),
      tokens_in: 0,
      tokens_out: 0,
    };
  }
}

// ── Planning ──

async function planSwarm(
  db: Db,
  userMessage: string,
  staffList: StaffAgent[],
  companyId: string,
  signal?: AbortSignal,
): Promise<{ plan: SwarmPlan; tokens_in: number; tokens_out: number }> {
  const roleList = staffList.map(s => `- ${s.role} (${s.role_name})`).join("\n");

  const planPrompt = `你是蜂群协调者（Conductor）。分析用户需求，决定需要哪些专家 Agent 参与。

可用 Agent 角色：
${roleList}

用户消息：「${userMessage}」

请返回 JSON（不要 markdown 代码块）：
{
  "mode": "parallel" 或 "sequential",
  "agents": [{"role": "角色key", "task": "分配给该角色的具体子任务描述"}],
  "reasoning": "一句话说明为什么这样分配"
}

规则：
- 如果任务之间没有依赖关系，用 parallel
- 如果后续 Agent 需要前面 Agent 的输出，用 sequential
- 只选真正需要的角色，不要把所有人都拉进来
- 至少选 1 个，最多选 4 个
- 如果任务简单到不需要多角色协作，只选 1 个最合适的
- task 描述要具体，包含需要分析的维度和期望产出格式

示例 1（并行）：
用户：「帮我分析一下公司要不要做短视频营销」
{"mode":"parallel","agents":[{"role":"cmo","task":"分析短视频营销的市场趋势、目标受众覆盖率和预期 ROI，给出投入产出评估"},{"role":"cfo","task":"评估短视频营销所需预算（人员、设备、投放），与现有营销预算对比"}],"reasoning":"营销可行性和财务评估无依赖，可并行"}

示例 2（顺序）：
用户：「帮我起草一份合伙人协议，然后审查风险」
{"mode":"sequential","agents":[{"role":"legal","task":"根据公司情况起草合伙人协议草案，包含出资比例、利润分配、退出机制等核心条款"},{"role":"cfo","task":"从财务角度审查协议中的出资和利润分配条款，评估财务风险并提出修改建议"}],"reasoning":"需先起草协议，再审查财务条款"}

示例 3（单角色）：
用户：「公司下个月的社保怎么缴」
{"mode":"parallel","agents":[{"role":"hr","task":"查询公司社保缴纳政策，说明下月社保缴纳的具体步骤、时间节点和注意事项"}],"reasoning":"纯人事问题，单角色即可"}`;

  const messages: ChatMessage[] = [
    { role: "system", content: planPrompt },
    { role: "user", content: userMessage },
  ];

  const resp = await callAi(messages, undefined, CONDUCTOR_MODEL, signal);
  const tokensIn = resp.usage?.prompt_tokens || 0;
  const tokensOut = resp.usage?.completion_tokens || 0;

  try {
    const cleaned = resp.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.mode || !Array.isArray(parsed.agents) || parsed.agents.length === 0) {
      throw new Error("invalid plan structure");
    }
    if (parsed.mode !== "parallel" && parsed.mode !== "sequential") {
      parsed.mode = "parallel";
    }
    for (const a of parsed.agents) {
      if (!a.role || !a.task) throw new Error("invalid agent entry");
    }

    return { plan: parsed as SwarmPlan, tokens_in: tokensIn, tokens_out: tokensOut };
  } catch {
    return {
      plan: {
        mode: "parallel",
        agents: [{ role: staffList[0]?.role || "assistant", task: userMessage }],
        reasoning: "无法解析分配计划，降级为单 Agent",
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    };
  }
}

// ── Agent 执行 ──

async function runAgentTurn(
  db: Db,
  agent: StaffAgent,
  task: string,
  userMessage: string,
  companyId: string,
  userId: string,
  agentModel: string,
  previousOutputs: string,
  taskBoard?: SwarmTaskBoard,
  onChunk?: (delta: string) => void,
  cachedContext?: string,
  revisionFeedback?: string,
  signal?: AbortSignal,
): Promise<SwarmTurnResult> {
  let contextSection = "";
  if (companyId) {
    const basePrompt = cachedContext ?? await buildSystemPrompt(db, companyId, "", userId);
    contextSection = `\n公司背景信息：\n${basePrompt}`;
  }

  const revisionSection = revisionFeedback
    ? `\n\n注意：协调者审阅了你上一次的输出，认为需要修订：\n「${revisionFeedback}」\n请针对以上反馈改进你的输出。`
    : "";
  const taskBoardSection = renderTaskBoardContext(taskBoard);

  const agentSystemPrompt = `${agent.system_prompt || `你是${agent.role_name}。`}

你的角色：${agent.role_name}
你正在蜂群协作模式下工作。协调者分配给你的子任务是：
「${task}」

${previousOutputs ? `\n其他 Agent 已完成的输出：\n${previousOutputs}\n\n基于以上信息继续你的任务。` : ""}
${taskBoardSection}
${contextSection}${revisionSection}

规则：
- 只聚焦于你被分配的子任务
- 先阅读共享任务板，优先补齐缺口，不要重复其他 Agent 已经完成的部分
- 输出要简洁、有结论
- 如果需要数据，调用工具获取
- 用中文回复`;

  const messages: ChatMessage[] = [
    { role: "system", content: agentSystemPrompt },
    { role: "user", content: userMessage },
  ];

  const roleTools = filterToolsForRole(agent.role);
  let totalIn = 0, totalOut = 0;
  const toolCallsLog: string[] = [];

  const MAX_ROUNDS = MAX_AGENT_TOOL_ROUNDS;
  let rounds = 0;

  let result = await callAiStreamWithTools(messages, roleTools, onChunk, agentModel, signal);
  if (result.usage) { totalIn += result.usage.prompt_tokens; totalOut += result.usage.completion_tokens; }

  while (result.tool_calls.length > 0 && rounds < MAX_ROUNDS && !signal?.aborted) {
    rounds++;
    const safeTcs = sanitizeToolCalls(result.tool_calls);
    messages.push({ role: "assistant", content: result.content, tool_calls: safeTcs });

    for (const tc of safeTcs) {
      if (signal?.aborted) break;
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
      toolCallsLog.push(`${tc.function.name}(${JSON.stringify(args).slice(0, 200)})`);
      const toolResult = await executeTool(tc.function.name, args, db, companyId, userId);
      messages.push({ role: "tool", content: toolResult, tool_call_id: tc.id, name: tc.function.name });
    }

    if (signal?.aborted) break;
    result = await callAiStreamWithTools(messages, roleTools, onChunk, agentModel, signal);
    if (result.usage) { totalIn += result.usage.prompt_tokens; totalOut += result.usage.completion_tokens; }
  }

  const output = result.content;
  const compressResult = await compressOutput(output, agent.role, agent.role_name, agentModel, signal);

  return {
    role: agent.role,
    role_name: agent.role_name,
    model: agentModel,
    output,
    compressed: compressResult.compressed,
    tokens_in: totalIn,
    tokens_out: totalOut,
    compress_tokens_in: compressResult.tokens_in,
    compress_tokens_out: compressResult.tokens_out,
    tool_calls_json: JSON.stringify(toolCallsLog),
  };
}

// ── 主流程 ──

const SWARM_TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 蜂群总超时 5 分钟

export async function runSwarm(
  db: Db,
  userId: string,
  companyId: string,
  conversationId: string,
  userMessage: string,
  userModel: string,
  callbacks: SwarmStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const swarmAc = new AbortController();
  const totalTimer = setTimeout(() => swarmAc.abort(), SWARM_TOTAL_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => swarmAc.abort(), { once: true });
  const swarmSignal = swarmAc.signal;

  try {
    const staffList = await getEnabledStaff(db, companyId);
    const cachedContext = companyId ? await buildSystemPrompt(db, companyId, "", userId) : undefined;

    callbacks.onPlanStart?.();

    // ── 1. Planning ──
    const planStart = Date.now();
    const { plan, tokens_in: planTokIn, tokens_out: planTokOut } = await planSwarm(db, userMessage, staffList, companyId, swarmSignal);
    const planDuration = Date.now() - planStart;

    const swarmSessionId = uuid();
    await db.query(
      "INSERT INTO opc_swarm_sessions (id, conversation_id, user_id, company_id, mode, status, created_at) VALUES ($1,$2,$3,$4,$5,'running',NOW())",
      [swarmSessionId, conversationId, userId, companyId || '', plan.mode],
    );

    await writeAuditLog(db, swarmSessionId, "plan", null, JSON.stringify({ mode: plan.mode, agents: plan.agents.length, reasoning: plan.reasoning }), planTokIn, planTokOut, planDuration);
    callbacks.onAuditEntry?.({ phase: "plan", duration_ms: planDuration, tokens_in: planTokIn, tokens_out: planTokOut });

    const resolvedAgents: StaffAgent[] = [];
    for (const pa of plan.agents) {
      const staff = staffList.find(s => s.role === pa.role);
      if (staff) resolvedAgents.push(staff);
    }
    if (resolvedAgents.length === 0) {
      resolvedAgents.push(staffList[0]);
      plan.agents = [{ role: staffList[0].role, task: userMessage }];
    }

    // 为每个 agent 注入分配的模型
    for (const pa of plan.agents) {
      pa.model = getAgentModel(pa.role);
    }

    const includeResearcher = needsResearcher(userMessage);
    const researcherModel = getAgentModel("researcher");
    if (includeResearcher) {
      plan.agents.unshift({ role: "researcher", task: "搜集与用户问题相关的最新信息和数据", model: researcherModel });
      resolvedAgents.unshift(RESEARCHER_AGENT);
    }

    callbacks.onPlanReady(plan, resolvedAgents);

    const planJson = JSON.stringify({
      mode: plan.mode,
      reasoning: plan.reasoning,
      agents: plan.agents.map((a, i) => ({
        role: a.role,
        role_name: resolvedAgents[i]?.role_name || a.role,
        task: a.task,
        model: a.model,
      })),
    });
    try {
      await db.query("UPDATE opc_swarm_sessions SET plan_json = $1 WHERE id = $2", [planJson, swarmSessionId]);
    } catch { /* plan_json column may not exist yet */ }

    const taskBoard = buildInitialTaskBoard(userMessage, plan, includeResearcher, resolvedAgents);
    await persistTaskBoard(db, swarmSessionId, taskBoard);

    // ── 2. 情报专家（按需启用） ──
    let researchResult: SwarmTurnResult = {
      role: RESEARCHER_AGENT.role,
      role_name: RESEARCHER_AGENT.role_name,
      model: researcherModel,
      output: "",
      compressed: "",
      tokens_in: 0,
      tokens_out: 0,
      compress_tokens_in: 0,
      compress_tokens_out: 0,
      tool_calls_json: "[]",
    };
    let researchContext = "";
    if (includeResearcher) {
      const researchTask = `搜集与以下问题相关的最新信息和数据：「${userMessage}」`;
      callbacks.onAgentStart(RESEARCHER_AGENT.role, RESEARCHER_AGENT.role_name, researchTask, researcherModel);

      const researchStart = Date.now();
      const researchTimer = createTimeoutSignal(swarmSignal, AGENT_TIMEOUT_MS);
      try {
        researchResult = await runAgentTurn(
          db, RESEARCHER_AGENT, researchTask, userMessage, companyId, userId, researcherModel, "",
          taskBoard,
          (delta) => callbacks.onAgentChunk(RESEARCHER_AGENT.role, delta),
          cachedContext, undefined, researchTimer.signal,
        );
      } finally {
        researchTimer.cleanup();
      }
      if (swarmSignal.aborted) throw new Error("蜂群已取消");
      const researchDuration = Date.now() - researchStart;

      callbacks.onAgentDone(RESEARCHER_AGENT.role, researchResult.output);

      const researchTurnId = uuid();
      await db.query(
        "INSERT INTO opc_swarm_turns (id, swarm_session_id, agent_role, agent_role_name, input_prompt, output_text, tokens_in, tokens_out, tool_calls_json, sequence, status, revision, review_score, full_output, compressed_output, created_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,-1,'done',0,'auto-pass',$10,$11,NOW(),NOW())",
        [researchTurnId, swarmSessionId, RESEARCHER_AGENT.role, RESEARCHER_AGENT.role_name, researchTask, researchResult.output, researchResult.tokens_in + researchResult.compress_tokens_in, researchResult.tokens_out + researchResult.compress_tokens_out, researchResult.tool_calls_json, researchResult.output, researchResult.compressed],
      );

      await writeAuditLog(db, swarmSessionId, "research", RESEARCHER_AGENT.role, JSON.stringify({ output_len: researchResult.output.length }), researchResult.tokens_in + researchResult.compress_tokens_in, researchResult.tokens_out + researchResult.compress_tokens_out, researchDuration);
      callbacks.onAuditEntry?.({ phase: "research", role: RESEARCHER_AGENT.role, duration_ms: researchDuration, tokens_in: researchResult.tokens_in + researchResult.compress_tokens_in, tokens_out: researchResult.tokens_out + researchResult.compress_tokens_out });

      researchContext = `\n\n### 情报专家搜集的最新资料：\n${researchResult.compressed}`;
      updateTaskBoardForAgent(taskBoard, RESEARCHER_AGENT.role, "done", researchResult.compressed, researchResult.output);
      await persistTaskBoard(db, swarmSessionId, taskBoard);
    }

    // ── 3. Agent Execution（角色专属模型，跳过情报专家） ──
    const expertAgents = includeResearcher ? plan.agents.slice(1) : plan.agents.slice();
    const expertResolved = includeResearcher ? resolvedAgents.slice(1) : resolvedAgents.slice();
    const results: SwarmTurnResult[] = [];

    if (plan.mode === "parallel") {
      for (let i = 0; i < expertAgents.length; i += PARALLEL_CONCURRENCY) {
        if (swarmSignal.aborted) break;
        const batch = expertAgents.slice(i, i + PARALLEL_CONCURRENCY);
        const batchPromises = batch.map(async (pa, batchIdx) => {
          const idx = i + batchIdx;
          const agent = expertResolved[idx];
          if (!agent) return null;
          const model = getAgentModel(agent.role);
          callbacks.onAgentStart(agent.role, agent.role_name, pa.task, model);
          updateTaskBoardForAgent(taskBoard, agent.role, "running", `正在执行：${pa.task}`, "");
          await persistTaskBoard(db, swarmSessionId, taskBoard);

          const agentStart = Date.now();
          const agentTimer = createTimeoutSignal(swarmSignal, AGENT_TIMEOUT_MS);
          let turnResult: SwarmTurnResult;
          try {
            turnResult = await runAgentTurn(
              db, agent, pa.task, userMessage, companyId, userId, model, researchContext,
              taskBoard,
              (delta) => callbacks.onAgentChunk(agent.role, delta),
              cachedContext, undefined, agentTimer.signal,
            );
          } finally {
            agentTimer.cleanup();
          }
          const agentDuration = Date.now() - agentStart;

          callbacks.onAgentDone(agent.role, turnResult.output);

          const turnId = uuid();
          await db.query(
            "INSERT INTO opc_swarm_turns (id, swarm_session_id, agent_role, agent_role_name, input_prompt, output_text, tokens_in, tokens_out, tool_calls_json, sequence, status, revision, full_output, compressed_output, created_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'done',0,$11,$12,NOW(),NOW())",
            [turnId, swarmSessionId, agent.role, agent.role_name, pa.task, turnResult.output, turnResult.tokens_in + turnResult.compress_tokens_in, turnResult.tokens_out + turnResult.compress_tokens_out, turnResult.tool_calls_json, idx, turnResult.output, turnResult.compressed],
          );

          await writeAuditLog(db, swarmSessionId, "agent_exec", agent.role, JSON.stringify({ task: pa.task, model, output_len: turnResult.output.length }), turnResult.tokens_in + turnResult.compress_tokens_in, turnResult.tokens_out + turnResult.compress_tokens_out, agentDuration);
          callbacks.onAuditEntry?.({ phase: "agent_exec", role: agent.role, duration_ms: agentDuration, tokens_in: turnResult.tokens_in + turnResult.compress_tokens_in, tokens_out: turnResult.tokens_out + turnResult.compress_tokens_out });

          updateTaskBoardForAgent(taskBoard, agent.role, "done", turnResult.compressed, turnResult.output);
          await persistTaskBoard(db, swarmSessionId, taskBoard);

          return turnResult;
        });

        const settled = await Promise.all(batchPromises);
        for (const r of settled) { if (r) results.push(r); }
      }
    } else {
      let previousOutputs = researchContext;
      for (let idx = 0; idx < expertAgents.length; idx++) {
        if (swarmSignal.aborted) break;
        const pa = expertAgents[idx];
        const agent = expertResolved[idx];
        if (!agent) continue;
        const model = getAgentModel(agent.role);
        callbacks.onAgentStart(agent.role, agent.role_name, pa.task, model);
        updateTaskBoardForAgent(taskBoard, agent.role, "running", `正在执行：${pa.task}`, "");
        await persistTaskBoard(db, swarmSessionId, taskBoard);

        const agentStart = Date.now();
          const agentTimer = createTimeoutSignal(swarmSignal, AGENT_TIMEOUT_MS);
          let turnResult: SwarmTurnResult;
          try {
            turnResult = await runAgentTurn(
              db, agent, pa.task, userMessage, companyId, userId, model, previousOutputs,
              taskBoard,
              (delta) => callbacks.onAgentChunk(agent.role, delta),
              cachedContext, undefined, agentTimer.signal,
            );
          } finally {
            agentTimer.cleanup();
          }
          const agentDuration = Date.now() - agentStart;

        callbacks.onAgentDone(agent.role, turnResult.output);
        results.push(turnResult);

        previousOutputs += `\n\n### ${agent.role_name} 的输出：\n${turnResult.compressed}`;
        if (previousOutputs.length > MAX_PREVIOUS_OUTPUTS_SOFT) {
          previousOutputs = previousOutputs.slice(-MAX_PREVIOUS_OUTPUTS_SOFT);
          previousOutputs = "[前文已截断]\n" + previousOutputs.slice(previousOutputs.indexOf("\n") + 1);
        }

        const turnId = uuid();
        await db.query(
          "INSERT INTO opc_swarm_turns (id, swarm_session_id, agent_role, agent_role_name, input_prompt, output_text, tokens_in, tokens_out, tool_calls_json, sequence, status, revision, full_output, compressed_output, created_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'done',0,$11,$12,NOW(),NOW())",
          [turnId, swarmSessionId, agent.role, agent.role_name, pa.task, turnResult.output, turnResult.tokens_in + turnResult.compress_tokens_in, turnResult.tokens_out + turnResult.compress_tokens_out, turnResult.tool_calls_json, idx, turnResult.output, turnResult.compressed],
        );

        await writeAuditLog(db, swarmSessionId, "agent_exec", agent.role, JSON.stringify({ task: pa.task, model, output_len: turnResult.output.length }), turnResult.tokens_in + turnResult.compress_tokens_in, turnResult.tokens_out + turnResult.compress_tokens_out, agentDuration);
        callbacks.onAuditEntry?.({ phase: "agent_exec", role: agent.role, duration_ms: agentDuration, tokens_in: turnResult.tokens_in + turnResult.compress_tokens_in, tokens_out: turnResult.tokens_out + turnResult.compress_tokens_out });
        updateTaskBoardForAgent(taskBoard, agent.role, "done", turnResult.compressed, turnResult.output);
        await persistTaskBoard(db, swarmSessionId, taskBoard);
      }
    }

    // ── 4. 审计专家审阅（排除情报专家，只审阅分析专家） ──
    callbacks.onReviewStart?.();
    if (includeResearcher) callbacks.onAgentReview?.(RESEARCHER_AGENT.role, "pass", "情报搜集自动通过");

    if (shouldReview(results, plan)) {
      const reviewStart = Date.now();
      const { reviews, tokens_in: revTokIn, tokens_out: revTokOut } = await reviewAgentOutputs(results, userMessage, plan, swarmSignal);
      const reviewDuration = Date.now() - reviewStart;

      await writeAuditLog(db, swarmSessionId, "review", null, JSON.stringify(reviews), revTokIn, revTokOut, reviewDuration);
      callbacks.onAuditEntry?.({ phase: "review", duration_ms: reviewDuration, tokens_in: revTokIn, tokens_out: revTokOut });

      for (const rev of reviews) {
        callbacks.onAgentReview?.(rev.role, rev.score, rev.feedback);

        try {
          await db.query(
            "UPDATE opc_swarm_turns SET review_score = $1, review_feedback = $2 WHERE swarm_session_id = $3 AND agent_role = $4",
            [rev.score, rev.feedback, swarmSessionId, rev.role],
          );
        } catch { /* non-critical */ }
      }

      const toRevise = MAX_REVISION_ROUNDS > 0 ? reviews.filter(r => r.score === "revise") : [];
      if (toRevise.length > 0) {
        for (const rev of toRevise) {
          const agent = resolvedAgents.find(a => a.role === rev.role);
          const pa = plan.agents.find(a => a.role === rev.role);
          if (!agent || !pa) continue;
          const model = getAgentModel(agent.role);

          callbacks.onAgentRevise?.(agent.role, agent.role_name);
          callbacks.onAgentStart(agent.role, agent.role_name, `[修订] ${pa.task}`, model);

          const reviseStart = Date.now();
          const reviseTimer = createTimeoutSignal(swarmSignal, AGENT_TIMEOUT_MS);
          let revisedResult: SwarmTurnResult;
          try {
            revisedResult = await runAgentTurn(
              db, agent, pa.task, userMessage, companyId, userId, model, "",
              taskBoard,
              (delta) => callbacks.onAgentChunk(agent.role, delta),
              cachedContext, rev.feedback, reviseTimer.signal,
            );
          } finally {
            reviseTimer.cleanup();
          }
          const reviseDuration = Date.now() - reviseStart;

          callbacks.onAgentDone(agent.role, revisedResult.output);

          const resultIdx = results.findIndex(r => r.role === rev.role);
          if (resultIdx >= 0) results[resultIdx] = revisedResult;

          const turnId = uuid();
          await db.query(
            "INSERT INTO opc_swarm_turns (id, swarm_session_id, agent_role, agent_role_name, input_prompt, output_text, tokens_in, tokens_out, tool_calls_json, sequence, status, revision, review_score, review_feedback, full_output, compressed_output, created_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'done',1,'revised',$11,$12,$13,NOW(),NOW())",
            [turnId, swarmSessionId, agent.role, agent.role_name, pa.task, revisedResult.output, revisedResult.tokens_in + revisedResult.compress_tokens_in, revisedResult.tokens_out + revisedResult.compress_tokens_out, revisedResult.tool_calls_json, plan.agents.indexOf(pa), rev.feedback, revisedResult.output, revisedResult.compressed],
          );

          await writeAuditLog(db, swarmSessionId, "revision", agent.role, JSON.stringify({ feedback: rev.feedback, output_len: revisedResult.output.length }), revisedResult.tokens_in + revisedResult.compress_tokens_in, revisedResult.tokens_out + revisedResult.compress_tokens_out, reviseDuration);
          callbacks.onAuditEntry?.({ phase: "revision", role: agent.role, duration_ms: reviseDuration, tokens_in: revisedResult.tokens_in + revisedResult.compress_tokens_in, tokens_out: revisedResult.tokens_out + revisedResult.compress_tokens_out });
          updateTaskBoardForAgent(taskBoard, agent.role, "done", revisedResult.compressed, revisedResult.output);
          await persistTaskBoard(db, swarmSessionId, taskBoard);
        }
      }
    } else {
      // 单 Agent 无需审阅，直接 pass
      callbacks.onAgentReview?.(results[0]?.role || "", "pass", "");
    }

    // ── 4.5 动态补派（轻量重规划） ──
    const supplement = inferSupplementAgent(taskBoard, results, staffList);
    if (supplement && !swarmSignal.aborted) {
      const supplementAgent = staffList.find((staff) => staff.role === supplement.role);
      if (supplementAgent) {
        const supplementModel = getAgentModel(supplement.role);
        taskBoard.agents.push({
          role: supplement.role,
          role_name: supplementAgent.role_name,
          task: supplement.task,
          status: "running",
          summary: "根据任务板缺口自动补派",
          updated_at: nowIso(),
        });
        taskBoard.updated_at = nowIso();
        await persistTaskBoard(db, swarmSessionId, taskBoard);

        callbacks.onAgentStart(supplementAgent.role, supplementAgent.role_name, `[补派] ${supplement.task}`, supplementModel);

        const supplementStart = Date.now();
        const supplementTimer = createTimeoutSignal(swarmSignal, AGENT_TIMEOUT_MS);
        let supplementResult: SwarmTurnResult;
        try {
          supplementResult = await runAgentTurn(
            db,
            supplementAgent,
            supplement.task,
            userMessage,
            companyId,
            userId,
            supplementModel,
            `${researchContext}\n\n${results.map((r) => `### ${r.role_name}\n${r.compressed || r.output}`).join("\n\n")}`,
            taskBoard,
            (delta) => callbacks.onAgentChunk(supplementAgent.role, delta),
            cachedContext,
            "请重点补齐当前任务板里仍未闭合的风险、动作或待确认问题。",
            supplementTimer.signal,
          );
        } finally {
          supplementTimer.cleanup();
        }

        const supplementDuration = Date.now() - supplementStart;
        callbacks.onAgentDone(supplementAgent.role, supplementResult.output);
        results.push(supplementResult);

        const supplementTurnId = uuid();
        await db.query(
          "INSERT INTO opc_swarm_turns (id, swarm_session_id, agent_role, agent_role_name, input_prompt, output_text, tokens_in, tokens_out, tool_calls_json, sequence, status, revision, full_output, compressed_output, created_at, finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'done',0,$11,$12,NOW(),NOW())",
          [
            supplementTurnId,
            swarmSessionId,
            supplementAgent.role,
            supplementAgent.role_name,
            supplement.task,
            supplementResult.output,
            supplementResult.tokens_in + supplementResult.compress_tokens_in,
            supplementResult.tokens_out + supplementResult.compress_tokens_out,
            supplementResult.tool_calls_json,
            taskBoard.agents.length,
            supplementResult.output,
            supplementResult.compressed,
          ],
        );

        await writeAuditLog(
          db,
          swarmSessionId,
          "replan",
          supplementAgent.role,
          JSON.stringify({ task: supplement.task, output_len: supplementResult.output.length }),
          supplementResult.tokens_in + supplementResult.compress_tokens_in,
          supplementResult.tokens_out + supplementResult.compress_tokens_out,
          supplementDuration,
        );
        callbacks.onAuditEntry?.({
          phase: "replan",
          role: supplementAgent.role,
          duration_ms: supplementDuration,
          tokens_in: supplementResult.tokens_in + supplementResult.compress_tokens_in,
          tokens_out: supplementResult.tokens_out + supplementResult.compress_tokens_out,
        });

        updateTaskBoardForAgent(taskBoard, supplementAgent.role, "done", supplementResult.compressed, supplementResult.output);
        await persistTaskBoard(db, swarmSessionId, taskBoard);
      }
    }

    // ── 5. Conductor Summary（含情报数据 + 开放工具 + 工具循环） ──
    const summaryStart = Date.now();
    const agentOutputs = results.map(r => `**${r.role_name}**：\n${r.compressed || r.output}`).join("\n\n---\n\n");
    const researchSection = researchResult.compressed
      ? `**情报专家搜集的最新资料**：\n${researchResult.compressed}\n\n---\n\n`
      : "";
    const summaryPrompt = `你是蜂群协调者。以下是${researchResult.compressed ? "情报专家搜集的最新资料和" : ""}各专家 Agent 对用户问题的分析：

${renderTaskBoardContext(taskBoard)}

${researchSection}
${agentOutputs}

用户的原始问题：「${userMessage}」

请将以上所有专家意见整合为一个连贯、有结构、有行动建议的最终回复。
规则：
- 结合情报专家搜集的最新数据来支撑结论
- 不要简单罗列各专家说了什么，要融合成统一视角
- 如果专家之间有矛盾，指出并给出你的判断
- 如果需要查询补充数据，可以调用工具
- 结尾给出 2-3 条具体的行动建议
- 用中文回复`;

    const summaryMessages: ChatMessage[] = [
      { role: "system", content: summaryPrompt },
      { role: "user", content: userMessage },
    ];

    const allTools = getToolDefinitions({
      capabilities: ["core_business", "research", "document", "communication", "automation"],
    });
    let summaryTotalIn = 0, summaryTotalOut = 0;

    if (swarmSignal.aborted) throw new Error("蜂群已取消");

    const summaryTimer = createTimeoutSignal(swarmSignal, SUMMARY_TIMEOUT_MS);
    let summaryResult: Awaited<ReturnType<typeof callAiStreamWithTools>>;
    try {
      summaryResult = await callAiStreamWithTools(
        summaryMessages, allTools,
        (delta) => callbacks.onSummaryChunk(delta),
        CONDUCTOR_MODEL, summaryTimer.signal,
      );
    } finally {
      summaryTimer.cleanup();
    }
    if (summaryResult.usage) { summaryTotalIn += summaryResult.usage.prompt_tokens; summaryTotalOut += summaryResult.usage.completion_tokens; }

    let summaryRounds = 0;
    while (summaryResult.tool_calls.length > 0 && summaryRounds < MAX_SUMMARY_TOOL_ROUNDS && !swarmSignal.aborted) {
      summaryRounds++;
      const safeSummaryTcs = sanitizeToolCalls(summaryResult.tool_calls);
      summaryMessages.push({ role: "assistant", content: summaryResult.content, tool_calls: safeSummaryTcs });

      for (const tc of safeSummaryTcs) {
        if (swarmSignal.aborted) break;
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        const toolResult = await executeTool(tc.function.name, args, db, companyId, userId);
        summaryMessages.push({ role: "tool", content: toolResult, tool_call_id: tc.id, name: tc.function.name });
      }

      if (swarmSignal.aborted) break;
      const summaryRoundTimer = createTimeoutSignal(swarmSignal, SUMMARY_TIMEOUT_MS);
      try {
        summaryResult = await callAiStreamWithTools(
          summaryMessages, allTools,
          (delta) => callbacks.onSummaryChunk(delta),
          CONDUCTOR_MODEL, summaryRoundTimer.signal,
        );
      } finally {
        summaryRoundTimer.cleanup();
      }
      if (summaryResult.usage) { summaryTotalIn += summaryResult.usage.prompt_tokens; summaryTotalOut += summaryResult.usage.completion_tokens; }
    }

    const summaryDuration = Date.now() - summaryStart;
    await writeAuditLog(db, swarmSessionId, "summary", null, JSON.stringify({ length: summaryResult.content.length, tool_rounds: summaryRounds }), summaryTotalIn, summaryTotalOut, summaryDuration);
    callbacks.onAuditEntry?.({ phase: "summary", duration_ms: summaryDuration, tokens_in: summaryTotalIn, tokens_out: summaryTotalOut });
    updateTaskBoardFromSummary(taskBoard, summaryResult.content);

    await db.query(
      "UPDATE opc_swarm_sessions SET status = 'done', conductor_summary = $1, task_board_json = $2, finished_at = NOW() WHERE id = $3",
      [summaryResult.content, JSON.stringify(taskBoard), swarmSessionId],
    );

    // ── 6. Done ──
    const totalDuration = Date.now() - planStart;
    await writeAuditLog(db, swarmSessionId, "done", null, JSON.stringify({ total_agents: results.length, total_duration_ms: totalDuration }), 0, 0, totalDuration);
    callbacks.onAuditEntry?.({ phase: "done", duration_ms: totalDuration, tokens_in: 0, tokens_out: 0 });

    callbacks.onDone(summaryResult.content, swarmSessionId);
  } catch (e) {
    const msg = swarmSignal.aborted ? "蜂群执行超时或已取消" : ((e as Error).message || "蜂群执行出错");
    callbacks.onError(msg);
  } finally {
    clearTimeout(totalTimer);
  }
}
