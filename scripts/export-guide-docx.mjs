import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";

const cwd = process.cwd();
const inputArg = process.argv[2];
const outputArg = process.argv[3];
const inputPath = inputArg
  ? path.resolve(cwd, inputArg)
  : path.join(cwd, "docs", "opc-software-overview-and-deployment-guide.md");
const outputPath = outputArg
  ? path.resolve(cwd, outputArg)
  : path.join(cwd, "docs", "opc-software-overview-and-deployment-guide.docx");

const md = fs.readFileSync(inputPath, "utf8");
const lines = md.split(/\r?\n/);

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];

function toCnNum(n) {
  return CN_NUM[n - 1] || String(n);
}

function toParenCnNum(n) {
  return `（${toCnNum(n)}）`;
}

function stripLeadingCnSection(text) {
  return text
    .replace(/^（[一二三四五六七八九十]+）\s*/, "")
    .replace(/^[一二三四五六七八九十]+、\s*/, "")
    .trim();
}

function flushParagraph(buffer, paragraphs) {
  const text = buffer.join(" ").trim();
  if (!text) return;
  paragraphs.push(
    new Paragraph({
      children: [
        new TextRun({
          text,
          size: 24,
          font: "SimSun",
        }),
      ],
      spacing: { after: 100, line: 420 },
      indent: { firstLine: 480 },
    }),
  );
  buffer.length = 0;
}

function makeHeading(text, level) {
  const heading = level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
  const size = level === 1 ? 32 : level === 2 ? 28 : 26;
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: true,
        size,
        color: "000000",
        font: "SimHei",
      }),
    ],
    heading,
    alignment: AlignmentType.LEFT,
    spacing: {
      before: level === 1 ? 320 : 240,
      after: 100,
    },
  });
}

function makeMinorHeading(text) {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: true,
        size: 24,
        color: "000000",
        font: "SimSun",
      }),
    ],
    spacing: {
      before: 120,
      after: 40,
      line: 360,
    },
  });
}

function stripInlineMd(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1");
}

function isTableLine(line) {
  return /^\|.*\|$/.test(line.trim());
}

function isDividerLine(line) {
  return /^\|(\s*:?-{3,}:?\s*\|)+$/.test(line.trim());
}

function parseTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => stripInlineMd(cell).trim());
}

function makeTable(rows) {
  const outerBorder = { style: BorderStyle.SINGLE, size: 6, color: "808080" };
  const innerBorder = { style: BorderStyle.SINGLE, size: 2, color: "CFCFCF" };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((cells, rowIndex) =>
      new TableRow({
        tableHeader: rowIndex === 0,
        children: cells.map(
          (cell) =>
            new TableCell({
              verticalAlign: VerticalAlign.CENTER,
              shading: rowIndex === 0 ? { fill: "F2F2F2" } : undefined,
              borders: {
                top: rowIndex === 0 ? outerBorder : innerBorder,
                bottom: rowIndex === rows.length - 1 ? outerBorder : innerBorder,
                left: outerBorder,
                right: outerBorder,
              },
              margins: {
                top: 90,
                bottom: 90,
                left: 100,
                right: 100,
              },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: cell,
                      font: "SimSun",
                      size: 22,
                      bold: rowIndex === 0,
                    }),
                  ],
                  spacing: { after: 20, before: 20, line: 320 },
                  alignment: rowIndex === 0 ? AlignmentType.CENTER : AlignmentType.LEFT,
                }),
              ],
            }),
        ),
      }),
    ),
  });
}

function parseMarkdownToParagraphs(content) {
  const paragraphs = [];
  const buffer = [];
  let inCode = false;
  let h2 = 0;
  let h3 = 0;
  const mdLines = content.split(/\r?\n/);

  for (let i = 0; i < mdLines.length; i += 1) {
    const rawLine = mdLines[i];
    const line = rawLine.replace(/\t/g, "    ");

    if (line.trim().startsWith("```")) {
      flushParagraph(buffer, paragraphs);
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: rawLine,
              font: "Consolas",
              size: 20,
            }),
          ],
          shading: { fill: "F7F7F7" },
          indent: { left: 240, right: 240 },
          spacing: { after: 60, line: 300 },
        }),
      );
      continue;
    }

    if (!line.trim()) {
      flushParagraph(buffer, paragraphs);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph(buffer, paragraphs);
      paragraphs.push(
        new Paragraph({
          border: { bottom: { color: "BFBFBF", space: 1, size: 6, style: "single" } },
          spacing: { after: 180, before: 180 },
        }),
      );
      continue;
    }

    if (
      isTableLine(line) &&
      i + 1 < mdLines.length &&
      isDividerLine(mdLines[i + 1])
    ) {
      flushParagraph(buffer, paragraphs);
      const tableRows = [parseTableCells(line)];
      i += 2;
      while (i < mdLines.length && isTableLine(mdLines[i])) {
        tableRows.push(parseTableCells(mdLines[i]));
        i += 1;
      }
      i -= 1;
      paragraphs.push(makeTable(tableRows));
      paragraphs.push(new Paragraph({ spacing: { after: 140 } }));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph(buffer, paragraphs);
      const level = headingMatch[1].length;
      let text = stripInlineMd(headingMatch[2]).trim();
      if (level === 2) {
        h2 += 1;
        h3 = 0;
        text = `${toCnNum(h2)}、${stripLeadingCnSection(text.replace(/^\d+\.\s*/, ""))}`;
        paragraphs.push(makeHeading(text, level));
      } else if (level >= 3) {
        h3 += 1;
        text = `${toParenCnNum(h3)} ${stripLeadingCnSection(text.replace(/^\d+(\.\d+)?\s*/, ""))}`;
        paragraphs.push(makeMinorHeading(text));
      } else {
        paragraphs.push(makeHeading(text, level));
      }
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph(buffer, paragraphs);
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: stripInlineMd(bulletMatch[1]).trim(),
              size: 24,
              font: "SimSun",
            }),
          ],
          bullet: { level: 0 },
          spacing: { after: 60, line: 360 },
        }),
      );
      continue;
    }

    const numberMatch = line.match(/^(\d+)\.\s+(.*)$/);
    if (numberMatch) {
      flushParagraph(buffer, paragraphs);
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${numberMatch[1]}. ${stripInlineMd(numberMatch[2]).trim()}`,
              size: 24,
              font: "SimSun",
            }),
          ],
          indent: { left: 240, hanging: 240 },
          spacing: { after: 80, line: 360 },
        }),
      );
      continue;
    }

    buffer.push(stripInlineMd(line).trim());
  }

  flushParagraph(buffer, paragraphs);
  return paragraphs;
}

const title = "星环 OPC 软件部署与功能说明书";
const today = new Date().toLocaleDateString("zh-CN");

const bodyParagraphs = parseMarkdownToParagraphs(md);

const doc = new Document({
  creator: "OpenAI Codex",
  title,
  description: "星环 OPC 正式交付说明文档",
  styles: {
    default: {
      document: {
        run: {
          font: "Microsoft YaHei",
          size: 24,
        },
        paragraph: {
          spacing: {
            line: 360,
            after: 120,
          },
        },
      },
    },
    paragraphStyles: [
      {
        id: "TitleMain",
        name: "TitleMain",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: {
          bold: true,
          size: 38,
          color: "000000",
          font: "SimHei",
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: { after: 240 },
        },
      },
      {
        id: "SubTitle",
        name: "SubTitle",
        basedOn: "Normal",
        next: "Normal",
        run: {
          size: 22,
          color: "000000",
          font: "SimSun",
        },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
        },
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          margin: {
            top: 1440,
            bottom: 1440,
            left: 1440,
            right: 1440,
          },
        },
      },
      children: [
        new Paragraph({
          text: title,
          style: "TitleMain",
        }),
        new Paragraph({
          text: "软件部署与使用说明文件",
          style: "SubTitle",
        }),
        new Paragraph({
          spacing: { after: 5200 },
        }),
        new Paragraph({
          text: "编制单位：星环 OPC 项目组",
          style: "SubTitle",
        }),
        new Paragraph({
          text: `日期：${today}`,
          style: "SubTitle",
        }),
        new Paragraph({
          pageBreakBefore: true,
        }),
        ...bodyParagraphs,
      ],
    },
  ],
});

const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(outputPath, buffer);
console.log(outputPath);
