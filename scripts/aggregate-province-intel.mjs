#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { filterOpportunities } from "./opportunity-quality.mjs";

function parseArgs(argv) {
  const args = {
    inputDir: "",
    outputDir: path.resolve(process.cwd(), "research"),
    province: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--input-dir" && next) {
      args.inputDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--output-dir" && next) {
      args.outputDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--province" && next) {
      args.province = next.trim();
      i += 1;
    }
  }
  if (!args.inputDir) throw new Error("缺少 --input-dir");
  return args;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function escapeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function groupCount(items, pick) {
  const map = new Map();
  for (const item of items) {
    const key = pick(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function topMoneyHints(documents, limit = 20) {
  const rows = [];
  for (const doc of documents) {
    for (const money of doc.money || []) {
      rows.push({ county: doc.county, city: doc.city, title: doc.title, url: doc.url, money, sourceType: doc.sourceType });
    }
  }
  return rows.slice(0, limit);
}

function deriveTopOpportunityMeta(item) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  let stageTag = "线索研判";
  if (/中标|成交结果|成交公告|结果公示/.test(text)) stageTag = "结果公示";
  else if (/招标公告|采购公告|竞争性磋商|遴选|比选|询价|拍卖公告|挂牌出让公告/.test(text)) stageTag = "招采报名";
  else if (/实施方案|项目库|项目计划|批复|资金分配方案|项目安排/.test(text)) stageTag = "储备立项";
  else if (/招商|推介|签约/.test(text)) stageTag = "招商对接";
  let priorityLabel = "C";
  const score = Number(item.opportunityScore || 0);
  if (score >= 85) priorityLabel = "S";
  else if (score >= 75) priorityLabel = "A";
  else if (score >= 65) priorityLabel = "B";
  return { stageTag, priorityLabel };
}

function buildPayload(countyPayloads, provinceName) {
  const countyOpportunities = countyPayloads.map((item) => ({
    payload: item,
    opportunities: filterOpportunities((item.opportunityPool || []).map((doc) => ({ ...doc, county: item.meta.county, city: item.meta.city, province: item.meta.province }))),
  }));
  const allDocuments = countyPayloads.flatMap((item) =>
    (item.documents || []).map((doc) => ({ ...doc, county: item.meta.county, city: item.meta.city, province: item.meta.province })),
  );
  const allOpportunities = countyOpportunities.flatMap((item) => item.opportunities);

  const cities = new Map();
  for (const { payload, opportunities } of countyOpportunities) {
    const city = payload.meta.city;
    const county = payload.meta.county;
    if (!cities.has(city)) {
      cities.set(city, { city, counties: 0, documents: 0, opportunities: 0, officialDocs: 0, biddingDocs: 0, policyDocs: 0, industryDocs: 0 });
    }
    const agg = cities.get(city);
    const docs = payload.documents || [];
    agg.counties += 1;
    agg.documents += docs.length;
    agg.opportunities += opportunities.length;
    agg.officialDocs += docs.filter((doc) => doc.official).length;
    agg.biddingDocs += docs.filter((doc) => doc.sourceType === "bidding").length;
    agg.policyDocs += docs.filter((doc) => doc.sourceType === "policy").length;
    agg.industryDocs += docs.filter((doc) => doc.sourceType === "industry").length;
    agg.lastCounty = county;
  }

  const cityStats = [...cities.values()].sort((a, b) => b.opportunities - a.opportunities || b.documents - a.documents);
  const countyStats = countyOpportunities.map(({ payload, opportunities }) => ({
    province: payload.meta.province,
    city: payload.meta.city,
    county: payload.meta.county,
    documents: (payload.documents || []).length,
    opportunities: opportunities.length,
    officialDocs: (payload.documents || []).filter((doc) => doc.official).length,
    topDemands: (payload.opportunityGraph || []).slice(0, 3).map((item) => item.label),
    assessment: payload.assessment || [],
  })).sort((a, b) => b.opportunities - a.opportunities || b.documents - a.documents);

  const topOpportunities = allOpportunities.slice().sort((a, b) => Number(b.opportunityScore || 0) - Number(a.opportunityScore || 0)).slice(0, 30).map((item) => ({
    ...deriveTopOpportunityMeta(item),
    city: item.city,
    county: item.county,
    title: item.title,
    sourceType: item.sourceType,
    score: item.opportunityScore || 0,
    money: item.money || [],
    targetOrgs: item.targetOrgs || [],
    url: item.url,
    summary: item.summary || "",
  }));

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      province: provinceName,
      countyCount: countyPayloads.length,
      cityCount: new Set(countyPayloads.map((item) => item.meta.city)).size,
      documentCount: allDocuments.length,
      opportunityCount: allOpportunities.length,
      rawOpportunityCount: countyPayloads.reduce((sum, item) => sum + (item.opportunityPool || []).length, 0),
    },
    cityStats,
    countyStats,
    topDemands: groupCount(countyPayloads.flatMap((item) => (item.opportunityGraph || []).slice(0, 3).map((entry) => entry.label)), (value) => value).slice(0, 12),
    sourceTypeMix: groupCount(allDocuments, (item) => item.sourceType),
    targetOrgTop: groupCount(allDocuments.flatMap((item) => (item.targetOrgs || []).map((org) => ({ org }))), (item) => item.org).slice(0, 20),
    topMoneyHints: topMoneyHints(allDocuments, 20),
    topOpportunities,
  };
}

function renderMarkdown(payload) {
  const province = payload.meta.province || "省级";
  const lines = [
    `# ${province}产业与机会总览`,
    "",
    `- 生成时间：${payload.meta.generatedAt}`,
    `- 覆盖城市：${payload.meta.cityCount}`,
    `- 覆盖区县：${payload.meta.countyCount}`,
    `- 文档总数：${payload.meta.documentCount}`,
    `- 机会总数：${payload.meta.opportunityCount}`,
    "",
    "## 城市热度",
  ];
  for (const item of payload.cityStats.slice(0, 20)) lines.push(`- ${item.city}：区县 ${item.counties} 个，文档 ${item.documents} 条，机会 ${item.opportunities} 条`);
  lines.push("", "## 高频需求方向");
  for (const item of payload.topDemands) lines.push(`- ${item.key}：${item.count} 次`);
  lines.push("", "## 区县机会榜");
  for (const item of payload.countyStats.slice(0, 30)) lines.push(`- ${item.city}${item.county}：文档 ${item.documents}，机会 ${item.opportunities}，方向 ${item.topDemands.join(" / ")}`);
  lines.push("", "## 重点机会");
  for (const item of payload.topOpportunities.slice(0, 20)) {
    lines.push(`- [${item.city}${item.county}] ${item.title}（${item.sourceType}，评分 ${item.score}）`);
    if (item.money.length) lines.push(`  - 金额线索：${item.money.join("、")}`);
    if (item.targetOrgs.length) lines.push(`  - 甲方主体：${item.targetOrgs.join("、")}`);
    lines.push(`  - 链接：${item.url}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderHtml(payload) {
  const province = payload.meta.province || "省级";
  const cityRows = payload.cityStats.slice(0, 20).map((item) => `<tr><td>${escapeHtml(item.city)}</td><td>${item.counties}</td><td>${item.documents}</td><td>${item.opportunities}</td><td>${item.policyDocs}</td><td>${item.industryDocs}</td><td>${item.biddingDocs}</td></tr>`).join("");
  const countyCards = payload.countyStats.slice(0, 24).map((item) => `<div class="county-card"><div class="county-title">${escapeHtml(item.city)} · ${escapeHtml(item.county)}</div><div class="county-meta">文档 ${item.documents} · 机会 ${item.opportunities} · 官方 ${item.officialDocs}</div><div class="county-tags">${item.topDemands.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div><div class="county-desc">${escapeHtml((item.assessment || []).slice(0, 2).join(" "))}</div></div>`).join("");
  const oppRows = payload.topOpportunities.slice(0, 24).map((item) => `<tr><td>${escapeHtml(item.city)}${escapeHtml(item.county)}</td><td>${escapeHtml(item.sourceType)}</td><td>${item.score}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml((item.money || []).join("、"))}</td><td>${escapeHtml((item.targetOrgs || []).join("、"))}</td><td><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">查看</a></td></tr>`).join("");
  const demandBadges = payload.topDemands.slice(0, 12).map((item) => `<span class="badge">${escapeHtml(item.key)} · ${item.count}</span>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(province)}产业与机会总览</title><style>body{margin:0;padding:24px;background:#f5f7fb;color:#1f2937;font-family:"Microsoft YaHei","PingFang SC",sans-serif}.hero{background:linear-gradient(135deg,#111827,#1d4ed8);color:#fff;border-radius:20px;padding:28px;margin-bottom:22px}.hero h1{margin:0 0 10px;font-size:32px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:18px}.stat{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px}.stat .k{font-size:12px;opacity:.8}.stat .v{font-size:24px;font-weight:700;margin-top:4px}.section{margin-top:22px}.section h2{margin:0 0 12px;font-size:20px}.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:#e0ecff;color:#1d4ed8;margin:0 8px 8px 0;font-size:12px}.county-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.county-card{background:#fff;border:1px solid #dbe3f0;border-radius:16px;padding:16px;box-shadow:0 8px 20px rgba(15,23,42,.04)}.county-title{font-size:16px;font-weight:700;margin-bottom:6px}.county-meta{font-size:12px;color:#64748b;margin-bottom:10px}.county-tags span{display:inline-block;margin:0 6px 6px 0;padding:4px 8px;background:#fff7ed;color:#c2410c;border-radius:999px;font-size:11px}.county-desc{font-size:12px;color:#475569;line-height:1.7}table{width:100%;border-collapse:collapse;background:#fff;border-radius:16px;overflow:hidden}th,td{padding:12px 10px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:13px;vertical-align:top}th{background:#eff6ff;color:#1e3a8a;font-weight:700}a{color:#2563eb;text-decoration:none}</style></head><body><div class="hero"><h1>${escapeHtml(province)}产业与机会总览</h1><div>把区县级政策、产业、招采线索合并为省级机会视图，便于做城市比较、重点县筛选和商机分发。</div><div class="stats"><div class="stat"><div class="k">覆盖城市</div><div class="v">${payload.meta.cityCount}</div></div><div class="stat"><div class="k">覆盖区县</div><div class="v">${payload.meta.countyCount}</div></div><div class="stat"><div class="k">文档总数</div><div class="v">${payload.meta.documentCount}</div></div><div class="stat"><div class="k">机会总数</div><div class="v">${payload.meta.opportunityCount}</div></div></div></div><div class="section"><h2>高频需求方向</h2><div>${demandBadges}</div></div><div class="section"><h2>城市热度排行</h2><table><thead><tr><th>城市</th><th>区县</th><th>文档</th><th>机会</th><th>政策</th><th>产业</th><th>招采</th></tr></thead><tbody>${cityRows}</tbody></table></div><div class="section"><h2>区县机会地图（卡片视图）</h2><div class="county-grid">${countyCards}</div></div><div class="section"><h2>重点机会榜</h2><table><thead><tr><th>地区</th><th>类型</th><th>评分</th><th>标题</th><th>金额线索</th><th>甲方</th><th>链接</th></tr></thead><tbody>${oppRows}</tbody></table></div></body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allFiles = await walk(args.inputDir);
  const countyFiles = allFiles.filter((file) => /-county-intel-\d{4}-\d{2}-\d{2}\.json$/.test(file));
  const countyPayloads = [];
  for (const file of countyFiles) {
    try {
      const raw = await fs.readFile(file, "utf8");
      countyPayloads.push(JSON.parse(raw.replace(/^\uFEFF/, "")));
    } catch {}
  }
  const provinceName = args.province || countyPayloads[0]?.meta?.province || "省级";
  const payload = buildPayload(countyPayloads, provinceName);
  await fs.mkdir(args.outputDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(args.outputDir, `${provinceName}-产业与机会总览-${date}.json`);
  const mdPath = path.join(args.outputDir, `${provinceName}-产业与机会总览-${date}.md`);
  const htmlPath = path.join(args.outputDir, `${provinceName}-产业与机会总览-${date}.html`);
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(payload), "utf8");
  await fs.writeFile(htmlPath, renderHtml(payload), "utf8");
  console.log(JSON.stringify({ ok: true, jsonPath, mdPath, htmlPath, countyCount: payload.meta.countyCount, cityCount: payload.meta.cityCount, documentCount: payload.meta.documentCount, opportunityCount: payload.meta.opportunityCount }, null, 2));
}

main().catch((error) => {
  console.error("[aggregate-province-intel] failed:", error);
  process.exitCode = 1;
});
