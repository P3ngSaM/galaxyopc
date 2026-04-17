#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import https from "node:https";
import "dotenv/config";
import { filterOpportunities } from "./opportunity-quality.mjs";

function parseArgs(argv) {
  const args = {
    inputDir: "",
    outputPath: "",
    cachePath: "",
    aggregatePath: "",
    province: "",
    centerAddress: "",
    maxOpportunities: 120,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--input-dir" && next) {
      args.inputDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--output" && next) {
      args.outputPath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--cache" && next) {
      args.cachePath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--aggregate" && next) {
      args.aggregatePath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--province" && next) {
      args.province = next.trim();
      i += 1;
    } else if (token === "--center-address" && next) {
      args.centerAddress = next.trim();
      i += 1;
    } else if (token === "--max-opportunities" && next) {
      args.maxOpportunities = Math.max(10, Number.parseInt(next, 10) || 120);
      i += 1;
    }
  }
  if (!args.inputDir) throw new Error("缺少 --input-dir");
  if (!args.aggregatePath) throw new Error("缺少 --aggregate");
  if (!args.province) throw new Error("缺少 --province");
  const slug = String(args.province).replace(/省|市|自治区|回族|壮族|维吾尔|特别行政区/g, "").trim() || "province";
  if (!args.outputPath) args.outputPath = path.resolve(process.cwd(), "research", `${slug}-opportunity-map.json`);
  if (!args.cachePath) args.cachePath = path.resolve(process.cwd(), "research", `${slug}-geocode-cache.json`);
  if (!args.centerAddress) args.centerAddress = args.province;
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

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 12000);
    https.get(url, (resp) => {
      let body = "";
      resp.on("data", (chunk) => { body += chunk.toString(); });
      resp.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("json parse error"));
        }
      });
      resp.on("error", reject);
    }).on("error", reject);
  });
}

async function geocode(address, city, cache) {
  const key = `${city}::${address}`;
  if (cache[key]) return cache[key];
  const amapKey = process.env.AMAP_SERVER_KEY || process.env.AMAP_KEY || "";
  if (!amapKey) throw new Error("缺少 AMAP_SERVER_KEY/AMAP_KEY");
  const params = new URLSearchParams({ key: amapKey, address, output: "json" });
  if (city) params.set("city", city);
  const data = await requestJson(`https://restapi.amap.com/v3/geocode/geo?${params.toString()}`);
  if (data.status !== "1" || !Array.isArray(data.geocodes) || !data.geocodes.length) throw new Error(`geocode failed for ${address}`);
  const loc = String(data.geocodes[0].location || "").split(",");
  if (loc.length !== 2) throw new Error(`invalid location for ${address}`);
  const value = { longitude: Number.parseFloat(loc[0]), latitude: Number.parseFloat(loc[1]), formattedAddress: data.geocodes[0].formatted_address || address };
  cache[key] = value;
  return value;
}

async function geocodeWithFallback(addresses, city, cache) {
  let lastError = null;
  for (const address of addresses) {
    if (!address) continue;
    try { return await geocode(address, city, cache); } catch (error) { lastError = error; }
  }
  throw lastError || new Error(`geocode failed for ${city}`);
}

function stableOffset(seed, scale = 0.12) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  const x = ((hash % 1000) / 1000 - 0.5) * scale;
  const y = ((((hash / 1000) | 0) % 1000) / 1000 - 0.5) * scale;
  return [Number(x.toFixed(6)), Number(y.toFixed(6))];
}

function deriveCountyCategory(topDemands) {
  const text = String((topDemands || []).join(" "));
  if (/工业|设备|数字化|制造/.test(text)) return "工业与制造";
  if (/农业|农田|品牌|渠道/.test(text)) return "农业与食品";
  if (/采购|专业服务|外包/.test(text)) return "政府采购";
  if (/招聘|用工|补贴/.test(text)) return "用工与人服";
  return "综合产业";
}

function deriveOpportunityType(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${(item.targetOrgs || []).join(" ")}`;
  if (/医院|卫生院|医疗/.test(text)) return "医疗采购";
  if (/教育|学校|校园|作业本/.test(text)) return "教育采购";
  if (/农业|农田|农机|农业农村/.test(text)) return "农业项目";
  if (/挂牌|拍卖|采矿权|采砂权|出让/.test(text)) return "资源出让";
  if (/招商|签约|推介/.test(text)) return "招商机会";
  if (/园区|产业|招商|新材料|制造/.test(text)) return "产业扩张";
  if (/中标|招标|采购|遴选|比选|项目/.test(text)) return "招采项目";
  return "综合商机";
}

function deriveServices(item, topDemands) {
  const text = `${item.title || ""} ${item.summary || ""} ${String((topDemands || []).join(" "))}`;
  if (/医院|卫生院|医疗/.test(text)) return ["医疗设备", "信息化系统", "工程配套", "维保交付"];
  if (/教育|学校|校园|作业本/.test(text)) return ["校园物资", "集采供货", "校园信息化", "履约配送"];
  if (/农业|农田|农机/.test(text)) return ["测绘设计", "农业设备", "项目申报", "社会化服务"];
  if (/工业|制造|设备|数字化/.test(text)) return ["设备改造", "工业数字化", "软件系统", "配套供应"];
  if (/招商|签约|推介/.test(text)) return ["招商陪跑", "落地服务", "项目包装", "渠道引入"];
  if (/挂牌|拍卖|采矿权|采砂权|出让/.test(text)) return ["资源撮合", "资质筛选", "项目尽调", "联合报名"];
  if (/招标|采购|遴选|比选|项目/.test(text)) return ["投标陪跑", "供应商撮合", "履约分包", "甲方拜访"];
  return ["线索研判", "需求撮合", "投标支持"];
}

function deriveOpportunityStageTag(item) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  if (/中标|成交结果|成交公告|结果公示/.test(text)) return "结果公示";
  if (/招标公告|采购公告|竞争性磋商|遴选|比选|询价|拍卖公告|挂牌出让公告/.test(text)) return "招采报名";
  if (/实施方案|项目库|项目计划|批复|资金分配方案|项目安排/.test(text)) return "储备立项";
  if (/招商|推介|签约/.test(text)) return "招商对接";
  if (/开工|施工/.test(text)) return "实施推进";
  return "线索研判";
}

function deriveMerchantFitProfiles(item, services) {
  const text = `${item.title || ""} ${item.summary || ""} ${(item.targetOrgs || []).join(" ")} ${services.join(" ")}`;
  const profiles = [];
  if (/施工|工程|监理|总承包|EPC|水利|基建/.test(text)) profiles.push("工程建设商家");
  if (/医疗|医院|卫生/.test(text)) profiles.push("医疗设备与信息化商家");
  if (/农业|农田|农机|乡村振兴|林业/.test(text)) profiles.push("农业服务与农资商家");
  if (/教育|学校|校园/.test(text)) profiles.push("教育集采与校园服务商家");
  if (/招商|园区|产业|数字化|制造/.test(text)) profiles.push("产业服务与数字化商家");
  if (/拍卖|挂牌|采矿权|采砂权|出让/.test(text)) profiles.push("资源开发与资质服务商家");
  if (!profiles.length) profiles.push("综合服务商家");
  return profiles.slice(0, 3);
}

function deriveEntryFocus(item) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  if (/招标|采购|磋商|比选|遴选/.test(text)) return "先拿招标文件和报名节点，锁定甲方、代理和资格条件。";
  if (/项目库|项目计划|实施方案|批复|资金分配/.test(text)) return "先找主管部门确认项目清单、实施主体和资金下达节奏。";
  if (/招商|推介|签约/.test(text)) return "先找招商主管或园区平台，确认拟落地企业、配套需求和合作模式。";
  if (/拍卖|挂牌|采矿权|采砂权|出让/.test(text)) return "先核实报名门槛、资质要求和联合参与方式。";
  return "先补齐甲方、预算、阶段和联系人，再判断自营还是撮合。";
}

function deriveNextActions(item, services, fitProfiles) {
  const target = (item.targetOrgs || [])[0] || "相关主管部门";
  return [
    `联系 ${target}，确认当前阶段、预算口径和关键时间点。`,
    `围绕 ${services.slice(0, 2).join("、") || "可售服务"} 做一页标准方案。`,
    `优先匹配 ${fitProfiles[0] || "综合服务商家"}，安排首轮触达和资质校验。`,
  ];
}

function derivePriority(item, services, fitProfiles) {
  const score = Number(item.opportunityScore || 0);
  const text = `${item.title || ""} ${item.summary || ""}`;
  let bonus = 0;
  if ((item.money || []).length > 0) bonus += 8;
  if ((item.targetOrgs || []).length > 0) bonus += 6;
  if (/招标公告|采购公告|竞争性磋商|比选|遴选|拍卖公告|挂牌出让公告/.test(text)) bonus += 8;
  if (/招商|签约|项目库|实施方案|批复|资金分配/.test(text)) bonus += 6;
  if (services.length >= 3) bonus += 3;
  if (fitProfiles.length >= 2) bonus += 2;
  const priorityScore = score + bonus;
  if (priorityScore >= 88) return { priorityScore, priorityLabel: "S", priorityText: "立即跟进" };
  if (priorityScore >= 78) return { priorityScore, priorityLabel: "A", priorityText: "高优先级" };
  if (priorityScore >= 68) return { priorityScore, priorityLabel: "B", priorityText: "重点观察" };
  return { priorityScore, priorityLabel: "C", priorityText: "线索储备" };
}

function formatMoney(money) {
  if (!Array.isArray(money) || !money.length) return "待核实";
  return money.join("、");
}

function pickBattlePlan(item, county) {
  const topDemands = county.topDemands || [];
  const type = deriveOpportunityType(item);
  const services = deriveServices(item, topDemands);
  return {
    why: `${county.city}${county.county}当前高频需求集中在${topDemands.slice(0, 2).join("、") || "政府采购与产业服务"}，这条线索适合作为进入当地甲方或园区的切入口。`,
    entry: ["先确认项目或政策当前处于立项、采购、招标还是实施阶段。", `优先联系 ${(item.targetOrgs || []).slice(0, 2).join("、") || `${county.city}${county.county}相关主管部门`}，不要只盯公告标题。`, `把可售服务拆成 ${services.join(" / ")}，形成标准方案。`],
    plan: ["建立县域线索台账，补齐预算、甲方、时间节点和阶段字段。", "把入驻商家能力贴到这条线索上，先筛出最匹配的 3 家。", "按 7 天节奏推进首轮触达、需求确认、报价和二次跟进。"],
    action: [`先打电话或拜访 ${(item.targetOrgs || [county.county])[0]}。`, "同步整理同县近 12 个月相似项目，反推真实成交体量。", "把平台收费切口放在精准线索、撮合服务和履约协同。"],
    monetization: `优先卖 ${services.slice(0, 2).join("、")} 这类更容易快速成交的服务，再延伸到更大客单价合作。`,
    risks: ["如果只展示线索、不做商家匹配和跟进台账，地图价值会迅速衰减。", `${type} 类机会通常周期长，需要持续推进而不是一次性查看。`],
  };
}

async function loadCountyPayloads(inputDir) {
  const allFiles = await walk(inputDir);
  const countyFiles = allFiles.filter((file) => /-county-intel-\d{4}-\d{2}-\d{2}\.json$/.test(file));
  const payloads = [];
  for (const file of countyFiles) {
    try {
      const raw = await fs.readFile(file, "utf8");
      payloads.push(JSON.parse(raw.replace(/^\uFEFF/, "")));
    } catch {}
  }
  return payloads;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const countyPayloads = await loadCountyPayloads(args.inputDir);
  const aggregate = await readJsonIfExists(args.aggregatePath, { meta: {}, cityStats: [], countyStats: [] });
  const cache = await readJsonIfExists(args.cachePath, {});
  const countyStatsByKey = new Map((aggregate.countyStats || []).map((item) => [`${item.city}::${item.county}`, item]));
  const countyOpportunities = new Map(countyPayloads.map((payload) => {
    const key = `${payload.meta.city}::${payload.meta.county}`;
    return [key, filterOpportunities(payload.opportunityPool || [])];
  }));

  const centerGeo = await geocodeWithFallback([args.centerAddress, args.province], "", cache);
  const countyCenters = new Map();
  const cityCenters = new Map();
  for (const payload of countyPayloads) {
    const key = `${payload.meta.city}::${payload.meta.county}`;
    try {
      const center = await geocodeWithFallback([
        `${args.province}${payload.meta.city}${payload.meta.county}人民政府`,
        `${payload.meta.city}${payload.meta.county}人民政府`,
        `${args.province}${payload.meta.city}${payload.meta.county}`,
        `${payload.meta.city}${payload.meta.county}`,
      ], payload.meta.city, cache);
      countyCenters.set(key, center);
    } catch {
      let cityCenter = cityCenters.get(payload.meta.city);
      if (!cityCenter) {
        try {
          cityCenter = await geocodeWithFallback([
            `${args.province}${payload.meta.city}人民政府`,
            `${args.province}${payload.meta.city}`,
            payload.meta.city,
          ], payload.meta.city, cache);
        } catch {
          const [cdx, cdy] = stableOffset(`city-center-fallback:${payload.meta.city}`, 0.8);
          cityCenter = {
            longitude: Number((centerGeo.longitude + cdx).toFixed(6)),
            latitude: Number((centerGeo.latitude + cdy).toFixed(6)),
            formattedAddress: `${args.province}${payload.meta.city}`,
          };
        }
        cityCenters.set(payload.meta.city, cityCenter);
      }
      const [dx, dy] = stableOffset(`county-fallback:${key}`, 0.36);
      countyCenters.set(key, { longitude: Number((cityCenter.longitude + dx).toFixed(6)), latitude: Number((cityCenter.latitude + dy).toFixed(6)), formattedAddress: `${args.province}${payload.meta.city}${payload.meta.county}` });
    }
  }

  const industries = countyPayloads.map((payload, index) => {
    const key = `${payload.meta.city}::${payload.meta.county}`;
    const center = countyCenters.get(key) || { longitude: centerGeo.longitude, latitude: centerGeo.latitude, formattedAddress: `${args.province}${payload.meta.city}${payload.meta.county}` };
    const county = countyStatsByKey.get(key) || {};
    const [dx, dy] = stableOffset(`industry:${key}:${index}`, 0.1);
    const topDemands = county.topDemands || (payload.opportunityGraph || []).slice(0, 3).map((item) => item.label);
    const opportunities = countyOpportunities.get(key) || [];
    return {
      id: `county-${payload.meta.city}-${payload.meta.county}`,
      name: `${payload.meta.county}产业与需求`,
      title: `${payload.meta.city}${payload.meta.county}产业机会面`,
      type: "区县产业面",
      category: deriveCountyCategory(topDemands),
      city: payload.meta.city,
      county: payload.meta.county,
      address: center.formattedAddress || `${args.province}${payload.meta.city}${payload.meta.county}`,
      longitude: Number((center.longitude + dx).toFixed(6)),
      latitude: Number((center.latitude + dy).toFixed(6)),
      summary: (payload.assessment || []).slice(0, 2).join(" "),
      services: deriveServices({ title: "", summary: topDemands.join(" ") }, topDemands),
      topDemands,
      documentCount: (payload.documents || []).length,
      opportunityCount: opportunities.length,
      score: Number((county.opportunities || 0) * 10 + (county.documents || 0)).toFixed(0),
    };
  });

  const opportunities = countyPayloads.flatMap((payload) => {
    const key = `${payload.meta.city}::${payload.meta.county}`;
    const center = countyCenters.get(key) || { longitude: centerGeo.longitude, latitude: centerGeo.latitude, formattedAddress: `${args.province}${payload.meta.city}${payload.meta.county}` };
    const county = countyStatsByKey.get(key) || {};
    return (countyOpportunities.get(key) || []).map((item, index) => {
      const [dx, dy] = stableOffset(`opportunity:${key}:${item.url || item.title || index}`, 0.18);
      const type = deriveOpportunityType(item);
      const services = deriveServices(item, county.topDemands || []);
      const fitProfiles = deriveMerchantFitProfiles(item, services);
      const priority = derivePriority(item, services, fitProfiles);
      const score = Number(item.opportunityScore || 0);
      return {
        id: `opp-${Buffer.from(`${key}:${item.url || item.title || index}`).toString("base64").replace(/[=+/]/g, "").slice(0, 18)}`,
        title: item.title || `${payload.meta.county}机会线索`,
        name: item.title || `${payload.meta.county}机会线索`,
        type,
        category: type,
        city: payload.meta.city,
        county: payload.meta.county,
        targetOrg: (item.targetOrgs || [])[0] || "",
        targetOrgs: item.targetOrgs || [],
        address: center.formattedAddress || `${args.province}${payload.meta.city}${payload.meta.county}`,
        longitude: Number((center.longitude + dx).toFixed(6)),
        latitude: Number((center.latitude + dy).toFixed(6)),
        budget: formatMoney(item.money),
        money: item.money || [],
        summary: String(item.summary || "").replace(/\s+/g, " ").trim(),
        services,
        fitProfiles,
        stageTag: deriveOpportunityStageTag(item),
        entryFocus: deriveEntryFocus(item),
        nextActions: deriveNextActions(item, services, fitProfiles),
        priorityLabel: priority.priorityLabel,
        priorityText: priority.priorityText,
        priorityScore: priority.priorityScore,
        sourceUrl: item.url || "",
        score,
        battle: pickBattlePlan(item, { city: payload.meta.city, county: payload.meta.county, topDemands: county.topDemands || [] }),
      };
    });
  }).sort((a, b) => b.score - a.score).slice(0, args.maxOpportunities);

  const payload = {
    meta: {
      province: args.province,
      scopeName: `${args.province}产业机会地图`,
      scopeType: "province",
      centerAddress: args.centerAddress,
      centerLongitude: centerGeo.longitude,
      centerLatitude: centerGeo.latitude,
      updatedAt: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      rawDocumentCount: aggregate.meta?.documentCount || 0,
      opportunityPoolCount: aggregate.meta?.opportunityCount || opportunities.length,
      rawOpportunityPoolCount: aggregate.meta?.rawOpportunityCount || opportunities.length,
      mappedIndustryCount: industries.length,
      mappedOpportunityCount: opportunities.length,
      cityCount: aggregate.meta?.cityCount || new Set(industries.map((item) => item.city)).size,
      countyCount: aggregate.meta?.countyCount || industries.length,
      topCities: (aggregate.cityStats || []).slice(0, 8),
      topDemands: aggregate.topDemands || [],
      description: `按区县产业面和重点商机点组织${args.province}县域产业与招采线索，用于地图展示、商家匹配和销售推进。`,
    },
    industries,
    opportunities,
  };

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.writeFile(args.outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, outputPath: args.outputPath, cachePath: args.cachePath, industryCount: industries.length, opportunityCount: opportunities.length }, null, 2));
}

main().catch((error) => {
  console.error("[build-province-opportunity-map] failed:", error);
  process.exitCode = 1;
});
