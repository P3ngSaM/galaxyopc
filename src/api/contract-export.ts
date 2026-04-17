import type { ServerResponse } from "node:http";
import type { Db } from "../db.js";
import type { AuthRequest } from "../auth/middleware.js";
import { requireAuth, parseBody, sendJson } from "../auth/middleware.js";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  HeadingLevel,
  ShadingType,
  convertInchesToTwip,
  Header,
  Footer,
  PageNumber,
} from "docx";

interface ContractRow {
  id: string;
  company_id: string;
  title: string;
  counterparty: string;
  type: string;
  value: number;
  status: string;
  start_date: string;
  end_date: string;
  terms: string;
  risk_level: string;
  created_at: string;
}

const FONT_SONG = "SimSun";
const FONT_HEI = "SimHei";
const COLOR_DARK = "333333";

function fmtDate(d: string | undefined): string {
  if (!d) return "____年__月__日";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}

function fmtMoney(v: number): string {
  return `¥${Number(v || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
    for (let i = str.length; i > 0; i -= 4) {
      groups.unshift(str.slice(Math.max(0, i - 4), i).split("").map(Number));
    }
    groups.forEach((g, gi) => {
      let groupStr = "";
      let zeroFlag = false;
      g.forEach((d, di) => {
        const pos = g.length - 1 - di;
        if (d === 0) {
          zeroFlag = true;
        } else {
          if (zeroFlag) { groupStr += "零"; zeroFlag = false; }
          groupStr += digits[d] + units[pos];
        }
      });
      if (groupStr) result += groupStr + bigUnits[groups.length - 1 - gi];
    });
    result += "元";
  }

  if (jiao > 0) result += digits[jiao] + "角";
  if (fen > 0) result += digits[fen] + "分";
  if (jiao === 0 && fen === 0) result += "整";

  return result;
}

function contractTypeCn(t: string): string {
  return { service: "服务合同", sales: "销售合同", purchase: "采购合同", nda: "保密协议", employment: "劳动合同", consulting: "咨询合同", lease: "租赁合同", license: "许可协议" }[t] || t || "服务合同";
}

function statusCn(s: string): string {
  return { draft: "草稿", active: "生效中", completed: "已完成", terminated: "已终止", expired: "已到期", pending: "待审批" }[s] || s;
}

function thinBorder() {
  return {
    top: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    left: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    right: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
  };
}

function labelCell(text: string): TableCell {
  return new TableCell({
    width: { size: 25, type: WidthType.PERCENTAGE },
    borders: thinBorder(),
    shading: { type: ShadingType.SOLID, color: "F5F5F5" },
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ text, font: FONT_HEI, size: 20, color: COLOR_DARK, bold: true })],
    })],
  });
}

function valCell(text: string, span = 1): TableCell {
  return new TableCell({
    columnSpan: span,
    width: span > 1 ? { size: 75, type: WidthType.PERCENTAGE } : { size: 25, type: WidthType.PERCENTAGE },
    borders: thinBorder(),
    children: [new Paragraph({
      spacing: { before: 60, after: 60 },
      children: [new TextRun({ text: text || "-", font: FONT_SONG, size: 20, color: COLOR_DARK })],
    })],
  });
}

function buildDocument(ct: ContractRow, companyName: string, ownerName: string): Document {
  const sections: Paragraph[] = [];

  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text: ct.title || "合同", font: FONT_HEI, size: 36, bold: true, color: COLOR_DARK })],
  }));

  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 },
    children: [new TextRun({ text: `合同编号：${ct.id.slice(0, 8).toUpperCase()}`, font: FONT_SONG, size: 18, color: "666666", italics: true })],
  }));

  const infoTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [labelCell("甲方（委托方）"), valCell(companyName, 3)] }),
      new TableRow({ children: [labelCell("乙方（受托方）"), valCell(ct.counterparty, 3)] }),
      new TableRow({ children: [labelCell("合同类型"), valCell(contractTypeCn(ct.type)), labelCell("合同状态"), valCell(statusCn(ct.status))] }),
      new TableRow({ children: [labelCell("合同金额"), valCell(`${fmtMoney(ct.value)}（大写：${cnMoney(ct.value)}）`), labelCell("风险等级"), valCell(ct.risk_level === "high" ? "高" : ct.risk_level === "medium" ? "中" : "低")] }),
      new TableRow({ children: [labelCell("开始日期"), valCell(fmtDate(ct.start_date)), labelCell("结束日期"), valCell(fmtDate(ct.end_date))] }),
      new TableRow({ children: [labelCell("创建日期"), valCell(fmtDate(ct.created_at)), labelCell("甲方代表"), valCell(ownerName)] }),
    ],
  });

  sections.push(new Paragraph({ spacing: { after: 200 }, children: [] }));

  const bodyParagraphs: Paragraph[] = [];

  bodyParagraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: "第一条 合同概述", font: FONT_HEI, size: 24, bold: true })],
  }));
  bodyParagraphs.push(new Paragraph({
    spacing: { before: 80, after: 80 },
    indent: { firstLine: convertInchesToTwip(0.4) },
    children: [new TextRun({ text: `甲方${companyName}（以下简称"甲方"）与乙方${ct.counterparty}（以下简称"乙方"）经友好协商，就${ct.title}事宜达成如下协议。本合同自${fmtDate(ct.start_date)}起至${fmtDate(ct.end_date)}止，合同总金额为${fmtMoney(ct.value)}（大写：${cnMoney(ct.value)}）。`, font: FONT_SONG, size: 21 })],
  }));

  if (ct.terms) {
    bodyParagraphs.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 150 },
      children: [new TextRun({ text: "第二条 关键条款", font: FONT_HEI, size: 24, bold: true })],
    }));
    ct.terms.split(/[;；\n]/).filter(Boolean).forEach((term, i) => {
      bodyParagraphs.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        indent: { firstLine: convertInchesToTwip(0.4) },
        children: [new TextRun({ text: `${i + 1}. ${term.trim()}`, font: FONT_SONG, size: 21 })],
      }));
    });
  }

  bodyParagraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: `第${ct.terms ? "三" : "二"}条 权利与义务`, font: FONT_HEI, size: 24, bold: true })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `1. 甲方有权依据本合同约定要求乙方按时、按质完成相关工作。`, font: FONT_SONG, size: 21 })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `2. 乙方应按照合同约定履行义务，保证工作质量符合甲方要求。`, font: FONT_SONG, size: 21 })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `3. 双方应相互配合，及时沟通，确保合同顺利履行。`, font: FONT_SONG, size: 21 })],
  }));

  const payArticle = ct.terms ? "四" : "三";
  bodyParagraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: `第${payArticle}条 付款方式`, font: FONT_HEI, size: 24, bold: true })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `甲方应按照合同约定的付款条件向乙方支付合同价款，总计${fmtMoney(ct.value)}。具体付款方式及时间节点由双方另行约定或依据关键条款执行。`, font: FONT_SONG, size: 21 })],
  }));

  const confArticle = ct.terms ? "五" : "四";
  bodyParagraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: `第${confArticle}条 保密条款`, font: FONT_HEI, size: 24, bold: true })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `双方应对本合同内容及履行过程中获悉的对方商业秘密和技术秘密予以保密，未经对方书面同意不得向第三方披露。保密义务自本合同签订之日起，至合同终止后两年内有效。`, font: FONT_SONG, size: 21 })],
  }));

  const disputeArticle = ct.terms ? "六" : "五";
  bodyParagraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: `第${disputeArticle}条 违约责任`, font: FONT_HEI, size: 24, bold: true })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `任何一方违反本合同约定，应承担违约责任并赔偿对方因此所遭受的一切损失。`, font: FONT_SONG, size: 21 })],
  }));

  const resolveArticle = ct.terms ? "七" : "六";
  bodyParagraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: `第${resolveArticle}条 争议解决`, font: FONT_HEI, size: 24, bold: true })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `本合同的签订、履行、解释及争议解决均适用中华人民共和国法律。因本合同引起或与本合同有关的任何争议，双方应首先通过友好协商解决；协商不成的，任何一方均有权向甲方所在地有管辖权的人民法院提起诉讼。`, font: FONT_SONG, size: 21 })],
  }));

  const lastArticle = ct.terms ? "八" : "七";
  bodyParagraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
    children: [new TextRun({ text: `第${lastArticle}条 其他`, font: FONT_HEI, size: 24, bold: true })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `1. 本合同一式两份，甲乙双方各执一份，具有同等法律效力。`, font: FONT_SONG, size: 21 })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `2. 本合同未尽事宜，由双方协商一致后另行签订补充协议。`, font: FONT_SONG, size: 21 })],
  }));
  bodyParagraphs.push(new Paragraph({
    indent: { firstLine: convertInchesToTwip(0.4) },
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text: `3. 本合同自双方签字盖章之日起生效。`, font: FONT_SONG, size: 21 })],
  }));

  bodyParagraphs.push(new Paragraph({ spacing: { before: 600 }, children: [] }));

  const signTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
            children: [
              new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "甲方（盖章）：", font: FONT_HEI, size: 21, bold: true })] }),
              new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: `法定代表人：${ownerName || "________"}`, font: FONT_SONG, size: 21 })] }),
              new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "签字日期：____年____月____日", font: FONT_SONG, size: 21 })] }),
            ],
          }),
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
            children: [
              new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "乙方（盖章）：", font: FONT_HEI, size: 21, bold: true })] }),
              new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "法定代表人：________", font: FONT_SONG, size: 21 })] }),
              new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "签字日期：____年____月____日", font: FONT_SONG, size: 21 })] }),
            ],
          }),
        ],
      }),
    ],
  });

  return new Document({
    styles: {
      default: {
        document: { run: { font: FONT_SONG, size: 21, color: COLOR_DARK } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.2), right: convertInchesToTwip(1.2) },
          },
        },
        headers: {
          default: new Header({
            children: [new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: `${ct.title} — 合同文本`, font: FONT_SONG, size: 16, color: "999999", italics: true })],
            })],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: "第 ", font: FONT_SONG, size: 16, color: "999999" }),
                new TextRun({ children: [PageNumber.CURRENT], font: FONT_SONG, size: 16, color: "999999" }),
                new TextRun({ text: " 页", font: FONT_SONG, size: 16, color: "999999" }),
              ],
            })],
          }),
        },
        children: [
          ...sections,
          infoTable,
          ...bodyParagraphs,
          signTable,
        ],
      },
    ],
  });
}

export async function handleExportContract(req: AuthRequest, res: ServerResponse, db: Db, contractId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows } = await db.query("SELECT * FROM opc_contracts WHERE id = $1", [contractId]);
  if (!rows[0]) {
    sendJson(res, 404, { error: "合同不存在" });
    return;
  }
  const ct = rows[0] as ContractRow;

  let companyName = "";
  let ownerName = "";
  try {
    const body = await parseBody(req);
    companyName = String(body.company_name || "");
    ownerName = String(body.company_owner || "");
  } catch { /* use defaults */ }

  if (!companyName) {
    const { rows: crows } = await db.query("SELECT name, owner_name FROM opc_companies WHERE id = $1", [ct.company_id]);
    if (crows[0]) {
      companyName = (crows[0] as { name: string }).name;
      ownerName = ownerName || (crows[0] as { owner_name: string }).owner_name;
    }
  }

  const doc = buildDocument(ct, companyName, ownerName);
  const buffer = await Packer.toBuffer(doc);

  const safeName = encodeURIComponent((ct.title || "合同") + ".docx");
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="contract.docx"; filename*=UTF-8''${safeName}`,
    "Content-Length": buffer.byteLength,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(buffer);
}
