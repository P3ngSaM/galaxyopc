#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const researchDir = path.resolve(process.cwd(), "research");
const today = new Date().toISOString().slice(0, 10);

const ORG_ADDRESS = new Map([
  ["大竹县财政局", "四川省达州市大竹县体育大道32号"],
  ["大竹县农业农村局", "四川省达州市大竹县白塔街道凤竹路111号"],
  ["大竹县教育局", "四川省达州市大竹县青年路122号"],
  ["大竹县泓泽农业服务有限公司", "四川省达州市大竹县白塔街道凤竹路111号"],
  ["大竹县宏高建筑材料有限公司", "四川省达州市大竹县高铁站片区"],
  ["大竹县经开区", "四川省达州市大竹县经济开发区"],
  ["大竹县观音中心卫生院", "四川省达州市大竹县观音镇"],
]);

const ADDRESS_COORD = new Map([
  ["四川省达州市大竹县白塔街道", [107.2044, 30.7418]],
  ["四川省达州市大竹县白塔街道凤竹路111号", [107.2118, 30.7386]],
  ["四川省达州市大竹县青年路122号", [107.2021, 30.7439]],
  ["四川省达州市大竹县体育大道32号", [107.1989, 30.7456]],
  ["四川省达州市大竹县经济开发区", [107.2478, 30.7235]],
  ["四川省达州市大竹县高铁站片区", [107.2596, 30.7324]],
  ["四川省达州市大竹县观音镇", [107.0864, 30.5931]],
  ["四川省达州市大竹县白塔街道青年路99号", [107.2035, 30.7427]],
]);

function cleanTitle(title, url = "") {
  if (url.includes("ggzy.gov.cn") && /招标公告/.test(title || "")) {
    return "西渝高铁大竹站站前广场及综合交通枢纽一期监理招标";
  }
  return String(title || "")
    .replace(/^\?+/, "")
    .replace(/^达州市人民政府_县（市、区）动态_/, "")
    .replace(/[.。]+$/, "")
    .trim();
}

function inferOpportunityType(doc) {
  const text = `${doc.title || ""} ${doc.summary || ""}`;
  if (/医院|卫生院|医疗/.test(text)) return "医疗采购";
  if (/教育局|作业本|学校/.test(text)) return "教育采购";
  if (/高标准农田|农业|农机|地膜/.test(text)) return "农业项目";
  if (/遴选|服务主体|实施主体/.test(text)) return "主体遴选";
  if (/以工代赈/.test(text)) return "财政项目";
  if (/高铁|交通枢纽|站前广场|停车场/.test(text)) return "招采项目";
  return doc.sourceType === "bidding" ? "招采项目" : "产业机会";
}

function inferServices(doc) {
  const text = `${doc.title || ""} ${doc.summary || ""}`;
  if (/医院|卫生院|医疗/.test(text)) return ["医疗设备", "施工分包", "维保交付", "投标陪跑"];
  if (/教育局|作业本|学校/.test(text)) return ["印刷物资", "集采供货", "校园信息化", "履约分包"];
  if (/高标准农田|农业/.test(text)) return ["测绘设计", "农业设备", "社会化服务", "项目履约"];
  if (/以工代赈/.test(text)) return ["施工协同", "劳务组织", "材料供应", "履约分包"];
  if (/高铁|交通枢纽|站前广场/.test(text)) return ["工程咨询", "监理协同", "施工配套", "材料供应"];
  if (/竹产业|竹原纤维|人工智能|工业/.test(text)) return ["产业招商", "工业数字化", "供应链撮合", "渠道拓展"];
  return ["投标陪跑", "供应商撮合", "履约分包"];
}

function withCoordinate(item) {
  const coord = ADDRESS_COORD.get(item.address);
  if (!coord) return item;
  return {
    ...item,
    longitude: coord[0],
    latitude: coord[1],
  };
}

function buildIndustryPoints(opportunities, followups) {
  const points = [];
  const hasBamboo = opportunities.find((doc) => /竹产业|竹原纤维|苎麻/.test(`${doc.title} ${doc.summary}`));
  if (hasBamboo) {
    points.push({
      id: "industry-bamboo",
      name: "竹产业与竹麻新材料",
      category: "产业集群",
      address: "四川省达州市大竹县经济开发区",
      summary: "围绕以竹代塑、竹原纤维、苎麻新材料与发酵食品等方向持续扩张。",
      services: ["产业招商", "供应链撮合", "工业数字化", "渠道拓展"],
    });
  }
  const hasEnergy = opportunities.find((doc) => /新能源|极柱|汽车零部件|工业开门红/.test(`${doc.title} ${doc.summary}`));
  if (hasEnergy) {
    points.push({
      id: "industry-energy",
      name: "新能源与精密制造",
      category: "产业集群",
      address: "四川省达州市大竹县经济开发区",
      summary: "新能源极柱、汽配和轻纺出口并行扩张，适合切系统、设备和配套供应。",
      services: ["MES/ERP", "设备联网", "配套供应", "订单撮合"],
    });
  }
  if (followups.find((item) => item.targetOrg === "大竹县农业农村局" || item.targetOrg === "大竹县泓泽农业服务有限公司")) {
    points.push({
      id: "industry-agri",
      name: "高标准农田与农业服务",
      category: "农业项目",
      address: "四川省达州市大竹县白塔街道凤竹路111号",
      summary: "高标准农田、农机补贴、地膜回收和农业社会化服务构成连续项目池。",
      services: ["测绘设计", "农业设备", "项目申报", "社会化服务"],
    });
  }
  if (opportunities.find((doc) => /医院|卫生院|医疗/.test(`${doc.title} ${doc.summary}`))) {
    points.push({
      id: "industry-health",
      name: "县域医疗建设与设备采购",
      category: "公共服务",
      address: "四川省达州市大竹县白塔街道青年路99号",
      summary: "医院建设和基层卫生院设备采购并行，适合医疗设备和工程服务切入。",
      services: ["施工分包", "设备采购", "维保服务", "投标陪跑"],
    });
  }
  if (followups.find((item) => item.targetOrg === "大竹县教育局")) {
    points.push({
      id: "industry-edu",
      name: "教育采购与校园物资",
      category: "公共服务",
      address: "四川省达州市大竹县青年路122号",
      summary: "教育局集采具备周期性，适合印刷物资、校园设备和信息化服务。",
      services: ["印刷物资", "集采供货", "校园信息化", "履约分包"],
    });
  }
  return points;
}

async function readJsonByPattern(pattern) {
  const files = await fs.readdir(researchDir);
  const file = files.find((name) => pattern.test(name));
  if (!file) throw new Error(`未找到文件: ${pattern}`);
  return JSON.parse(await fs.readFile(path.join(researchDir, file), "utf8"));
}

async function main() {
  const opportunityJson = await readJsonByPattern(/2026商机池-.*\.json$/);
  const followupJson = await readJsonByPattern(/2026甲方跟进清单-.*\.json$/);
  const intelJson = await readJsonByPattern(/county-intel-.*\.json$/);

  const opportunities = (opportunityJson.opportunities || [])
    .filter((doc) => (doc.official !== false))
    .map((doc, index) => {
      const targetOrg = doc.targetOrgs?.[0] || "";
      return {
        id: `opp-${index + 1}`,
        title: cleanTitle(doc.title, doc.url),
        type: inferOpportunityType(doc),
        targetOrg: targetOrg || "待补主体",
        address: ORG_ADDRESS.get(targetOrg) || "四川省达州市大竹县白塔街道",
        budget: (doc.money || []).join("、") || "待披露",
        summary: String(doc.summary || doc.keyPoints?.[0] || "").replace(/\s+/g, " ").trim(),
        services: inferServices(doc),
        sourceUrl: doc.url,
      };
    })
    .map(withCoordinate)
    .slice(0, 12);

  const industries = buildIndustryPoints(opportunities, followupJson.followups || []).map(withCoordinate);

  const payload = {
    meta: {
      county: "大竹县",
      city: "达州市",
      province: "四川省",
      updatedAt: today,
      centerAddress: "四川省达州市大竹县白塔街道",
      generatedFrom: "research-json",
      rawDocumentCount: intelJson.meta?.documentCount || 0,
      opportunityPoolCount: opportunityJson.meta?.opportunityCount || opportunities.length,
      followupCount: followupJson.meta?.followupCount || 0,
      mappedIndustryCount: industries.length,
      mappedOpportunityCount: opportunities.length,
    },
    industries,
    opportunities,
  };

  const outPath = path.join(researchDir, "dazhu-opportunity-map.json");
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, outPath, industryCount: industries.length, opportunityCount: opportunities.length }, null, 2));
}

main().catch((error) => {
  console.error("[build-dazhu-opportunity-map] failed:", error);
  process.exitCode = 1;
});
