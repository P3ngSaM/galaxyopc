/**
 * 物联网空间管理 API — 创建空间、管理房间、智能产品推荐、3D 布局
 */
import type { ServerResponse } from "node:http";
import type { AuthRequest } from "../auth/middleware.js";
import { sendJson, parseBody, requireAuth } from "../auth/middleware.js";
import type { Db } from "../db.js";
import { callAi } from "../chat/ai-client.js";
import type { ChatMessage } from "../chat/ai-client.js";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";

const PHOTO_DIR = resolve(process.cwd(), basename(process.cwd()) === "opc-server" ? "uploads" : "opc-server/uploads", "iot-photos");

interface RoomRecommendation {
  room_type: string;
  area: number;
  products: Array<{ product_id: string; name: string; category: string; icon: string; quantity: number; reason: string }>;
}

const ROOM_RULES: Record<string, (area: number) => Array<{ product_id: string; quantity: number | ((a: number) => number); reason: string }>> = {
  office: (area) => [
    { product_id: "prod_desk_exec", quantity: Math.max(1, Math.floor(area / 6)), reason: "每 6㎡ 配一个工位" },
    { product_id: "prod_chair_ergo", quantity: Math.max(1, Math.floor(area / 6)), reason: "每个工位配一把椅子" },
    { product_id: "prod_cabinet", quantity: Math.max(1, Math.floor(area / 15)), reason: "每 15㎡ 配一个文件柜" },
    { product_id: "prod_sensor_temp", quantity: 1, reason: "监控办公区温湿度" },
    { product_id: "prod_sensor_motion", quantity: 1, reason: "智能节能，无人时自动关灯" },
    { product_id: "prod_smart_light", quantity: Math.max(1, Math.ceil(area / 15)), reason: "每 15㎡ 一个灯控面板" },
    ...(area >= 20 ? [{ product_id: "prod_smart_ac", quantity: 1, reason: "面积较大需独立空调控制" }] : []),
    ...(area >= 30 ? [{ product_id: "prod_ap", quantity: 1, reason: "大面积办公区需独立无线覆盖" }] : []),
    ...(area >= 30 ? [{ product_id: "prod_printer", quantity: 1, reason: "大面积办公区配置网络打印机" }] : []),
  ],
  meeting: (area) => [
    { product_id: "prod_conf_table", quantity: 1, reason: "会议室标配会议桌" },
    { product_id: "prod_conf_chair", quantity: Math.max(4, Math.floor(area / 2.5)), reason: "按面积配置座椅" },
    { product_id: "prod_screen", quantity: 1, reason: "会议演示必备" },
    { product_id: "prod_sensor_motion", quantity: 1, reason: "自动检测会议室占用状态" },
    { product_id: "prod_smart_light", quantity: 1, reason: "会议模式灯光控制" },
    ...(area >= 15 ? [{ product_id: "prod_whiteboard", quantity: 1, reason: "中大型会议室配智能白板" }] : []),
    ...(area >= 15 ? [{ product_id: "prod_sensor_air", quantity: 1, reason: "密闭会议室需监控空气质量" }] : []),
    ...(area >= 10 ? [{ product_id: "prod_smart_ac", quantity: 1, reason: "独立温控提升会议体验" }] : []),
  ],
  reception: (area) => [
    { product_id: "prod_sofa", quantity: Math.max(1, Math.floor(area / 10)), reason: "接待区配置沙发" },
    { product_id: "prod_camera", quantity: 1, reason: "门禁安全监控" },
    { product_id: "prod_smart_lock", quantity: 1, reason: "智能门禁管理" },
    { product_id: "prod_smart_light", quantity: 1, reason: "接待区灯光氛围" },
    { product_id: "prod_sensor_temp", quantity: 1, reason: "保持接待区舒适温度" },
  ],
  server_room: (_area) => [
    { product_id: "prod_sensor_temp", quantity: 2, reason: "机房温湿度需双传感器冗余监控" },
    { product_id: "prod_sensor_air", quantity: 1, reason: "监控机房环境" },
    { product_id: "prod_camera", quantity: 1, reason: "机房安全监控" },
    { product_id: "prod_smart_lock", quantity: 1, reason: "机房门禁" },
    { product_id: "prod_smart_ac", quantity: 1, reason: "精密空调控制" },
    { product_id: "prod_router", quantity: 1, reason: "网络核心设备" },
    { product_id: "prod_switch", quantity: 1, reason: "网络交换设备" },
  ],
  restroom: (_area) => [
    { product_id: "prod_sensor_motion", quantity: 1, reason: "智能照明节能" },
    { product_id: "prod_smart_light", quantity: 1, reason: "感应灯控" },
  ],
  storage: (_area) => [
    { product_id: "prod_cabinet", quantity: 2, reason: "存储空间配置文件柜" },
    { product_id: "prod_sensor_temp", quantity: 1, reason: "存储环境监控" },
    { product_id: "prod_smart_lock", quantity: 1, reason: "库房门禁" },
  ],
  pantry: (area) => [
    { product_id: "prod_sensor_temp", quantity: 1, reason: "茶水间环境监控" },
    { product_id: "prod_smart_light", quantity: 1, reason: "灯控" },
    ...(area >= 8 ? [{ product_id: "prod_sensor_air", quantity: 1, reason: "茶水间通风质量监控" }] : []),
  ],
  open_area: (area) => [
    { product_id: "prod_desk_exec", quantity: Math.max(2, Math.floor(area / 5)), reason: "开放工位区每 5㎡ 一个工位" },
    { product_id: "prod_chair_ergo", quantity: Math.max(2, Math.floor(area / 5)), reason: "每个工位配椅" },
    { product_id: "prod_smart_light", quantity: Math.max(1, Math.ceil(area / 12)), reason: "开放区密集照明" },
    { product_id: "prod_sensor_temp", quantity: Math.max(1, Math.ceil(area / 30)), reason: "大面积多点温控" },
    { product_id: "prod_sensor_motion", quantity: Math.max(1, Math.ceil(area / 25)), reason: "多区域人感" },
    { product_id: "prod_ap", quantity: Math.max(1, Math.ceil(area / 40)), reason: "大面积无线覆盖" },
    ...(area >= 50 ? [{ product_id: "prod_router", quantity: 1, reason: "大面积需核心路由" }] : []),
    ...(area >= 40 ? [{ product_id: "prod_printer", quantity: 1, reason: "公共打印区" }] : []),
  ],
  lobby: (area) => [
    { product_id: "prod_smart_light", quantity: Math.max(2, Math.ceil(area / 10)), reason: "大堂需充足照明" },
    { product_id: "prod_camera", quantity: Math.max(1, Math.ceil(area / 30)), reason: "大堂安全监控" },
    { product_id: "prod_sensor_motion", quantity: 1, reason: "智能迎宾感应" },
    { product_id: "prod_smart_lock", quantity: 1, reason: "大门智能门禁" },
    ...(area >= 20 ? [{ product_id: "prod_smart_ac", quantity: 1, reason: "大堂独立空调" }] : []),
  ],
  private_room: (area) => [
    { product_id: "prod_smart_light", quantity: 1, reason: "包厢灯光氛围控制" },
    { product_id: "prod_sensor_temp", quantity: 1, reason: "包厢温湿度监控" },
    ...(area >= 10 ? [{ product_id: "prod_smart_ac", quantity: 1, reason: "包厢独立温控" }] : []),
  ],
  kitchen: (area) => [
    { product_id: "prod_sensor_temp", quantity: 1, reason: "厨房温度监控" },
    { product_id: "prod_sensor_air", quantity: 1, reason: "厨房油烟/空气质量" },
    { product_id: "prod_smart_light", quantity: Math.max(1, Math.ceil(area / 10)), reason: "操作照明" },
    { product_id: "prod_camera", quantity: 1, reason: "厨房安全监控" },
  ],
  dining_hall: (area) => [
    { product_id: "prod_smart_light", quantity: Math.max(1, Math.ceil(area / 12)), reason: "餐厅照明" },
    { product_id: "prod_sensor_temp", quantity: 1, reason: "餐厅环境监控" },
    { product_id: "prod_smart_ac", quantity: Math.max(1, Math.ceil(area / 30)), reason: "用餐区空调" },
  ],
  lounge: (area) => [
    { product_id: "prod_sofa", quantity: Math.max(1, Math.floor(area / 8)), reason: "休息区沙发" },
    { product_id: "prod_smart_light", quantity: 1, reason: "休闲氛围灯光" },
    { product_id: "prod_sensor_temp", quantity: 1, reason: "环境舒适监控" },
  ],
  classroom: (area) => [
    { product_id: "prod_desk_exec", quantity: Math.max(4, Math.floor(area / 3)), reason: "课桌" },
    { product_id: "prod_chair_ergo", quantity: Math.max(4, Math.floor(area / 3)), reason: "座椅" },
    { product_id: "prod_screen", quantity: 1, reason: "教学投影/屏幕" },
    { product_id: "prod_smart_light", quantity: Math.max(1, Math.ceil(area / 12)), reason: "教室照明" },
    ...(area >= 30 ? [{ product_id: "prod_ap", quantity: 1, reason: "无线网络" }] : []),
  ],
};

async function getRecommendations(db: Db, roomType: string, area: number): Promise<RoomRecommendation> {
  const ruleFn = ROOM_RULES[roomType] || ROOM_RULES["office"];
  const rules = ruleFn(area);

  const productIds = rules.map(r => r.product_id);
  const { rows: products } = await db.query(
    `SELECT * FROM opc_iot_product_catalog WHERE id = ANY($1)`,
    [productIds]
  );
  const productMap = new Map(products.map(p => [p.id, p]));

  const recommended = rules
    .filter(r => productMap.has(r.product_id))
    .map(r => {
      const p = productMap.get(r.product_id)!;
      const qty = typeof r.quantity === "function" ? r.quantity(area) : r.quantity;
      return {
        product_id: r.product_id,
        name: p.name,
        category: p.category,
        icon: p.icon,
        quantity: qty,
        reason: r.reason,
        price_range: p.price_range,
        is_iot: p.is_iot,
      };
    });

  return { room_type: roomType, area, products: recommended };
}

// ── Spaces CRUD ──

export async function handleListSpaces(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    `SELECT s.*, (SELECT COUNT(*) FROM opc_iot_rooms r WHERE r.space_id = s.id) as room_count
     FROM opc_iot_spaces s WHERE s.user_id = $1 ORDER BY s.updated_at DESC`,
    [req.user!.userId]
  );
  sendJson(res, 200, { spaces: rows });
}

export async function handleGetSpace(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  // 允许通过 space ID 公开访问（3D 页面需要跨账户/匿名查看）
  // 如果有 token 则尝试解析，否则匿名访问
  if (!req.user) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (token) {
      try {
        const { verifyToken } = await import("../auth/jwt.js");
        req.user = verifyToken(token);
      } catch { /* anonymous */ }
    }
  }
  const { rows: spaces } = await db.query("SELECT * FROM opc_iot_spaces WHERE id = $1", [id]);
  if (!spaces.length) return sendJson(res, 404, { error: "空间不存在" });
  const { rows: rooms } = await db.query("SELECT * FROM opc_iot_rooms WHERE space_id = $1 ORDER BY floor, created_at", [id]);
  sendJson(res, 200, { ...spaces[0], rooms });
}

export async function handleCreateSpace(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const id = randomUUID();
  const name = String(body.name || "我的办公空间").trim();
  const totalArea = Number(body.total_area) || 0;
  if (totalArea <= 0) return sendJson(res, 400, { error: "面积必须大于 0" });

  await db.query(
    `INSERT INTO opc_iot_spaces (id, user_id, company_id, name, total_area) VALUES ($1,$2,$3,$4,$5)`,
    [id, req.user!.userId, body.company_id || null, name, totalArea]
  );
  const { rows } = await db.query("SELECT * FROM opc_iot_spaces WHERE id = $1", [id]);
  sendJson(res, 201, rows[0]);
}

export async function handleUpdateSpace(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const fields: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  for (const f of ["name", "total_area", "layout_json", "status"]) {
    if (body[f] !== undefined) {
      fields.push(`${f} = $${idx++}`);
      vals.push(f === "total_area" ? Number(body[f]) : String(body[f]));
    }
  }
  if (!fields.length) return sendJson(res, 400, { error: "无可更新字段" });
  fields.push("updated_at = NOW()");
  vals.push(id, req.user!.userId);
  await db.query(`UPDATE opc_iot_spaces SET ${fields.join(", ")} WHERE id = $${idx++} AND user_id = $${idx}`, vals);
  const { rows } = await db.query("SELECT * FROM opc_iot_spaces WHERE id = $1", [id]);
  sendJson(res, 200, rows[0]);
}

export async function handleDeleteSpace(req: AuthRequest, res: ServerResponse, db: Db, id: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  await db.query("DELETE FROM opc_iot_spaces WHERE id = $1 AND user_id = $2", [id, req.user!.userId]);
  sendJson(res, 200, { success: true });
}

// ── Upload space photo ──

export async function handleUploadSpacePhoto(req: AuthRequest, res: ServerResponse, db: Db, spaceId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query("SELECT 1 FROM opc_iot_spaces WHERE id = $1 AND user_id = $2", [spaceId, req.user!.userId]);
  if (!rows.length) return sendJson(res, 404, { error: "空间不存在" });

  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += (chunk as Buffer).length;
    if (totalSize > 5 * 1024 * 1024) return sendJson(res, 400, { error: "照片不能超过 5MB" });
    chunks.push(chunk as Buffer);
  }
  const buf = Buffer.concat(chunks);

  const fileName = `${spaceId}-${Date.now()}.jpg`;
  await mkdir(PHOTO_DIR, { recursive: true });
  await writeFile(resolve(PHOTO_DIR, fileName), buf);

  const photoUrl = `/iot-photos/${fileName}`;
  const { rows: space } = await db.query("SELECT photo_urls FROM opc_iot_spaces WHERE id = $1", [spaceId]);
  const existing = JSON.parse(space[0]?.photo_urls || "[]");
  existing.push(photoUrl);
  await db.query("UPDATE opc_iot_spaces SET photo_urls = $1, floor_plan_url = $2, updated_at = NOW() WHERE id = $3",
    [JSON.stringify(existing), photoUrl, spaceId]);
  sendJson(res, 200, { photo_url: photoUrl, all_photos: existing });
}

// ── Rooms CRUD ──

export async function handleListRooms(req: AuthRequest, res: ServerResponse, db: Db, spaceId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query(
    `SELECT r.* FROM opc_iot_rooms r
     JOIN opc_iot_spaces s ON r.space_id = s.id
     WHERE s.id = $1 AND s.user_id = $2 ORDER BY r.created_at`,
    [spaceId, req.user!.userId]
  );
  sendJson(res, 200, { rooms: rows });
}

export async function handleCreateRoom(req: AuthRequest, res: ServerResponse, db: Db, spaceId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows: spaceCheck } = await db.query("SELECT 1 FROM opc_iot_spaces WHERE id = $1 AND user_id = $2", [spaceId, req.user!.userId]);
  if (!spaceCheck.length) return sendJson(res, 404, { error: "空间不存在" });

  const body = await parseBody(req);
  const id = randomUUID();
  const roomType = String(body.room_type || "office");
  const area = Number(body.area) || 10;
  const name = String(body.name || ROOM_TYPE_LABELS[roomType] || "房间").trim();

  await db.query(
    `INSERT INTO opc_iot_rooms (id, space_id, name, room_type, area, position_x, position_y, width, depth)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, spaceId, name, roomType, area,
     Number(body.position_x) || 0, Number(body.position_y) || 0,
     Number(body.width) || Math.sqrt(area), Number(body.depth) || Math.sqrt(area)]
  );

  const recommendation = await getRecommendations(db, roomType, area);
  await db.query("UPDATE opc_iot_rooms SET products_json = $1 WHERE id = $2", [JSON.stringify(recommendation.products), id]);

  const { rows } = await db.query("SELECT * FROM opc_iot_rooms WHERE id = $1", [id]);
  sendJson(res, 201, { ...rows[0], recommendations: recommendation });
}

export async function handleUpdateRoom(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const fields: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  for (const f of ["name", "room_type", "area", "position_x", "position_y", "width", "depth", "products_json"]) {
    if (body[f] !== undefined) {
      fields.push(`${f} = $${idx++}`);
      vals.push(["area", "position_x", "position_y", "width", "depth"].includes(f) ? Number(body[f]) : String(body[f]));
    }
  }
  if (!fields.length) return sendJson(res, 400, { error: "无可更新字段" });
  fields.push("updated_at = NOW()");
  vals.push(roomId);
  await db.query(`UPDATE opc_iot_rooms SET ${fields.join(", ")} WHERE id = $${idx}`, vals);

  const { rows } = await db.query("SELECT * FROM opc_iot_rooms WHERE id = $1", [roomId]);
  sendJson(res, 200, rows[0]);
}

export async function handleDeleteRoom(req: AuthRequest, res: ServerResponse, db: Db, roomId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  await db.query(
    `DELETE FROM opc_iot_rooms WHERE id = $1 AND space_id IN (SELECT id FROM opc_iot_spaces WHERE user_id = $2)`,
    [roomId, req.user!.userId]
  );
  sendJson(res, 200, { success: true });
}

// ── Recommendations ──

export async function handleGetRecommendations(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);
  const roomType = String(body.room_type || "office");
  const area = Number(body.area) || 10;
  const rec = await getRecommendations(db, roomType, area);
  sendJson(res, 200, rec);
}

export async function handleAutoLayout(req: AuthRequest, res: ServerResponse, db: Db, spaceId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows: spaces } = await db.query("SELECT * FROM opc_iot_spaces WHERE id = $1 AND user_id = $2", [spaceId, req.user!.userId]);
  if (!spaces.length) return sendJson(res, 404, { error: "空间不存在" });

  const totalArea = spaces[0].total_area;
  const { rows: existingRooms } = await db.query("SELECT * FROM opc_iot_rooms WHERE space_id = $1", [spaceId]);

  if (existingRooms.length > 0) {
    const allRecs = [];
    for (const room of existingRooms) {
      const rec = await getRecommendations(db, room.room_type, room.area);
      await db.query("UPDATE opc_iot_rooms SET products_json = $1, updated_at = NOW() WHERE id = $2",
        [JSON.stringify(rec.products), room.id]);
      allRecs.push({ room_id: room.id, room_name: room.name, ...rec });
    }
    return sendJson(res, 200, { mode: "existing", rooms: allRecs });
  }

  const layout = generateAutoLayout(totalArea);
  const results = [];

  for (const room of layout) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO opc_iot_rooms (id, space_id, name, room_type, area, position_x, position_y, width, depth)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, spaceId, room.name, room.type, room.area, room.x, room.y, room.w, room.d]
    );
    const rec = await getRecommendations(db, room.type, room.area);
    await db.query("UPDATE opc_iot_rooms SET products_json = $1 WHERE id = $2", [JSON.stringify(rec.products), id]);
    results.push({ room_id: id, room_name: room.name, room_type: room.type, area: room.area, recommendations: rec, position: { x: room.x, y: room.y, w: room.w, d: room.d } });
  }

  sendJson(res, 200, { mode: "auto_generated", total_area: totalArea, rooms: results });
}

export async function handleGetProductCatalog(_req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  const { rows } = await db.query("SELECT * FROM opc_iot_product_catalog ORDER BY category, sort_order, name");
  sendJson(res, 200, { products: rows });
}

export async function handleGetRoomTypes(_req: AuthRequest, res: ServerResponse): Promise<void> {
  const types = Object.entries(ROOM_TYPE_LABELS).map(([key, label]) => ({ key, label }));
  sendJson(res, 200, { room_types: types });
}

// ── AI 智能空间生成 ──

const AI_LAYOUT_SYSTEM_PROMPT = `你是一个专业的空间规划AI，支持办公、餐饮、酒店、零售、教育、工业等各类场景。用户会描述空间需求（面积、楼层、房间数、用途等），你需要生成合理的空间布局方案。

你必须返回严格的JSON格式（不要包含markdown代码块标记），结构如下：
{
  "space_name": "空间名称",
  "total_area": 数字（总面积，单位㎡），
  "floors": 数字（楼层数），
  "rooms": [
    {
      "name": "房间显示名称（如：大堂、包厢1、总经理办公室）",
      "room_type": "房间类型key",
      "area": 数字（面积㎡），
      "floor": 数字（所在楼层，从1开始），
      "position_x": 数字（X坐标，从0开始，单位米），
      "position_y": 数字（Y坐标，从0开始，单位米），
      "width": 数字（宽度，米），
      "depth": 数字（深度，米）
    }
  ]
}

房间类型（room_type）可选值：
【通用】office(办公室) | meeting(会议室) | reception(接待区/前台) | open_area(开放办公区) | restroom(卫生间) | storage(储物间) | pantry(茶水间/休息区) | server_room(机房)
【餐饮】lobby(大堂/大厅) | private_room(包厢/包间) | kitchen(厨房) | dining_hall(餐厅/用餐区)
【休闲】lounge(休息室/休闲区) | gym(健身房) | library(图书室) | garden(花园/绿化区) | balcony(阳台/露台)
【教育/工业】classroom(教室/培训室) | lab(实验室) | workshop(工作坊/车间) | showroom(展厅) | warehouse(仓库)
【酒店/住宿】bedroom(卧室/客房) | corridor(走廊) | security(安保室)
【其他】parking(停车场)

布局规则：
1. 房间不能重叠，同一楼层内位置坐标必须合理排列
2. 每个房间的 width * depth ≈ area
3. position_x 和 position_y 从 0 开始，单位为米
4. 多楼层时：每层的房间各自从(0,0)开始排列，用 floor 字段区分楼层；同一层的房间排列要紧凑
5. 根据用户描述的场景类型选择合适的 room_type，不要强行用办公类型替代
6. 如果用户说"包厢十个"，就生成10个独立的包厢房间（包厢1~包厢10），每个都是独立条目
7. 房间排列要紧凑，像真实平面图那样排列，相邻房间坐标紧挨
8. 走廊空间约占总面积10-15%，不需要单独列出（除非用户指定）
9. 按用户描述的场景合理分配面积，不要套用固定的办公室比例`;

export async function handleAiGenerateSpace(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  if (!requireAuth(req, res)) return;
  const body = await parseBody(req);

  const description = String(body.description || "").trim();
  const totalArea = Number(body.total_area) || 0;
  const floors = Number(body.floors) || 1;
  const roomCount = Number(body.room_count) || 0;
  const imageBase64 = body.image_base64 ? String(body.image_base64) : "";

  if (!description && totalArea <= 0) {
    return sendJson(res, 400, { error: "请至少提供空间描述或总面积" });
  }

  // 删除用户所有旧空间（每个用户只保留一个空间）
  const { rows: oldSpaces } = await db.query("SELECT id FROM opc_iot_spaces WHERE user_id = $1", [req.user!.userId]);
  for (const old of oldSpaces) {
    await db.query("DELETE FROM opc_iot_rooms WHERE space_id = $1", [old.id]);
    await db.query("DELETE FROM opc_iot_spaces WHERE id = $1", [old.id]);
  }

  let userPrompt = "";
  if (description) {
    userPrompt += `用户描述：${description}\n`;
  }
  if (totalArea > 0) userPrompt += `总面积：${totalArea}㎡\n`;
  if (floors > 1) userPrompt += `楼层数：${floors}层\n`;
  if (roomCount > 0) userPrompt += `期望房间数量：${roomCount}间\n`;
  if (imageBase64) {
    userPrompt += `\n用户还上传了一张办公空间的参考图片，请结合图片中的布局风格来规划空间。`;
  }
  userPrompt += "\n请根据以上信息生成空间布局JSON。";

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: AI_LAYOUT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    const aiResult = await callAi(messages, undefined, undefined, undefined);
    let content = aiResult.content.trim();

    // strip markdown fences if present
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

    let layout: {
      space_name?: string;
      total_area?: number;
      floors?: number;
      rooms?: Array<{
        name: string; room_type: string; area: number; floor?: number;
        position_x: number; position_y: number; width: number; depth: number;
      }>;
    };
    try {
      layout = JSON.parse(content);
    } catch {
      return sendJson(res, 500, { error: "AI 返回格式异常", raw: content });
    }

    if (!layout.rooms || !Array.isArray(layout.rooms) || layout.rooms.length === 0) {
      return sendJson(res, 500, { error: "AI 未生成有效房间布局", raw: content });
    }

    const spaceId = randomUUID();
    const spaceName = String(layout.space_name || body.space_name || "AI 规划空间").trim();
    const finalArea = layout.total_area || totalArea || layout.rooms.reduce((s, r) => s + (r.area || 0), 0);

    await db.query(
      `INSERT INTO opc_iot_spaces (id, user_id, company_id, name, total_area, layout_json, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [spaceId, req.user!.userId, body.company_id || null, spaceName, finalArea, JSON.stringify(layout)]
    );

    const roomResults = [];
    const validTypes = Object.keys(ROOM_TYPE_LABELS);
    for (const room of layout.rooms) {
      const roomId = randomUUID();
      const roomType = validTypes.includes(room.room_type) ? room.room_type : "office";
      const area = Number(room.area) || 10;
      const w = Number(room.width) || Math.sqrt(area * 1.3);
      const d = Number(room.depth) || area / w;
      const floor = Number(room.floor) || 1;

      await db.query(
        `INSERT INTO opc_iot_rooms (id, space_id, name, room_type, area, position_x, position_y, width, depth, floor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [roomId, spaceId, room.name || ROOM_TYPE_LABELS[roomType] || "房间",
         roomType, area, Number(room.position_x) || 0, Number(room.position_y) || 0, w, d, floor]
      );

      const rec = await getRecommendations(db, roomType, area);
      await db.query("UPDATE opc_iot_rooms SET products_json = $1 WHERE id = $2",
        [JSON.stringify(rec.products), roomId]);

      roomResults.push({
        room_id: roomId, room_name: room.name, room_type: roomType, area, floor,
        position: { x: room.position_x, y: room.position_y, w, d },
        recommendations: rec,
      });
    }

    sendJson(res, 201, {
      space_id: spaceId,
      space_name: spaceName,
      total_area: finalArea,
      rooms: roomResults,
      ai_layout: layout,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[AI Space Generate]", msg);
    sendJson(res, 500, { error: "AI 生成失败：" + msg });
  }
}

// ── Helpers ──

const ROOM_TYPE_LABELS: Record<string, string> = {
  office: "独立办公室", meeting: "会议室", reception: "接待区/前台",
  server_room: "机房/弱电间", restroom: "卫生间", storage: "储物间/档案室",
  pantry: "茶水间/休息区", open_area: "开放办公区",
  lobby: "大堂/大厅", private_room: "包厢/包间", kitchen: "厨房",
  dining_hall: "餐厅/用餐区", lounge: "休息室/休闲区", gym: "健身房",
  library: "图书室/阅览室", lab: "实验室", workshop: "工作坊/车间",
  showroom: "展厅/展示区", warehouse: "仓库", classroom: "教室/培训室",
  bedroom: "卧室/客房", corridor: "走廊/过道", balcony: "阳台/露台",
  garden: "花园/绿化区", parking: "停车场", security: "安保室/监控室",
};

function generateAutoLayout(totalArea: number): Array<{ name: string; type: string; area: number; x: number; y: number; w: number; d: number }> {
  const rooms: Array<{ name: string; type: string; area: number; x: number; y: number; w: number; d: number }> = [];

  const receptionArea = Math.max(8, totalArea * 0.05);
  const meetingRoomCount = totalArea >= 200 ? 2 : 1;
  const meetingArea = totalArea >= 200 ? totalArea * 0.1 : Math.max(12, totalArea * 0.12);
  const pantryArea = Math.max(6, totalArea * 0.04);
  const restroomArea = Math.max(4, totalArea * 0.03);
  const serverArea = totalArea >= 150 ? Math.max(8, totalArea * 0.04) : 0;
  const storageArea = totalArea >= 100 ? Math.max(6, totalArea * 0.03) : 0;

  let allocated = receptionArea + meetingArea * meetingRoomCount + pantryArea + restroomArea + serverArea + storageArea;
  const officeArea = totalArea - allocated;

  const bossOfficeArea = Math.min(25, officeArea * 0.15);
  const openArea = officeArea - bossOfficeArea;

  let x = 0, y = 0;
  const addRoom = (name: string, type: string, area: number) => {
    const w = Math.round(Math.sqrt(area * 1.3) * 10) / 10;
    const d = Math.round((area / w) * 10) / 10;
    rooms.push({ name, type, area: Math.round(area * 10) / 10, x, y, w, d });
    x += w + 0.5;
    if (x > Math.sqrt(totalArea) * 1.5) { x = 0; y += d + 0.5; }
  };

  addRoom("前台/接待区", "reception", receptionArea);
  addRoom("总经理办公室", "office", bossOfficeArea);
  addRoom("开放办公区", "open_area", openArea);
  for (let i = 0; i < meetingRoomCount; i++) {
    addRoom(meetingRoomCount > 1 ? `会议室${i + 1}` : "会议室", "meeting", meetingArea);
  }
  addRoom("茶水间", "pantry", pantryArea);
  addRoom("卫生间", "restroom", restroomArea);
  if (serverArea > 0) addRoom("机房", "server_room", serverArea);
  if (storageArea > 0) addRoom("储物间", "storage", storageArea);

  return rooms;
}

// ═══════════════════════════════════════════════════════════════
// AI Chat Layout — 通过对话修改房间布局（不持久化，仅返回调整后的 JSON）
// ═══════════════════════════════════════════════════════════════
export async function handleAiChatLayout(req: AuthRequest, res: ServerResponse, db: Db): Promise<void> {
  // 尝试认证但不强制 — AI chat 仅调用 AI 不操作用户数据
  if (!req.user) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (token) {
      try {
        const { verifyToken } = await import("../auth/jwt.js");
        req.user = verifyToken(token);
      } catch { /* token invalid, continue as anonymous */ }
    }
  }
  const body = await parseBody(req);
  const message = String(body.message || "").trim();
  const totalArea = Number(body.totalArea) || 200;
  const currentRooms = (body.currentRooms || []) as Array<{ name: string; room_type: string; area: number }>;

  if (!message) return sendJson(res, 400, { error: "请输入调整指令" });

  const validTypes = Object.keys(ROOM_TYPE_LABELS);
  const typeList = validTypes.join(", ");

  const systemPrompt = `你是一个办公空间布局 AI 助手。用户会描述他们想调整的内容，你需要根据当前房间列表进行增删改。

规则：
1. room_type 只能从 [${typeList}] 中选择
2. 所有房间面积之和不超过总面积
3. 每个房间至少 4㎡
4. 返回 JSON 对象：{"rooms":[{"name":"房间名","room_type":"类型","area":数值}],"explanation":"用一句话中文说明你做了什么调整"}
5. 只返回 JSON，不要 markdown 标记`;

  const userPrompt = `当前空间总面积：${totalArea}㎡
当前房间：${JSON.stringify(currentRooms)}

用户要求：${message}

请返回调整后的完整房间列表 JSON。`;

  try {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const aiResult = await callAi(messages, undefined, undefined, undefined);
    let content = aiResult.content.trim();
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

    let result: { rooms?: Array<{ name: string; room_type: string; area: number }>; explanation?: string };
    try {
      result = JSON.parse(content);
    } catch {
      return sendJson(res, 200, { rooms: [], explanation: "AI 返回格式异常，请换个表述再试。" });
    }

    if (!result.rooms || !Array.isArray(result.rooms)) {
      return sendJson(res, 200, { rooms: [], explanation: result.explanation || "未能解析房间列表" });
    }

    result.rooms = result.rooms.map(r => ({
      name: String(r.name || "未命名"),
      room_type: validTypes.includes(r.room_type) ? r.room_type : "office",
      area: Math.max(4, Number(r.area) || 10),
    }));

    sendJson(res, 200, { rooms: result.rooms, explanation: result.explanation || `已调整为 ${result.rooms.length} 个房间` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    sendJson(res, 200, { rooms: [], explanation: "AI 调用失败：" + msg.substring(0, 100) });
  }
}
