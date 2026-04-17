/**
 * 飞书工作助理工具集 — 本地版专属
 *
 * 消息: 发送文本/富文本/卡片/文件/图片, 群发
 * 通讯录: 搜索用户, 获取部门列表
 * 云文档: CRUD, 权限管理, 分享
 * 电子表格: 创建, 读写数据
 * 群聊: 创建群, 拉人/踢人, 群信息
 * 日历: 创建/查看日程
 * 任务: 创建/查看飞书任务
 * 审批: 查看审批实例
 * 工作日志 / 会议纪要 / 工作报告 (本地 DB)
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { v4 as uuid } from "uuid";
import type { Db } from "../db.js";
import type { ToolDef } from "../chat/ai-client.js";
import { callAi } from "../chat/ai-client.js";

let _larkClient: InstanceType<typeof Lark.Client> | null = null;
let _db: Db | null = null;

export function setFeishuClient(client: InstanceType<typeof Lark.Client> | null) {
  _larkClient = client;
}

export function setFeishuDb(db: Db) {
  _db = db;
}

export function getFeishuClient() {
  return _larkClient;
}

let _contactCache: { users: any[]; ts: number } | null = null;
const CONTACT_CACHE_TTL = 5 * 60 * 1000;

async function getAllUsers(): Promise<any[]> {
  if (_contactCache && Date.now() - _contactCache.ts < CONTACT_CACHE_TTL) return _contactCache.users;
  const client = _larkClient as any;
  if (!client) return [];

  const allUsers: any[] = [];
  const deptQueue = ["0"];
  const visited = new Set<string>();

  while (deptQueue.length > 0 && allUsers.length < 500) {
    const deptId = deptQueue.shift()!;
    if (visited.has(deptId)) continue;
    visited.add(deptId);

    try {
      let pageToken = "";
      do {
        const r = await client.request({
          method: "GET",
          url: `/open-apis/contact/v3/users?department_id=${encodeURIComponent(deptId)}&page_size=50${pageToken ? `&page_token=${pageToken}` : ""}`,
        });
        allUsers.push(...(r?.data?.items || []));
        pageToken = r?.data?.page_token || "";
      } while (pageToken && allUsers.length < 500);
    } catch (e: any) {
      console.warn(`[Feishu] list users in dept ${deptId} failed:`, e?.response?.data?.msg || e.message);
    }

    try {
      const cr = await client.request({
        method: "GET",
        url: `/open-apis/contact/v3/departments?parent_department_id=${encodeURIComponent(deptId)}&page_size=50&department_id_type=open_department_id`,
      });
      for (const d of (cr?.data?.items || [])) {
        const childId = d.open_department_id || d.department_id;
        if (childId) deptQueue.push(childId);
      }
    } catch { /* skip inaccessible depts */ }
  }

  _contactCache = { users: allUsers, ts: Date.now() };
  return allUsers;
}

async function findUserByName(name: string): Promise<any | null> {
  const users = await getAllUsers();
  return users.find((u: any) => (u.name || "").includes(name)) || null;
}

// ─── 工具定义 ──────────────────────────────────────────

export function getFeishuToolDefinitions(): ToolDef[] {
  if (!_larkClient) return [];
  return [
    // ── 消息 ──
    {
      type: "function",
      function: {
        name: "feishu_send_message",
        description: "通过飞书发送消息。支持文本、富文本(post)、卡片(interactive)三种格式。如不知道 open_id，先用 feishu_search_contact 查找。",
        parameters: {
          type: "object",
          properties: {
            receive_id: { type: "string", description: "接收者 ID（open_id 或 chat_id）" },
            receive_id_type: { type: "string", enum: ["open_id", "chat_id"], description: "ID 类型" },
            content: { type: "string", description: "消息文本内容" },
            msg_type: { type: "string", enum: ["text", "post", "interactive"], description: "消息类型（默认 text）。post=富文本(支持标题+格式)，interactive=卡片消息" },
            card_title: { type: "string", description: "卡片标题（msg_type=interactive 时使用）" },
            card_color: { type: "string", enum: ["blue", "green", "orange", "red", "purple"], description: "卡片主题色（默认 blue）" },
          },
          required: ["receive_id", "receive_id_type", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_batch_send",
        description: "飞书群发消息：同时向多个用户或群聊发送相同内容。receive_ids 用逗号分隔。",
        parameters: {
          type: "object",
          properties: {
            receive_ids: { type: "string", description: "接收者 ID 列表，逗号分隔" },
            receive_id_type: { type: "string", enum: ["open_id", "chat_id"], description: "ID 类型" },
            content: { type: "string", description: "消息文本内容" },
          },
          required: ["receive_ids", "receive_id_type", "content"],
        },
      },
    },

    // ── 通讯录 ──
    {
      type: "function",
      function: {
        name: "feishu_search_contact",
        description: "在飞书通讯录中搜索用户。输入姓名关键词，返回匹配的用户列表（含 open_id、姓名、部门）。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词（姓名、手机号等）" },
          },
          required: ["query"],
        },
      },
    },

    // ── 云文档 ──
    {
      type: "function",
      function: {
        name: "feishu_doc_create",
        description: "创建飞书云文档。返回文档 ID 和 URL。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "文档标题" },
            folder_token: { type: "string", description: "目标文件夹 token（可选）" },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_doc_read",
        description: "读取飞书云文档的纯文本内容。",
        parameters: {
          type: "object",
          properties: {
            document_id: { type: "string", description: "飞书文档 ID" },
          },
          required: ["document_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_doc_write",
        description: "向飞书云文档追加内容（在文档末尾写入段落）。",
        parameters: {
          type: "object",
          properties: {
            document_id: { type: "string", description: "飞书文档 ID" },
            content: { type: "string", description: "要追加的文本内容（换行分隔多段）" },
          },
          required: ["document_id", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_list_docs",
        description: "列出飞书云空间文件。",
        parameters: {
          type: "object",
          properties: {
            folder_token: { type: "string", description: "文件夹 token（可选）" },
            page_size: { type: "number", description: "每页数量（默认 20）" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_doc_permission",
        description: "管理飞书文档权限：分享给指定用户或设置公开链接。可将 OPC 生成的方案/报告分享给同事协作编辑。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add_member", "set_public", "list_members"], description: "操作类型" },
            token: { type: "string", description: "文档 token（document_id 或 file_token）" },
            token_type: { type: "string", enum: ["docx", "sheet", "file"], description: "token 类型（默认 docx）" },
            member_id: { type: "string", description: "被授权用户 open_id（add_member 时必填）" },
            perm: { type: "string", enum: ["view", "edit", "full_access"], description: "权限级别（默认 view）" },
            link_share_entity: { type: "string", enum: ["tenant_readable", "tenant_editable", "anyone_readable", "anyone_editable", "closed"], description: "链接分享范围（set_public 时使用）" },
          },
          required: ["action", "token"],
        },
      },
    },

    // ── 电子表格 ──
    {
      type: "function",
      function: {
        name: "feishu_sheet_create",
        description: "创建飞书电子表格。可用于生成财务报表、客户清单、项目进度表等结构化数据。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "表格标题" },
            folder_token: { type: "string", description: "目标文件夹 token（可选）" },
          },
          required: ["title"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_sheet_write",
        description: "向飞书电子表格写入数据。data 是二维数组，每行一组数据。适合写入客户名单、财务流水、项目任务等。",
        parameters: {
          type: "object",
          properties: {
            spreadsheet_token: { type: "string", description: "表格 token" },
            sheet_id: { type: "string", description: "工作表 ID（可选，默认第一个）" },
            range: { type: "string", description: "写入范围（如 A1:D10，可选，默认追加）" },
            data: { type: "string", description: "JSON 格式的二维数组，如 [[\"姓名\",\"电话\"],[\"张三\",\"138xxx\"]]" },
          },
          required: ["spreadsheet_token", "data"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_sheet_read",
        description: "读取飞书电子表格数据。返回指定范围的单元格内容。",
        parameters: {
          type: "object",
          properties: {
            spreadsheet_token: { type: "string", description: "表格 token" },
            sheet_id: { type: "string", description: "工作表 ID（可选，默认第一个）" },
            range: { type: "string", description: "读取范围（如 A1:D10）" },
          },
          required: ["spreadsheet_token"],
        },
      },
    },

    // ── 群聊管理 ──
    {
      type: "function",
      function: {
        name: "feishu_group_manage",
        description: "飞书群聊管理：创建群、拉人进群、踢人、查看群成员、修改群名。适用于创建项目群、客户沟通群等场景。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "add_members", "remove_member", "list_members", "update", "list_groups"], description: "操作类型" },
            chat_id: { type: "string", description: "群聊 ID（除 create/list_groups 外必填）" },
            name: { type: "string", description: "群名称（create/update 时使用）" },
            description: { type: "string", description: "群描述（create/update 时可选）" },
            member_ids: { type: "string", description: "成员 open_id，逗号分隔（add_members 时必填）" },
            member_id: { type: "string", description: "单个成员 open_id（remove_member 时必填）" },
          },
          required: ["action"],
        },
      },
    },

    // ── 日历 ──
    {
      type: "function",
      function: {
        name: "feishu_calendar",
        description: "飞书日历管理：创建日程、查看日程。可将 OPC 的项目里程碑、客户拜访等同步到飞书日历提醒。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "list"], description: "操作类型" },
            summary: { type: "string", description: "日程标题（create 时必填）" },
            description: { type: "string", description: "日程描述（可选）" },
            start_time: { type: "string", description: "开始时间 YYYY-MM-DD HH:mm（create 时必填）" },
            end_time: { type: "string", description: "结束时间 YYYY-MM-DD HH:mm（create 时必填）" },
            attendee_ids: { type: "string", description: "参与人 open_id，逗号分隔（可选）" },
            start_date: { type: "string", description: "查询起始日期 YYYY-MM-DD（list 时可选，默认今天）" },
            end_date: { type: "string", description: "查询结束日期 YYYY-MM-DD（list 时可选，默认 7 天后）" },
          },
          required: ["action"],
        },
      },
    },

    // ── 任务 ──
    {
      type: "function",
      function: {
        name: "feishu_task",
        description: "飞书任务管理：创建任务并分配给团队成员，可设置截止时间。可将 OPC 的项目任务同步到飞书。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "list"], description: "操作类型" },
            summary: { type: "string", description: "任务标题（create 时必填）" },
            description: { type: "string", description: "任务描述" },
            due_date: { type: "string", description: "截止日期 YYYY-MM-DD（可选）" },
            assignee_ids: { type: "string", description: "执行人 open_id，逗号分隔（可选）" },
            page_size: { type: "number", description: "每页数量（list 时可选，默认 20）" },
          },
          required: ["action"],
        },
      },
    },

    // ── 审批 ──
    {
      type: "function",
      function: {
        name: "feishu_approval",
        description: "查看飞书审批实例。可查看请假、报销、采购等审批的状态。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list_definitions", "list_instances"], description: "list_definitions=查看审批类型列表, list_instances=查看审批实例" },
            approval_code: { type: "string", description: "审批定义 code（list_instances 时必填）" },
            page_size: { type: "number", description: "每页数量（默认 20）" },
          },
          required: ["action"],
        },
      },
    },

    // ── 工作日志/纪要/报告（本地 DB）──
    {
      type: "function",
      function: {
        name: "feishu_work_log",
        description: "工作日志管理。记录每日工作内容，支持增删查。action: add(记录工作)、list(查看日志)、delete(删除)。category 可选：general/meeting/task/progress/issue。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "list", "delete"], description: "操作类型" },
            content: { type: "string", description: "工作内容（add 时必填）" },
            category: { type: "string", enum: ["general", "meeting", "task", "progress", "issue"], description: "分类（默认 general）" },
            date: { type: "string", description: "日期 YYYY-MM-DD（默认今天）" },
            start_date: { type: "string", description: "查询起始日期（list 时可选）" },
            end_date: { type: "string", description: "查询结束日期（list 时可选）" },
            log_id: { type: "string", description: "日志 ID（delete 时必填）" },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_meeting_minutes",
        description: "生成会议纪要：根据用户描述的会议内容，AI 自动整理成结构化纪要，创建飞书云文档，并可选发送给参会人。",
        parameters: {
          type: "object",
          properties: {
            meeting_topic: { type: "string", description: "会议主题" },
            meeting_content: { type: "string", description: "会议内容、讨论要点、决议（用户口述即可，AI 会整理）" },
            participants: { type: "string", description: "参会人姓名列表，逗号分隔（可选，会自动搜索 open_id 并发送）" },
            date: { type: "string", description: "会议日期（默认今天）" },
            send_to_participants: { type: "boolean", description: "是否发送给参会人（默认 true）" },
          },
          required: ["meeting_topic", "meeting_content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "feishu_work_report",
        description: "生成工作进度报告：汇总指定时间段的工作日志，AI 整理成结构化报告，创建飞书云文档。可指定发送给领导。",
        parameters: {
          type: "object",
          properties: {
            start_date: { type: "string", description: "起始日期 YYYY-MM-DD（默认本周一）" },
            end_date: { type: "string", description: "结束日期 YYYY-MM-DD（默认今天）" },
            report_type: { type: "string", enum: ["daily", "weekly", "custom"], description: "报告类型（默认 weekly）" },
            send_to: { type: "string", description: "发送给谁（姓名，可选，会搜索 open_id）" },
            extra_notes: { type: "string", description: "补充说明（可选）" },
          },
          required: [],
        },
      },
    },
  ];
}

// ─── 工具执行 ──────────────────────────────────────────

const LOCAL_ONLY_TOOLS = new Set(["feishu_work_log"]);

export async function executeFeishuTool(toolName: string, args: Record<string, unknown>, db?: Db, userId?: string): Promise<string> {
  if (!_larkClient && !LOCAL_ONLY_TOOLS.has(toolName)) {
    return JSON.stringify({ error: "飞书未连接，请先在设置中配置飞书通道" });
  }
  const effectiveDb = db || _db;

  try {
    switch (toolName) {
      case "feishu_send_message": return await execSendMessage(args);
      case "feishu_batch_send": return await execBatchSend(args);
      case "feishu_search_contact": return await execSearchContact(args);
      case "feishu_doc_create": return await execDocCreate(args);
      case "feishu_doc_read": return await execDocRead(args);
      case "feishu_doc_write": return await execDocWrite(args);
      case "feishu_list_docs": return await execListDocs(args);
      case "feishu_doc_permission": return await execDocPermission(args);
      case "feishu_sheet_create": return await execSheetCreate(args);
      case "feishu_sheet_write": return await execSheetWrite(args);
      case "feishu_sheet_read": return await execSheetRead(args);
      case "feishu_group_manage": return await execGroupManage(args);
      case "feishu_calendar": return await execCalendar(args);
      case "feishu_task": return await execTask(args);
      case "feishu_approval": return await execApproval(args);
      case "feishu_work_log": return await execWorkLog(args, effectiveDb, userId);
      case "feishu_meeting_minutes": return await execMeetingMinutes(args, effectiveDb, userId);
      case "feishu_work_report": return await execWorkReport(args, effectiveDb, userId);
      default: return JSON.stringify({ error: `未知飞书工具: ${toolName}` });
    }
  } catch (e: any) {
    console.error(`[FeishuTool] ${toolName} 失败:`, e.message || e);
    return JSON.stringify({ error: `飞书操作失败: ${e.message || "未知错误"}` });
  }
}

// ─── 发送消息（文本/富文本/卡片）──────────────────────────

const CARD_COLORS: Record<string, string> = { blue: "blue", green: "green", orange: "orange", red: "red", purple: "purple" };

async function execSendMessage(args: Record<string, unknown>): Promise<string> {
  const receiveId = String(args.receive_id || "").trim();
  const receiveIdType = String(args.receive_id_type || "open_id").trim();
  const content = String(args.content || "").trim();
  const msgType = String(args.msg_type || "text").trim();

  if (!receiveId || !content) return JSON.stringify({ error: "receive_id 和 content 不能为空" });

  let finalMsgType = "text";
  let finalContent = JSON.stringify({ text: content });

  if (msgType === "post") {
    finalMsgType = "post";
    const lines = content.split("\n").map((line: string) => [{ tag: "text", text: line }]);
    finalContent = JSON.stringify({ zh_cn: { title: String(args.card_title || ""), content: lines } });
  } else if (msgType === "interactive") {
    finalMsgType = "interactive";
    const color = CARD_COLORS[String(args.card_color || "blue")] || "blue";
    const title = String(args.card_title || "通知");
    finalContent = JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: title }, template: color },
      elements: [{ tag: "markdown", content }],
    });
  }

  console.log(`[FeishuSend] to=${receiveId} type=${receiveIdType} msgType=${finalMsgType} content=${finalContent.slice(0, 100)}`);
  const resp = await _larkClient!.im.message.create({
    params: { receive_id_type: receiveIdType as any },
    data: { receive_id: receiveId, msg_type: finalMsgType, content: finalContent },
  });
  const msgId = resp?.data?.message_id;
  console.log(`[FeishuSend] result: message_id=${msgId}, code=${(resp as any)?.code}`);

  if (!msgId) {
    return JSON.stringify({ error: "消息发送可能失败", detail: resp?.data || resp, hint: "请确认：1) 飞书应用「可用范围」已设为全部员工；2) 接收者已安装该应用" });
  }

  return JSON.stringify({ success: true, message_id: msgId, summary: `已发送${msgType === "interactive" ? "卡片" : ""}消息` });
}

// ─── 群发消息 ──────────────────────────────────────────

async function execBatchSend(args: Record<string, unknown>): Promise<string> {
  const ids = String(args.receive_ids || "").split(",").map(s => s.trim()).filter(Boolean);
  const idType = String(args.receive_id_type || "open_id").trim();
  const content = String(args.content || "").trim();

  if (ids.length === 0) return JSON.stringify({ error: "receive_ids 不能为空" });
  if (!content) return JSON.stringify({ error: "content 不能为空" });

  let sent = 0, failed = 0;
  const errors: string[] = [];

  for (const id of ids) {
    try {
      await _larkClient!.im.message.create({
        params: { receive_id_type: idType as any },
        data: { receive_id: id, msg_type: "text", content: JSON.stringify({ text: content }) },
      });
      sent++;
    } catch (e: any) {
      failed++;
      errors.push(`${id}: ${e.message || "失败"}`);
    }
  }

  return JSON.stringify({ success: true, sent, failed, total: ids.length, errors: errors.length > 0 ? errors : undefined, summary: `群发完成：${sent} 成功，${failed} 失败` });
}

// ─── 通讯录搜索 ──────────────────────────────────────────

async function execSearchContact(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) return JSON.stringify({ error: "搜索关键词不能为空" });

  try {
    const allUsers = await getAllUsers();

    const matched = allUsers.filter((u: any) => {
      const name = u.name || "";
      const enName = u.en_name || "";
      const mobile = u.mobile || "";
      return name.includes(query) || enName.toLowerCase().includes(query.toLowerCase()) || mobile.includes(query);
    });

    const seen = new Set<string>();
    const results = matched.filter((u: any) => {
      if (seen.has(u.open_id)) return false;
      seen.add(u.open_id);
      return true;
    }).slice(0, 10).map((u: any) => ({
      open_id: u.open_id, name: u.name, en_name: u.en_name || "",
      mobile: u.mobile || "", department: u.department_ids?.[0] || "", email: u.email || "",
    }));

    return JSON.stringify({
      results,
      total: matched.length,
      scanned_users: allUsers.length,
      message: matched.length === 0 ? `在 ${allUsers.length} 名成员中未找到「${query}」` : undefined,
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg.includes("403") || msg.includes("permission") || msg.includes("99991668") || msg.includes("99991672")) {
      return JSON.stringify({
        error: "通讯录权限不足",
        hint: "需要飞书管理员在「管理后台 → 工作台管理 → 应用管理」中，将该应用的「通讯录权限范围」设置为「全部成员」。同时确保应用已开启 contact:user.employee_id:readonly 和 contact:user.base:readonly 权限。",
        suggestion: "如果你知道对方的飞书 open_id（格式 ou_xxxxxx），可以直接提供给我，跳过搜索直接发送。",
      });
    }
    throw e;
  }
}

// ─── 创建文档 ──────────────────────────────────────────

async function execDocCreate(args: Record<string, unknown>): Promise<string> {
  const title = String(args.title || "").trim();
  const folderToken = String(args.folder_token || "").trim();
  if (!title) return JSON.stringify({ error: "文档标题不能为空" });

  const resp = await _larkClient!.docx.document.create({
    data: { title, folder_token: folderToken || undefined },
  });
  const doc = resp?.data?.document;
  return JSON.stringify({ success: true, document_id: doc?.document_id, title: doc?.title, url: `https://feishu.cn/docx/${doc?.document_id}` });
}

// ─── 读取文档 ──────────────────────────────────────────

async function execDocRead(args: Record<string, unknown>): Promise<string> {
  const documentId = String(args.document_id || "").trim();
  if (!documentId) return JSON.stringify({ error: "document_id 不能为空" });

  const resp = await _larkClient!.docx.document.rawContent({ path: { document_id: documentId } });
  return JSON.stringify({ success: true, document_id: documentId, content: resp?.data?.content || "" });
}

// ─── 向文档追加内容 ──────────────────────────────────────

async function execDocWrite(args: Record<string, unknown>): Promise<string> {
  const documentId = String(args.document_id || "").trim();
  const content = String(args.content || "").trim();
  if (!documentId || !content) return JSON.stringify({ error: "document_id 和 content 不能为空" });

  const paragraphs = content.split("\n").filter(line => line.trim());
  for (const text of paragraphs) {
    await _larkClient!.docx.documentBlockChildren.create({
      path: { document_id: documentId, block_id: documentId },
      data: { children: [{ block_type: 2, paragraph: { elements: [{ text_run: { content: text } }] } }], index: -1 } as any,
    });
  }
  return JSON.stringify({ success: true, document_id: documentId, paragraphs_added: paragraphs.length });
}

// ─── 列出文件 ──────────────────────────────────────────

async function execListDocs(args: Record<string, unknown>): Promise<string> {
  const folderToken = String(args.folder_token || "").trim();
  const pageSize = Math.min(Number(args.page_size) || 20, 200);

  const resp = await _larkClient!.drive.file.list({ params: { folder_token: folderToken || undefined, page_size: pageSize } as any });
  const files = (resp?.data?.files || []).map((f: any) => ({ token: f.token, name: f.name, type: f.type, url: f.url || "" }));
  return JSON.stringify({ files, total: files.length, has_more: resp?.data?.has_more || false });
}

// ─── 工作日志 ──────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function mondayStr(): string {
  const d = new Date();
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

async function execWorkLog(args: Record<string, unknown>, db: Db | null, userId?: string): Promise<string> {
  if (!db) return JSON.stringify({ error: "数据库未就绪" });
  const action = String(args.action || "").trim();
  const uid = userId || "local_user";

  if (action === "add") {
    const content = String(args.content || "").trim();
    if (!content) return JSON.stringify({ error: "工作内容不能为空" });
    const logDate = String(args.date || todayStr()).trim();
    const category = String(args.category || "general").trim();
    const id = uuid();
    await db.query(
      "INSERT INTO opc_work_logs (id, user_id, log_date, category, content, source, created_at) VALUES ($1,$2,$3,$4,$5,'manual',NOW())",
      [id, uid, logDate, category, content],
    );
    return JSON.stringify({ success: true, log_id: id, date: logDate, category, summary: `已记录工作日志` });
  }

  if (action === "list") {
    const startDate = String(args.start_date || mondayStr()).trim();
    const endDate = String(args.end_date || todayStr()).trim();
    const { rows } = await db.query(
      "SELECT id, log_date, category, content, source, created_at FROM opc_work_logs WHERE user_id = $1 AND log_date >= $2 AND log_date <= $3 ORDER BY log_date DESC, created_at DESC",
      [uid, startDate, endDate],
    );
    return JSON.stringify({ logs: rows, total: rows.length, range: { start: startDate, end: endDate } });
  }

  if (action === "delete") {
    const logId = String(args.log_id || "").trim();
    if (!logId) return JSON.stringify({ error: "log_id 不能为空" });
    await db.query("DELETE FROM opc_work_logs WHERE id = $1 AND user_id = $2", [logId, uid]);
    return JSON.stringify({ success: true, summary: "已删除" });
  }

  return JSON.stringify({ error: "未知 action，支持: add, list, delete" });
}

// ─── 会议纪要生成 ──────────────────────────────────────

async function execMeetingMinutes(args: Record<string, unknown>, db: Db | null, userId?: string): Promise<string> {
  const topic = String(args.meeting_topic || "").trim();
  const rawContent = String(args.meeting_content || "").trim();
  const participants = String(args.participants || "").split(",").map(s => s.trim()).filter(Boolean);
  const date = String(args.date || todayStr()).trim();
  const shouldSend = args.send_to_participants !== false;

  if (!topic || !rawContent) return JSON.stringify({ error: "meeting_topic 和 meeting_content 不能为空" });

  const aiResp = await callAi([{
    role: "system",
    content: `你是一位专业的会议纪要整理助手。请将以下会议内容整理成结构化的会议纪要。

格式要求：
会议主题：${topic}
会议日期：${date}
参会人员：${participants.length > 0 ? participants.join("、") : "待补充"}

一、会议要点
（分条列出讨论的核心要点）

二、决议事项
（列出会议达成的决策和结论）

三、待办事项
（列出后续需要跟进的任务，标注负责人和时间）

请用简洁专业的中文输出，不要使用 Markdown 语法。`,
  }, {
    role: "user",
    content: rawContent,
  }]);

  const minutes = aiResp.content;

  if (db) {
    const uid = userId || "local_user";
    await db.query(
      "INSERT INTO opc_work_logs (id, user_id, log_date, category, content, source, created_at) VALUES ($1,$2,$3,'meeting',$4,'meeting_minutes',NOW())",
      [uuid(), uid, date, `【会议纪要】${topic}\n${minutes}`],
    );
  }

  let docResult: any = null;
  if (_larkClient) {
    try {
      const docResp = await _larkClient.docx.document.create({
        data: { title: `会议纪要 - ${topic} (${date})` },
      });
      const docId = docResp?.data?.document?.document_id;
      if (docId) {
        const paragraphs = minutes.split("\n").filter((l: string) => l.trim());
        for (const text of paragraphs) {
          await _larkClient.docx.documentBlockChildren.create({
            path: { document_id: docId, block_id: docId },
            data: { children: [{ block_type: 2, paragraph: { elements: [{ text_run: { content: text } }] } }], index: -1 } as any,
          });
        }
        docResult = { document_id: docId, url: `https://feishu.cn/docx/${docId}` };
      }
    } catch (e: any) {
      console.error("[FeishuTool] 创建会议纪要文档失败:", e.message);
    }
  }

  let sendResults: any = null;
  if (shouldSend && participants.length > 0 && _larkClient) {
    sendResults = [];
    for (const name of participants) {
      try {
        const user = await findUserByName(name);
        if (user?.open_id) {
          const docUrl = docResult?.url || "";
          const msgText = `📋 会议纪要已整理完成\n主题：${topic}\n日期：${date}\n${docUrl ? `文档链接：${docUrl}` : ""}`;
          await _larkClient.im.message.create({
            params: { receive_id_type: "open_id" },
            data: { receive_id: user.open_id, msg_type: "text", content: JSON.stringify({ text: msgText }) },
          });
          sendResults.push({ name, status: "sent" });
        } else {
          sendResults.push({ name, status: "not_found" });
        }
      } catch {
        sendResults.push({ name, status: "failed" });
      }
    }
  }

  return JSON.stringify({
    success: true,
    minutes,
    document: docResult,
    notifications: sendResults,
    summary: `会议纪要「${topic}」已生成${docResult ? "并创建云文档" : ""}${sendResults ? `，已通知 ${sendResults.filter((r: any) => r.status === "sent").length} 人` : ""}`,
  });
}

// ─── 工作进度报告 ──────────────────────────────────────

async function execWorkReport(args: Record<string, unknown>, db: Db | null, userId?: string): Promise<string> {
  if (!db) return JSON.stringify({ error: "数据库未就绪" });

  const uid = userId || "local_user";
  const reportType = String(args.report_type || "weekly").trim();
  const startDate = String(args.start_date || mondayStr()).trim();
  const endDate = String(args.end_date || todayStr()).trim();
  const sendTo = String(args.send_to || "").trim();
  const extraNotes = String(args.extra_notes || "").trim();

  const { rows: logs } = await db.query(
    "SELECT log_date, category, content FROM opc_work_logs WHERE user_id = $1 AND log_date >= $2 AND log_date <= $3 ORDER BY log_date ASC, created_at ASC",
    [uid, startDate, endDate],
  );

  if (logs.length === 0) {
    return JSON.stringify({ error: `${startDate} 至 ${endDate} 期间没有工作日志记录。请先用 feishu_work_log 记录工作内容。` });
  }

  const logsText = logs.map((l: any) => `[${l.log_date}] [${l.category}] ${l.content}`).join("\n");
  const typeLabel = reportType === "daily" ? "日报" : reportType === "weekly" ? "周报" : "工作报告";

  const aiResp = await callAi([{
    role: "system",
    content: `你是一位专业的工作汇报助手。请根据以下工作日志，整理成一份${typeLabel}。

格式要求：
${typeLabel}（${startDate} ~ ${endDate}）

一、本${reportType === "daily" ? "日" : "周"}完成工作
（按类别分组，简洁列出已完成的工作）

二、进行中的工作
（列出正在推进但未完成的事项）

三、遇到的问题
（如有）

四、下${reportType === "daily" ? "日" : "周"}计划
（简要规划）

请用简洁专业的中文输出，不要使用 Markdown 语法。直接输出报告内容。
${extraNotes ? `\n补充说明：${extraNotes}` : ""}`,
  }, {
    role: "user",
    content: logsText,
  }]);

  const report = aiResp.content;

  let docResult: any = null;
  if (_larkClient) {
    try {
      const title = `${typeLabel} (${startDate} ~ ${endDate})`;
      const docResp = await _larkClient.docx.document.create({ data: { title } });
      const docId = docResp?.data?.document?.document_id;
      if (docId) {
        const paragraphs = report.split("\n").filter((l: string) => l.trim());
        for (const text of paragraphs) {
          await _larkClient.docx.documentBlockChildren.create({
            path: { document_id: docId, block_id: docId },
            data: { children: [{ block_type: 2, paragraph: { elements: [{ text_run: { content: text } }] } }], index: -1 } as any,
          });
        }
        docResult = { document_id: docId, url: `https://feishu.cn/docx/${docId}`, title };
      }
    } catch (e: any) {
      console.error("[FeishuTool] 创建工作报告文档失败:", e.message);
    }
  }

  let sendResult: any = null;
  if (sendTo && _larkClient) {
    try {
      const user = await findUserByName(sendTo);
      if (user?.open_id) {
        const docUrl = docResult?.url || "";
        const msgText = `📊 ${typeLabel}已提交\n时间范围：${startDate} ~ ${endDate}\n${docUrl ? `文档链接：${docUrl}` : ""}`;
        await _larkClient.im.message.create({
          params: { receive_id_type: "open_id" },
          data: { receive_id: user.open_id, msg_type: "text", content: JSON.stringify({ text: msgText }) },
        });
        sendResult = { name: sendTo, status: "sent" };
      } else {
        sendResult = { name: sendTo, status: "not_found" };
      }
    } catch {
      sendResult = { name: sendTo, status: "failed" };
    }
  }

  return JSON.stringify({
    success: true,
    report,
    document: docResult,
    notification: sendResult,
    logs_count: logs.length,
    summary: `${typeLabel}已生成（基于 ${logs.length} 条日志）${docResult ? "，已创建云文档" : ""}${sendResult?.status === "sent" ? `，已发送给${sendTo}` : ""}`,
  });
}

// ─── 文档权限管理 ──────────────────────────────────────

async function execDocPermission(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action || "").trim();
  const token = String(args.token || "").trim();
  const tokenType = String(args.token_type || "docx").trim();
  if (!token) return JSON.stringify({ error: "token 不能为空" });
  const client = _larkClient as any;

  if (action === "add_member") {
    const memberId = String(args.member_id || "").trim();
    const perm = String(args.perm || "view").trim();
    if (!memberId) return JSON.stringify({ error: "member_id 不能为空" });
    const permMap: Record<string, string> = { view: "view", edit: "edit", full_access: "full_access" };
    await client.request({
      method: "POST",
      url: `/open-apis/drive/v1/permissions/${token}/members?type=${tokenType}&need_notification=true`,
      data: { member_type: "openid", member_id: memberId, perm: permMap[perm] || "view" },
    });
    return JSON.stringify({ success: true, summary: `已授予 ${perm} 权限` });
  }

  if (action === "set_public") {
    const linkShare = String(args.link_share_entity || "tenant_readable").trim();
    await client.request({
      method: "PATCH",
      url: `/open-apis/drive/v1/permissions/${token}/public?type=${tokenType}`,
      data: { link_share_entity: linkShare, external_access_entity: "open" },
    });
    return JSON.stringify({ success: true, summary: `已设置链接分享: ${linkShare}` });
  }

  if (action === "list_members") {
    const resp = await client.request({
      method: "GET",
      url: `/open-apis/drive/v1/permissions/${token}/members?type=${tokenType}`,
    });
    const members = (resp?.data?.items || []).map((m: any) => ({
      member_type: m.member_type, member_id: m.member_id, perm: m.perm,
    }));
    return JSON.stringify({ members, total: members.length });
  }

  return JSON.stringify({ error: "未知 action，支持: add_member, set_public, list_members" });
}

// ─── 电子表格 ──────────────────────────────────────────

async function execSheetCreate(args: Record<string, unknown>): Promise<string> {
  const title = String(args.title || "").trim();
  const folderToken = String(args.folder_token || "").trim();
  if (!title) return JSON.stringify({ error: "表格标题不能为空" });
  const client = _larkClient as any;

  const resp = await client.request({
    method: "POST",
    url: "/open-apis/sheets/v3/spreadsheets",
    data: { title, folder_token: folderToken || undefined },
  });
  const sheet = resp?.data?.spreadsheet;
  return JSON.stringify({
    success: true,
    spreadsheet_token: sheet?.spreadsheet_token,
    title: sheet?.title,
    url: sheet?.url || `https://feishu.cn/sheets/${sheet?.spreadsheet_token}`,
  });
}

async function execSheetWrite(args: Record<string, unknown>): Promise<string> {
  const token = String(args.spreadsheet_token || "").trim();
  if (!token) return JSON.stringify({ error: "spreadsheet_token 不能为空" });
  const client = _larkClient as any;

  let data: any[][];
  try {
    data = JSON.parse(String(args.data || "[]"));
    if (!Array.isArray(data)) throw new Error("data 必须是二维数组");
  } catch (e: any) {
    return JSON.stringify({ error: `data 格式错误: ${e.message}` });
  }

  let sheetId = String(args.sheet_id || "").trim();
  if (!sheetId) {
    const meta = await client.request({ method: "GET", url: `/open-apis/sheets/v3/spreadsheets/${token}` });
    sheetId = meta?.data?.spreadsheet?.sheets?.[0]?.sheet_id || "";
  }

  const range = String(args.range || "").trim();
  const fullRange = range ? `${sheetId}!${range}` : `${sheetId}!A1`;

  await client.request({
    method: "PUT",
    url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
    data: { valueRange: { range: fullRange, values: data } },
  }).catch(async () => {
    for (let r = 0; r < data.length; r++) {
      try {
        await client.request({
          method: "PUT",
          url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
          data: { valueRange: { range: `${sheetId}!A${r + 1}`, values: [data[r]] } },
        });
      } catch { /* best effort */ }
    }
  });

  return JSON.stringify({ success: true, rows_written: data.length, summary: `已写入 ${data.length} 行数据` });
}

async function execSheetRead(args: Record<string, unknown>): Promise<string> {
  const token = String(args.spreadsheet_token || "").trim();
  if (!token) return JSON.stringify({ error: "spreadsheet_token 不能为空" });
  const client = _larkClient as any;

  let sheetId = String(args.sheet_id || "").trim();
  if (!sheetId) {
    const meta = await client.request({ method: "GET", url: `/open-apis/sheets/v3/spreadsheets/${token}` });
    sheetId = meta?.data?.spreadsheet?.sheets?.[0]?.sheet_id || "";
  }

  const range = String(args.range || "A1:Z100").trim();
  const fullRange = `${sheetId}!${range}`;

  const resp = await client.request({
    method: "GET",
    url: `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(fullRange)}`,
  });

  const values = resp?.data?.valueRange?.values || [];
  return JSON.stringify({ success: true, data: values, rows: values.length });
}

// ─── 群聊管理 ──────────────────────────────────────────

async function execGroupManage(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action || "").trim();

  if (action === "create") {
    const name = String(args.name || "").trim();
    if (!name) return JSON.stringify({ error: "群名称不能为空" });
    const memberIds = String(args.member_ids || "").split(",").map(s => s.trim()).filter(Boolean);
    const resp = await _larkClient!.im.chat.create({
      data: {
        name,
        description: String(args.description || ""),
        chat_mode: "group",
        chat_type: "private",
        ...(memberIds.length > 0 ? { user_id_list: memberIds } : {}),
      } as any,
      params: { user_id_type: "open_id" } as any,
    });
    return JSON.stringify({ success: true, chat_id: resp?.data?.chat_id, summary: `群「${name}」已创建` });
  }

  if (action === "add_members") {
    const chatId = String(args.chat_id || "").trim();
    const memberIds = String(args.member_ids || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!chatId || memberIds.length === 0) return JSON.stringify({ error: "chat_id 和 member_ids 不能为空" });
    await _larkClient!.im.chatMembers.create({
      path: { chat_id: chatId },
      data: { id_list: memberIds },
      params: { member_id_type: "open_id" } as any,
    });
    return JSON.stringify({ success: true, summary: `已添加 ${memberIds.length} 人到群聊` });
  }

  if (action === "remove_member") {
    const chatId = String(args.chat_id || "").trim();
    const memberId = String(args.member_id || "").trim();
    if (!chatId || !memberId) return JSON.stringify({ error: "chat_id 和 member_id 不能为空" });
    await _larkClient!.im.chatMembers.delete({
      path: { chat_id: chatId },
      data: { id_list: [memberId] },
      params: { member_id_type: "open_id" } as any,
    });
    return JSON.stringify({ success: true, summary: "已移除成员" });
  }

  if (action === "list_members") {
    const chatId = String(args.chat_id || "").trim();
    if (!chatId) return JSON.stringify({ error: "chat_id 不能为空" });
    const resp = await _larkClient!.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: "open_id" } as any,
    });
    const members = (resp?.data?.items || []).map((m: any) => ({
      member_id: m.member_id, name: m.name, tenant_key: m.tenant_key,
    }));
    return JSON.stringify({ members, total: members.length });
  }

  if (action === "update") {
    const chatId = String(args.chat_id || "").trim();
    if (!chatId) return JSON.stringify({ error: "chat_id 不能为空" });
    const updateData: any = {};
    if (args.name) updateData.name = String(args.name);
    if (args.description) updateData.description = String(args.description);
    await _larkClient!.im.chat.update({
      path: { chat_id: chatId },
      data: updateData,
    });
    return JSON.stringify({ success: true, summary: "群信息已更新" });
  }

  if (action === "list_groups") {
    const resp = await _larkClient!.im.chat.list({
      params: { page_size: 50 } as any,
    });
    const chats = (resp?.data?.items || []).map((c: any) => ({
      chat_id: c.chat_id, name: c.name, owner_id: c.owner_id, member_count: c.user_count,
    }));
    return JSON.stringify({ groups: chats, total: chats.length });
  }

  return JSON.stringify({ error: "未知 action，支持: create, add_members, remove_member, list_members, update, list_groups" });
}

// ─── 日历 ──────────────────────────────────────────────

function toTimestamp(dateStr: string): string {
  const d = new Date(dateStr.replace(" ", "T"));
  return isNaN(d.getTime()) ? String(Math.floor(Date.now() / 1000)) : String(Math.floor(d.getTime() / 1000));
}

async function execCalendar(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action || "").trim();
  const client = _larkClient as any;

  if (action === "create") {
    const summary = String(args.summary || "").trim();
    const startTime = String(args.start_time || "").trim();
    const endTime = String(args.end_time || "").trim();
    if (!summary || !startTime || !endTime) return JSON.stringify({ error: "summary, start_time, end_time 不能为空" });

    const attendeeIds = String(args.attendee_ids || "").split(",").map(s => s.trim()).filter(Boolean);

    const resp = await client.request({
      method: "POST",
      url: "/open-apis/calendar/v4/calendars/primary/events",
      data: {
        summary,
        description: String(args.description || ""),
        start_time: { timestamp: toTimestamp(startTime) },
        end_time: { timestamp: toTimestamp(endTime) },
        attendee_ability: "can_modify_event",
      },
    });

    const eventId = resp?.data?.event?.event_id;

    if (eventId && attendeeIds.length > 0) {
      try {
        await client.request({
          method: "POST",
          url: `/open-apis/calendar/v4/calendars/primary/events/${eventId}/attendees?user_id_type=open_id`,
          data: { attendees: attendeeIds.map(id => ({ type: "user", user_id: id })) },
        });
      } catch (e: any) {
        console.error("[FeishuTool] 添加日程参与人失败:", e.message);
      }
    }

    return JSON.stringify({ success: true, event_id: eventId, summary: `日程「${summary}」已创建${attendeeIds.length > 0 ? `，已邀请 ${attendeeIds.length} 人` : ""}` });
  }

  if (action === "list") {
    const startDate = String(args.start_date || todayStr()).trim();
    const d = new Date(startDate);
    const endDate = String(args.end_date || "").trim() || new Date(d.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const startTs = toTimestamp(startDate + " 00:00");
    const endTs = toTimestamp(endDate + " 23:59");

    const resp = await client.request({
      method: "GET",
      url: `/open-apis/calendar/v4/calendars/primary/events?start_time=${startTs}&end_time=${endTs}&page_size=50`,
    });

    const events = (resp?.data?.items || []).map((e: any) => ({
      event_id: e.event_id,
      summary: e.summary,
      start: e.start_time?.date || new Date(Number(e.start_time?.timestamp || 0) * 1000).toISOString(),
      end: e.end_time?.date || new Date(Number(e.end_time?.timestamp || 0) * 1000).toISOString(),
      status: e.status,
    }));
    return JSON.stringify({ events, total: events.length, range: { start: startDate, end: endDate } });
  }

  return JSON.stringify({ error: "未知 action，支持: create, list" });
}

// ─── 任务 ──────────────────────────────────────────────

async function execTask(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action || "").trim();

  if (action === "create") {
    const summary = String(args.summary || "").trim();
    if (!summary) return JSON.stringify({ error: "任务标题不能为空" });
    const description = String(args.description || "").trim();
    const dueDate = String(args.due_date || "").trim();
    const assigneeIds = String(args.assignee_ids || "").split(",").map(s => s.trim()).filter(Boolean);

    const taskData: any = { summary };
    if (description) taskData.description = description;
    if (dueDate) taskData.due = { timestamp: toTimestamp(dueDate + " 23:59"), is_all_day: true };
    if (assigneeIds.length > 0) {
      taskData.members = assigneeIds.map(id => ({ id, type: "user", role: "assignee" }));
    }

    const resp = await (_larkClient as any).request?.({
      method: "POST",
      url: "/open-apis/task/v2/tasks",
      data: taskData,
    });

    return JSON.stringify({
      success: true,
      task_id: resp?.data?.task?.guid,
      summary: `任务「${summary}」已创建${assigneeIds.length > 0 ? `，已分配给 ${assigneeIds.length} 人` : ""}`,
    });
  }

  if (action === "list") {
    const pageSize = Math.min(Number(args.page_size) || 20, 100);
    const resp = await (_larkClient as any).request?.({
      method: "GET",
      url: `/open-apis/task/v2/tasks?page_size=${pageSize}`,
    });

    const tasks = (resp?.data?.items || []).map((t: any) => ({
      task_id: t.guid, summary: t.summary, completed_at: t.completed_at, due: t.due,
    }));
    return JSON.stringify({ tasks, total: tasks.length });
  }

  return JSON.stringify({ error: "未知 action，支持: create, list" });
}

// ─── 审批 ──────────────────────────────────────────────

async function execApproval(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action || "").trim();

  if (action === "list_definitions") {
    const resp = await (_larkClient as any).request?.({
      method: "GET",
      url: "/open-apis/approval/v4/approvals?page_size=50",
    });
    const items = (resp?.data?.items || []).map((a: any) => ({
      approval_code: a.approval_code, approval_name: a.approval_name, status: a.status,
    }));
    return JSON.stringify({ definitions: items, total: items.length });
  }

  if (action === "list_instances") {
    const code = String(args.approval_code || "").trim();
    if (!code) return JSON.stringify({ error: "approval_code 不能为空" });
    const pageSize = Math.min(Number(args.page_size) || 20, 100);
    const resp = await (_larkClient as any).request?.({
      method: "GET",
      url: `/open-apis/approval/v4/instances?approval_code=${code}&page_size=${pageSize}`,
    });
    const instances = (resp?.data?.items || []).map((i: any) => ({
      instance_code: i.instance_code, status: i.status, user_id: i.user_id,
      start_time: i.start_time, end_time: i.end_time,
    }));
    return JSON.stringify({ instances, total: instances.length });
  }

  return JSON.stringify({ error: "未知 action，支持: list_definitions, list_instances" });
}
