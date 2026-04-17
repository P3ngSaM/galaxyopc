import nodemailer from "nodemailer";
import type { Db } from "../db.js";
import { asString } from "./tool-executor-helpers.js";
import { callAiResponses } from "./ai-client.js";

interface SearchConfig {
  apiKey: string;
  apiUrl: string;
}

interface ToolAbortOptions {
  signal?: AbortSignal;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

type ResponsesOutputItem = Record<string, unknown>;

type SearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date: string;
  full_text?: string;
};

type SearchExecutionResult = {
  success: boolean;
  provider: string;
  query: string;
  total_results: number;
  results: SearchResultItem[];
  result_count: number;
  process_time_ms?: number;
  fallback_from?: string[];
  note?: string;
  error?: string;
};

function cleanSearchText(value: unknown): string {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactResults(results: SearchResultItem[]): SearchResultItem[] {
  return results
    .filter((item) => item.title && item.url)
    .map((item) => ({
      ...item,
      title: cleanSearchText(item.title).slice(0, 200),
      snippet: cleanSearchText(item.snippet).slice(0, 800),
      source: cleanSearchText(item.source).slice(0, 120),
      date: cleanSearchText(item.date).slice(0, 60),
      ...(item.full_text ? { full_text: cleanSearchText(item.full_text).slice(0, 2000) } : {}),
    }));
}

async function fetchUapiResults(
  query: string,
  params: Record<string, unknown>,
  config: SearchConfig,
  options: ToolAbortOptions,
): Promise<SearchExecutionResult> {
  if (!config.apiKey) return { success: false, provider: "uapi", query, total_results: 0, results: [], result_count: 0, error: "UAPI 未配置" };
  const body: Record<string, unknown> = { query, timeout_ms: 15000 };
  if (params.site) body.site = asString(params.site);
  if (params.filetype) body.filetype = asString(params.filetype);
  if (params.fetch_full) body.fetch_full = true;
  if (params.time_range) body.time_range = asString(params.time_range);
  if (params.sort) body.sort = asString(params.sort);

  const res = await fetch(config.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    return { success: false, provider: "uapi", query, total_results: 0, results: [], result_count: 0, error: `搜索API错误 (${res.status}): ${text.slice(0, 200)}` };
  }
  const data = await res.json() as {
    query: string;
    total_results: number;
    results: Array<{ title: string; url: string; snippet: string; domain?: string; source?: string; publish_time?: string; full_text?: string }>;
    process_time_ms: number;
  };
  const results = compactResults((data.results || []).slice(0, 8).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    source: result.domain || result.source || "",
    date: result.publish_time || "",
    ...(result.full_text ? { full_text: result.full_text } : {}),
  })));
  return {
    success: results.length > 0,
    provider: "uapi",
    query: data.query || query,
    total_results: Number(data.total_results || results.length),
    results,
    result_count: results.length,
    process_time_ms: data.process_time_ms,
    ...(results.length === 0 ? { error: "UAPI 未返回有效结果" } : {}),
  };
}


export async function execOpcSearchReadOnly(
  params: Record<string, unknown>,
  config: SearchConfig,
  options: ToolAbortOptions = {},
): Promise<string> {
  const query = asString(params.query);
  if (!query) return JSON.stringify({ error: "请提供搜索关键词" });
  if (!config.apiKey) {
    return JSON.stringify({ error: "搜索服务未配置，请先在系统设置中配置搜索 API Key" });
  }

  try {
    const result = await fetchUapiResults(query, params, config, options);
    if (!result.success) {
      return JSON.stringify({ error: result.error || "搜索失败" });
    }
    return JSON.stringify({
      success: true,
      query: result.query,
      total_results: result.total_results,
      results: result.results,
      result_count: result.result_count,
      process_time_ms: result.process_time_ms,
    });
  } catch (error: unknown) {
    return JSON.stringify({ error: `搜索请求失败: ${(error as Error).message}` });
  }
}

function collectResponseText(output: ResponsesOutputItem[]): string {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function collectWebSources(output: ResponsesOutputItem[]): string[] {
  const urls: string[] = [];
  for (const item of output) {
    if (item.type !== "web_search_call") continue;
    const action = item.action as Record<string, unknown> | undefined;
    const sources = Array.isArray(action?.sources) ? action?.sources as Array<Record<string, unknown>> : [];
    for (const source of sources) {
      if (source.type === "url" && typeof source.url === "string") urls.push(source.url);
    }
  }
  return [...new Set(urls)];
}

function normalizeNativeSources(urls: string[], summary: string, query: string): SearchResultItem[] {
  return urls.map((url, index) => ({
    title: `原生搜索结果 ${index + 1}`,
    url,
    snippet: summary.slice(0, 500),
    source: (() => {
      try { return new URL(url).hostname; } catch { return ""; }
    })(),
    date: "",
  }));
}

function hasEnoughSearchResults(result: { results?: SearchResultItem[]; summary?: string; sources?: string[] }): boolean {
  const resultCount = Array.isArray(result.results) ? result.results.length : 0;
  const sourceCount = Array.isArray(result.sources) ? result.sources.length : 0;
  const summaryLen = String(result.summary || "").trim().length;
  return resultCount >= 3 || sourceCount >= 3 || summaryLen >= 120;
}

export async function execNativeWebSearchReadOnly(
  params: Record<string, unknown>,
  options: ToolAbortOptions = {},
): Promise<string> {
  const query = asString(params.query);
  if (!query) return JSON.stringify({ error: "请提供搜索关键词" });

  const domainHint = asString(params.domains);
  const limit = Math.max(1, Math.min(10, Number(params.limit || 5)));
  const prompt = [
    `Use web_search to research: ${query}`,
    domainHint ? `Prefer these domains if relevant: ${domainHint}` : "",
    `Return a concise summary and at most ${limit} high-value sources with URLs.`,
  ].filter(Boolean).join("\n");

  try {
    const result = await callAiResponses(prompt, [{ type: "web_search" }], {
      signal: options.signal,
      enableThinking: false,
    });
    const summary = collectResponseText(result.output);
    const sources = collectWebSources(result.output).slice(0, limit);
    return JSON.stringify({
      success: true,
      provider: "dashscope_responses",
      query,
      summary,
      sources,
      results: normalizeNativeSources(sources, summary, query),
      usage: result.usage,
    });
  } catch (error: unknown) {
    return JSON.stringify({ error: `原生 web_search 调用失败: ${(error as Error).message}` });
  }
}

export async function execHybridSearchReadOnly(
  params: Record<string, unknown>,
  config: SearchConfig,
  options: ToolAbortOptions = {},
): Promise<string> {
  const nativeRaw = await execNativeWebSearchReadOnly(params, options);
  let nativeData: Record<string, unknown> = {};
  try { nativeData = JSON.parse(nativeRaw); } catch {}

  const nativeOk = !!nativeData.success;
  const nativeResults = Array.isArray(nativeData.results) ? nativeData.results as SearchResultItem[] : [];
  const nativeSummary = typeof nativeData.summary === "string" ? nativeData.summary : "";
  const nativeSources = Array.isArray(nativeData.sources) ? nativeData.sources as string[] : [];

  if (nativeOk && hasEnoughSearchResults({ results: nativeResults, summary: nativeSummary, sources: nativeSources })) {
    return JSON.stringify({
      success: true,
      provider: "dashscope_responses",
      query: asString(params.query),
      results: nativeResults,
      result_count: nativeResults.length,
      summary: nativeSummary,
      sources: nativeSources,
      fallback_used: false,
      usage: nativeData.usage,
    });
  }

  const uapiRaw = await execOpcSearchReadOnly(params, config, options);
  let uapiData: Record<string, unknown> = {};
  try { uapiData = JSON.parse(uapiRaw); } catch {}
  if (!uapiData.success) {
    if (nativeOk) {
      return JSON.stringify({
        success: true,
        provider: "dashscope_responses",
        query: asString(params.query),
        results: nativeResults,
        result_count: nativeResults.length,
        summary: nativeSummary,
        sources: nativeSources,
        fallback_used: false,
        note: "原生搜索已返回结果，但数量或细节偏少；UAPI 补充失败。",
        usage: nativeData.usage,
      });
    }
    return uapiRaw;
  }

  const uapiResults = Array.isArray(uapiData.results) ? uapiData.results as SearchResultItem[] : [];
  const mergedMap = new Map<string, SearchResultItem>();
  for (const item of nativeResults) {
    if (item.url) mergedMap.set(item.url, item);
  }
  for (const item of uapiResults) {
    if (item.url) mergedMap.set(item.url, item);
  }
  const mergedResults = [...mergedMap.values()].slice(0, 8);
  return JSON.stringify({
    success: true,
    provider: nativeOk ? "dashscope_responses+uapi" : "uapi",
    query: uapiData.query || asString(params.query),
    results: mergedResults,
    result_count: mergedResults.length,
    total_results: uapiData.total_results || mergedResults.length,
    process_time_ms: uapiData.process_time_ms,
    summary: nativeSummary || "",
    sources: [
      ...new Set([
        ...nativeSources,
        ...mergedResults.map((item) => item.url).filter(Boolean),
      ]),
    ].slice(0, 10),
    fallback_used: true,
    fallback_reason: nativeOk ? "原生搜索结果不足，已补充 UAPI" : "原生搜索失败，已切换 UAPI",
    native_error: nativeOk ? undefined : nativeData.error,
    usage: nativeData.usage,
  });
}

export async function execNativeWebExtractReadOnly(
  params: Record<string, unknown>,
  options: ToolAbortOptions = {},
): Promise<string> {
  const goal = asString(params.goal || params.query);
  const url = asString(params.url);
  if (!goal && !url) return JSON.stringify({ error: "请提供 goal、query 或 url" });

  const prompt = [
    "Use web_search and web_extractor together.",
    url ? `Prioritize extracting from this URL: ${url}` : "",
    goal ? `Extraction goal: ${goal}` : "Extract the page title and key points.",
    "Return a concise Chinese summary, the page title if available, and key points.",
  ].filter(Boolean).join("\n");

  try {
    const result = await callAiResponses(prompt, [{ type: "web_search" }, { type: "web_extractor" }], {
      signal: options.signal,
      enableThinking: true,
    });
    const extractorItems = result.output.filter((item) => item.type === "web_extractor_call");
    return JSON.stringify({
      success: true,
      provider: "dashscope_responses",
      goal: goal || url,
      summary: collectResponseText(result.output),
      sources: collectWebSources(result.output).slice(0, 8),
      extracted: extractorItems.map((item) => ({
        goal: typeof item.goal === "string" ? item.goal : "",
        output: typeof item.output === "string" ? item.output.slice(0, 6000) : "",
      })),
      usage: result.usage,
    });
  } catch (error: unknown) {
    return JSON.stringify({ error: `原生 web_extractor 调用失败: ${(error as Error).message}` });
  }
}

export async function execNativeCodeInterpreterReadOnly(
  params: Record<string, unknown>,
  options: ToolAbortOptions = {},
): Promise<string> {
  const task = asString(params.task || params.query);
  if (!task) return JSON.stringify({ error: "请提供计算或分析任务" });

  try {
    const result = await callAiResponses(task, [{ type: "code_interpreter", container: "auto" }], {
      signal: options.signal,
      enableThinking: true,
    });
    const codeRuns = result.output
      .filter((item) => item.type === "code_interpreter_call")
      .map((item) => ({
        code: typeof item.code === "string" ? item.code : "",
        outputs: item.outputs,
      }));
    return JSON.stringify({
      success: true,
      provider: "dashscope_responses",
      task,
      result: collectResponseText(result.output),
      runs: codeRuns,
      usage: result.usage,
    });
  } catch (error: unknown) {
    return JSON.stringify({ error: `原生 code_interpreter 调用失败: ${(error as Error).message}` });
  }
}

export async function execOpcEmailReadOnly(
  params: Record<string, unknown>,
  smtp: SmtpConfig,
): Promise<string> {
  if (!smtp.user || !smtp.pass) return JSON.stringify({ error: "邮件服务未配置，请设置 SMTP_USER / SMTP_PASS 环境变量" });

  const to = asString(params.to);
  const subject = asString(params.subject);
  const body = asString(params.body);
  if (!to || !subject || !body) return JSON.stringify({ error: "收件人、主题、正文不能为空" });

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: true,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  try {
    const info = await transporter.sendMail({
      from: `"星环OPC" <${smtp.user}>`,
      to,
      cc: asString(params.cc) || undefined,
      subject,
      html: `
        <div style="max-width:640px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="border-bottom:2px solid #f97316;padding-bottom:16px;margin-bottom:24px;">
            <h2 style="color:#f97316;margin:0;font-size:18px;">星环OPC</h2>
            <p style="color:#888;font-size:12px;margin:4px 0 0;">一人公司 AI 运营平台</p>
          </div>
          <div style="color:#333;font-size:14px;line-height:1.8;">${body}</div>
          <div style="border-top:1px solid #eee;padding-top:16px;margin-top:32px;">
            <p style="color:#999;font-size:11px;margin:0;">此邮件由 星环OPC AI 系统自动发送</p>
          </div>
        </div>`,
    });

    return JSON.stringify({
      success: true,
      message_id: info.messageId,
      to,
      subject,
      note: `邮件已成功发送至 ${to}`,
    });
  } catch (error: unknown) {
    return JSON.stringify({ error: `邮件发送失败: ${(error as Error).message}` });
  }
}

export async function execOpcReportReadOnly(
  params: Record<string, unknown>,
  db: Db,
  companyId: string,
  config: SearchConfig,
  options: ToolAbortOptions = {},
): Promise<string> {
  const action = asString(params.action, "custom");
  const title = asString(params.title, "未命名报告");
  const period = asString(params.period, new Date().toISOString().slice(0, 7));
  const extraContext = asString(params.extra_context);

  const searchQueries = Array.isArray(params.search_queries) ? (params.search_queries as string[]) : [];
  const searchResults: Array<{ query: string; results: unknown[] }> = [];

  if (config.apiKey && searchQueries.length > 0) {
    for (const query of searchQueries.slice(0, 5)) {
      try {
        const res = await fetch(config.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ query, timeout_ms: 10000 }),
          signal: options.signal,
        });
        if (res.ok) {
          const data = await res.json() as { results: Array<{ title: string; url: string; snippet: string }> };
          searchResults.push({
            query,
            results: (data.results || []).slice(0, 5).map((result) => ({
              title: result.title,
              url: result.url,
              snippet: result.snippet,
            })),
          });
        }
      } catch {
        // skip failed search
      }
    }
  }

  const companyData: Record<string, unknown> = {};
  if (companyId) {
    const [companyResult, financeResult, contactsResult, projectsResult, employeesResult, contractsResult] = await Promise.all([
      db.query("SELECT name, industry, status, registered_capital, description FROM opc_companies WHERE id = $1", [companyId]),
      db.query(
        "SELECT type, SUM(amount) as total, COUNT(*) as cnt FROM opc_transactions WHERE company_id = $1 AND transaction_date LIKE $2 GROUP BY type",
        [companyId, `${period}%`],
      ),
      db.query("SELECT COUNT(*) as cnt FROM opc_contacts WHERE company_id = $1", [companyId]),
      db.query("SELECT COUNT(*) as cnt FROM opc_projects WHERE company_id = $1", [companyId]),
      db.query("SELECT COUNT(*) as cnt FROM opc_employees WHERE company_id = $1 AND status = 'active'", [companyId]),
      db.query("SELECT COUNT(*) as cnt, SUM(value) as total FROM opc_contracts WHERE company_id = $1", [companyId]),
    ]);

    if (companyResult.rows[0]) companyData.company = companyResult.rows[0];
    companyData.finance = financeResult.rows;
    companyData.contact_count = Number(contactsResult.rows[0]?.cnt || 0);
    companyData.project_count = Number(projectsResult.rows[0]?.cnt || 0);
    companyData.employee_count = Number(employeesResult.rows[0]?.cnt || 0);
    companyData.contracts = {
      count: Number(contractsResult.rows[0]?.cnt || 0),
      total_value: Number(contractsResult.rows[0]?.total || 0),
    };
  }

  const reportTypeMap: Record<string, string> = {
    market_research: "市场调研报告",
    competitor_analysis: "竞品分析报告",
    financial_analysis: "财务分析报告",
    operations_report: "运营报告",
    industry_trends: "行业趋势报告",
    custom: "自定义报告",
  };

  return JSON.stringify({
    success: true,
    report_type: reportTypeMap[action] || action,
    title,
    period,
    company_data: companyData,
    search_data: searchResults,
    extra_context: extraContext,
    instruction: "请基于上述公司数据和搜索结果，生成一份专业、详细的报告。报告使用 Markdown 格式，包含摘要、正文分析、数据图表描述、结论和建议。引用搜索来源时附上 URL。",
  });
}

export async function execOpcWebpageReadOnly(
  params: Record<string, unknown>,
  options: ToolAbortOptions = {},
): Promise<string> {
  const url = asString(params.url);
  if (!url) return JSON.stringify({ error: "请提供网页URL" });

  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  const timeout = setTimeout(() => controller.abort(), 15000);
  options.signal?.addEventListener("abort", relayAbort, { once: true });

  try {
    const visited = new Set<string>();
    const fetchWithRedirects = async (targetUrl: string, depth = 0): Promise<Response> => {
      const normalized = new URL(targetUrl).toString();
      if (visited.has(normalized)) {
        throw new Error(`目标站点发生重定向循环: ${normalized}`);
      }
      if (depth > 8) {
        throw new Error("目标站点重定向次数过多");
      }
      visited.add(normalized);
      const res = await fetch(normalized, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; OpcBot/1.0)" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`网页重定向失败 (${res.status})`);
        const nextUrl = new URL(location, normalized).toString();
        return fetchWithRedirects(nextUrl, depth + 1);
      }
      return res;
    };

    const res = await fetchWithRedirects(url);

    if (!res.ok) return JSON.stringify({ error: `网页请求失败 (${res.status})` });

    const html = await res.text();
    const extractType = asString(params.extract_type, "full_text");
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";

    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#?\w+;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (extractType === "metadata") {
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
      return JSON.stringify({
        success: true,
        url,
        title,
        description: descMatch ? descMatch[1] : "",
        content_length: text.length,
      });
    }

    const maxLen = extractType === "summary" ? 1500 : 6000;
    if (text.length > maxLen) text = `${text.slice(0, maxLen)}...（内容已截断）`;

    return JSON.stringify({ success: true, url, title, content: text, content_length: text.length });
  } catch (error: unknown) {
    return JSON.stringify({ error: `网页抓取失败: ${(error as Error).message}` });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}
