/**
 * 飞书长连接桥接 — 本地版专属
 *
 * 通过 @larksuiteoapi/node-sdk 的 WSClient 建立 WebSocket 长连接，
 * 接收飞书消息 → 转发给 AI → 回复到飞书。
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { Db } from "../db.js";
import { callAi, type ChatMessage } from "../chat/ai-client.js";
import { getToolDefinitions, executeTool } from "../chat/tool-executor.js";
import { buildSystemPrompt } from "../chat/context-builder.js";
import { extractAndSaveMemory } from "../chat/memory-extractor.js";
import { setFeishuClient, setFeishuDb } from "./feishu-tools.js";

let wsClient: InstanceType<typeof Lark.WSClient> | null = null;
let larkClient: InstanceType<typeof Lark.Client> | null = null;
let _db: Db | null = null;
let _status: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
let _errorMsg = "";
let _appId = "";

export function getFeishuStatus() {
  return { status: _status, error: _errorMsg, appId: _appId };
}

export async function startFeishu(appId: string, appSecret: string, db: Db): Promise<{ ok: boolean; error?: string }> {
  if (wsClient) {
    await stopFeishu();
  }

  _db = db;
  _appId = appId;
  _status = "connecting";
  _errorMsg = "";

  try {
    larkClient = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        try {
          await handleFeishuMessage(data);
        } catch (e) {
          console.error("[Feishu] 消息处理异常:", e);
        }
      },
    });

    wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    _status = "connected";
    setFeishuClient(larkClient);
    setFeishuDb(db);
    console.log("[Feishu] 长连接已建立, appId:", appId);
    return { ok: true };
  } catch (e: any) {
    _status = "error";
    _errorMsg = e.message || String(e);
    console.error("[Feishu] 连接失败:", _errorMsg);
    return { ok: false, error: _errorMsg };
  }
}

export async function stopFeishu(): Promise<void> {
  if (wsClient) {
    try {
      wsClient = null;
      larkClient = null;
    } catch { /* ignore */ }
  }
  setFeishuClient(null);
  _status = "disconnected";
  _errorMsg = "";
  console.log("[Feishu] 已断开连接");
}

const chatHistoryMap = new Map<string, ChatMessage[]>();
const processedMsgIds = new Set<string>();
const DEDUP_MAX = 500;

async function handleFeishuMessage(data: any) {
  if (!_db || !larkClient) return;

  const msg = data?.message;
  if (!msg) return;

  // 消息去重：飞书3秒超时会重推同一条消息
  const msgId = msg.message_id;
  if (msgId && processedMsgIds.has(msgId)) {
    console.log("[Feishu] 跳过重复消息:", msgId);
    return;
  }
  if (msgId) {
    processedMsgIds.add(msgId);
    if (processedMsgIds.size > DEDUP_MAX) {
      const first = processedMsgIds.values().next().value;
      if (first) processedMsgIds.delete(first);
    }
  }

  const msgType = msg.message_type;

  let text = "";
  try {
    const content = JSON.parse(msg.content || "{}");
    if (msgType === "text") {
      text = content.text || "";
    } else if (msgType === "post") {
      text = extractPostText(content);
    } else {
      await replyFeishu(msg.chat_id, "暂时只支持文本和富文本消息哦~");
      return;
    }
  } catch {
    text = msg.content || "";
  }

  if (!text.trim()) return;

  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return;

  const chatId = msg.chat_id;
  const senderId = data?.sender?.sender_id?.open_id || "feishu_user";

  console.log("[Feishu] 收到消息:", text.slice(0, 50), "from:", senderId, "msgId:", msgId);

  if (!chatHistoryMap.has(chatId)) {
    chatHistoryMap.set(chatId, []);
  }
  const history = chatHistoryMap.get(chatId)!;
  history.push({ role: "user", content: text });
  if (history.length > 20) history.splice(0, history.length - 20);

  try {
    const { rows: users } = await _db.query("SELECT id FROM opc_users LIMIT 1");
    const userId = users[0]?.id || "";
    const { rows: companies } = await _db.query(
      "SELECT company_id FROM opc_user_companies WHERE user_id = $1 LIMIT 1",
      [userId],
    );
    const companyId = companies[0]?.company_id || "";

    const systemPrompt = await buildSystemPrompt(_db, companyId, userId);
    const tools = getToolDefinitions();

    const feishuAssistantPrompt = `

[飞书工作助理模式]
当前对话来自飞书。你是用户的全能 AI 工作助理，深度打通飞书与 OPC 平台。

核心能力：
1. 工作日志：用户说工作内容时，主动用 feishu_work_log(action:add) 记录。
2. 会议纪要：用户说"开完会"或描述会议内容时，用 feishu_meeting_minutes 整理纪要 → 创建云文档 → 通知参会人。
3. 工作报告：用户说"写周报/日报/汇报"，用 feishu_work_report 从日志自动生成。
4. 消息：用 feishu_send_message 发消息。支持 text(纯文本)、post(富文本)、interactive(卡片消息)。重要通知建议用卡片消息(更醒目)。
5. 群发：feishu_batch_send 批量发送。
6. 通讯录：feishu_search_contact 搜索联系人 open_id。
7. 云文档：feishu_doc_create/read/write 创建读写文档，feishu_list_docs 列出文件。
8. 文档权限：feishu_doc_permission 分享文档给同事(view/edit/full_access)或设置链接公开访问。
9. 电子表格：feishu_sheet_create 创建表格，feishu_sheet_write 写入数据(JSON二维数组)，feishu_sheet_read 读取。适合财务报表/客户清单/进度表。
10. 群聊管理：feishu_group_manage 创建群(create)/拉人(add_members)/踢人(remove_member)/改群名(update)/查群列表(list_groups)。
11. 日历日程：feishu_calendar(create) 创建日程并邀请参与人，feishu_calendar(list) 查看日程。
12. 飞书任务：feishu_task(create) 创建任务并分配，feishu_task(list) 查看任务。
13. 审批：feishu_approval 查看审批类型和审批实例状态。
14. OPC 业务工具：所有 opc_manage/opc_finance/opc_hr/opc_project 等工具照常使用。

智能场景识别：
- 用户说"帮我建个群把张三李四拉进来" → feishu_search_contact + feishu_group_manage(create)
- 用户说"把这个方案分享给张三" → feishu_doc_permission(add_member)
- 用户说"明天下午3点开会" → feishu_calendar(create)
- 用户说"做个客户清单表格" → feishu_sheet_create + feishu_sheet_write
- 用户说"这个任务分配给王五" → feishu_task(create)
- 用户说"记账/注册公司/查看财务" → 使用 OPC 业务工具

回复规则：
- 用纯文本回复，禁止 Markdown 语法（飞书不渲染 Markdown）
- 用换行和空格组织内容
- 当用户提到工作内容时，主动记录到工作日志
- 当用户提到"汇报/进度"时，主动建议生成工作报告
- 执行完操作后，简洁报告结果，附上相关链接`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt + feishuAssistantPrompt },
      ...history,
    ];

    let reply = "";
    let loopCount = 0;
    const maxLoops = 5;

    while (loopCount < maxLoops) {
      loopCount++;
      const aiResult = await callAi(messages, tools);

      if (aiResult.tool_calls && aiResult.tool_calls.length > 0) {
        messages.push({
          role: "assistant",
          content: aiResult.content || "",
          tool_calls: aiResult.tool_calls,
        });

        for (const tc of aiResult.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* */ }
          const toolResult = await executeTool(tc.function.name, args, _db, companyId, userId);
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: toolResult,
          } as any);
        }
        continue;
      }

      reply = aiResult.content || "抱歉，我暂时无法回答。";
      break;
    }

    reply = stripMarkdown(reply);

    history.push({ role: "assistant", content: reply });

    const chunks = splitText(reply, 2000);
    for (const chunk of chunks) {
      await replyFeishu(chatId, chunk);
    }

    // 异步提炼记忆（不阻塞回复）
    extractAndSaveMemory(_db, userId, companyId, "feishu_" + chatId, text, reply).catch(() => {});
  } catch (e: any) {
    console.error("[Feishu] AI 处理失败:", e);
    await replyFeishu(chatId, "AI 处理出错: " + (e.message || "未知错误"));
  }
}

function extractPostText(post: any): string {
  const parts: string[] = [];
  const title = post?.title;
  if (title) parts.push(title);

  const zhContent = post?.content || post?.zh_cn?.content || post?.en_us?.content;
  if (Array.isArray(zhContent)) {
    for (const line of zhContent) {
      if (!Array.isArray(line)) continue;
      const lineText = line.map((el: any) => {
        if (el.tag === "text") return el.text || "";
        if (el.tag === "a") return el.text || el.href || "";
        if (el.tag === "at") return el.user_name ? `@${el.user_name}` : "";
        return "";
      }).join("");
      if (lineText.trim()) parts.push(lineText);
    }
  }
  return parts.join("\n");
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")          // # 标题 → 去掉 #
    .replace(/\*\*(.+?)\*\*/g, "$1")       // **粗体** → 粗体
    .replace(/\*(.+?)\*/g, "$1")           // *斜体* → 斜体
    .replace(/__(.+?)__/g, "$1")           // __下划线__
    .replace(/_(.+?)_/g, "$1")             // _斜体_
    .replace(/~~(.+?)~~/g, "$1")           // ~~删除线~~
    .replace(/`{3}[\s\S]*?`{3}/g, (m) =>  // ```代码块``` → 保留内容
      m.replace(/^`{3}\w*\n?/, "").replace(/\n?`{3}$/, ""))
    .replace(/`([^`]+)`/g, "$1")           // `行内代码`
    .replace(/^\s*[-*+]\s+/gm, "· ")       // - 列表 → · 列表
    .replace(/^\s*\d+\.\s+/gm, (m) => m)  // 有序列表保留
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [链接文字](url) → 链接文字
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]") // 图片
    .replace(/^>\s+/gm, "")               // > 引用
    .replace(/\n{3,}/g, "\n\n");           // 多余空行
}

async function replyFeishu(chatId: string, text: string, parentMsgId?: string) {
  if (!larkClient) return;
  try {
    await larkClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  } catch (e: any) {
    console.error("[Feishu] 发送消息失败:", e.message || e);
  }
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    parts.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}
