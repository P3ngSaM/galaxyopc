import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { requireAuth, parseBody, sendJson } from "../auth/middleware.js";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, convertInchesToTwip,
  Header, Footer, PageNumber,
} from "docx";

interface InvoiceRow {
  id: string; company_id: string; invoice_number: string;
  type: string; contact_id: string; amount: number;
  tax_amount: number; status: string; issue_date: string;
  due_date: string; paid_date: string; notes: string; created_at: string;
}

const SONG = "SimSun";
const HEI = "SimHei";
const RED = "c7254e";
const BLU = "2563eb";
const GRAY = "888888";
const BLK = "333333";

type Align = (typeof AlignmentType)[keyof typeof AlignmentType];

function typeCn(t: string) { return { receivable: "应收发票（销项）", payable: "应付发票（进项）", receipt: "收据" }[t] || t; }
function statusCn(s: string) { return { draft: "待开具", issued: "已开具", sent: "已寄出", paid: "已收款", overdue: "已逾期", cancelled: "已作废" }[s] || s; }
function fmtDate(d: string | undefined): string {
  if (!d) return "    年  月  日";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return `${dt.getFullYear()}年${String(dt.getMonth() + 1).padStart(2, "0")}月${String(dt.getDate()).padStart(2, "0")}日`;
}
function fmtMoney(v: number) { return `¥${Number(v || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

function cnMoney(v: number): string {
  const digits = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const units = ["", "拾", "佰", "仟"];
  const bigUnits = ["", "万", "亿"];
  const num = Math.abs(Number(v || 0));
  const intPart = Math.floor(num);
  const decPart = Math.round((num - intPart) * 100);
  const jiao = Math.floor(decPart / 10);
  const fen = decPart % 10;
  if (intPart === 0 && decPart === 0) return "零元整";
  let result = "";
  if (intPart > 0) {
    const str = String(intPart);
    const groups: number[][] = [];
    for (let i = str.length; i > 0; i -= 4) groups.unshift(str.slice(Math.max(0, i - 4), i).split("").map(Number));
    groups.forEach((g, gi) => {
      let gs = ""; let zf = false;
      g.forEach((d, di) => { const pos = g.length - 1 - di; if (d === 0) { zf = true; } else { if (zf) { gs += "零"; zf = false; } gs += digits[d] + units[pos]; } });
      if (gs) result += gs + bigUnits[groups.length - 1 - gi];
    });
    result += "元";
  }
  if (jiao > 0) result += digits[jiao] + "角";
  if (fen > 0) result += digits[fen] + "分";
  if (jiao === 0 && fen === 0) result += "整";
  return result;
}

function randomHex(len: number) {
  let s = "";
  for (let i = 0; i < len; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

// Red border used for official invoice frame
function mkBdr(style: typeof BorderStyle[keyof typeof BorderStyle], size: number, color: string) { return { style, size, color }; }
const redBdr = mkBdr(BorderStyle.SINGLE, 3, RED);
const redBorders = { top: redBdr, bottom: redBdr, left: redBdr, right: redBdr };
const thinRed = mkBdr(BorderStyle.SINGLE, 1, RED);
const thinRedBorders = { top: thinRed, bottom: thinRed, left: thinRed, right: thinRed };
const noBorder = mkBdr(BorderStyle.NONE, 0, "ffffff");
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

function p(text: string, opts: { font?: string; size?: number; color?: string; bold?: boolean; align?: Align; spacing?: { before?: number; after?: number }; italic?: boolean } = {}): Paragraph {
  return new Paragraph({
    alignment: opts.align || AlignmentType.LEFT,
    spacing: opts.spacing || { before: 20, after: 20 },
    children: [new TextRun({ text, font: opts.font || SONG, size: opts.size || 18, color: opts.color || BLK, bold: opts.bold, italics: opts.italic })],
  });
}

function labelCell(text: string, w?: number): TableCell {
  return new TableCell({
    width: w ? { size: w, type: WidthType.PERCENTAGE } : undefined,
    borders: thinRedBorders,
    children: [new Paragraph({ spacing: { before: 30, after: 30 }, children: [new TextRun({ text, font: SONG, size: 16, color: BLK })] })],
  });
}
function valCell(text: string, w?: number, opts: { bold?: boolean; color?: string; align?: Align } = {}): TableCell {
  return new TableCell({
    width: w ? { size: w, type: WidthType.PERCENTAGE } : undefined,
    borders: thinRedBorders,
    children: [new Paragraph({ alignment: opts.align || AlignmentType.LEFT, spacing: { before: 30, after: 30 }, children: [new TextRun({ text: text || " ", font: SONG, size: 16, bold: opts.bold, color: opts.color || BLK })] })],
  });
}

function buildInvoiceDocument(inv: InvoiceRow, companyName: string, ownerName: string): Document {
  const isRcv = inv.type === "receivable";
  const pretax = Number(inv.amount) || 0;
  const taxAmt = Number(inv.tax_amount) || 0;
  const total = pretax + taxAmt;
  const counterparty = inv.contact_id || "————";
  const taxRate = pretax > 0 ? Math.round(taxAmt / pretax * 100) : 0;
  const displayRate = taxRate > 100 ? 6 : taxRate; // guard against data anomalies

  const children: (Paragraph | Table)[] = [];

  // ━━━ Title ━━━
  children.push(new Paragraph({ spacing: { before: 60, after: 0 }, children: [] }));

  const titleColor = isRcv ? RED : BLU;
  const titleText = isRcv ? "增 值 税 专 用 发 票" : "增 值 税 普 通 发 票";
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 20 },
    children: [new TextRun({ text: titleText, font: HEI, size: 36, bold: true, color: titleColor })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 120 },
    children: [new TextRun({ text: `（${typeCn(inv.type)}）`, font: SONG, size: 16, color: GRAY })],
  }));

  // ━━━ Meta row: code + date ━━━
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [
      new TableCell({ borders: noBorders, width: { size: 50, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ spacing: { before: 20, after: 20 }, children: [
          new TextRun({ text: "发票代码：", font: SONG, size: 16, color: GRAY }),
          new TextRun({ text: inv.invoice_number || "————", font: HEI, size: 18, color: BLK, bold: true }),
        ] })] }),
      new TableCell({ borders: noBorders, width: { size: 50, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 20, after: 20 }, children: [
          new TextRun({ text: "开票日期：", font: SONG, size: 16, color: GRAY }),
          new TextRun({ text: fmtDate(inv.issue_date), font: HEI, size: 18, color: BLK, bold: true }),
        ] })] }),
    ] })],
  }));
  children.push(new Paragraph({ spacing: { before: 60 }, children: [] }));

  // ━━━ Buyer box ━━━
  const buyerLabel = isRcv ? "购 买 方" : "销 售 方";
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [
        new TableCell({ borders: redBorders, rowSpan: 4, width: { size: 10, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.SOLID, color: "FEF2F2" },
          children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 160 },
            children: [new TextRun({ text: buyerLabel, font: HEI, size: 20, bold: true, color: RED })] })],
        }),
        labelCell("名    称", 14),
        valCell(counterparty, 46, { bold: true }),
        new TableCell({ borders: redBorders, rowSpan: 4, width: { size: 30, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.SOLID, color: "FEFCE8" },
          children: [
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 20 }, children: [new TextRun({ text: "密  码  区", font: HEI, size: 14, color: GRAY })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 10, after: 10 }, children: [new TextRun({ text: randomHex(28), font: "Consolas", size: 12, color: RED })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 10, after: 10 }, children: [new TextRun({ text: randomHex(28), font: "Consolas", size: 12, color: RED })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 10, after: 10 }, children: [new TextRun({ text: randomHex(28), font: "Consolas", size: 12, color: RED })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 10, after: 10 }, children: [new TextRun({ text: randomHex(28), font: "Consolas", size: 12, color: RED })] }),
          ],
        }),
      ] }),
      new TableRow({ children: [labelCell("纳税人识别号"), valCell("————", undefined)] }),
      new TableRow({ children: [labelCell("地址、电话"), valCell("————", undefined)] }),
      new TableRow({ children: [labelCell("开户行及账号"), valCell("————", undefined)] }),
    ],
  }));
  children.push(new Paragraph({ spacing: { before: 60 }, children: [] }));

  // ━━━ Items table ━━━
  function itemHdrCell(text: string, w: number): TableCell {
    return new TableCell({
      width: { size: w, type: WidthType.PERCENTAGE }, borders: redBorders,
      shading: { type: ShadingType.SOLID, color: "FEF2F2" },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 }, children: [new TextRun({ text, font: HEI, size: 16, bold: true, color: RED })] })],
    });
  }
  function itemDataCell(text: string, align: Align = AlignmentType.CENTER, bold = false): TableCell {
    return new TableCell({
      borders: thinRedBorders,
      children: [new Paragraph({ alignment: align, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: text || "—", font: SONG, size: 16, bold, color: BLK })] })],
    });
  }
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [itemHdrCell("货物或应税劳务、服务名称", 34), itemHdrCell("规格型号", 12), itemHdrCell("单位", 8), itemHdrCell("数量", 8), itemHdrCell("单  价", 18), itemHdrCell("金  额", 20)] }),
      new TableRow({ children: [
        itemDataCell(inv.notes || "技术服务费"),
        itemDataCell("—"),
        itemDataCell("项"),
        itemDataCell("1"),
        itemDataCell(fmtMoney(pretax), AlignmentType.RIGHT),
        itemDataCell(fmtMoney(pretax), AlignmentType.RIGHT, true),
      ] }),
      // empty spacer rows for authentic look
      new TableRow({ children: [itemDataCell(" "), itemDataCell(" "), itemDataCell(" "), itemDataCell(" "), itemDataCell(" "), itemDataCell(" ")] }),
      // subtotal
      new TableRow({ children: [
        new TableCell({ borders: redBorders, columnSpan: 4, children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "合      计", font: HEI, size: 16, bold: true, color: RED })] })] }),
        itemDataCell(" ", AlignmentType.RIGHT),
        itemDataCell(fmtMoney(pretax), AlignmentType.RIGHT, true),
      ] }),
      // tax row
      new TableRow({ children: [
        new TableCell({ borders: redBorders, columnSpan: 2, children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "税    率", font: HEI, size: 16, bold: true, color: RED })] })] }),
        new TableCell({ borders: thinRedBorders, columnSpan: 2, children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: `${displayRate}%`, font: SONG, size: 18, bold: true, color: BLK })] })] }),
        new TableCell({ borders: redBorders, children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "税    额", font: HEI, size: 16, bold: true, color: RED })] })] }),
        itemDataCell(fmtMoney(taxAmt), AlignmentType.RIGHT, true),
      ] }),
    ],
  }));
  children.push(new Paragraph({ spacing: { before: 60 }, children: [] }));

  // ━━━ Grand total ━━━
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [
      new TableCell({ borders: redBorders, width: { size: 20, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: "FEF2F2" },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 },
          children: [new TextRun({ text: "价税合计（大写）", font: HEI, size: 16, bold: true, color: RED })] })],
      }),
      new TableCell({ borders: redBorders, width: { size: 48, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ spacing: { before: 60, after: 60 },
          children: [
            new TextRun({ text: " ⊗ ", font: SONG, size: 20, color: RED }),
            new TextRun({ text: cnMoney(total), font: HEI, size: 22, bold: true, color: RED }),
          ] })],
      }),
      new TableCell({ borders: redBorders, width: { size: 32, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 60, after: 60 },
          children: [
            new TextRun({ text: "（小写）", font: SONG, size: 14, color: GRAY }),
            new TextRun({ text: `  ${fmtMoney(total)}`, font: HEI, size: 24, bold: true, color: RED }),
          ] })],
      }),
    ] })],
  }));
  children.push(new Paragraph({ spacing: { before: 60 }, children: [] }));

  // ━━━ Seller box ━━━
  const sellerLabel = isRcv ? "销 售 方" : "购 买 方";
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [
        new TableCell({ borders: redBorders, rowSpan: 4, width: { size: 10, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.SOLID, color: "FEF2F2" },
          children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 160 },
            children: [new TextRun({ text: sellerLabel, font: HEI, size: 20, bold: true, color: RED })] })],
        }),
        labelCell("名    称", 14),
        valCell(companyName, 46, { bold: true }),
        new TableCell({ borders: redBorders, rowSpan: 4, width: { size: 30, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 60, after: 20 }, children: [new TextRun({ text: "备  注", font: HEI, size: 14, color: GRAY })] }),
            new Paragraph({ spacing: { before: 10 }, children: [new TextRun({ text: inv.notes ? `  ${inv.notes}` : " ", font: SONG, size: 14, color: BLK })] }),
            ...(inv.due_date ? [new Paragraph({ spacing: { before: 10 }, children: [new TextRun({ text: `  付款到期日：${fmtDate(inv.due_date)}`, font: SONG, size: 14, color: BLK })] })] : []),
            ...(inv.paid_date ? [new Paragraph({ spacing: { before: 10 }, children: [new TextRun({ text: `  实际付款日：${fmtDate(inv.paid_date)}`, font: SONG, size: 14, color: BLK })] })] : []),
          ],
        }),
      ] }),
      new TableRow({ children: [labelCell("纳税人识别号"), valCell("————")] }),
      new TableRow({ children: [labelCell("地址、电话"), valCell("————")] }),
      new TableRow({ children: [labelCell("开户行及账号"), valCell("————")] }),
    ],
  }));
  children.push(new Paragraph({ spacing: { before: 100 }, children: [] }));

  // ━━━ Footer: 收款人 / 复核 / 开票人 ━━━
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [
      new TableCell({ borders: noBorders, width: { size: 33, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [
          new TextRun({ text: "收 款 人：", font: SONG, size: 16, color: GRAY }),
          new TextRun({ text: ownerName || "________", font: SONG, size: 16, color: BLK }),
        ] })] }),
      new TableCell({ borders: noBorders, width: { size: 33, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
          new TextRun({ text: "复 核 人：", font: SONG, size: 16, color: GRAY }),
          new TextRun({ text: "________", font: SONG, size: 16, color: BLK }),
        ] })] }),
      new TableCell({ borders: noBorders, width: { size: 33, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
          new TextRun({ text: "开 票 人：", font: SONG, size: 16, color: GRAY }),
          new TextRun({ text: ownerName || "________", font: SONG, size: 16, color: BLK }),
        ] })] }),
    ] })],
  }));
  children.push(new Paragraph({ spacing: { before: 80 }, children: [] }));

  // ━━━ Machine check code ━━━
  const checkCode = randomHex(20).toUpperCase();
  children.push(new Paragraph({
    alignment: AlignmentType.LEFT, spacing: { before: 60 },
    children: [
      new TextRun({ text: "机器编号：", font: SONG, size: 14, color: GRAY }),
      new TextRun({ text: "499099153892  ", font: "Consolas", size: 14, color: GRAY }),
      new TextRun({ text: "校 验 码：", font: SONG, size: 14, color: GRAY }),
      new TextRun({ text: checkCode, font: "Consolas", size: 14, color: RED }),
    ],
  }));

  // ━━━ Status watermark ━━━
  const statusText = statusCn(inv.status);
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 200 },
    children: [new TextRun({ text: `— ${statusText} —`, font: HEI, size: 28, color: GRAY, bold: true })],
  }));

  // ━━━ Legal disclaimer ━━━
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 200 },
    children: [new TextRun({ text: "本发票由 星环OPC 企业运营平台 生成，仅供内部参考，不作为正式税务凭证。", font: SONG, size: 14, color: GRAY, italics: true })],
  }));

  return new Document({
    styles: { default: { document: { run: { font: SONG, size: 18, color: BLK } } } },
    sections: [{
      properties: { page: { margin: { top: convertInchesToTwip(0.7), bottom: convertInchesToTwip(0.6), left: convertInchesToTwip(0.8), right: convertInchesToTwip(0.8) } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `${inv.invoice_number}`, font: "Consolas", size: 12, color: "cccccc" })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "第 ", size: 14, color: "bbbbbb" }), new TextRun({ children: [PageNumber.CURRENT], size: 14, color: "bbbbbb" }), new TextRun({ text: " 页 · 星环OPC", size: 14, color: "bbbbbb" })] })] }) },
      children: children as Paragraph[],
    }],
  });
}

export async function handleExportInvoice(req: AuthRequest, res: ServerResponse, db: Db, invoiceId: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const { rows } = await db.query("SELECT * FROM opc_invoices WHERE id = $1", [invoiceId]);
  if (!rows[0]) { sendJson(res, 404, { error: "发票不存在" }); return; }
  const inv = rows[0] as InvoiceRow;

  let companyName = "", ownerName = "";
  try { const body = await parseBody(req); companyName = String(body.company_name || ""); ownerName = String(body.company_owner || ""); } catch { /* defaults */ }
  if (!companyName) {
    const { rows: c } = await db.query("SELECT name, owner_name FROM opc_companies WHERE id = $1", [inv.company_id]);
    if (c[0]) { companyName = (c[0] as { name: string }).name; ownerName = ownerName || (c[0] as { owner_name: string }).owner_name; }
  }

  const doc = buildInvoiceDocument(inv, companyName, ownerName);
  const buffer = await Packer.toBuffer(doc);
  const safeName = encodeURIComponent((inv.invoice_number || "发票") + ".docx");
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="invoice.docx"; filename*=UTF-8''${safeName}`,
    "Content-Length": buffer.byteLength,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(buffer);
}
