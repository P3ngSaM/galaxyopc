#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const researchDir = path.resolve(process.cwd(), "research");
const dateText = new Date().toISOString().slice(0, 10);

const TITLE_OVERRIDES = new Map([
  [
    "https://www.ggzy.gov.cn/information/html/b//510000/0101/202601/19/005105c9c0119f2a410f939005413f5da58c.shtml",
    "西渝高铁大竹站站前广场及综合交通枢纽一期监理招标公告",
  ],
  [
    "https://www.dazhou.gov.cn/news-show-269407.html",
    "大竹：锚定“十五五”开局 冲刺工业“开门红”",
  ],
  [
    "https://www.dazhou.gov.cn/news-show-268687.html",
    "大竹：实干托举百强梦 匠心雕琢幸福城",
  ],
]);

const CURATED_OPPORTUNITY_URLS = [
  "https://www.ggzy.gov.cn/information/html/b//510000/0101/202601/19/005105c9c0119f2a410f939005413f5da58c.shtml",
  "https://ggzyjy.sc.gov.cn/jyxx/002001/002001001/20260106/55f7d224-51a3-4df3-9734-d8da1aac9514.html",
  "https://ggzyjy.sc.gov.cn/jyxx/002001/002001001/20251020/c47cdce0-0f41-489a-8ed8-2be47b91a99f.html",
  "https://ggzyjy.sc.gov.cn/jyxx/002002/002002002/20250804/8a69d40c986d4568019873d96a7f3bbf.html",
  "https://www.dazhu.gov.cn/xxgk-show-224327.html",
  "https://www.dazhu.gov.cn/xxgk-show-225121.html",
  "https://www.dazhou.gov.cn/news-show-269407.html",
  "https://www.dazhou.gov.cn/news-show-268687.html",
  "https://www.dazhu.gov.cn/xxgk-show-218519.html",
];

const CURATED_TARGETS = [
  "大竹县财政局",
  "大竹县农业农村局",
  "大竹县宏高建筑材料有限公司",
  "大竹县教育局",
  "大竹县泓泽农业服务有限公司",
  "大竹县经开区",
];

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortText(value, limit = 120) {
  const text = String(value || "")
    .replace(/[>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function cleanTitle(title, url) {
  if (TITLE_OVERRIDES.has(url)) return TITLE_OVERRIDES.get(url);
  return String(title || "")
    .replace(/^\?+/, "")
    .replace(/^达州市人民政府_县（市、区）动态_/, "")
    .replace(/[.。]+$/, "")
    .trim();
}

async function readJsonByPattern(pattern) {
  const files = await fs.readdir(researchDir);
  const matched = files.find((name) => pattern.test(name));
  if (!matched) throw new Error(`未找到文件: ${pattern}`);
  const fullPath = path.join(researchDir, matched);
  return JSON.parse(await fs.readFile(fullPath, "utf8"));
}

function normalizeFollowup(item) {
  return {
    ...item,
    sampleTitles: (item.sampleTitles || []).map((title, index) => cleanTitle(title, item.sampleUrls?.[index] || "")),
  };
}

function buildExecutiveSummary() {
  return [
    "大竹县已经可以验证一条清晰的商业链路：从政策和预算信号识别需求，再用招采项目和甲方主体完成订单匹配。",
    "当前最值得优先跟进的，不是泛产业资讯，而是高铁枢纽建设、医疗建设、教育采购、农业项目和园区产业扩张这五类明确需求。",
    "星环 OPC 的收费点应放在线索订阅、预算解析、供应商撮合、投标陪跑和履约分包，而不是单纯卖数据列表。",
  ];
}

function renderTargetCards(followups) {
  return followups.map((item) => {
    const tone = item.urgency === "高" ? "high" : "mid";
    return `
      <article class="target-card ${tone}">
        <div class="target-head">
          <h3>${escapeHtml(item.targetOrg)}</h3>
          <span class="score">评分 ${item.leadScore}</span>
        </div>
        <div class="meta">
          <span>优先级 ${escapeHtml(item.urgency)}</span>
          <span>最近日期 ${escapeHtml(item.latestDate || "-")}</span>
          <span>机会 ${item.opportunityCount}</span>
        </div>
        <p>${escapeHtml(item.outreach)}</p>
        <div class="chips">${(item.serviceFits || []).map((v) => `<span>${escapeHtml(v)}</span>`).join("")}</div>
        <ul>
          ${(item.sampleTitles || []).slice(0, 2).map((v) => `<li>${escapeHtml(v)}</li>`).join("")}
        </ul>
      </article>
    `;
  }).join("");
}

function inferDemand(title, targetOrg) {
  const text = `${title} ${targetOrg}`;
  if (/高铁|交通枢纽|站前广场|停车场/.test(text)) return "工程咨询、监理、施工配套、材料供应";
  if (/医院|医疗/.test(text)) return "施工总包分包、设备安装、后勤配套、维保";
  if (/教育局|作业本|学校/.test(text)) return "集采供货、印刷物资、校园信息化";
  if (/农田|农业|地膜|农机/.test(text)) return "测绘设计、农业设备、项目申报、社会化服务";
  if (/经开区|工业|竹产业|人工智能/.test(text)) return "招商协同、工业数字化、供应链撮合";
  return "投标陪跑、资源撮合、履约分包";
}

function renderOpportunityRows(opportunities) {
  return opportunities.map((item) => `
    <tr>
      <td>${escapeHtml(item.date || "")}</td>
      <td>${escapeHtml(item.targetOrgs?.join("、") || "待补主体")}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(inferDemand(item.title, item.targetOrgs?.join("、") || ""))}</td>
      <td>${escapeHtml(item.money?.join("、") || "-")}</td>
      <td>${escapeHtml(shortText(item.summary || item.keyPoints?.[0] || ""))}</td>
      <td><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">查看原文</a></td>
    </tr>
  `).join("");
}

async function main() {
  const followupJson = await readJsonByPattern(/2026甲方跟进清单-.*\.json$/);
  const opportunityJson = await readJsonByPattern(/2026商机池-.*\.json$/);
  const intelJson = await readJsonByPattern(/county-intel-.*\.json$/);

  const followups = (followupJson.followups || [])
    .filter((item) => CURATED_TARGETS.includes(item.targetOrg))
    .map(normalizeFollowup);

  const opportunities = CURATED_OPPORTUNITY_URLS
    .map((url) => (opportunityJson.opportunities || []).find((item) => item.url === url))
    .filter(Boolean)
    .map((item) => ({
      ...item,
      title: cleanTitle(item.title, item.url),
    }));

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>大竹县 2026 商机总览</title>
  <style>
    :root {
      --ink: #17212b;
      --muted: #5c6b77;
      --line: rgba(23,33,43,0.12);
      --teal: #0f766e;
      --gold: #a16207;
      --bg: #f7f3ea;
      --panel: rgba(255,255,255,0.82);
      --shadow: 0 18px 46px rgba(21,34,51,0.10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.12), transparent 26%),
        radial-gradient(circle at top right, rgba(161,98,7,0.12), transparent 22%),
        linear-gradient(180deg, #f6efe3 0%, #fbf8f2 55%, #f3f6f7 100%);
    }
    .page { max-width: 1240px; margin: 0 auto; padding: 28px 20px 48px; }
    .hero, .panel { border-radius: 26px; border: 1px solid rgba(255,255,255,0.65); box-shadow: var(--shadow); }
    .hero {
      padding: 30px;
      color: #fff;
      background: linear-gradient(135deg, #16334a 0%, #0f766e 100%);
    }
    .hero-top { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
    .hero h1 { margin: 0; font-size: 42px; line-height: 1.08; }
    .hero p { margin: 12px 0 0; max-width: 780px; color: rgba(255,255,255,0.86); line-height: 1.8; }
    .stamp { padding: 10px 14px; border-radius: 14px; background: rgba(255,255,255,0.12); font-size: 12px; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-top: 22px; }
    .stat { padding: 16px 18px; border-radius: 18px; background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.12); }
    .stat b { display: block; font-size: 30px; margin-bottom: 6px; }
    .stat span { font-size: 12px; color: rgba(255,255,255,0.8); text-transform: uppercase; letter-spacing: .04em; }
    .section { margin-top: 20px; }
    .panel { background: var(--panel); backdrop-filter: blur(10px); padding: 22px 24px; }
    .section-head { display: flex; justify-content: space-between; gap: 14px; align-items: end; margin-bottom: 14px; }
    .section-head h2 { margin: 0; font-size: 24px; }
    .section-head p { margin: 0; color: var(--muted); font-size: 13px; }
    .summary-list { margin: 0; padding-left: 20px; line-height: 1.9; }
    .grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 18px; }
    .target-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .target-card { padding: 18px; border-radius: 22px; border: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,255,255,.92), rgba(247,249,250,.82)); }
    .target-card.high { outline: 2px solid rgba(180,35,24,0.08); }
    .target-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .target-head h3 { margin: 0; font-size: 20px; }
    .score { color: var(--teal); font-weight: 700; font-size: 13px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; color: var(--muted); font-size: 12px; }
    .target-card p { margin: 14px 0 12px; line-height: 1.8; color: var(--muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips span { padding: 6px 10px; border-radius: 999px; background: rgba(15,118,110,.10); color: var(--teal); font-size: 12px; font-weight: 700; }
    .target-card ul { margin: 14px 0 0; padding-left: 18px; line-height: 1.75; }
    .signal-box { padding: 4px 0; }
    .signal { padding: 14px 0; border-bottom: 1px dashed var(--line); }
    .signal:last-child { border-bottom: 0; }
    .signal h4 { margin: 0 0 6px; font-size: 18px; }
    .signal p { margin: 0; color: var(--muted); line-height: 1.8; }
    .table-wrap { overflow: auto; }
    table { width: 100%; min-width: 980px; border-collapse: collapse; }
    th, td { padding: 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
    td a { color: var(--teal); text-decoration: none; font-weight: 700; }
    .foot { margin-top: 12px; color: var(--muted); font-size: 12px; line-height: 1.7; }
    @media (max-width: 980px) {
      .stats, .grid, .target-grid { grid-template-columns: 1fr; }
      .hero-top { flex-direction: column; }
      .hero h1 { font-size: 34px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1>大竹县 2026 商机总览</h1>
          <p>聚焦高铁枢纽、医疗建设、教育采购、农业项目和园区扩张五类机会，直接展示可跟进甲方与可承接服务。</p>
        </div>
        <div class="stamp">Galaxy OPC<br />${escapeHtml(intelJson.meta.generatedAt)}</div>
      </div>
      <div class="stats">
        <div class="stat"><b>${opportunities.length}</b><span>精选机会</span></div>
        <div class="stat"><b>${followups.length}</b><span>重点甲方</span></div>
        <div class="stat"><b>${intelJson.meta.documentCount}</b><span>全量样本</span></div>
        <div class="stat"><b>${escapeHtml(intelJson.opportunityGraph?.[0]?.label || "-")}</b><span>主需求方向</span></div>
      </div>
    </section>

    <section class="section panel">
      <div class="section-head">
        <h2>结论</h2>
        <p>这一页适合直接转发和汇报</p>
      </div>
      <ul class="summary-list">
        ${buildExecutiveSummary().map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </section>

    <section class="section grid">
      <div class="panel">
        <div class="section-head">
          <h2>重点甲方</h2>
          <p>建议优先从预算口、农业口、平台公司和教育口切入</p>
        </div>
        <div class="target-grid">${renderTargetCards(followups)}</div>
      </div>
      <div class="panel">
        <div class="section-head">
          <h2>需求信号</h2>
          <p>为什么这些主体值得跟</p>
        </div>
        <div class="signal-box">
          <div class="signal">
            <h4>工程建设需求已经明确</h4>
            <p>高铁站前广场、停车场、综合交通枢纽一期监理，以及第二人民医院施工标段，说明工程类订单正在释放。</p>
          </div>
          <div class="signal">
            <h4>农业项目具备连续性</h4>
            <p>高标准农田、地膜回收、农机补贴和以工代赈项目，意味着农业项目不只是政策背景，而是可拆成设计、设备、施工和服务外包。</p>
          </div>
          <div class="signal">
            <h4>园区和产业扩张给企业服务留出口</h4>
            <p>大竹经开区的新能源、轻纺、汽配和竹产业链扩张，适合切招商协同、供应链撮合和工业数字化。</p>
          </div>
          <div class="signal">
            <h4>收费点要围绕成交前后两端</h4>
            <p>前端卖线索订阅、预算解析和投标陪跑，后端卖供应商撮合、履约分包和项目交付协同。</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section panel">
      <div class="section-head">
        <h2>精选机会</h2>
        <p>按“能跟、能卖、能成交”标准筛过一轮</p>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>甲方</th>
              <th>项目</th>
              <th>可卖服务</th>
              <th>金额线索</th>
              <th>摘要</th>
              <th>链接</th>
            </tr>
          </thead>
          <tbody>${renderOpportunityRows(opportunities)}</tbody>
        </table>
      </div>
      <div class="foot">说明：页面中的条目优先采用官方来源。部分项目发布时间在 2025 年，但执行、交付或预算周期明确覆盖 2026 年，因此保留。</div>
    </section>
  </div>
</body>
</html>`;

  const outPath = path.join(researchDir, `大竹县-2026商机总览-精选版-${dateText}.html`);
  await fs.writeFile(outPath, html, "utf8");
  console.log(JSON.stringify({ ok: true, outPath }, null, 2));
}

main().catch((error) => {
  console.error("[build-dazhu-briefing-html] failed:", error);
  process.exitCode = 1;
});
