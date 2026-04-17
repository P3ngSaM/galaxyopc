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

interface ProjectRow {
  id: string;
  company_id: string;
  name: string;
  description: string;
  status: string;
  budget: number;
  spent: number;
  start_date: string;
  end_date: string;
  document: string;
  created_at: string;
}

const FONT_SONG = "SimSun";
const FONT_HEI = "SimHei";
const COLOR_DARK = "333333";

function statusCn(s: string): string {
  return { planning: "规划中", active: "进行中", completed: "已完成", paused: "已暂停", cancelled: "已取消" }[s] || s;
}

function fmtDate(d: string | undefined): string {
  if (!d) return "-";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
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
      children: [new TextRun({ text, font: FONT_HEI, size: 20, bold: true, color: COLOR_DARK })],
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

function parseMarkdownToDocx(markdown: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = markdown.split("\n");
  let inCodeBlock = false;
  let inTable = false;
  const tableRows: string[][] = [];

  const flushTable = () => {
    if (tableRows.length < 2) { inTable = false; tableRows.length = 0; return; }
    const headerCells = tableRows[0];
    const dataRows = tableRows.slice(2);
    const rows: TableRow[] = [];
    rows.push(new TableRow({
      children: headerCells.map((cell) => new TableCell({
        borders: thinBorder(),
        shading: { type: ShadingType.SOLID, color: "F5F5F5" },
        children: [new Paragraph({ children: [new TextRun({ text: cell.trim(), font: FONT_HEI, size: 18, bold: true })] })],
      })),
    }));
    for (const dr of dataRows) {
      rows.push(new TableRow({
        children: dr.map((cell) => new TableCell({
          borders: thinBorder(),
          children: [new Paragraph({ children: [new TextRun({ text: cell.trim(), font: FONT_SONG, size: 18 })] })],
        })),
      }));
    }
    paragraphs.push(new Paragraph({ spacing: { before: 100 }, children: [] }));
    paragraphs.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }) as unknown as Paragraph);
    paragraphs.push(new Paragraph({ spacing: { after: 100 }, children: [] }));
    inTable = false;
    tableRows.length = 0;
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      paragraphs.push(new Paragraph({
        spacing: { before: 20, after: 20 },
        indent: { left: convertInchesToTwip(0.3) },
        children: [new TextRun({ text: line, font: "Consolas", size: 17, color: "444444" })],
      }));
      continue;
    }
    if (line.includes("|") && line.trim().startsWith("|")) {
      const cells = line.split("|").slice(1, -1);
      if (!inTable) inTable = true;
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (line.match(/^#{1,2}\s/)) {
      const level = line.startsWith("## ") ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1;
      const text = line.replace(/^#+\s*/, "");
      paragraphs.push(new Paragraph({
        heading: level,
        spacing: { before: 300, after: 150 },
        children: [new TextRun({ text, font: FONT_HEI, size: level === HeadingLevel.HEADING_1 ? 28 : 24, bold: true })],
      }));
    } else if (line.match(/^###\s/)) {
      paragraphs.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
        children: [new TextRun({ text: line.replace(/^###\s*/, ""), font: FONT_HEI, size: 22, bold: true })],
      }));
    } else if (line.match(/^####\s/)) {
      paragraphs.push(new Paragraph({
        spacing: { before: 150, after: 80 },
        children: [new TextRun({ text: line.replace(/^####\s*/, ""), font: FONT_HEI, size: 21, bold: true })],
      }));
    } else if (line.match(/^[-*]\s/)) {
      const text = line.replace(/^[-*]\s*/, "");
      const runs = parseInlineFormatting(text);
      paragraphs.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.15) },
        children: [new TextRun({ text: "• ", font: FONT_SONG, size: 20 }), ...runs],
      }));
    } else if (line.match(/^\d+\.\s/)) {
      const text = line.replace(/^\d+\.\s*/, "");
      const num = line.match(/^(\d+)\./)?.[1] || "1";
      const runs = parseInlineFormatting(text);
      paragraphs.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { left: convertInchesToTwip(0.3), hanging: convertInchesToTwip(0.2) },
        children: [new TextRun({ text: `${num}. `, font: FONT_SONG, size: 20, bold: true }), ...runs],
      }));
    } else if (line.match(/^>\s/)) {
      paragraphs.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        indent: { left: convertInchesToTwip(0.4) },
        children: [new TextRun({ text: line.replace(/^>\s*/, ""), font: FONT_SONG, size: 20, italics: true, color: "666666" })],
      }));
    } else if (line.trim() === "" || line.match(/^---/)) {
      paragraphs.push(new Paragraph({ spacing: { before: 80, after: 80 }, children: [] }));
    } else {
      const runs = parseInlineFormatting(line);
      paragraphs.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        indent: { firstLine: convertInchesToTwip(0.3) },
        children: runs,
      }));
    }
  }
  if (inTable) flushTable();
  return paragraphs;
}

function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), font: FONT_HEI, size: 20, bold: true }));
    } else if (part.startsWith("`") && part.endsWith("`")) {
      runs.push(new TextRun({ text: part.slice(1, -1), font: "Consolas", size: 18, color: "c7254e" }));
    } else {
      runs.push(new TextRun({ text: part, font: FONT_SONG, size: 20, color: COLOR_DARK }));
    }
  }
  return runs;
}

function buildProjectDocument(proj: ProjectRow, companyName: string): Document {
  const children: (Paragraph | Table)[] = [];

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 60 },
    children: [new TextRun({ text: proj.name, font: FONT_HEI, size: 36, bold: true, color: COLOR_DARK })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 100 },
    children: [new TextRun({ text: "项目需求文档", font: FONT_HEI, size: 28, color: "666666" })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 },
    children: [new TextRun({ text: `${companyName} · ${fmtDate(proj.created_at)}`, font: FONT_SONG, size: 18, color: "999999", italics: true })],
  }));

  const budget = Number(proj.budget) || 0;
  const infoTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: [labelCell("项目名称"), valCell(proj.name, 3)] }),
      new TableRow({ children: [labelCell("项目状态"), valCell(statusCn(proj.status)), labelCell("项目预算"), valCell(budget ? `¥${budget.toLocaleString()}` : "-")] }),
      new TableRow({ children: [labelCell("开始日期"), valCell(fmtDate(proj.start_date)), labelCell("结束日期"), valCell(fmtDate(proj.end_date))] }),
      new TableRow({ children: [labelCell("所属公司"), valCell(companyName, 3)] }),
      new TableRow({ children: [labelCell("项目描述"), valCell(proj.description || "-", 3)] }),
    ],
  });
  children.push(infoTable);
  children.push(new Paragraph({ spacing: { before: 200 }, children: [] }));

  if (proj.document) {
    const docParagraphs = parseMarkdownToDocx(proj.document);
    children.push(...docParagraphs as Paragraph[]);
  } else {
    children.push(new Paragraph({
      spacing: { before: 200 },
      children: [new TextRun({ text: "（暂无详细需求文档）", font: FONT_SONG, size: 21, color: "999999", italics: true })],
    }));
  }

  children.push(new Paragraph({ spacing: { before: 400 }, children: [] }));
  children.push(new Paragraph({
    spacing: { before: 100 },
    children: [new TextRun({ text: `文档生成时间：${new Date().toLocaleString("zh-CN")}`, font: FONT_SONG, size: 16, color: "999999", italics: true })],
  }));

  return new Document({
    styles: { default: { document: { run: { font: FONT_SONG, size: 21, color: COLOR_DARK } } } },
    sections: [{
      properties: {
        page: { margin: { top: convertInchesToTwip(1), bottom: convertInchesToTwip(1), left: convertInchesToTwip(1.2), right: convertInchesToTwip(1.2) } },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `${proj.name} — 项目需求文档`, font: FONT_SONG, size: 16, color: "999999", italics: true })],
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
      children: children as Paragraph[],
    }],
  });
}

export async function handleExportProject(req: AuthRequest, res: ServerResponse, db: Db, projectId: string): Promise<void> {
  if (!requireAuth(req, res)) return;

  const { rows } = await db.query("SELECT * FROM opc_projects WHERE id = $1", [projectId]);
  if (!rows[0]) { sendJson(res, 404, { error: "项目不存在" }); return; }
  const proj = rows[0] as ProjectRow;

  let companyName = "";
  try {
    const body = await parseBody(req);
    companyName = String(body.company_name || "");
  } catch { /* use default */ }

  if (!companyName) {
    const { rows: crows } = await db.query("SELECT name FROM opc_companies WHERE id = $1", [proj.company_id]);
    if (crows[0]) companyName = (crows[0] as { name: string }).name;
  }

  const doc = buildProjectDocument(proj, companyName);
  const buffer = await Packer.toBuffer(doc);

  const safeName = encodeURIComponent((proj.name || "项目") + "-需求文档.docx");
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `attachment; filename="document.docx"; filename*=UTF-8''${safeName}`,
    "Content-Length": buffer.byteLength,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(buffer);
}
