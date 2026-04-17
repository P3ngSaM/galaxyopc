/**
 * 工具执行器 — PostgreSQL 异步版
 *
 * 将 AI 返回的 tool_call 映射到数据库操作。
 * 每个 tool 都自动注入 company_id 以确保数据隔离。
 */

import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { ToolDef } from "./ai-client.js";
import { callAi } from "./ai-client.js";
import { searchCatalog } from "./skills-catalog.js";
import { cancelJob, executeTask } from "../scheduler/scheduler.js";
import { detectImapHost, testImapConnection, sendEmailReply } from "../email/email-reader.js";
import { getLocalToolDefinitions, executeLocalTool } from "../local-agent/local-tools.js";
import { isLocalModeEnabled } from "../local-agent/security.js";
import { getFeishuToolDefinitions, executeFeishuTool, setFeishuDb } from "../local-agent/feishu-tools.js";
import { asNumber as n, asString as s, detectMailHost as detectHost } from "./tool-executor-helpers.js";
import {
  execNativeCodeInterpreterReadOnly,
  execNativeWebExtractReadOnly,
  execNativeWebSearchReadOnly,
  execHybridSearchReadOnly,
  execOpcEmailReadOnly,
  execOpcReportReadOnly,
  execOpcSearchReadOnly,
  execOpcWebpageReadOnly,
} from "./tool-executor-readers.js";
import { execOpcVideoIsolated } from "./tool-executor-video.js";
import { requestApproval } from "../local-agent/security.js";
import { filterToolDefinitionsByCapabilities, registerToolDefinition, type ToolCapability } from "./tool-registry.js";

let UAPI_KEY = process.env.UAPI_KEY || "";
let UAPI_URL = process.env.UAPI_URL || "https://uapis.cn/api/v1/search/aggregate";

export function configureSearch(opts: { apiKey?: string; apiUrl?: string }) {
  if (opts.apiKey) UAPI_KEY = opts.apiKey;
  if (opts.apiUrl) UAPI_URL = opts.apiUrl;
}

let SMTP_HOST = process.env.SMTP_HOST || "smtp.163.com";
let SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
let SMTP_USER = process.env.SMTP_USER || "";
let SMTP_PASS = process.env.SMTP_PASS || "";

interface ToolExecutionContext {
  db: Db;
  companyId: string;
  userId?: string;
  signal?: AbortSignal;
}

type ToolRiskLevel = "low" | "medium" | "high";

function classifyToolRisk(toolName: string, args: Record<string, unknown>): ToolRiskLevel {
  const action = String(args.action || "").toLowerCase();
  if (toolName.startsWith("local_") || toolName.startsWith("feishu_")) return "high";
  if (toolName === "opc_service_config" || toolName === "setup_email" || toolName === "reply_email") return "high";
  if (toolName === "opc_video" || toolName === "invoke_skill" || toolName === "find_skills") return "medium";
  if (/(delete|remove|cancel|save|update|create|approve|reject|toggle|run)/.test(action)) return "medium";
  if (toolName === "opc_manage" || toolName === "opc_finance" || toolName === "opc_legal" || toolName === "opc_hr" || toolName === "opc_project" || toolName === "opc_schedule" || toolName === "opc_cron") {
    return "medium";
  }
  return "low";
}

function truncateText(value: string, maxLen: number): string {
  const text = String(value || "");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function safeJsonStringify(value: unknown, maxLen = 4000): string {
  try {
    return truncateText(JSON.stringify(value), maxLen);
  } catch {
    return truncateText(String(value ?? ""), maxLen);
  }
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    tool: toolName,
    action: args.action || "",
    company_id: args.company_id || "",
  };
  for (const key of ["query", "url", "goal", "title", "name", "service", "job_title", "report_type"]) {
    if (args[key] !== undefined && args[key] !== "") summary[key] = truncateText(String(args[key]), 300);
  }
  return summary;
}

function summarizeToolResult(output: string, errorMessage = ""): Record<string, unknown> {
  if (errorMessage) {
    return { ok: false, error: truncateText(errorMessage, 1000) };
  }
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        ok: !obj.error,
        error: obj.error ? truncateText(String(obj.error), 1000) : "",
        keys: Object.keys(obj).slice(0, 12),
        preview: truncateText(JSON.stringify(obj).slice(0, 800), 800),
      };
    }
  } catch {
    // plain text output
  }
  return { ok: true, preview: truncateText(output, 800) };
}

async function writeToolExecutionAudit(
  db: Db,
  payload: {
    userId?: string;
    toolName: string;
    args: Record<string, unknown>;
    result?: string;
    errorMessage?: string;
    riskLevel: ToolRiskLevel;
    startedAt: number;
    approved?: boolean;
  },
): Promise<void> {
  try {
    const auditArgs = {
      ...summarizeToolArgs(payload.toolName, payload.args),
      duration_ms: Math.max(0, Date.now() - payload.startedAt),
      approved: payload.approved !== false,
      started_at: new Date(payload.startedAt).toISOString(),
    };
    const auditResult = summarizeToolResult(payload.result || "", payload.errorMessage || "");
    await db.query(
      `INSERT INTO opc_local_audit_log (id, user_id, tool, args, result, risk_level, approved, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        uuid(),
        payload.userId || "system",
        payload.toolName,
        safeJsonStringify(auditArgs),
        safeJsonStringify(auditResult, 6000),
        payload.riskLevel,
        payload.approved !== false,
      ],
    );
  } catch (error) {
    console.warn("[tool-audit] failed to persist audit log:", error);
  }
}

export function configureSmtp(opts: { host?: string; port?: number; user?: string; pass?: string }) {
  if (opts.host) SMTP_HOST = opts.host;
  if (opts.port) SMTP_PORT = opts.port;
  if (opts.user) SMTP_USER = opts.user;
  if (opts.pass) SMTP_PASS = opts.pass;
}

function buildOpportunityMarkerFromPayload(p: Record<string, unknown>): string {
  const opportunityId = s(p.opportunity_id || p.opportunityId);
  return opportunityId ? `[机会ID:${opportunityId}]` : "";
}

function appendOpportunityMarker(text: string, marker: string): string {
  const base = String(text || "").trim();
  if (!marker) return base;
  if (base.includes(marker)) return base;
  return base ? `${base}\n${marker}` : marker;
}

// ─── 工具定义（给 AI 的 schema）────────────────────────────────────────

export function getToolDefinitions(options: { capabilities?: ToolCapability[] } = {}): ToolDef[] {
  const localTools = isLocalModeEnabled() ? getLocalToolDefinitions() : [];
  const feishuTools = isLocalModeEnabled() ? getFeishuToolDefinitions() : [];
  const definitions: ToolDef[] = [
    ...localTools,
    ...feishuTools,
    {
      type: "function",
      function: {
        name: "opc_manage",
        description: "一人公司管理工具：公司信息、记账、客户 CRM、仪表盘。action: register_company/get_company/update_company/list_my_companies/add_transaction/list_transactions/finance_summary/add_contact/list_contacts/update_contact/delete_contact/dashboard/crm_pipeline/follow_up_reminders。list_my_companies 可列出当前用户名下所有公司（含协作公司）。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["register_company", "get_company", "update_company", "list_my_companies", "add_transaction", "list_transactions", "finance_summary", "add_contact", "list_contacts", "update_contact", "delete_contact", "dashboard", "crm_pipeline", "follow_up_reminders"] },
            company_id: { type: "string" }, name: { type: "string" }, industry: { type: "string" },
            owner_name: { type: "string" }, owner_contact: { type: "string" },
            registered_capital: { type: "string" }, description: { type: "string" },
            type: { type: "string", description: "交易类型: income(收入) 或 expense(支出)", enum: ["income", "expense"] }, category: { type: "string" }, amount: { type: "number" },
            counterparty: { type: "string", description: "交易对方名称（客户/供应商），记账时如有对方信息请填写" },
            transaction_date: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
            company: { type: "string" }, role: { type: "string" }, source: { type: "string" },
            pipeline_stage: { type: "string" }, deal_value: { type: "number" },
            follow_up_date: { type: "string" }, notes: { type: "string" }, contact_id: { type: "string" },
            status: { type: "string" }, start_date: { type: "string" }, end_date: { type: "string" },
            opportunity_id: { type: "string", description: "如该动作来自某个地图机会，可传机会ID，系统会自动建立供需闭环标记" },
            limit: { type: "number" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_finance",
        description: "财税管理：发票、增值税/所得税计算、纳税申报、收付款、凭证管理、报表编制、成本核算、资金监控、银行对账、档案管理。action: create_invoice/list_invoices/calc_vat/calc_income_tax/create_tax_filing/list_tax_filings/tax_calendar/create_payment/list_payments/payment_summary/create_voucher/list_vouchers/bank_reconciliation/financial_report/cost_analysis/cash_flow_forecast/budget_vs_actual/tax_risk_scan/archive_status/monthly_closing",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create_invoice", "list_invoices", "calc_vat", "calc_income_tax", "create_tax_filing", "list_tax_filings", "tax_calendar", "create_payment", "list_payments", "payment_summary", "create_voucher", "list_vouchers", "bank_reconciliation", "financial_report", "cost_analysis", "cash_flow_forecast", "budget_vs_actual", "tax_risk_scan", "archive_status", "monthly_closing"] },
            company_id: { type: "string" }, type: { type: "string" }, counterparty: { type: "string" },
            amount: { type: "number" }, tax_rate: { type: "number" }, invoice_number: { type: "string" },
            issue_date: { type: "string" }, due_date: { type: "string" }, notes: { type: "string" },
            status: { type: "string" }, invoice_id: { type: "string" }, period: { type: "string" },
            tax_type: { type: "string" }, revenue: { type: "number" }, deductible: { type: "number" },
            tax_amount: { type: "number" }, direction: { type: "string" },
            payment_method: { type: "string" }, category: { type: "string" },
            opportunity_id: { type: "string", description: "如该发票/付款来自某个地图机会，可传机会ID，系统会自动写入机会标记" },
            voucher_date: { type: "string", description: "凭证日期" },
            debit_account: { type: "string", description: "借方科目" },
            credit_account: { type: "string", description: "贷方科目" },
            description: { type: "string", description: "凭证摘要/业务描述" },
            report_type: { type: "string", description: "报表类型: balance_sheet/income_statement/cash_flow" },
            month: { type: "string", description: "月份YYYY-MM" },
            cost_category: { type: "string", description: "成本分类: material/labor/overhead/operating" },
            budget_amount: { type: "number", description: "预算金额" },
            forecast_months: { type: "number", description: "预测月数(1-12)" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_legal",
        description: "法务合同管理：创建/查询/更新合同、风险评估。action: create_contract/list_contracts/get_contract/update_contract/delete_contract",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create_contract", "list_contracts", "get_contract", "update_contract", "delete_contract"] },
            company_id: { type: "string" }, title: { type: "string" }, counterparty: { type: "string" },
            contract_type: { type: "string" }, amount: { type: "number" }, start_date: { type: "string" },
            end_date: { type: "string" }, status: { type: "string" }, key_terms: { type: "string" },
            opportunity_id: { type: "string", description: "如该合同来自某个地图机会，可传机会ID，系统会自动写入机会标记" },
            contract_id: { type: "string" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_hr",
        description: "人力资源管理：员工档案、薪资核算、考勤管理、社保公积金、招聘、培训、月度报表。action: add_employee/list_employees/update_employee/calc_social_insurance/calc_personal_tax/payroll_summary/attendance_report/payroll_calc/social_insurance_report/recruitment_plan/training_plan/hr_monthly_report/employee_change_report/onboarding_checklist/offboarding_checklist",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add_employee", "list_employees", "update_employee", "calc_social_insurance", "calc_personal_tax", "payroll_summary", "attendance_report", "payroll_calc", "social_insurance_report", "recruitment_plan", "training_plan", "hr_monthly_report", "employee_change_report", "onboarding_checklist", "offboarding_checklist"] },
            company_id: { type: "string" }, employee_name: { type: "string" }, position: { type: "string" },
            salary: { type: "number" }, social_insurance: { type: "number" },
            housing_fund: { type: "number" }, start_date: { type: "string" },
            contract_type: { type: "string" }, employee_id: { type: "string" },
            status: { type: "string" }, notes: { type: "string" },
            base_salary: { type: "number" }, city: { type: "string" },
            month: { type: "string", description: "月份，格式YYYY-MM，用于考勤/薪资/报表" },
            work_days: { type: "number", description: "应出勤天数" },
            actual_days: { type: "number", description: "实际出勤天数" },
            overtime_hours: { type: "number", description: "加班时长（小时）" },
            leave_days: { type: "number", description: "请假天数" },
            late_count: { type: "number", description: "迟到次数" },
            performance_score: { type: "number", description: "绩效评分(0-100)" },
            bonus: { type: "number", description: "奖金" },
            deduction: { type: "number", description: "扣款" },
            job_title: { type: "string", description: "招聘岗位名称" },
            headcount: { type: "number", description: "招聘人数" },
            training_topic: { type: "string", description: "培训主题" },
            training_date: { type: "string", description: "培训日期" },
            attendees: { type: "number", description: "参训人数" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_project",
        description: "项目管理：项目/任务CRUD、看板。action: create_project/list_projects/update_project/add_task/list_tasks/update_task/project_summary/kanban。创建项目时请同时生成 document（项目需求文档，Markdown格式，包含项目背景、目标、范围、功能需求、技术方案、里程碑计划、风险评估等）。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create_project", "list_projects", "update_project", "add_task", "list_tasks", "update_task", "project_summary", "kanban"] },
            company_id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
            document: { type: "string", description: "项目需求文档（Markdown格式），创建项目时必须生成，包含：项目背景、项目目标、项目范围、功能需求清单、技术方案概述、里程碑计划、风险评估、验收标准等" },
            status: { type: "string" }, budget: { type: "number" }, start_date: { type: "string" },
            end_date: { type: "string" }, project_id: { type: "string" }, title: { type: "string" },
            assignee: { type: "string" }, priority: { type: "string" }, task_id: { type: "string" },
            hours_estimated: { type: "number" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_search",
        description: "联网搜索工具：实时搜索互联网获取最新信息、行业资讯、政策法规、竞品分析、市场数据等。系统会默认优先尝试 Qwen 原生搜索；若失败或结果不足，再自动补充 UAPI 结果。用户无需指定搜索引擎。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词，支持中英文" },
            site: { type: "string", description: "限定搜索特定网站，如 zhihu.com" },
            filetype: { type: "string", description: "限定文件类型，如 pdf、doc" },
            fetch_full: { type: "boolean", description: "是否获取页面完整正文（会影响响应时间）" },
            time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "时间范围过滤" },
            sort: { type: "string", enum: ["relevance", "date"], description: "排序方式" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "native_web_search",
        description: "调用 Qwen3.6-Plus Responses API 的原生 web_search 能力做联网搜索。适合最新新闻、政策、产业动态、公开网页线索搜索。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "要搜索的问题或关键词" },
            domains: { type: "string", description: "可选，优先关注的域名，多个用逗号分隔" },
            limit: { type: "number", description: "最多返回多少条来源，默认 5，最大 10" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "native_web_extract",
        description: "调用 Qwen3.6-Plus Responses API 的 web_search + web_extractor 组合能力，从网页或搜索结果中抽取正文与关键信息。适合政策页、公告页、园区页、新闻页。",
        parameters: {
          type: "object",
          properties: {
            goal: { type: "string", description: "你想从页面提取什么信息" },
            query: { type: "string", description: "搜索并抽取的主题，如“大竹县 最新采购公告 金额 甲方”" },
            url: { type: "string", description: "可选，优先抽取的目标 URL" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "native_code_interpreter",
        description: "调用 Qwen3.6-Plus Responses API 的 code_interpreter 进行计算、脚本执行和结构化分析。适合金额测算、评分、表格推导、简单数据处理。",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "明确的计算或分析任务描述" },
            query: { type: "string", description: "兼容字段，等同于 task" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_email",
        description: "发送邮件工具：可以向指定邮箱发送邮件。适用于：发送报告、通知客户、跟进合作伙伴、发送合同/发票提醒等。支持 HTML 格式正文。",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "收件人邮箱地址，多个用逗号分隔" },
            subject: { type: "string", description: "邮件主题" },
            body: { type: "string", description: "邮件正文（支持 HTML 格式）" },
            cc: { type: "string", description: "抄送邮箱地址，多个用逗号分隔" },
          },
          required: ["to", "subject", "body"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_report",
        description: "报告生成工具：基于公司数据和搜索结果，生成专业的商业报告。可生成：市场调研报告、竞品分析、财务分析报告、运营周报/月报、行业趋势分析等。报告以 Markdown 格式输出。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["market_research", "competitor_analysis", "financial_analysis", "operations_report", "industry_trends", "custom"], description: "报告类型" },
            company_id: { type: "string" },
            title: { type: "string", description: "报告标题" },
            search_queries: { type: "array", items: { type: "string" }, description: "需要搜索的关键词列表，用于收集外部数据" },
            extra_context: { type: "string", description: "附加背景信息或特定要求" },
            period: { type: "string", description: "报告周期，如 2025-03 或 2025-Q1" },
          },
          required: ["action", "title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_document",
        description: "文档生成工具：生成商务文档并保存到系统（云端存储），用户可导出为Word。调用时需在content参数中传入完整Markdown正文。【重要】本地桌面版请优先使用 local_write_file 直接保存到用户电脑，不要用此工具。此工具仅适用于云端在线版。",
        parameters: {
          type: "object",
          properties: {
            doc_type: { type: "string", enum: ["business_plan", "contract_template", "marketing_plan", "meeting_minutes", "weekly_report", "monthly_report", "prd", "proposal", "letter", "notice", "custom"], description: "文档类型" },
            title: { type: "string", description: "文档标题" },
            content: { type: "string", description: "文档正文（Markdown格式），必须完整、专业、可直接使用" },
            recipient: { type: "string", description: "收件人/目标对象（如适用）" },
            extra_requirements: { type: "string", description: "额外要求" },
          },
          required: ["doc_type", "title", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_schedule",
        description: "日程与待办管理工具。【重要】当用户提到任何会议、约见、出差、约会、事项安排时，必须调用 add_event 将其写入日历（即使用户只说'提醒我'）。add_event 用于日历事件；add_todo 用于无具体时间的任务清单。其他 action：list_events 查询日程、update_event 修改、delete_event 删除、check_availability 检查时间冲突、today_agenda 今日概览、upcoming 未来安排。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add_todo", "list_todos", "complete_todo", "delete_todo", "today_agenda", "upcoming", "add_event", "list_events", "update_event", "delete_event", "check_availability"], description: "操作类型" },
            company_id: { type: "string" },
            title: { type: "string", description: "待办/日程标题" },
            description: { type: "string", description: "详细描述" },
            priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级" },
            category: { type: "string", description: "分类（待办：财务/法务等；日程：work/meeting/travel/personal/other）" },
            due_date: { type: "string", description: "截止日期 YYYY-MM-DD" },
            todo_id: { type: "string", description: "待办ID（用于完成/删除）" },
            event_id: { type: "string", description: "日程事件ID（用于修改/删除）" },
            date: { type: "string", description: "日程日期 YYYY-MM-DD" },
            start_time: { type: "string", description: "开始时间 HH:mm，空表示全天" },
            end_time: { type: "string", description: "结束时间 HH:mm" },
            location: { type: "string", description: "地点" },
            status: { type: "string", description: "日程状态：scheduled/completed/cancelled" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_data_analysis",
        description: "数据分析工具：基于公司数据进行智能分析。可分析：收支趋势、同比环比增长、客户转化率、成本结构、项目进度、员工效能等。返回结构化数据+分析洞察。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["revenue_trend", "expense_breakdown", "client_conversion", "monthly_comparison", "cash_runway", "growth_rate", "kpi_dashboard"], description: "分析类型" },
            company_id: { type: "string" },
            period: { type: "string", description: "分析周期，如 2025-03 或 2025-Q1" },
            months: { type: "number", description: "分析月份数（默认6）" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_webpage",
        description: "网页内容抓取工具：获取指定URL的网页正文内容。适用于：阅读新闻文章、获取政策全文、分析竞品官网、提取产品信息等。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要抓取的网页URL" },
            extract_type: { type: "string", enum: ["full_text", "summary", "metadata"], description: "提取类型：full_text完整正文、summary摘要、metadata元数据" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_video",
        description: "AI 视频制作工具：根据主题自动生成视频脚本并用 Remotion 渲染为 MP4。兼容 create_script（旧版脚本骨架）和 generate_script（新版 prompt 工作流）。工作流：1）generate_script 获取生成 prompt → 2）AI 调用 chat 生成 script_json → 3）render_video 渲染 → 4）get_status 轮询进度。",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create_script", "generate_script", "render_video", "get_status", "list_videos"],
              description: "操作：create_script=生成脚本骨架, generate_script=生成脚本prompt, render_video=开始渲染, get_status=查询进度, list_videos=列出所有任务",
            },
            topic: { type: "string", description: "视频主题（generate_script 时必填，例如「星环OPC 产品介绍」）" },
            template: { type: "string", description: "脚本模板（create_script 时可传，默认 promo）" },
            duration_seconds: { type: "number", description: "视频时长秒数（create_script 时可传）" },
            scenes_count: { type: "number", description: "场景数量（默认4，范围2-6）" },
            title: { type: "string", description: "视频标题（render_video 时填写）" },
            script_json: {
              type: "string",
              description: "AI 生成的视频配置 JSON 字符串（render_video 时必填）。格式：{productName, tagline, accentColor, scenes:[{icon,title,subtitle,color,body,subs:[{text,start,end}]}]}",
            },
            video_id: { type: "string", description: "视频ID（get_status 时必填）" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_cron",
        description: "创建或管理定时提醒/通知任务（邮件或站内通知）。支持一次性（delay_minutes 或 run_at）和周期性（cron_expr）两种模式。【注意】如果用户提到会议、约见等日历事件，请先调用 opc_schedule add_event 写入日历，再用本工具设置时间提醒——两步缺一不可。示例：'10分钟后给xxx@qq.com发邮件'、'每天早上9点提醒开晨会'。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "list", "cancel", "run_now"], description: "操作：create 创建任务, list 列出任务, cancel 取消任务, run_now 立即执行" },
            name: { type: "string", description: "任务名称/描述，如'10分钟后给张三发邮件'" },
            task_type: { type: "string", enum: ["email", "notify", "both"], description: "任务类型：email 发邮件, notify 站内通知, both 两者都发" },
            delay_minutes: { type: "number", description: "从现在起多少分钟后执行（一次性任务）" },
            run_at: { type: "string", description: "ISO 时间字符串，精确执行时间（一次性任务，与 delay_minutes 二选一）" },
            cron_expr: { type: "string", description: "cron 表达式（周期性任务，如 '0 9 * * 1-5' 表示工作日早9点）" },
            max_runs: { type: "number", description: "周期任务最大执行次数，不填表示无限" },
            to_email: { type: "string", description: "收件人邮箱" },
            subject: { type: "string", description: "邮件主题" },
            body: { type: "string", description: "邮件正文（支持HTML）" },
            notify_message: { type: "string", description: "站内通知内容" },
            task_id: { type: "string", description: "任务ID（cancel / run_now 时必填）" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "invoke_skill",
        description: "调用已激活的专项技能（Skill）作为子智能体完成深度任务。例如：用「竞品分析师」分析某公司商业模式、用「PPT大纲设计师」生成演讲结构。技能会以专业视角给出深度输出。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "技能名称，必须与已激活技能列表中的名称完全一致" },
            task: { type: "string", description: "交给该技能的具体任务描述，越详细越好" },
          },
          required: ["name", "task"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "setup_email",
        description: "配置或管理用户的邮件账户（IMAP收件 + SMTP发件）。首次配置时询问用户邮箱和授权码，保存后系统自动定期拉取新邮件。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["save", "list", "remove", "test"], description: "操作：save 保存账户, list 列出账户, remove 删除账户, test 测试连接" },
            email: { type: "string", description: "邮箱地址（save/test 时必填）" },
            password: { type: "string", description: "邮箱授权码（save 时必填，非登录密码）" },
            display_name: { type: "string", description: "发件人显示名称（可选）" },
            imap_host: { type: "string", description: "IMAP 服务器地址（不填则自动检测）" },
            imap_port: { type: "number", description: "IMAP 端口（默认 993）" },
            smtp_host: { type: "string", description: "SMTP 服务器地址（不填则自动检测）" },
            smtp_port: { type: "number", description: "SMTP 端口（默认 465）" },
            account_id: { type: "string", description: "账户ID（remove/test 时使用）" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_email",
        description: "读取用户收件箱的邮件列表和摘要，了解最新来信情况。",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "返回条数，默认 10" },
            status: { type: "string", enum: ["new", "notified", "replied", "task_created", "archived", "all"], description: "按状态筛选，默认 all" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reply_email",
        description: "回复收件箱中的某封邮件（使用用户配置的邮箱发送）。",
        parameters: {
          type: "object",
          properties: {
            email_id: { type: "string", description: "邮件 ID" },
            content: { type: "string", description: "回复正文（HTML 格式）" },
          },
          required: ["email_id", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_skills",
        description: "从内置技能库搜索匹配技能，找不到时自动生成新技能并安装。安装完成后可立即用 invoke_skill 调用。当用户需要某类专业能力但当前没有合适技能时使用。",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string", description: "描述你需要什么类型的技能，越具体越好，如「帮我写B2B冷启动邮件的技能」" },
          },
          required: ["description"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "opc_service_config",
        description: "配置外部服务（邮箱SMTP、飞书、企业微信、钉钉、搜索服务）。action: get 获取当前配置, save 保存配置。用户说\"帮我配置邮箱/飞书/钉钉/企微\"时使用此工具。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get", "save"], description: "get=查看, save=保存" },
            service: { type: "string", enum: ["email", "feishu", "wecom", "dingtalk", "search"], description: "服务类型" },
            smtp_host: { type: "string" }, smtp_port: { type: "number" }, smtp_user: { type: "string" }, smtp_pass: { type: "string" },
            feishu_app_id: { type: "string" }, feishu_app_secret: { type: "string" }, feishu_webhook: { type: "string" },
            wecom_corpid: { type: "string" }, wecom_secret: { type: "string" }, wecom_agent_id: { type: "string" }, wecom_webhook: { type: "string" },
            dingtalk_app_key: { type: "string" }, dingtalk_app_secret: { type: "string" }, dingtalk_webhook: { type: "string" },
            uapi_key: { type: "string" }, uapi_url: { type: "string" },
          },
          required: ["action", "service"],
        },
      },
    },
  ];
  return filterToolDefinitionsByCapabilities(
    definitions.map((definition) => registerToolDefinition(definition)),
    options.capabilities,
  ).map((entry) => entry.definition);
}

// ─── 工具执行 ──────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  db: Db,
  companyId: string,
  userId?: string,
  signal?: AbortSignal,
): Promise<string> {
  console.log("[executeTool]", toolName, args.action || args.query || args.url || "", "userId:", userId);
  if (args.company_id === undefined || args.company_id === "") {
    args.company_id = companyId;
  }
  const startedAt = Date.now();
  const riskLevel = classifyToolRisk(toolName, args);
  const context: ToolExecutionContext = {
    db,
    companyId: String(args.company_id),
    userId,
    signal,
  };

  const needsManualApproval = !!userId && riskLevel === "high" && !toolName.startsWith("local_");
  if (needsManualApproval) {
    const approved = await requestApproval(userId, toolName, args);
    if (!approved) {
      const rejectedMessage = "高风险工具执行未获审批，已中止";
      await writeToolExecutionAudit(db, {
        userId,
        toolName,
        args,
        errorMessage: rejectedMessage,
        riskLevel,
        startedAt,
        approved: false,
      });
      return JSON.stringify({ error: rejectedMessage, tool: toolName, approval_required: true });
    }
  }

  try {
    const result = await executeBuiltInTool(toolName, args, context);
    await writeToolExecutionAudit(db, {
      userId,
      toolName,
      args,
      result,
      riskLevel,
      startedAt,
      approved: true,
    });
    return result;
  } catch (e: unknown) {
    const errorMessage = `工具执行错误: ${(e as Error).message}`;
    await writeToolExecutionAudit(db, {
      userId,
      toolName,
      args,
      errorMessage,
      riskLevel,
      startedAt,
      approved: true,
    });
    return JSON.stringify({ error: errorMessage });
  }
}

async function executeBuiltInTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const { db, companyId, userId, signal } = context;

  switch (toolName) {
    case "opc_manage": return await execOpcManage(args, db, companyId, userId);
    case "opc_finance": return await execOpcFinance(args, db, companyId);
    case "opc_legal": return await execOpcLegal(args, db, companyId);
    case "opc_hr": return await execOpcHr(args, db, companyId);
    case "opc_project": return await execOpcProject(args, db, companyId);
    case "opc_search": return await execOpcSearch(args, signal);
    case "native_web_search": return await execNativeWebSearchReadOnly(args, { signal });
    case "native_web_extract": return await execNativeWebExtractReadOnly(args, { signal });
    case "native_code_interpreter": return await execNativeCodeInterpreterReadOnly(args, { signal });
    case "opc_email": return await execOpcEmail(args);
    case "opc_report": return await execOpcReport(args, db, companyId, signal);
    case "opc_document": return await execOpcDocument(args, db, companyId);
    case "opc_schedule": return await execOpcSchedule(args, db, companyId, userId || "");
    case "opc_data_analysis": return await execOpcDataAnalysis(args, db, companyId);
    case "opc_webpage": return await execOpcWebpage(args, signal);
    case "opc_video": return await execOpcVideo(args, db, companyId, userId);
    case "opc_cron": return await execOpcCron(args, db, companyId, userId || "");
    case "invoke_skill": return await execInvokeSkill(args, db, userId || "", signal);
    case "find_skills": return await execFindSkills(args, db, userId || "");
    case "setup_email": return await execSetupEmail(args, db, userId || "");
    case "read_email": return await execReadEmail(args, db, userId || "");
    case "reply_email": return await execReplyEmail(args, db, userId || "");
    case "opc_service_config": return await execServiceConfig(args, db);
    default:
      if (isLocalModeEnabled() && toolName.startsWith("feishu_")) {
        return await executeFeishuTool(toolName, args, db, userId);
      }
      if (isLocalModeEnabled() && toolName.startsWith("local_")) {
        return await executeLocalTool(toolName, args, db, userId || "");
      }
      return JSON.stringify({ error: `未知工具: ${toolName}` });
  }
}

// ─── opc_manage ────────────────────────────────────────────────────────

async function execOpcManage(p: Record<string, unknown>, db: Db, cid: string, userId?: string): Promise<string> {
  const action = String(p.action);

  switch (action) {
    case "register_company": {
      const id = uuid();
      const now = new Date().toISOString();
      const registrationMode = s(p.registration_mode || p.registrationMode, "virtual");
      const registrationStage = s(p.registration_stage || p.registrationStage, registrationMode === "real" ? "preparing" : "simulated");
      const startupStage = s(p.startup_stage || p.startupStage, "setup");
      const firstOrderStage = s(p.first_order_stage || p.firstOrderStage, "not_started");
      await db.query(
        "INSERT INTO opc_companies (id,name,industry,status,registration_mode,registration_stage,startup_stage,first_order_stage,owner_name,owner_contact,registered_capital,description,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [id, s(p.name), s(p.industry), "pending", registrationMode, registrationStage, startupStage, firstOrderStage, s(p.owner_name), s(p.owner_contact), s(p.registered_capital), s(p.description), now, now],
      );
      if (userId) {
        await db.query(
          "INSERT INTO opc_user_companies (user_id, company_id, role, created_at) VALUES ($1, $2, 'owner', $3) ON CONFLICT DO NOTHING",
          [userId, id, now],
        );
      }
      const { rows } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [id]);
      return JSON.stringify({ success: true, company: rows[0] });
    }
    case "get_company": {
      if (!cid) return JSON.stringify({ error: "未指定公司，请先使用 list_my_companies 查看用户的公司列表" });
      const { rows: cr } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [cid]);
      if (!cr[0]) return JSON.stringify({ error: "公司不存在" });
      const { rows: fin } = await db.query("SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 GROUP BY type", [cid]);
      return JSON.stringify({ company: cr[0], finance: fin });
    }
    case "list_my_companies": {
      if (!userId) return JSON.stringify({ error: "未登录" });
      const { rows } = await db.query(
        `SELECT c.id, c.name, c.industry, c.status, c.owner_name, c.created_at, uc.role
         FROM opc_companies c
         JOIN opc_user_companies uc ON uc.company_id = c.id
         WHERE uc.user_id = $1
         ORDER BY c.created_at DESC`,
        [userId],
      );
      const roleMap: Record<string, string> = { owner: "所有者", admin: "管理员", member: "成员" };
      const list = (rows as any[]).map(r => ({
        ...r,
        role_label: roleMap[r.role] || r.role,
      }));
      return JSON.stringify({ success: true, total: list.length, companies: list });
    }
    case "update_company": {
      const sets: string[] = []; const vals: unknown[] = []; let idx = 1;
      for (const f of ["name", "industry", "status", "owner_name", "owner_contact", "registered_capital", "description"]) {
        if (p[f] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(String(p[f])); }
      }
      if (sets.length === 0) return JSON.stringify({ error: "无更新内容" });
      sets.push("updated_at = NOW()");
      vals.push(cid);
      await db.query(`UPDATE opc_companies SET ${sets.join(",")} WHERE id = $${idx}`, vals);
      const { rows } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [cid]);
      return JSON.stringify({ success: true, company: rows[0] });
    }
    case "add_transaction": {
      const id = uuid();
      const rawType = s(p.type, "expense").toLowerCase();
      const txType = (rawType === "income" || rawType === "收入" || rawType === "in") ? "income" : "expense";
      const cp = s(p.counterparty);
      const marker = buildOpportunityMarkerFromPayload(p);
      const description = appendOpportunityMarker(s(p.description), marker);
      await db.query(
        "INSERT INTO opc_transactions (id,company_id,type,category,amount,description,counterparty,transaction_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())",
        [id, cid, txType, s(p.category), n(p.amount), description, cp, s(p.transaction_date, new Date().toISOString().slice(0, 10))],
      );
      const { rows } = await db.query("SELECT * FROM opc_transactions WHERE id = $1", [id]);
      // Auto-add counterparty as contact if provided
      let autoContact = "";
      if (cp && cp.length >= 2) {
        const { rows: existing } = await db.query(
          "SELECT id FROM opc_contacts WHERE company_id = $1 AND (name = $2 OR company = $2) LIMIT 1",
          [cid, cp],
        );
        if (!existing.length) {
          await db.query(
            "INSERT INTO opc_contacts (id,company_id,name,company,source,pipeline_stage,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
            [uuid(), cid, cp, cp, "交易记录自动添加", "lead", appendOpportunityMarker(`通过${txType === "income" ? "收入" : "支出"}记录 ¥${n(p.amount)} 自动关联`, marker)],
          );
          autoContact = cp;
        }
      }
      return JSON.stringify({ success: true, transaction: rows[0], auto_added_contact: autoContact || undefined });
    }
    case "list_transactions": {
      const limit = n(p.limit, 20);
      const { rows } = await db.query("SELECT * FROM opc_transactions WHERE company_id = $1 ORDER BY transaction_date DESC LIMIT $2", [cid, limit]);
      return JSON.stringify({ transactions: rows, count: rows.length });
    }
    case "finance_summary": {
      const { rows } = await db.query("SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 GROUP BY type", [cid]);
      let income = 0, expense = 0;
      for (const r of rows as { type: string; total: number }[]) { if (r.type === "income") income = Number(r.total); else expense = Number(r.total); }
      return JSON.stringify({ total_income: income, total_expense: expense, net: income - expense });
    }
    case "add_contact": {
      const id = uuid();
      await db.query(
        "INSERT INTO opc_contacts (id,company_id,name,email,phone,company,role,source,pipeline_stage,deal_value,follow_up_date,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())",
        [id, cid, s(p.name), s(p.email), s(p.phone), s(p.company), s(p.role), s(p.source), s(p.pipeline_stage, "lead"), n(p.deal_value), s(p.follow_up_date), s(p.notes)],
      );
      const { rows } = await db.query("SELECT * FROM opc_contacts WHERE id = $1", [id]);
      return JSON.stringify({ success: true, contact: rows[0] });
    }
    case "list_contacts": {
      const { rows } = await db.query("SELECT * FROM opc_contacts WHERE company_id = $1 ORDER BY created_at DESC", [cid]);
      return JSON.stringify({ contacts: rows, count: rows.length });
    }
    case "update_contact": {
      const sets: string[] = []; const vals: unknown[] = []; let idx = 1;
      for (const f of ["name", "email", "phone", "company", "role", "source", "pipeline_stage", "deal_value", "follow_up_date", "notes"]) {
        if (p[f] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(f === "deal_value" ? n(p[f]) : String(p[f])); }
      }
      if (sets.length === 0) return JSON.stringify({ error: "无更新字段" });
      vals.push(String(p.contact_id));
      await db.query(`UPDATE opc_contacts SET ${sets.join(",")} WHERE id = $${idx}`, vals);
      const { rows } = await db.query("SELECT * FROM opc_contacts WHERE id = $1", [String(p.contact_id)]);
      return JSON.stringify({ success: true, contact: rows[0] });
    }
    case "delete_contact": {
      await db.query("DELETE FROM opc_contacts WHERE id = $1 AND company_id = $2", [String(p.contact_id), cid]);
      return JSON.stringify({ success: true });
    }
    case "dashboard": {
      if (!cid) return JSON.stringify({ error: "未指定公司，请先使用 list_my_companies 查看用户的公司列表" });
      const { rows: cr } = await db.query("SELECT * FROM opc_companies WHERE id = $1", [cid]);
      const { rows: fin } = await db.query("SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id = $1 GROUP BY type", [cid]);
      const { rows: ctc } = await db.query("SELECT COUNT(*) as c FROM opc_contacts WHERE company_id = $1", [cid]);
      const { rows: prj } = await db.query("SELECT COUNT(*) as c FROM opc_projects WHERE company_id = $1", [cid]);
      return JSON.stringify({ company: cr[0], finance: fin, contacts: ctc[0], projects: prj[0] });
    }
    case "crm_pipeline": {
      const { rows } = await db.query("SELECT pipeline_stage, COUNT(*) as cnt, SUM(deal_value) as val FROM opc_contacts WHERE company_id = $1 GROUP BY pipeline_stage", [cid]);
      return JSON.stringify({ pipeline: rows });
    }
    case "follow_up_reminders": {
      const today = new Date().toISOString().slice(0, 10);
      const { rows } = await db.query("SELECT * FROM opc_contacts WHERE company_id = $1 AND follow_up_date <= $2 AND pipeline_stage NOT IN ('won','lost','churned') ORDER BY follow_up_date", [cid, today]);
      return JSON.stringify({ reminders: rows, count: rows.length });
    }
    default:
      return JSON.stringify({ error: `opc_manage: 未知 action '${action}'` });
  }
}

// ─── opc_finance ──────────────────────────────────────────────────────

async function execOpcFinance(p: Record<string, unknown>, db: Db, cid: string): Promise<string> {
  const action = String(p.action);

  switch (action) {
    case "create_invoice": {
      const id = uuid();
      const taxRate = n(p.tax_rate, 0.06);
      const amount = n(p.amount);
      const taxAmt = Math.round(amount * taxRate * 100) / 100;
      const num = s(p.invoice_number) || `INV-${new Date().toISOString().slice(0, 7).replace("-", "")}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      const marker = buildOpportunityMarkerFromPayload(p);
      const notes = appendOpportunityMarker(s(p.notes), marker);
      await db.query(
        "INSERT INTO opc_invoices (id,company_id,invoice_number,type,contact_id,amount,tax_amount,status,issue_date,due_date,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())",
        [id, cid, num, s(p.type, "receivable"), s(p.counterparty), amount, taxAmt, "draft", s(p.issue_date, new Date().toISOString().slice(0, 10)), s(p.due_date), notes],
      );
      const { rows } = await db.query("SELECT * FROM opc_invoices WHERE id = $1", [id]);
      return JSON.stringify({ success: true, invoice: rows[0] });
    }
    case "list_invoices": {
      let sql = "SELECT * FROM opc_invoices WHERE company_id = $1";
      const params: unknown[] = [cid];
      let idx = 2;
      if (p.type) { sql += ` AND type = $${idx++}`; params.push(String(p.type)); }
      if (p.status) { sql += ` AND status = $${idx++}`; params.push(String(p.status)); }
      sql += " ORDER BY issue_date DESC LIMIT 50";
      const { rows } = await db.query(sql, params);
      return JSON.stringify({ invoices: rows });
    }
    case "calc_vat": {
      const period = s(p.period);
      const { rows: salesRows } = await db.query("SELECT COALESCE(SUM(tax_amount),0) as v FROM opc_invoices WHERE company_id = $1 AND type = 'receivable' AND issue_date LIKE $2", [cid, `${period}%`]);
      const { rows: purchaseRows } = await db.query("SELECT COALESCE(SUM(tax_amount),0) as v FROM opc_invoices WHERE company_id = $1 AND type = 'payable' AND issue_date LIKE $2", [cid, `${period}%`]);
      const salesV = Number(salesRows[0]?.v || 0);
      const purchaseV = Number(purchaseRows[0]?.v || 0);
      const vat = Math.max(0, salesV - purchaseV);
      return JSON.stringify({ period, output_tax: salesV, input_tax: purchaseV, vat_payable: vat });
    }
    case "calc_income_tax": {
      const { rows: fin } = await db.query("SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id = $1 GROUP BY type", [cid]);
      let revenue = 0, cost = 0;
      for (const r of fin as { type: string; total: number }[]) { if (r.type === "income") revenue = Number(r.total); else cost = Number(r.total); }
      const profit = revenue - cost;
      let taxRate = 0.25;
      if (profit <= 3000000) taxRate = 0.05;
      else if (profit <= 10000000) taxRate = 0.10;
      const tax = Math.round(profit * taxRate * 100) / 100;
      return JSON.stringify({ revenue, cost, profit, tax_rate: taxRate, income_tax: Math.max(0, tax) });
    }
    case "create_tax_filing": {
      const id = uuid();
      await db.query(
        "INSERT INTO opc_invoices (id,company_id,invoice_number,type,amount,tax_amount,status,issue_date,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())",
        [id, cid, `TAX-${s(p.period)}`, s(p.tax_type, "vat"), n(p.revenue), n(p.tax_amount), "draft", new Date().toISOString().slice(0, 10), s(p.notes)],
      );
      return JSON.stringify({ success: true, filing_id: id });
    }
    case "list_tax_filings": {
      const { rows } = await db.query("SELECT * FROM opc_invoices WHERE company_id = $1 AND invoice_number LIKE 'TAX-%' ORDER BY created_at DESC", [cid]);
      return JSON.stringify({ filings: rows });
    }
    case "tax_calendar": {
      return JSON.stringify({
        calendar: [
          { tax: "增值税", period: "月度/季度", deadline: "次月15日" },
          { tax: "企业所得税", period: "季度预缴", deadline: "季后15日" },
          { tax: "企业所得税", period: "年度汇算", deadline: "次年5月31日" },
          { tax: "个人所得税", period: "月度", deadline: "次月15日" },
          { tax: "印花税", period: "按次/季度", deadline: "季后15日" },
        ],
      });
    }
    case "create_payment": {
      const id = uuid();
      const marker = buildOpportunityMarkerFromPayload(p);
      const paymentNote = appendOpportunityMarker(s(p.notes, `付款给 ${s(p.counterparty)}`), marker);
      await db.query(
        "INSERT INTO opc_transactions (id,company_id,type,category,amount,description,transaction_date,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())",
        [id, cid, s(p.direction, "expense"), s(p.category), n(p.amount), paymentNote, s(p.issue_date, new Date().toISOString().slice(0, 10))],
      );
      return JSON.stringify({ success: true, payment_id: id });
    }
    case "list_payments": {
      const { rows } = await db.query("SELECT * FROM opc_transactions WHERE company_id = $1 ORDER BY transaction_date DESC LIMIT 30", [cid]);
      return JSON.stringify({ payments: rows });
    }
    case "payment_summary": {
      const { rows } = await db.query("SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 GROUP BY type", [cid]);
      return JSON.stringify({ summary: rows });
    }
    case "create_voucher": {
      const id = uuid();
      const vDate = s(p.voucher_date, new Date().toISOString().slice(0, 10));
      const amt = n(p.amount);
      const vNum = `V-${vDate.replace(/-/g, "")}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      await db.query(
        "INSERT INTO opc_transactions (id,company_id,type,category,amount,description,transaction_date,counterparty,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())",
        [id, cid, "voucher", s(p.debit_account, "未分类"), amt, `[凭证] ${s(p.description)} | 借:${s(p.debit_account)} 贷:${s(p.credit_account)}`, vDate, vNum],
      );
      return JSON.stringify({ success: true, voucher_id: id, voucher_number: vNum, date: vDate, debit: s(p.debit_account), credit: s(p.credit_account), amount: amt, description: s(p.description), note: "凭证草稿已生成，请财务人员复核确认" });
    }
    case "list_vouchers": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const { rows } = await db.query("SELECT * FROM opc_transactions WHERE company_id = $1 AND counterparty LIKE 'V-%' AND transaction_date LIKE $2 ORDER BY transaction_date", [cid, `${month}%`]);
      return JSON.stringify({ month, vouchers: rows, count: rows.length });
    }
    case "bank_reconciliation": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const { rows: txns } = await db.query("SELECT * FROM opc_transactions WHERE company_id = $1 AND transaction_date LIKE $2 ORDER BY transaction_date", [cid, `${month}%`]);
      const { rows: invs } = await db.query("SELECT * FROM opc_invoices WHERE company_id = $1 AND issue_date LIKE $2", [cid, `${month}%`]);
      const totalIn = (txns as any[]).filter(t => t.type === "income").reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const totalOut = (txns as any[]).filter(t => t.type === "expense").reduce((s, r) => s + (Number(r.amount) || 0), 0);
      return JSON.stringify({ month, transaction_count: txns.length, invoice_count: invs.length, total_income: totalIn, total_expense: totalOut, net: totalIn - totalOut, reconciliation_status: "待核对", note: "请核对银行流水与系统记录是否一致，标记异常交易" });
    }
    case "financial_report": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const reportType = s(p.report_type, "income_statement");
      const { rows: txns } = await db.query("SELECT type, category, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 AND transaction_date LIKE $2 GROUP BY type, category", [cid, `${month}%`]);
      if (reportType === "income_statement") {
        let revenue = 0, expense = 0;
        const details: any[] = [];
        for (const r of txns as any[]) {
          const amt = Number(r.total) || 0;
          if (r.type === "income") { revenue += amt; details.push({ type: "收入", category: r.category || "未分类", amount: amt, count: Number(r.cnt) }); }
          else if (r.type === "expense") { expense += amt; details.push({ type: "支出", category: r.category || "未分类", amount: amt, count: Number(r.cnt) }); }
        }
        return JSON.stringify({ month, report_type: "利润表", revenue, expense, net_profit: revenue - expense, details, note: "财务报表初稿，请复核确认后对外报送" });
      }
      return JSON.stringify({ month, report_type: reportType, data: txns, note: "请根据需要选择报表类型: balance_sheet/income_statement/cash_flow" });
    }
    case "cost_analysis": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const { rows } = await db.query("SELECT category, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 AND type = 'expense' AND transaction_date LIKE $2 GROUP BY category ORDER BY total DESC", [cid, `${month}%`]);
      const total = (rows as any[]).reduce((s, r) => s + (Number(r.total) || 0), 0);
      const breakdown = (rows as any[]).map(r => ({ category: r.category || "未分类", amount: Number(r.total) || 0, percentage: total > 0 ? Math.round((Number(r.total) || 0) / total * 10000) / 100 : 0, count: Number(r.cnt) }));
      return JSON.stringify({ month, total_cost: total, breakdown, optimization_suggestions: ["1. 分析占比最高的成本项，评估优化空间", "2. 对比上月数据，关注异常增长", "3. 固定成本vs可变成本分离，制定降本目标"], note: "成本分析初稿，建议结合业务部门调研补充原因分析" });
    }
    case "cash_flow_forecast": {
      const forecastMonths = n(p.forecast_months, 3);
      const { rows: recent } = await db.query("SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id = $1 AND transaction_date >= NOW() - INTERVAL '3 months' GROUP BY type", [cid]);
      let avgIncome = 0, avgExpense = 0;
      for (const r of recent as any[]) {
        if (r.type === "income") avgIncome = Math.round((Number(r.total) || 0) / 3);
        else avgExpense = Math.round((Number(r.total) || 0) / 3);
      }
      const forecast = [];
      const now = new Date();
      for (let i = 1; i <= forecastMonths; i++) {
        const m = new Date(now.getFullYear(), now.getMonth() + i, 1);
        forecast.push({ month: m.toISOString().slice(0, 7), projected_income: avgIncome, projected_expense: avgExpense, projected_net: avgIncome - avgExpense });
      }
      return JSON.stringify({ basis: "近3个月平均值", avg_monthly_income: avgIncome, avg_monthly_expense: avgExpense, forecast, risk_note: "预测基于历史均值，实际可能因业务变化有偏差。建议采用AI基础预测+人工调整的滚动预测机制" });
    }
    case "budget_vs_actual": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const budget = n(p.budget_amount, 0);
      const { rows } = await db.query("SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id = $1 AND transaction_date LIKE $2 GROUP BY type", [cid, `${month}%`]);
      let actualIncome = 0, actualExpense = 0;
      for (const r of rows as any[]) {
        if (r.type === "income") actualIncome = Number(r.total) || 0;
        else actualExpense = Number(r.total) || 0;
      }
      const variance = budget > 0 ? Math.round((actualExpense - budget) / budget * 10000) / 100 : 0;
      return JSON.stringify({ month, budget, actual_income: actualIncome, actual_expense: actualExpense, net: actualIncome - actualExpense, budget_variance: variance, status: variance > 10 ? "超支" : variance > 0 ? "略超" : "正常" });
    }
    case "tax_risk_scan": {
      const { rows: txns } = await db.query("SELECT COUNT(*) as cnt, SUM(amount) as total FROM opc_transactions WHERE company_id = $1", [cid]);
      const { rows: invs } = await db.query("SELECT COUNT(*) as cnt, SUM(amount) as total FROM opc_invoices WHERE company_id = $1", [cid]);
      const txnTotal = Number(txns[0]?.total || 0);
      const invTotal = Number(invs[0]?.total || 0);
      const risks = [];
      if (Math.abs(txnTotal - invTotal) > txnTotal * 0.1 && txnTotal > 0) risks.push({ level: "中", item: "收支与发票金额差异较大", suggestion: "核查是否存在漏开发票或重复入账" });
      const { rows: noInv } = await db.query("SELECT COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 AND type = 'income' AND id NOT IN (SELECT COALESCE(contact_id,'') FROM opc_invoices WHERE company_id = $1)", [cid]);
      if (Number(noInv[0]?.cnt || 0) > 0) risks.push({ level: "低", item: `${noInv[0].cnt}笔收入无对应发票`, suggestion: "建议补开发票或确认免票范围" });
      if (risks.length === 0) risks.push({ level: "低", item: "未发现明显税务风险", suggestion: "建议定期扫描，保持合规" });
      return JSON.stringify({ scan_date: new Date().toISOString().slice(0, 10), risks, recommendation: "AI扫描结果仅供参考，建议结合税务顾问意见处理高风险事项" });
    }
    case "archive_status": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const { rows: txnCnt } = await db.query("SELECT COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 AND transaction_date LIKE $2", [cid, `${month}%`]);
      const { rows: invCnt } = await db.query("SELECT COUNT(*) as cnt FROM opc_invoices WHERE company_id = $1 AND issue_date LIKE $2", [cid, `${month}%`]);
      const { rows: ctCnt } = await db.query("SELECT COUNT(*) as cnt FROM opc_contracts WHERE company_id = $1", [cid]);
      return JSON.stringify({ month, archive: { transactions: Number(txnCnt[0]?.cnt || 0), invoices: Number(invCnt[0]?.cnt || 0), contracts: Number(ctCnt[0]?.cnt || 0) }, checklist: ["1. 凭证整理装订", "2. 银行对账单归档", "3. 发票存根归档", "4. 纳税申报表留存", "5. 合同档案整理"], status: "待归档" });
    }
    case "monthly_closing": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const { rows: fin } = await db.query("SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 AND transaction_date LIKE $2 GROUP BY type", [cid, `${month}%`]);
      let income = 0, expense = 0, inCnt = 0, exCnt = 0;
      for (const r of fin as any[]) {
        if (r.type === "income") { income = Number(r.total) || 0; inCnt = Number(r.cnt); }
        else { expense = Number(r.total) || 0; exCnt = Number(r.cnt); }
      }
      return JSON.stringify({
        month, summary: { income, expense, net_profit: income - expense, income_transactions: inCnt, expense_transactions: exCnt },
        closing_checklist: [
          { step: "账务核对", status: "待完成", desc: "核对所有收支记录，确认无遗漏" },
          { step: "银行对账", status: "待完成", desc: "银行流水与系统记录匹配" },
          { step: "凭证审核", status: "待完成", desc: "复核所有凭证准确性" },
          { step: "报表生成", status: "待完成", desc: "生成利润表/资产负债表" },
          { step: "纳税申报", status: "待完成", desc: "增值税/所得税申报" },
          { step: "档案归档", status: "待完成", desc: "所有财务资料归档备查" },
        ],
        note: "月结流程初稿，请按清单逐项确认完成",
      });
    }
    default:
      return JSON.stringify({ error: `opc_finance: 未知 action '${action}'` });
  }
}

// ─── opc_legal ────────────────────────────────────────────────────────

async function execOpcLegal(p: Record<string, unknown>, db: Db, cid: string): Promise<string> {
  const action = String(p.action);

  switch (action) {
    case "create_contract": {
      const id = uuid();
      const marker = buildOpportunityMarkerFromPayload(p);
      const contractTitle = appendOpportunityMarker(s(p.title), marker);
      const contractTerms = appendOpportunityMarker(s(p.key_terms), marker);
      await db.query(
        "INSERT INTO opc_contracts (id,company_id,title,counterparty,type,value,status,start_date,end_date,terms,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())",
        [id, cid, contractTitle, s(p.counterparty), s(p.contract_type, "service"), n(p.amount), "draft", s(p.start_date), s(p.end_date), contractTerms],
      );
      const { rows } = await db.query("SELECT * FROM opc_contracts WHERE id = $1", [id]);
      return JSON.stringify({ success: true, contract: rows[0] });
    }
    case "list_contracts": {
      const { rows } = await db.query("SELECT * FROM opc_contracts WHERE company_id = $1 ORDER BY created_at DESC", [cid]);
      return JSON.stringify({ contracts: rows, count: rows.length });
    }
    case "get_contract": {
      const { rows } = await db.query("SELECT * FROM opc_contracts WHERE id = $1", [String(p.contract_id)]);
      return JSON.stringify(rows[0] || { error: "合同不存在" });
    }
    case "update_contract": {
      const sets: string[] = []; const vals: unknown[] = []; let idx = 1;
      for (const f of ["title", "counterparty", "type", "status", "start_date", "end_date", "key_terms"]) {
        if (p[f] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(String(p[f])); }
      }
      if (p.amount !== undefined) { sets.push(`value = $${idx++}`); vals.push(n(p.amount)); }
      if (sets.length === 0) return JSON.stringify({ error: "无更新字段" });
      vals.push(String(p.contract_id));
      await db.query(`UPDATE opc_contracts SET ${sets.join(",")} WHERE id = $${idx}`, vals);
      return JSON.stringify({ success: true });
    }
    case "delete_contract": {
      await db.query("DELETE FROM opc_contracts WHERE id = $1 AND company_id = $2", [String(p.contract_id), cid]);
      return JSON.stringify({ success: true });
    }
    default:
      return JSON.stringify({ error: `opc_legal: 未知 action '${action}'` });
  }
}

// ─── opc_hr ────────────────────────────────────────────────────────────

async function execOpcHr(p: Record<string, unknown>, db: Db, cid: string): Promise<string> {
  const action = String(p.action);

  switch (action) {
    case "add_employee": {
      const id = uuid();
      await db.query(
        "INSERT INTO opc_employees (id,company_id,name,role,department,salary,hire_date,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, cid, s(p.employee_name), s(p.position), s(p.department), n(p.salary), s(p.start_date, new Date().toISOString().slice(0, 10)), "active"],
      );
      const { rows } = await db.query("SELECT * FROM opc_employees WHERE id = $1", [id]);
      return JSON.stringify({ success: true, employee: rows[0] });
    }
    case "list_employees": {
      const { rows } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1 ORDER BY hire_date DESC", [cid]);
      return JSON.stringify({ employees: rows, count: rows.length });
    }
    case "update_employee": {
      const sets: string[] = []; const vals: unknown[] = []; let idx = 1;
      for (const f of ["name", "role", "department", "status"]) {
        const src = f === "name" ? "employee_name" : f === "role" ? "position" : f;
        if (p[src] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(String(p[src])); }
      }
      if (p.salary !== undefined) { sets.push(`salary = $${idx++}`); vals.push(n(p.salary)); }
      if (sets.length === 0) return JSON.stringify({ error: "无更新字段" });
      vals.push(String(p.employee_id));
      await db.query(`UPDATE opc_employees SET ${sets.join(",")} WHERE id = $${idx}`, vals);
      return JSON.stringify({ success: true });
    }
    case "calc_social_insurance": {
      const base = n(p.base_salary, n(p.salary, 8000));
      const pension = Math.round(base * 0.16 * 100) / 100;
      const medical = Math.round(base * 0.095 * 100) / 100;
      const unemployment = Math.round(base * 0.005 * 100) / 100;
      const injury = Math.round(base * 0.004 * 100) / 100;
      const housing = Math.round(base * 0.12 * 100) / 100;
      const companyTotal = pension + medical + unemployment + injury + housing;
      const ePension = Math.round(base * 0.08 * 100) / 100;
      const eMedical = Math.round(base * 0.02 * 100) / 100;
      const eUnemployment = Math.round(base * 0.005 * 100) / 100;
      const eHousing = Math.round(base * 0.12 * 100) / 100;
      const employeeTotal = ePension + eMedical + eUnemployment + eHousing;
      return JSON.stringify({
        base_salary: base,
        company: { pension, medical, unemployment, injury, housing, total: companyTotal },
        employee: { pension: ePension, medical: eMedical, unemployment: eUnemployment, housing: eHousing, total: employeeTotal },
        total_cost: base + companyTotal,
      });
    }
    case "calc_personal_tax": {
      const salary = n(p.salary, n(p.base_salary, 8000));
      const deductions = Math.round(salary * 0.225 * 100) / 100;
      const taxable = Math.max(0, salary - deductions - 5000);
      let tax = 0;
      if (taxable <= 3000) tax = taxable * 0.03;
      else if (taxable <= 12000) tax = taxable * 0.1 - 210;
      else if (taxable <= 25000) tax = taxable * 0.2 - 1410;
      else if (taxable <= 35000) tax = taxable * 0.25 - 2660;
      else if (taxable <= 55000) tax = taxable * 0.3 - 4410;
      else if (taxable <= 80000) tax = taxable * 0.35 - 7160;
      else tax = taxable * 0.45 - 15160;
      return JSON.stringify({ salary, deductions, threshold: 5000, taxable_income: taxable, personal_tax: Math.max(0, Math.round(tax * 100) / 100) });
    }
    case "payroll_summary": {
      const { rows } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1 AND status = 'active'", [cid]);
      const totalSalary = (rows as { salary: number }[]).reduce((s, r) => s + (Number(r.salary) || 0), 0);
      return JSON.stringify({ employee_count: rows.length, total_salary: totalSalary, avg_salary: rows.length > 0 ? Math.round(totalSalary / rows.length) : 0 });
    }
    case "attendance_report": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const { rows } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1 AND status = 'active'", [cid]);
      const workDays = n(p.work_days, 22);
      const report = (rows as any[]).map(e => ({
        name: e.name, position: e.role,
        work_days: workDays, actual_days: workDays, overtime_hours: 0, leave_days: 0, late_count: 0,
        status: "正常",
      }));
      return JSON.stringify({ month, total_employees: rows.length, standard_work_days: workDays, attendance: report, note: "此为基础模板，请根据实际打卡数据更新各员工考勤" });
    }
    case "payroll_calc": {
      const { rows } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1 AND status = 'active'", [cid]);
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const payroll = (rows as any[]).map(e => {
        const base = Number(e.salary) || 0;
        const siBase = base;
        const ePension = Math.round(siBase * 0.08 * 100) / 100;
        const eMedical = Math.round(siBase * 0.02 * 100) / 100;
        const eUnemploy = Math.round(siBase * 0.005 * 100) / 100;
        const eHousing = Math.round(siBase * 0.12 * 100) / 100;
        const siTotal = ePension + eMedical + eUnemploy + eHousing;
        const taxable = Math.max(0, base - siTotal - 5000);
        let tax = 0;
        if (taxable <= 3000) tax = taxable * 0.03;
        else if (taxable <= 12000) tax = taxable * 0.1 - 210;
        else if (taxable <= 25000) tax = taxable * 0.2 - 1410;
        else if (taxable <= 35000) tax = taxable * 0.25 - 2660;
        else if (taxable <= 55000) tax = taxable * 0.3 - 4410;
        else if (taxable <= 80000) tax = taxable * 0.35 - 7160;
        else tax = taxable * 0.45 - 15160;
        tax = Math.max(0, Math.round(tax * 100) / 100);
        const netPay = Math.round((base - siTotal - tax + n(p.bonus)) * 100) / 100;
        return { name: e.name, position: e.role, base_salary: base, social_insurance: siTotal, personal_tax: tax, bonus: n(p.bonus), deduction: n(p.deduction), net_pay: netPay };
      });
      const totalNet = payroll.reduce((s, r) => s + r.net_pay, 0);
      const totalBase = payroll.reduce((s, r) => s + r.base_salary, 0);
      return JSON.stringify({ month, employee_count: payroll.length, total_base_salary: totalBase, total_net_pay: Math.round(totalNet * 100) / 100, payroll, note: "薪资条初稿，请人工复核确认后发放" });
    }
    case "social_insurance_report": {
      const { rows } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1 AND status = 'active'", [cid]);
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      let companyTotal = 0, employeeTotal = 0;
      const details = (rows as any[]).map(e => {
        const base = Number(e.salary) || 0;
        const cPart = Math.round(base * (0.16 + 0.095 + 0.005 + 0.004 + 0.12) * 100) / 100;
        const ePart = Math.round(base * (0.08 + 0.02 + 0.005 + 0.12) * 100) / 100;
        companyTotal += cPart; employeeTotal += ePart;
        return { name: e.name, base, company_part: cPart, employee_part: ePart, total: Math.round((cPart + ePart) * 100) / 100 };
      });
      return JSON.stringify({ month, headcount: rows.length, company_total: Math.round(companyTotal * 100) / 100, employee_total: Math.round(employeeTotal * 100) / 100, grand_total: Math.round((companyTotal + employeeTotal) * 100) / 100, details, deadline: `${month}-10`, note: "请于截止日前登录社保公积金官网完成申报" });
    }
    case "recruitment_plan": {
      return JSON.stringify({
        plan: {
          job_title: s(p.job_title, "待定岗位"), headcount: n(p.headcount, 1), priority: "中",
          channels: ["Boss直聘", "拉勾", "猎聘", "内推"],
          timeline: { jd_publish: "第1周", resume_screen: "第1-2周", interview: "第2-3周", offer: "第3-4周" },
          budget_estimate: "招聘渠道费用 + 面试成本",
        },
        checklist: ["1. 编写JD（岗位职责+任职要求）", "2. 发布招聘信息", "3. 简历筛选（AI初筛+HR复核）", "4. 安排面试（电话→技术→终面）", "5. 薪酬谈判与发放offer", "6. 入职准备"],
        note: "AI已生成招聘计划模板，请根据实际需求调整",
      });
    }
    case "training_plan": {
      return JSON.stringify({
        plan: {
          topic: s(p.training_topic, "待定主题"), date: s(p.training_date, "待定"), target_attendees: n(p.attendees, 0),
          format: "线上+线下混合", duration: "2小时",
          outline: ["1. 培训目标与背景", "2. 核心内容讲解", "3. 案例分析与讨论", "4. 实操演练", "5. Q&A与总结"],
        },
        checklist: ["1. 确认讲师（内部/外部）", "2. 准备培训材料（PPT/讲义）", "3. 发送培训通知（提前3个工作日）", "4. 布置场地/测试线上平台", "5. 培训执行与签到", "6. 培训反馈收集（培训后3日内）", "7. 效果评估与资料归档"],
        note: "AI已生成培训计划模板，请根据实际需求调整",
      });
    }
    case "hr_monthly_report": {
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const { rows: emps } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1", [cid]);
      const active = (emps as any[]).filter(e => e.status === "active");
      const totalSalary = active.reduce((s, r) => s + (Number(r.salary) || 0), 0);
      return JSON.stringify({
        month, report: {
          total_employees: emps.length, active_employees: active.length,
          total_salary_budget: totalSalary, avg_salary: active.length > 0 ? Math.round(totalSalary / active.length) : 0,
          turnover_rate: "需根据实际离职数据计算",
          key_metrics: { attendance_rate: "待考勤数据导入", training_participation: "待培训记录", social_insurance_compliance: "100%（目标）" },
          action_items: ["1. 完成考勤核算确认", "2. 薪资条审核与发放", "3. 社保公积金申报", "4. 员工变动手续办理", "5. 月度人事总结撰写"],
        },
        note: "月度人事报表初稿，请结合实际数据完善",
      });
    }
    case "employee_change_report": {
      const { rows: emps } = await db.query("SELECT * FROM opc_employees WHERE company_id = $1 ORDER BY hire_date DESC", [cid]);
      const month = s(p.month, new Date().toISOString().slice(0, 7));
      const active = (emps as any[]).filter(e => e.status === "active");
      const onLeave = (emps as any[]).filter(e => e.status === "on_leave");
      const left = (emps as any[]).filter(e => e.status === "resigned" || e.status === "terminated");
      return JSON.stringify({ month, total: emps.length, active: active.length, on_leave: onLeave.length, resigned: left.length, roster: emps.map((e: any) => ({ name: e.name, role: e.role, status: e.status, hire_date: e.hire_date })) });
    }
    case "onboarding_checklist": {
      return JSON.stringify({
        employee_name: s(p.employee_name, "新员工"),
        checklist: [
          { step: "签订劳动合同", responsible: "HR", deadline: "入职当天", status: "pending" },
          { step: "录入员工信息系统", responsible: "HR", deadline: "入职当天", status: "pending" },
          { step: "讲解公司制度与文化", responsible: "HR", deadline: "入职第1天", status: "pending" },
          { step: "领取办公设备与物品", responsible: "行政", deadline: "入职第1天", status: "pending" },
          { step: "开通企业邮箱/IM账号", responsible: "IT", deadline: "入职前1天", status: "pending" },
          { step: "安排导师/伙伴", responsible: "部门主管", deadline: "入职第1天", status: "pending" },
          { step: "社保公积金开户登记", responsible: "HR", deadline: "入职后5个工作日", status: "pending" },
          { step: "试用期考核目标确认", responsible: "部门主管", deadline: "入职第1周", status: "pending" },
        ],
        note: "请逐项确认完成，确保新员工顺利入职",
      });
    }
    case "offboarding_checklist": {
      return JSON.stringify({
        employee_name: s(p.employee_name, "离职员工"),
        checklist: [
          { step: "离职面谈记录", responsible: "HR", deadline: "提出离职后3日内", status: "pending" },
          { step: "工作交接清单确认", responsible: "部门主管", deadline: "最后工作日前5日", status: "pending" },
          { step: "结清薪资与报销", responsible: "财务", deadline: "最后工作日", status: "pending" },
          { step: "收回办公设备与门禁卡", responsible: "行政", deadline: "最后工作日", status: "pending" },
          { step: "关闭系统账号", responsible: "IT", deadline: "最后工作日", status: "pending" },
          { step: "社保公积金停缴", responsible: "HR", deadline: "次月申报前", status: "pending" },
          { step: "开具离职证明", responsible: "HR", deadline: "最后工作日", status: "pending" },
          { step: "竞业限制确认（如适用）", responsible: "法务", deadline: "最后工作日", status: "pending" },
          { step: "档案转移/归档", responsible: "HR", deadline: "离职后15日内", status: "pending" },
        ],
        note: "请逐项确认完成，确保离职手续合规完整",
      });
    }
    default:
      return JSON.stringify({ error: `opc_hr: 未知 action '${action}'` });
  }
}

// ─── opc_project ──────────────────────────────────────────────────────

async function execOpcProject(p: Record<string, unknown>, db: Db, cid: string): Promise<string> {
  const action = String(p.action);

  switch (action) {
    case "create_project": {
      const id = uuid();
      await db.query(
        "INSERT INTO opc_projects (id,company_id,name,description,status,budget,spent,start_date,end_date,document,created_at) VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,NOW())",
        [id, cid, s(p.name), s(p.description), "planning", n(p.budget), s(p.start_date), s(p.end_date), s(p.document)],
      );
      const { rows } = await db.query("SELECT * FROM opc_projects WHERE id = $1", [id]);
      return JSON.stringify({ success: true, project: rows[0] });
    }
    case "list_projects": {
      const { rows } = await db.query("SELECT * FROM opc_projects WHERE company_id = $1 ORDER BY created_at DESC", [cid]);
      return JSON.stringify({ projects: rows, count: rows.length });
    }
    case "update_project": {
      const sets: string[] = []; const vals: unknown[] = []; let idx = 1;
      for (const f of ["name", "description", "status", "start_date", "end_date", "document"]) {
        if (p[f] !== undefined) { sets.push(`${f} = $${idx++}`); vals.push(String(p[f])); }
      }
      if (p.budget !== undefined) { sets.push(`budget = $${idx++}`); vals.push(n(p.budget)); }
      if (sets.length === 0) return JSON.stringify({ error: "无更新字段" });
      vals.push(String(p.project_id));
      await db.query(`UPDATE opc_projects SET ${sets.join(",")} WHERE id = $${idx}`, vals);
      return JSON.stringify({ success: true });
    }
    case "add_task": {
      const id = uuid();
      await db.query(
        "INSERT INTO opc_projects (id,company_id,name,description,status,budget,spent,start_date,end_date,created_at) VALUES ($1,$2,$3,$4,$5,0,0,'','',NOW())",
        [id, cid, s(p.title, "任务"), s(p.description), s(p.status, "todo")],
      );
      return JSON.stringify({ success: true, task_id: id });
    }
    case "list_tasks": {
      const { rows } = await db.query("SELECT * FROM opc_projects WHERE company_id = $1 AND budget = 0 ORDER BY created_at DESC LIMIT 50", [cid]);
      return JSON.stringify({ tasks: rows });
    }
    case "update_task": {
      const sets: string[] = []; const vals: unknown[] = []; let idx = 1;
      if (p.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(String(p.status)); }
      if (p.title !== undefined) { sets.push(`name = $${idx++}`); vals.push(String(p.title)); }
      if (sets.length === 0) return JSON.stringify({ error: "无更新字段" });
      vals.push(String(p.task_id));
      await db.query(`UPDATE opc_projects SET ${sets.join(",")} WHERE id = $${idx}`, vals);
      return JSON.stringify({ success: true });
    }
    case "project_summary": {
      const { rows: projects } = await db.query("SELECT * FROM opc_projects WHERE company_id = $1 AND budget > 0", [cid]);
      const total = projects.length;
      const active = projects.filter((p: any) => p.status === "active" || p.status === "in_progress").length;
      const totalBudget = projects.reduce((s: number, r: any) => s + Number(r.budget), 0);
      const totalSpent = projects.reduce((s: number, r: any) => s + Number(r.spent), 0);
      return JSON.stringify({ total_projects: total, active_projects: active, total_budget: totalBudget, total_spent: totalSpent });
    }
    case "kanban": {
      const { rows } = await db.query("SELECT status, COUNT(*) as cnt FROM opc_projects WHERE company_id = $1 GROUP BY status", [cid]);
      return JSON.stringify({ kanban: rows });
    }
    default:
      return JSON.stringify({ error: `opc_project: 未知 action '${action}'` });
  }
}

// ─── opc_search ──────────────────────────────────────────────────────

async function execOpcSearch(p: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
      return execHybridSearchReadOnly(p, { apiKey: UAPI_KEY, apiUrl: UAPI_URL }, { signal });
}

// ─── opc_email ───────────────────────────────────────────────────────

async function execOpcEmail(p: Record<string, unknown>): Promise<string> {
  return execOpcEmailReadOnly(p, {
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_USER,
    pass: SMTP_PASS,
  });
}

// ─── opc_report ──────────────────────────────────────────────────────

async function execOpcReport(p: Record<string, unknown>, db: Db, cid: string, signal?: AbortSignal): Promise<string> {
  return execOpcReportReadOnly(p, db, cid, { apiKey: UAPI_KEY, apiUrl: UAPI_URL }, { signal });
}

// ─── opc_document ────────────────────────────────────────────────────

async function execOpcDocument(p: Record<string, unknown>, db: Db, cid: string): Promise<string> {
  console.log("[opc_document] args keys:", Object.keys(p), "title:", p.title, "content length:", typeof p.content === "string" ? p.content.length : "N/A", "cid:", cid);
  const docType = s(p.doc_type, "custom");
  const title = s(p.title, "未命名文档");
  const content = s(p.content);
  if (!content) {
    console.warn("[opc_document] content is empty, returning instruction to output directly");
    return JSON.stringify({
      success: true,
      note: `请直接在回复中以 Markdown 格式输出「${title}」的完整内容。用户可以通过页面"导出为文档"按钮导出。`,
      instruction: "content参数为空，请在你的回复中直接输出完整的文档正文内容，格式为Markdown。",
    });
  }

  const id = uuid();
  const docTypeMap: Record<string, string> = {
    business_plan: "商业计划书", contract_template: "合同模板", marketing_plan: "营销方案",
    meeting_minutes: "会议纪要", weekly_report: "工作周报", monthly_report: "工作月报",
    prd: "产品需求文档", proposal: "项目方案书", letter: "商务信函", notice: "通知公告", custom: "自定义文档",
  };

  let saved = false;
  let exportUrl = "";

  try {
    await db.query(
      "INSERT INTO opc_projects (id,company_id,name,description,status,budget,spent,start_date,end_date,document,created_at) VALUES ($1,$2,$3,$4,$5,0,0,'','', $6, NOW())",
      [id, cid || null, `[文档] ${title}`, `类型: ${docTypeMap[docType] || docType}`, "completed", content],
    );
    saved = true;
    exportUrl = `/api/projects/${id}/export`;
  } catch (dbErr: unknown) {
    console.error("[opc_document] DB insert failed, returning content directly:", (dbErr as Error).message);
  }

  return JSON.stringify({
    success: true,
    document_id: saved ? id : undefined,
    doc_type: docTypeMap[docType] || docType,
    title,
    content_length: content.length,
    export_url: exportUrl || undefined,
    note: saved
      ? `文档「${title}」已生成并保存（${content.length} 字）。【重要】不要在回复中重复输出文档内容，只需告知用户文档已生成，并提供导出按钮。`
      : `文档「${title}」已生成（${content.length} 字）。【重要】不要在回复中重复输出文档内容。`,
  });
}

// ─── opc_schedule ────────────────────────────────────────────────────

async function execOpcSchedule(p: Record<string, unknown>, db: Db, cid: string, userId: string): Promise<string> {
  const action = s(p.action);

  switch (action) {
    case "add_todo": {
      const id = uuid();
      await db.query(
        "INSERT INTO opc_todos (id,company_id,title,priority,category,due_date,description,completed,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,0,NOW())",
        [id, cid, s(p.title), s(p.priority, "medium"), s(p.category), s(p.due_date), s(p.description)],
      );
      const { rows } = await db.query("SELECT * FROM opc_todos WHERE id = $1", [id]);
      return JSON.stringify({ success: true, todo: rows[0] });
    }
    case "list_todos": {
      const { rows } = await db.query(
        "SELECT * FROM opc_todos WHERE company_id = $1 AND completed = 0 ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC",
        [cid],
      );
      return JSON.stringify({ success: true, todos: rows, count: rows.length });
    }
    case "complete_todo": {
      await db.query("UPDATE opc_todos SET completed = 1 WHERE id = $1 AND company_id = $2", [s(p.todo_id), cid]);
      return JSON.stringify({ success: true, note: "待办已标记完成" });
    }
    case "delete_todo": {
      await db.query("DELETE FROM opc_todos WHERE id = $1 AND company_id = $2", [s(p.todo_id), cid]);
      return JSON.stringify({ success: true });
    }
    case "today_agenda": {
      const today = new Date().toISOString().slice(0, 10);
      const { rows: todos } = await db.query(
        "SELECT * FROM opc_todos WHERE company_id = $1 AND completed = 0 AND due_date <= $2 ORDER BY priority, due_date",
        [cid, today],
      );
      const { rows: followUps } = await db.query(
        "SELECT name, follow_up_date, notes FROM opc_contacts WHERE company_id = $1 AND follow_up_date = $2 AND pipeline_stage NOT IN ('won','lost','churned')",
        [cid, today],
      );
      const { rows: contracts } = await db.query(
        "SELECT title, end_date FROM opc_contracts WHERE company_id = $1 AND end_date != '' AND end_date <= $2 AND status NOT IN ('completed','cancelled')",
        [cid, today],
      );
      const { rows: events } = await db.query(
        "SELECT id, title, start_time, end_time, location, category, status FROM opc_schedules WHERE user_id = $1 AND date = $2 AND status != 'cancelled' ORDER BY start_time",
        [userId, today],
      );
      return JSON.stringify({
        success: true,
        date: today,
        pending_todos: todos,
        client_follow_ups: followUps,
        expiring_contracts: contracts,
        today_events: events,
        summary: `今日待办 ${todos.length} 项，日程 ${events.length} 个，客户跟进 ${followUps.length} 项，合同到期 ${contracts.length} 份`,
      });
    }
    case "upcoming": {
      const today = new Date().toISOString().slice(0, 10);
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const { rows: todos } = await db.query(
        "SELECT * FROM opc_todos WHERE company_id = $1 AND completed = 0 AND due_date BETWEEN $2 AND $3 ORDER BY due_date, priority",
        [cid, today, nextWeek],
      );
      const { rows: events } = await db.query(
        "SELECT id, title, date, start_time, end_time, location, category, status FROM opc_schedules WHERE user_id = $1 AND date BETWEEN $2 AND $3 AND status != 'cancelled' ORDER BY date, start_time",
        [userId, today, nextWeek],
      );
      return JSON.stringify({ success: true, upcoming_todos: todos, upcoming_events: events, period: `${today} ~ ${nextWeek}` });
    }
    case "add_event": {
      const date = s(p.date);
      const title = s(p.title);
      console.log("[opc_schedule add_event]", { userId, date, title, start_time: s(p.start_time) });
      if (!date || !title) return JSON.stringify({ error: "日程需要 date 和 title" });
      const id = uuid();
      await db.query(
        `INSERT INTO opc_schedules (id, user_id, company_id, title, date, start_time, end_time, location, description, category, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled')`,
        [id, userId, cid, title, date, s(p.start_time), s(p.end_time), s(p.location), s(p.description), s(p.category, "work")],
      );
      const { rows } = await db.query("SELECT * FROM opc_schedules WHERE id = $1", [id]);
      return JSON.stringify({ success: true, event: rows[0], note: `日程「${title}」已创建` });
    }
    case "list_events": {
      const date = s(p.date);
      let rows;
      if (date) {
        ({ rows } = await db.query(
          "SELECT * FROM opc_schedules WHERE user_id = $1 AND date = $2 AND status != 'cancelled' ORDER BY start_time",
          [userId, date],
        ));
      } else {
        const today = new Date().toISOString().slice(0, 10);
        const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        ({ rows } = await db.query(
          "SELECT * FROM opc_schedules WHERE user_id = $1 AND date BETWEEN $2 AND $3 AND status != 'cancelled' ORDER BY date, start_time",
          [userId, today, nextWeek],
        ));
      }
      return JSON.stringify({ success: true, events: rows, count: rows.length });
    }
    case "update_event": {
      const eventId = s(p.event_id);
      if (!eventId) return JSON.stringify({ error: "需要 event_id" });
      const updates: string[] = [];
      const vals: unknown[] = [];
      let idx = 1;
      for (const key of ["title", "date", "start_time", "end_time", "location", "description", "category", "status"] as const) {
        if (p[key] !== undefined) { updates.push(`${key} = $${idx++}`); vals.push(s(p[key] as string)); }
      }
      if (updates.length === 0) return JSON.stringify({ error: "没有需要更新的字段" });
      vals.push(eventId, userId);
      await db.query(`UPDATE opc_schedules SET ${updates.join(", ")} WHERE id = $${idx++} AND user_id = $${idx}`, vals);
      const { rows } = await db.query("SELECT * FROM opc_schedules WHERE id = $1", [eventId]);
      return JSON.stringify({ success: true, event: rows[0] });
    }
    case "delete_event": {
      const eventId = s(p.event_id);
      if (!eventId) return JSON.stringify({ error: "需要 event_id" });
      await db.query("DELETE FROM opc_schedules WHERE id = $1 AND user_id = $2", [eventId, userId]);
      return JSON.stringify({ success: true, note: "日程已删除" });
    }
    case "check_availability": {
      const date = s(p.date);
      if (!date) return JSON.stringify({ error: "需要 date" });
      const { rows } = await db.query(
        "SELECT id, title, start_time, end_time, location, category FROM opc_schedules WHERE user_id = $1 AND date = $2 AND status = 'scheduled' ORDER BY start_time",
        [userId, date],
      );
      const startTime = s(p.start_time);
      const endTime = s(p.end_time);
      let conflicts: typeof rows = [];
      if (startTime && endTime) {
        conflicts = rows.filter((e: any) => {
          if (!e.start_time || !e.end_time) return true; // all-day events always conflict
          return e.start_time < endTime && e.end_time > startTime;
        });
      }
      return JSON.stringify({
        success: true,
        date,
        existing_events: rows,
        conflicts,
        available: conflicts.length === 0,
        summary: rows.length === 0 ? `${date} 全天空闲` : `${date} 已有 ${rows.length} 个日程` + (conflicts.length > 0 ? `，其中 ${conflicts.length} 个时间冲突` : ""),
      });
    }
    default:
      return JSON.stringify({ error: `opc_schedule: 未知 action '${action}'` });
  }
}

// ─── opc_data_analysis ───────────────────────────────────────────────

async function execOpcDataAnalysis(p: Record<string, unknown>, db: Db, cid: string): Promise<string> {
  const action = s(p.action);
  const months = n(p.months, 6);

  switch (action) {
    case "revenue_trend": {
      const { rows } = await db.query(
        `SELECT TO_CHAR(transaction_date::date, 'YYYY-MM') as month, type, SUM(amount) as total, COUNT(*) as cnt
         FROM opc_transactions WHERE company_id = $1 AND transaction_date >= NOW() - INTERVAL '${months} months'
         GROUP BY month, type ORDER BY month`,
        [cid],
      );
      const byMonth: Record<string, { income: number; expense: number; net: number }> = {};
      for (const r of rows as any[]) {
        if (!byMonth[r.month]) byMonth[r.month] = { income: 0, expense: 0, net: 0 };
        const amt = Number(r.total) || 0;
        if (r.type === "income") byMonth[r.month].income = amt;
        else byMonth[r.month].expense = amt;
        byMonth[r.month].net = byMonth[r.month].income - byMonth[r.month].expense;
      }
      const trend = Object.entries(byMonth).map(([month, d]) => ({ month, ...d }));
      return JSON.stringify({ success: true, analysis: "revenue_trend", months, trend, insight: trend.length >= 2 ? `近${trend.length}个月数据，请分析趋势走向` : "数据不足，建议积累更多月度数据" });
    }
    case "expense_breakdown": {
      const period = s(p.period, new Date().toISOString().slice(0, 7));
      const { rows } = await db.query(
        "SELECT category, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 AND type = 'expense' AND transaction_date LIKE $2 GROUP BY category ORDER BY total DESC",
        [cid, `${period}%`],
      );
      const total = (rows as any[]).reduce((s, r) => s + (Number(r.total) || 0), 0);
      const breakdown = (rows as any[]).map(r => ({
        category: r.category || "未分类",
        amount: Number(r.total) || 0,
        percentage: total > 0 ? Math.round((Number(r.total) || 0) / total * 10000) / 100 : 0,
        count: Number(r.cnt),
      }));
      return JSON.stringify({ success: true, analysis: "expense_breakdown", period, total_expense: total, breakdown });
    }
    case "client_conversion": {
      const { rows } = await db.query(
        "SELECT pipeline_stage, COUNT(*) as cnt, COALESCE(SUM(deal_value),0) as val FROM opc_contacts WHERE company_id = $1 GROUP BY pipeline_stage",
        [cid],
      );
      const total = (rows as any[]).reduce((s, r) => s + Number(r.cnt), 0);
      const won = (rows as any[]).find((r: any) => r.pipeline_stage === "won");
      const convRate = total > 0 && won ? Math.round(Number(won.cnt) / total * 10000) / 100 : 0;
      return JSON.stringify({
        success: true, analysis: "client_conversion", total_leads: total, conversion_rate: convRate,
        funnel: (rows as any[]).map(r => ({ stage: r.pipeline_stage, count: Number(r.cnt), value: Number(r.val) })),
      });
    }
    case "monthly_comparison": {
      const thisMonth = new Date().toISOString().slice(0, 7);
      const lastDate = new Date(); lastDate.setMonth(lastDate.getMonth() - 1);
      const lastMonth = lastDate.toISOString().slice(0, 7);

      const getData = async (period: string) => {
        const { rows } = await db.query(
          "SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id = $1 AND transaction_date LIKE $2 GROUP BY type",
          [cid, `${period}%`],
        );
        let income = 0, expense = 0;
        for (const r of rows as any[]) { if (r.type === "income") income = Number(r.total) || 0; else expense = Number(r.total) || 0; }
        return { income, expense, net: income - expense };
      };

      const current = await getData(thisMonth);
      const previous = await getData(lastMonth);
      const incomeGrowth = previous.income > 0 ? Math.round((current.income - previous.income) / previous.income * 10000) / 100 : 0;
      const expenseGrowth = previous.expense > 0 ? Math.round((current.expense - previous.expense) / previous.expense * 10000) / 100 : 0;

      return JSON.stringify({
        success: true, analysis: "monthly_comparison",
        current_month: { period: thisMonth, ...current },
        previous_month: { period: lastMonth, ...previous },
        growth: { income_growth: incomeGrowth, expense_growth: expenseGrowth },
      });
    }
    case "cash_runway": {
      const { rows: fin } = await db.query(
        "SELECT type, SUM(amount) as total FROM opc_transactions WHERE company_id = $1 GROUP BY type",
        [cid],
      );
      let totalIncome = 0, totalExpense = 0;
      for (const r of fin as any[]) { if (r.type === "income") totalIncome = Number(r.total) || 0; else totalExpense = Number(r.total) || 0; }
      const balance = totalIncome - totalExpense;

      const { rows: recent } = await db.query(
        "SELECT SUM(amount) as total FROM opc_transactions WHERE company_id = $1 AND type = 'expense' AND transaction_date >= NOW() - INTERVAL '3 months'",
        [cid],
      );
      const avgMonthlyBurn = Math.round((Number(recent[0]?.total || 0)) / 3);
      const runwayMonths = avgMonthlyBurn > 0 ? Math.round(balance / avgMonthlyBurn * 10) / 10 : -1;

      return JSON.stringify({
        success: true, analysis: "cash_runway",
        current_balance: balance,
        avg_monthly_burn: avgMonthlyBurn,
        runway_months: runwayMonths,
        risk_level: runwayMonths < 3 ? "高风险" : runwayMonths < 6 ? "中风险" : "安全",
      });
    }
    case "growth_rate": {
      const { rows } = await db.query(
        `SELECT TO_CHAR(transaction_date::date, 'YYYY-MM') as month, SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as income
         FROM opc_transactions WHERE company_id = $1 AND transaction_date >= NOW() - INTERVAL '${months} months'
         GROUP BY month ORDER BY month`,
        [cid],
      );
      const monthlyIncome = (rows as any[]).map(r => ({ month: r.month, income: Number(r.income) || 0 }));
      const growthRates = [];
      for (let i = 1; i < monthlyIncome.length; i++) {
        const prev = monthlyIncome[i - 1].income;
        const curr = monthlyIncome[i].income;
        growthRates.push({
          month: monthlyIncome[i].month,
          income: curr,
          growth: prev > 0 ? Math.round((curr - prev) / prev * 10000) / 100 : 0,
        });
      }
      return JSON.stringify({ success: true, analysis: "growth_rate", data: growthRates });
    }
    case "kpi_dashboard": {
      const { rows: fin } = await db.query("SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 GROUP BY type", [cid]);
      const { rows: contacts } = await db.query("SELECT COUNT(*) as c FROM opc_contacts WHERE company_id = $1", [cid]);
      const { rows: projects } = await db.query("SELECT COUNT(*) as c, SUM(CASE WHEN status IN ('active','in_progress') THEN 1 ELSE 0 END) as active FROM opc_projects WHERE company_id = $1 AND budget > 0", [cid]);
      const { rows: employees } = await db.query("SELECT COUNT(*) as c, SUM(salary) as total_salary FROM opc_employees WHERE company_id = $1 AND status = 'active'", [cid]);
      const { rows: contracts } = await db.query("SELECT COUNT(*) as c, SUM(value) as v FROM opc_contracts WHERE company_id = $1", [cid]);

      let income = 0, expense = 0;
      for (const r of fin as any[]) { if (r.type === "income") income = Number(r.total) || 0; else expense = Number(r.total) || 0; }

      return JSON.stringify({
        success: true, analysis: "kpi_dashboard",
        kpis: {
          total_revenue: income, total_expense: expense, net_profit: income - expense,
          profit_margin: income > 0 ? Math.round((income - expense) / income * 10000) / 100 : 0,
          total_contacts: Number(contacts[0]?.c || 0),
          total_projects: Number(projects[0]?.c || 0), active_projects: Number(projects[0]?.active || 0),
          total_employees: Number(employees[0]?.c || 0), total_salary_cost: Number(employees[0]?.total_salary || 0),
          total_contracts: Number(contracts[0]?.c || 0), contract_value: Number(contracts[0]?.v || 0),
        },
      });
    }
    default:
      return JSON.stringify({ error: `opc_data_analysis: 未知 action '${action}'` });
  }
}

// ─── opc_webpage ─────────────────────────────────────────────────────

async function execOpcWebpage(p: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return execOpcWebpageReadOnly(p, { signal });
}

// ─── opc_video ───────────────────────────────────────────────────────

async function execOpcVideo(p: Record<string, unknown>, _db: Db, _cid: string, userId?: string): Promise<string> {
  return execOpcVideoIsolated(p, _db, userId);
}

// ─── opc_cron ─────────────────────────────────────────────────────────

async function execOpcCron(p: Record<string, unknown>, db: Db, _cid: string, userId: string): Promise<string> {
  const action = s(p.action);

  switch (action) {
    case "create": {
      const taskType = s(p.task_type, "notify");
      if (!["email", "notify", "both"].includes(taskType)) {
        return JSON.stringify({ error: "task_type 须为 email / notify / both" });
      }

      let runAt: Date | null = null;
      const cronExpr: string | null = s(p.cron_expr) || null;

      if (!cronExpr) {
        // 一次性任务
        if (p.delay_minutes !== undefined && p.delay_minutes !== null && s(p.delay_minutes) !== "") {
          const mins = n(p.delay_minutes, 0);
          if (mins <= 0) return JSON.stringify({ error: "delay_minutes 须大于 0" });
          runAt = new Date(Date.now() + mins * 60 * 1000);
        } else if (p.run_at) {
          runAt = new Date(s(p.run_at));
          if (isNaN(runAt.getTime())) return JSON.stringify({ error: "run_at 时间格式无效" });
        } else {
          return JSON.stringify({ error: "一次性任务须提供 delay_minutes 或 run_at；周期任务须提供 cron_expr" });
        }
      }

      const payload: Record<string, string> = {};
      if (taskType === "email" || taskType === "both") {
        payload.to = s(p.to_email);
        payload.subject = s(p.subject);
        payload.body = s(p.body);
        if (!payload.to || !payload.subject || !payload.body) {
          return JSON.stringify({ error: "邮件任务须填写 to_email / subject / body" });
        }
      }
      if (taskType === "notify" || taskType === "both") {
        payload.notify_message = s(p.notify_message);
        if (!payload.notify_message) return JSON.stringify({ error: "notify 任务须填写 notify_message" });
      }

      const id = uuid();
      const companyId = s(p.company_id) || null;
      const maxRuns = p.max_runs != null && s(p.max_runs) !== "" ? n(p.max_runs) : null;

      await db.query(
        `INSERT INTO opc_scheduled_tasks
         (id, user_id, company_id, name, task_type, cron_expr, run_at, payload, status, run_count, max_runs, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,$9,NOW())`,
        [id, userId, companyId, s(p.name, "定时任务"), taskType, cronExpr, runAt?.toISOString() ?? null, JSON.stringify(payload), maxRuns],
      );

      const { rows } = await db.query("SELECT * FROM opc_scheduled_tasks WHERE id = $1", [id]);

      // 一次性任务自动同步到日历（opc_schedules）
      if (runAt) {
        try {
          const eventDate = runAt.toISOString().slice(0, 10);
          const eventTime = runAt.toTimeString().slice(0, 5); // HH:mm
          const eventTitle = s(p.name, "待处理事项");
          const eventDesc = s(p.notify_message) || s(p.subject) || "";
          console.log("[opc_cron→calendar sync]", { userId, eventTitle, eventDate, eventTime });
          await db.query(
            `INSERT INTO opc_schedules (id, user_id, company_id, title, date, start_time, end_time, location, description, category, status)
             VALUES ($1,$2,$3,$4,$5,$6,'','',  $7,'work','scheduled')`,
            [uuid(), userId, companyId || "", eventTitle, eventDate, eventTime, eventDesc],
          );
          console.log("[opc_cron→calendar sync] OK");
        } catch (syncErr: unknown) {
          console.error("[opc_cron→calendar sync] FAILED:", (syncErr as Error).message);
        }
      } else {
        console.log("[opc_cron] runAt is null (periodic task), skipping calendar sync");
      }

      return JSON.stringify({
        success: true,
        task: rows[0],
        note: runAt
          ? `任务已创建，将于 ${runAt.toLocaleString("zh-CN")} 执行，已同步到日历`
          : `周期任务已创建，cron: ${cronExpr}`,
      });
    }

    case "list": {
      const { rows } = await db.query(
        "SELECT * FROM opc_scheduled_tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30",
        [userId],
      );
      return JSON.stringify({ success: true, tasks: rows, count: rows.length });
    }

    case "cancel": {
      const taskId = s(p.task_id);
      if (!taskId) return JSON.stringify({ error: "须提供 task_id" });
      const { rows } = await db.query(
        "SELECT id, status FROM opc_scheduled_tasks WHERE id = $1 AND user_id = $2",
        [taskId, userId],
      );
      if (!rows[0]) return JSON.stringify({ error: "任务不存在或无权操作" });
      if (rows[0].status === "cancelled") return JSON.stringify({ error: "任务已取消" });
      await db.query(
        "UPDATE opc_scheduled_tasks SET status = 'cancelled' WHERE id = $1",
        [taskId],
      );
      cancelJob(taskId);
      return JSON.stringify({ success: true, note: "任务已取消" });
    }

    case "run_now": {
      const taskId = s(p.task_id);
      if (!taskId) return JSON.stringify({ error: "须提供 task_id" });
      const { rows } = await db.query(
        "SELECT * FROM opc_scheduled_tasks WHERE id = $1 AND user_id = $2",
        [taskId, userId],
      );
      if (!rows[0]) return JSON.stringify({ error: "任务不存在或无权操作" });
      // 临时设为 pending，让 executeTask 能运行
      await db.query("UPDATE opc_scheduled_tasks SET status = 'pending' WHERE id = $1", [taskId]);
      await executeTask(rows[0]);
      return JSON.stringify({ success: true, note: "任务已立即触发执行" });
    }

    default:
      return JSON.stringify({ error: `opc_cron: 未知 action '${action}'` });
  }
}

// ─── invoke_skill ─────────────────────────────────────────────────────

async function logSkillUsage(
  db: Db,
  payload: {
    userId: string;
    skillName: string;
    category: string;
    task: string;
    status: "success" | "error";
    outputPreview?: string;
  },
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO opc_skill_usage
         (id, user_id, skill_name, category, task, status, output_preview, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        uuid(),
        payload.userId,
        payload.skillName,
        payload.category,
        truncateText(payload.task, 500),
        payload.status,
        truncateText(payload.outputPreview || "", 1500),
      ],
    );
  } catch {
    // skill usage logging should not break the main flow
  }
}

async function execInvokeSkill(p: Record<string, unknown>, db: Db, userId: string, signal?: AbortSignal): Promise<string> {
  const name = s(p.name);
  const task = s(p.task);
  if (!name) return JSON.stringify({ error: "须提供技能名称 name" });
  if (!task) return JSON.stringify({ error: "须提供任务描述 task" });

  const { rows } = await db.query(
    "SELECT name, description, prompt, category FROM opc_skills WHERE user_id = $1 AND name = $2 AND enabled = 1 LIMIT 1",
    [userId, name],
  );
  if (!rows[0]) {
    return JSON.stringify({
      error: `技能「${name}」不存在或未激活`,
      hint: `可调用 find_skills(description="描述你需要的技能") 来搜索或安装合适技能`,
    });
  }

  const skill = rows[0] as { name: string; description: string; prompt: string; category: string };
  const systemPrompt = `${skill.prompt || `你是${skill.name}，${skill.description}。请专业地完成用户交给你的任务。`}

补充硬规则：
- 如果任务需要真实网页、真实公告、真实政策、真实招标信息，你只能基于任务里已提供的链接、正文或明确来源工作
- 如果任务里没有真实链接、没有真实正文、没有可核验来源，不要假装你已经抓取到了内容
- 不要输出“由于无法直接抓取实时动态链接，所以基于经验分析”这类兜底废话
- 信息不足时，明确指出“缺少真实来源/正文，当前只能给搜索建议，不能产出可信结论”
- 不能编造标题、链接、发布日期、金额、甲方、政策条款、招标要求`;

  try {
    const result = await callAi([
      { role: "system", content: systemPrompt },
      { role: "user", content: task },
    ], undefined, undefined, signal);
    const output = result.content || "";
    const suspiciousPhrases = [
      "由于无法直接抓取实时动态链接",
      "基于近期产业重点和常规采购规律",
      "基于经验分析",
      "无法直接抓取",
    ];
    if (suspiciousPhrases.some((phrase) => output.includes(phrase))) {
      await logSkillUsage(db, {
        userId,
        skillName: skill.name,
        category: skill.category,
        task,
        status: "error",
        outputPreview: output,
      });
      return JSON.stringify({
        error: `技能「${skill.name}」未获得真实来源或正文，当前结果不可信，已中止使用`,
        skill: skill.name,
        category: skill.category,
        needs_real_source: true,
      });
    }
    await logSkillUsage(db, {
      userId,
      skillName: skill.name,
      category: skill.category,
      task,
      status: "success",
      outputPreview: output,
    });
    return JSON.stringify({
      skill: skill.name,
      category: skill.category,
      output,
    });
  } catch (e: unknown) {
    await logSkillUsage(db, {
      userId,
      skillName: name,
      category: "unknown",
      task,
      status: "error",
      outputPreview: String((e as Error).message || ""),
    });
    return JSON.stringify({ error: `技能调用失败: ${(e as Error).message}` });
  }
}

// ─── find_skills ──────────────────────────────────────────────────────

async function execFindSkills(p: Record<string, unknown>, db: Db, userId: string): Promise<string> {
  const description = s(p.description);
  if (!description) return JSON.stringify({ error: "须提供技能描述 description" });

  // 1. 关键词匹配内置目录
  const matches = searchCatalog(description);
  let skillToInstall: { name: string; description: string; category: string; prompt: string } | null = null;

  if (matches.length > 0) {
    skillToInstall = matches[0];
  } else {
    // 2. 未命中 → AI 生成新技能
    try {
      const genResult = await callAi([
        {
          role: "system",
          content: `你是技能设计专家。根据用户描述，生成一个专项AI技能的JSON定义。
输出格式（只输出JSON，不要任何解释）：
{
  "name": "技能名称（中文，2-8字）",
  "description": "一句话描述该技能能做什么（不超过30字）",
  "category": "分类（business/content/finance/legal/product/marketing/efficiency 之一）",
  "prompt": "详细的技能系统提示词（200-400字），定义该技能的专业视角、分析框架、输出格式等"
}`,
        },
        { role: "user", content: `请为以下需求设计技能：${description}` },
      ]);

      const jsonMatch = genResult.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          name?: unknown; description?: unknown; category?: unknown; prompt?: unknown;
        };
        if (parsed.name && parsed.prompt) {
          skillToInstall = {
            name: String(parsed.name),
            description: String(parsed.description || ""),
            category: String(parsed.category || "custom"),
            prompt: String(parsed.prompt),
          };
        }
      }
    } catch { /* ignore AI gen error, fall through */ }
  }

  if (!skillToInstall) {
    return JSON.stringify({
      success: false,
      message: "未找到匹配技能，且自动生成失败。请换个描述方式或手动在技能库中创建。",
    });
  }

  // 3. 检查同名不重复，写入数据库
  const { rows: existing } = await db.query(
    "SELECT id FROM opc_skills WHERE user_id = $1 AND name = $2 LIMIT 1",
    [userId, skillToInstall.name],
  );

  if (existing.length > 0) {
    // 已存在则确保 enabled=1
    await db.query(
      "UPDATE opc_skills SET enabled = 1, updated_at = NOW() WHERE user_id = $1 AND name = $2",
      [userId, skillToInstall.name],
    );
    return JSON.stringify({
      success: true,
      installed: false,
      message: `技能「${skillToInstall.name}」已在你的技能库中，已重新激活。`,
      skill: { name: skillToInstall.name, description: skillToInstall.description, category: skillToInstall.category },
      hint: `现在可以调用 invoke_skill(name="${skillToInstall.name}", task="你的具体任务")`,
    });
  }

  const id = uuid();
  await db.query(
    `INSERT INTO opc_skills (id, user_id, name, description, category, prompt, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, NOW(), NOW())`,
    [id, userId, skillToInstall.name, skillToInstall.description, skillToInstall.category, skillToInstall.prompt],
  );

  return JSON.stringify({
    success: true,
    installed: true,
    message: `技能「${skillToInstall.name}」已成功安装并激活！`,
    skill: { name: skillToInstall.name, description: skillToInstall.description, category: skillToInstall.category },
    hint: `现在可以调用 invoke_skill(name="${skillToInstall.name}", task="你的具体任务")`,
  });
}

// ─── setup_email ──────────────────────────────────────────────────────

async function execSetupEmail(p: Record<string, unknown>, db: Db, userId: string): Promise<string> {
  if (!userId) return JSON.stringify({ error: "未登录" });
  const action = s(p.action, "list");

  switch (action) {
    case "save": {
      const email = s(p.email);
      const password = s(p.password);
      if (!email || !password) return JSON.stringify({ error: "email 和 password 为必填项" });

      const detected = detectImapHost(email);
      const imapHost = s(p.imap_host) || detected.imap_host;
      const smtpHost = s(p.smtp_host) || detected.smtp_host;

      if (!imapHost || !smtpHost) {
        return JSON.stringify({ error: "无法自动识别该邮箱的 IMAP/SMTP 地址，请手动填写 imap_host 和 smtp_host" });
      }

      const imapPort = n(p.imap_port, 993);
      const smtpPort = n(p.smtp_port, 465);

      // 测试 IMAP 连接
      const testResult = await testImapConnection({ imap_host: imapHost, imap_port: imapPort, email, password });
      if (!testResult.ok) {
        return JSON.stringify({ error: `IMAP 连接测试失败：${testResult.error}。请检查邮箱授权码或服务器地址` });
      }

      // UPSERT（同一 user_id + email 唯一）
      const { rows: existing } = await db.query(
        "SELECT id FROM opc_email_accounts WHERE user_id = $1 AND email = $2",
        [userId, email]
      );

      if (existing.length > 0) {
        await db.query(
          `UPDATE opc_email_accounts
           SET display_name=$1, imap_host=$2, imap_port=$3, smtp_host=$4, smtp_port=$5,
               password=$6, enabled=true, last_uid=0
           WHERE id=$7`,
          [s(p.display_name) || null, imapHost, imapPort, smtpHost, smtpPort, password, existing[0].id]
        );
        return JSON.stringify({ success: true, message: `邮箱 ${email} 配置已更新，5分钟内开始拉取新邮件`, account_id: existing[0].id });
      } else {
        const id = uuid();
        await db.query(
          `INSERT INTO opc_email_accounts
             (id, user_id, email, display_name, imap_host, imap_port, smtp_host, smtp_port, password, enabled, last_uid, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,0,NOW())`,
          [id, userId, email, s(p.display_name) || null, imapHost, imapPort, smtpHost, smtpPort, password]
        );
        return JSON.stringify({ success: true, message: `邮箱 ${email} 配置成功！系统将每5分钟自动拉取新邮件，AI 会分析来信并通知你。`, account_id: id });
      }
    }

    case "list": {
      const { rows } = await db.query(
        "SELECT id, email, display_name, imap_host, smtp_host, enabled, last_poll, created_at FROM opc_email_accounts WHERE user_id = $1 ORDER BY created_at",
        [userId]
      );
      return JSON.stringify({ accounts: rows, count: rows.length });
    }

    case "remove": {
      const accountId = s(p.account_id);
      if (!accountId) return JSON.stringify({ error: "account_id 为必填项" });
      const { rowCount } = await db.query(
        "DELETE FROM opc_email_accounts WHERE id = $1 AND user_id = $2",
        [accountId, userId]
      );
      return JSON.stringify({ success: (rowCount || 0) > 0, message: (rowCount || 0) > 0 ? "账户已删除" : "账户不存在" });
    }

    case "test": {
      const accountId = s(p.account_id);
      const email = s(p.email);
      let acc: { imap_host: string; imap_port: number; email: string; password: string } | null = null;

      if (accountId) {
        const { rows } = await db.query(
          "SELECT * FROM opc_email_accounts WHERE id = $1 AND user_id = $2",
          [accountId, userId]
        );
        if (!rows[0]) return JSON.stringify({ error: "账户不存在" });
        acc = rows[0] as { imap_host: string; imap_port: number; email: string; password: string };
      } else if (email) {
        acc = {
          imap_host: s(p.imap_host) || detectImapHost(email).imap_host,
          imap_port: n(p.imap_port, 993),
          email,
          password: s(p.password),
        };
      } else {
        return JSON.stringify({ error: "请提供 account_id 或 email" });
      }

      const result = await testImapConnection(acc);
      return JSON.stringify(result.ok ? { success: true, message: "IMAP 连接测试成功" } : { success: false, error: result.error });
    }

    default:
      return JSON.stringify({ error: `setup_email: 未知 action '${action}'` });
  }
}

// ─── read_email ───────────────────────────────────────────────────────

async function execReadEmail(p: Record<string, unknown>, db: Db, userId: string): Promise<string> {
  if (!userId) return JSON.stringify({ error: "未登录" });

  const limit = Math.min(n(p.limit, 10), 50);
  const status = s(p.status, "all");

  let sql = `SELECT id, from_addr, from_name, subject, received_at, ai_summary, ai_action, status
             FROM opc_email_inbox WHERE user_id = $1`;
  const params: unknown[] = [userId];

  if (status !== "all") {
    sql += ` AND status = $2`;
    params.push(status);
  }

  sql += ` ORDER BY received_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await db.query(sql, params);
  return JSON.stringify({ emails: rows, count: rows.length, hint: rows.length === 0 ? "收件箱为空，如尚未配置邮箱请先调用 setup_email" : undefined });
}

// ─── reply_email ──────────────────────────────────────────────────────

async function execReplyEmail(p: Record<string, unknown>, db: Db, userId: string): Promise<string> {
  if (!userId) return JSON.stringify({ error: "未登录" });

  const emailId = s(p.email_id);
  const content = s(p.content);
  if (!emailId || !content) return JSON.stringify({ error: "email_id 和 content 为必填项" });

  const { rows } = await db.query(
    "SELECT * FROM opc_email_inbox WHERE id = $1 AND user_id = $2",
    [emailId, userId]
  );
  if (!rows[0]) return JSON.stringify({ error: "邮件不存在" });

  const email = rows[0] as { account_id: string; from_addr: string; subject: string };

  const { rows: accRows } = await db.query(
    "SELECT * FROM opc_email_accounts WHERE id = $1 AND user_id = $2",
    [email.account_id, userId]
  );
  if (!accRows[0]) return JSON.stringify({ error: "邮件账户不存在，请先配置邮箱" });

  await sendEmailReply(accRows[0] as Parameters<typeof sendEmailReply>[0], email.from_addr, email.subject || "", content);
  await db.query("UPDATE opc_email_inbox SET status = 'replied', is_read = true WHERE id = $1", [emailId]);

  return JSON.stringify({ success: true, message: `回复已发送至 ${email.from_addr}` });
}

// ─── 服务配置（AI 对话调用） ───────────────────────────────────────────

async function execServiceConfig(p: Record<string, unknown>, db: Db): Promise<string> {
  const action = s(p.action);
  const service = s(p.service);
  const validServices = ["email", "feishu", "wecom", "dingtalk", "search"];
  if (!validServices.includes(service)) return JSON.stringify({ error: "未知服务: " + service + "，支持 " + validServices.join("/") });

  if (service === "email") {
    if (action === "get") {
      const { rows } = await db.query("SELECT email, smtp_host, smtp_port, imap_host, imap_port, display_name, password FROM opc_email_accounts WHERE enabled = true ORDER BY created_at LIMIT 1");
      if (rows.length === 0) return JSON.stringify({ service: "email", config: {}, hint: "尚未配置邮箱。请提供邮箱地址和授权码。" });
      const a = rows[0];
      return JSON.stringify({ service: "email", config: { email: a.email, smtp_host: a.smtp_host, smtp_port: a.smtp_port, imap_host: a.imap_host, imap_port: a.imap_port, display_name: a.display_name || "", password: a.password ? a.password.slice(0, 4) + "****" : "" } });
    }
    if (action === "save") {
      const email = s(p.smtp_user) || s(p.email);
      const pass = s(p.smtp_pass) || s(p.password);
      if (!email || !pass) return JSON.stringify({ error: "email 和 password/smtp_pass 为必填项" });
      const smtpHost = s(p.smtp_host) || detectHost(email, "smtp");
      const imapHost = s(p.imap_host) || detectHost(email, "imap");
      const smtpPort = n(p.smtp_port, 465);
      const imapPort = n(p.imap_port, 993);
      const { rows: ex } = await db.query("SELECT id FROM opc_email_accounts WHERE email = $1", [email]);
      if (ex.length > 0) {
        await db.query("UPDATE opc_email_accounts SET smtp_host=$1, smtp_port=$2, imap_host=$3, imap_port=$4, password=$5, enabled=true WHERE id=$6",
          [smtpHost, smtpPort, imapHost, imapPort, pass, ex[0].id]);
      } else {
        await db.query("INSERT INTO opc_email_accounts (id, user_id, email, smtp_host, smtp_port, imap_host, imap_port, password, enabled, last_uid, created_at) VALUES ($1, (SELECT id FROM opc_users LIMIT 1), $2, $3, $4, $5, $6, $7, true, 0, NOW())",
          [uuid(), email, smtpHost, smtpPort, imapHost, imapPort, pass]);
      }
      configureSmtp({ host: smtpHost, port: smtpPort, user: email, pass });
      return JSON.stringify({ success: true, message: "邮箱 " + email + " 已配置成功，AI 现在可以帮你收发邮件了。" });
    }
  }

  const keyMap: Record<string, string[]> = {
    feishu:   ["feishu_app_id", "feishu_app_secret", "feishu_webhook"],
    wecom:    ["wecom_corpid", "wecom_secret", "wecom_agent_id", "wecom_webhook"],
    dingtalk: ["dingtalk_app_key", "dingtalk_app_secret", "dingtalk_webhook"],
    search:   ["uapi_key", "uapi_url"],
  };
  const keys = keyMap[service]!;

  if (action === "get") {
    const cfg: Record<string, string> = {};
    for (const k of keys) {
      const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = $1", [k]);
      const val = rows[0]?.value || "";
      cfg[k] = (k.includes("secret") || k.includes("webhook") || k.includes("key")) && val ? val.slice(0, 4) + "****" + val.slice(-4) : val;
    }
    return JSON.stringify({ service, config: cfg, hint: "已脱敏显示。如需修改，请使用 save 并提供完整的值。" });
  }

  if (action === "save") {
    let saved = 0;
    for (const k of keys) {
      if (p[k] !== undefined && !String(p[k]).includes("****")) {
        await db.query("INSERT INTO opc_tool_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [k, String(p[k])]);
        saved++;
      }
    }
    if (service === "search") {
      const getVal = async (k: string) => { const { rows } = await db.query("SELECT value FROM opc_tool_config WHERE key = $1", [k]); return rows[0]?.value || ""; };
      const ak = await getVal("uapi_key"); const au = await getVal("uapi_url");
      if (ak) configureSearch({ apiKey: ak, apiUrl: au || undefined });
    }
    return JSON.stringify({ success: true, saved, message: service + " 配置已保存。共更新 " + saved + " 项。" });
  }

  return JSON.stringify({ error: "action 必须是 get 或 save" });
}
