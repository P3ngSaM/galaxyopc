import test from "node:test";
import assert from "node:assert/strict";
import { hitRateLimit } from "../src/auth/rate-limit.js";
import { handleLocalRoutes } from "../src/router/local-routes.js";
import { sanitizeToolCalls, ensureConversationAccess } from "../src/chat/chat-service.js";
import {
  execOpcEmailReadOnly,
  execOpcReportReadOnly,
  execOpcSearchReadOnly,
  execOpcWebpageReadOnly,
} from "../src/chat/tool-executor-readers.js";
import { execOpcVideoIsolated } from "../src/chat/tool-executor-video.js";
import { callAi, configureAi } from "../src/chat/ai-client.js";
import type { ToolCall } from "../src/chat/ai-client.js";

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(payload?: string) {
      this.body = payload ?? "";
      return this;
    },
  };
}

test("rate limit blocks after threshold within window", () => {
  const namespace = `test:${Date.now()}`;
  assert.equal(hitRateLimit(namespace, "user-1", 2, 60_000), false);
  assert.equal(hitRateLimit(namespace, "user-1", 2, 60_000), false);
  assert.equal(hitRateLimit(namespace, "user-1", 2, 60_000), true);
});

test("local routes are hidden when not in local mode", async () => {
  const previousDbType = process.env.DB_TYPE;
  const previousLocalMode = process.env.LOCAL_MODE;
  delete process.env.DB_TYPE;
  delete process.env.LOCAL_MODE;

  const res = createMockResponse();
  const handled = await handleLocalRoutes({
    req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any,
    res: res as any,
    db: {} as any,
    pathname: "/api/local/tasks",
    method: "GET",
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /仅本地版可用/);

  if (previousDbType === undefined) delete process.env.DB_TYPE;
  else process.env.DB_TYPE = previousDbType;
  if (previousLocalMode === undefined) delete process.env.LOCAL_MODE;
  else process.env.LOCAL_MODE = previousLocalMode;
});

test("sanitizeToolCalls repairs invalid tool arguments", () => {
  const toolCalls: ToolCall[] = [
    {
      id: "call_1",
      type: "function",
      function: { name: "opc_manage", arguments: "{bad json" },
    },
  ];

  const sanitized = sanitizeToolCalls(toolCalls);
  assert.equal(sanitized[0].function.arguments, "{}");
});

test("ensureConversationAccess rejects foreign conversation ids", async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("opc_user_companies")) {
        return { rows: [{ ok: 1 }] };
      }
      if (sql.includes("opc_chat_conversations")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () => ensureConversationAccess(db as any, "user-1", "company-1", "conv-1", "hello"),
    /对话不存在或无权访问/,
  );
  assert.equal(queries.length >= 2, true);
});

test("execOpcSearchReadOnly rejects missing api key", async () => {
  const result = await execOpcSearchReadOnly(
    { query: "星环OPC" },
    { apiKey: "", apiUrl: "https://example.com/search" },
  );

  assert.match(result, /搜索服务未配置/);
});

test("execOpcEmailReadOnly rejects missing smtp config", async () => {
  const result = await execOpcEmailReadOnly(
    { to: "user@example.com", subject: "hello", body: "<p>world</p>" },
    { host: "smtp.example.com", port: 465, user: "", pass: "" },
  );

  assert.match(result, /邮件服务未配置/);
});

test("execOpcReportReadOnly aggregates company data", async () => {
  const sqls: string[] = [];
  const db = {
    async query(sql: string) {
      sqls.push(sql);
      if (sql.includes("FROM opc_companies")) return { rows: [{ name: "测试公司", industry: "AI" }] };
      if (sql.includes("FROM opc_transactions")) return { rows: [{ type: "income", total: "88", cnt: "2" }] };
      if (sql.includes("FROM opc_contacts")) return { rows: [{ cnt: "3" }] };
      if (sql.includes("FROM opc_projects")) return { rows: [{ cnt: "4" }] };
      if (sql.includes("FROM opc_employees")) return { rows: [{ cnt: "5" }] };
      if (sql.includes("FROM opc_contracts")) return { rows: [{ cnt: "6", total: "99" }] };
      return { rows: [] };
    },
  };

  const result = JSON.parse(await execOpcReportReadOnly(
    { action: "operations_report", title: "运营月报", period: "2026-03" },
    db as any,
    "company-1",
    { apiKey: "", apiUrl: "https://example.com/search" },
  ));

  assert.equal(result.success, true);
  assert.equal(result.report_type, "运营报告");
  assert.equal(result.company_data.contact_count, 3);
  assert.equal(result.company_data.project_count, 4);
  assert.equal(result.company_data.employee_count, 5);
  assert.equal(result.company_data.contracts.count, 6);
  assert.equal(sqls.length, 6);
});

test("execOpcWebpageReadOnly extracts metadata", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => "<html><head><title>示例页</title><meta name=\"description\" content=\"描述信息\"></head><body><main>正文内容</main></body></html>",
  })) as typeof fetch;

  try {
    const result = JSON.parse(await execOpcWebpageReadOnly({
      url: "https://example.com",
      extract_type: "metadata",
    }));

    assert.equal(result.success, true);
    assert.equal(result.title, "示例页");
    assert.equal(result.description, "描述信息");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("execOpcSearchReadOnly forwards abort signal to fetch", async () => {
  const previousFetch = globalThis.fetch;
  let receivedAborted = false;
  globalThis.fetch = (async (_input, init) => {
    receivedAborted = Boolean(init?.signal?.aborted);
    throw new Error("aborted");
  }) as typeof fetch;

  try {
    const ac = new AbortController();
    ac.abort();
    const result = await execOpcSearchReadOnly(
      { query: "星环OPC" },
      { apiKey: "test-key", apiUrl: "https://example.com/search" },
      { signal: ac.signal },
    );

    assert.equal(receivedAborted, true);
    assert.match(result, /搜索请求失败/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("execOpcVideoIsolated creates script and lists jobs", async () => {
  const scriptResult = JSON.parse(await execOpcVideoIsolated({
    action: "create_script",
    title: "演示视频",
    template: "promo",
    duration_seconds: 40,
  }));
  assert.equal(scriptResult.success, true);
  assert.equal(scriptResult.script.duration_seconds, 40);

  const listResult = JSON.parse(await execOpcVideoIsolated({ action: "list_videos" }));
  assert.equal(listResult.success, true);
  assert.equal(Array.isArray(listResult.videos), true);
});

test("callAi cancels queued request before slot acquisition", async () => {
  const previousFetch = globalThis.fetch;
  const previousMaxConcurrent = process.env.AI_MAX_CONCURRENT;
  process.env.AI_MAX_CONCURRENT = "1";
  configureAi({ baseUrl: "https://example.com", apiKey: "test-key", model: "test-model" });

  let releaseFirst!: () => void;
  let fetchCount = 0;
  globalThis.fetch = ((..._args: any[]) => {
    fetchCount++;
    if (fetchCount === 1) {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "first" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        });
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "second" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
  }) as typeof fetch;

  try {
    const first = callAi([{ role: "user", content: "first" }]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const ac = new AbortController();
    const queued = callAi([{ role: "user", content: "second" }], undefined, undefined, ac.signal);
    ac.abort();

    await assert.rejects(queued, /AI 请求已取消/);
    assert.equal(fetchCount, 1);

    releaseFirst();
    await first;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousMaxConcurrent === undefined) delete process.env.AI_MAX_CONCURRENT;
    else process.env.AI_MAX_CONCURRENT = previousMaxConcurrent;
    configureAi({ baseUrl: "https://example.com", apiKey: "test-key", model: "test-model" });
  }
});
