import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createPool, initDatabase } from "../src/db.js";

type AnyRecord = Record<string, any>;

const CITY_PROVINCE_HINTS: Record<string, string> = {
  "成都市": "四川省",
  "自贡市": "四川省",
  "攀枝花市": "四川省",
  "泸州市": "四川省",
  "德阳市": "四川省",
  "绵阳市": "四川省",
  "广元市": "四川省",
  "遂宁市": "四川省",
  "内江市": "四川省",
  "乐山市": "四川省",
  "南充市": "四川省",
  "眉山市": "四川省",
  "宜宾市": "四川省",
  "广安市": "四川省",
  "达州市": "四川省",
  "雅安市": "四川省",
  "巴中市": "四川省",
  "资阳市": "四川省",
  "阿坝藏族羌族自治州": "四川省",
  "甘孜藏族自治州": "四川省",
  "凉山彝族自治州": "四川省",
  "昆明市": "云南省",
  "曲靖市": "云南省",
  "玉溪市": "云南省",
  "保山市": "云南省",
  "昭通市": "云南省",
  "丽江市": "云南省",
  "普洱市": "云南省",
  "临沧市": "云南省",
  "楚雄彝族自治州": "云南省",
  "红河哈尼族彝族自治州": "云南省",
  "文山壮族苗族自治州": "云南省",
  "西双版纳傣族自治州": "云南省",
  "大理白族自治州": "云南省",
  "德宏傣族景颇族自治州": "云南省",
  "怒江傈僳族自治州": "云南省",
  "迪庆藏族自治州": "云南省",
  "贵阳市": "贵州省",
  "六盘水市": "贵州省",
  "遵义市": "贵州省",
  "安顺市": "贵州省",
  "毕节市": "贵州省",
  "铜仁市": "贵州省",
  "黔西南布依族苗族自治州": "贵州省",
  "黔东南苗族侗族自治州": "贵州省",
  "黔南布依族苗族自治州": "贵州省",
};

function env(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

function argValue(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function stableId(prefix: string, parts: Array<string | number | null | undefined>): string {
  const raw = parts.map((part) => String(part || "").trim()).join("|");
  return `${prefix}-${createHash("sha1").update(raw).digest("hex").slice(0, 24)}`;
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: any): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function asNumber(value: any): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asText(value).replace(/[^\d.-]/g, "");
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asBool(value: any): boolean {
  return value === true || value === 1 || value === "1";
}

function json(value: any): string {
  return JSON.stringify(value ?? null);
}

function mapBusinessStage(stageTag: string, haystack: string, opportunityKind: string): string {
  const stage = asText(stageTag);
  if (stage) return stage;
  if (/中标|成交|结果公示|候选人/.test(haystack)) return "结果公示";
  if (/招标|采购|磋商|竞谈|询价|遴选|比选/.test(haystack)) return "招采报名";
  if (/立项|可研|项目库|前期工作|实施方案|预算/.test(haystack)) return "储备立项";
  if (/招商|签约|推介|对接/.test(haystack)) return "招商对接";
  if (/开工|实施|建设/.test(haystack)) return "实施推进";
  if (opportunityKind === "招采订单") return "招采报名";
  if (opportunityKind === "招商项目") return "招商对接";
  if (opportunityKind === "政策窗口") return "政策申报";
  return "线索研判";
}

function deriveStructuredOpportunityFields(opp: AnyRecord) {
  const title = asText(opp.title || opp.name);
  const summary = asText(opp.summary);
  const sourceType = asText(opp.sourceType);
  const category = asText(opp.category);
  const type = asText(opp.type);
  const stageTag = asText(opp.stageTag);
  const priorityLabel = asText(opp.priorityLabel).toUpperCase();
  const budget = asText(opp.budget);
  const targetOrg = asText(opp.targetOrg);
  const haystack = [title, summary, sourceType, category, type, stageTag, budget, targetOrg, asArray(opp.tags).join(" "), asArray(opp.keyPoints).join(" ")].join("\n");

  let opportunityKind = "产业线索";
  if (/招标|采购|中标|成交|比选|遴选|竞谈|磋商|询价|EPC|总承包/.test(haystack)) opportunityKind = "招采订单";
  else if (/招商|签约|推介|投资促进|落地项目/.test(haystack)) opportunityKind = "招商项目";
  else if (/补助资金|专项资金|资金分配|惠企政策|申报|政策找企业|经营主体|营商环境|风险补偿/.test(haystack)) opportunityKind = "政策窗口";

  const businessStage = mapBusinessStage(stageTag, haystack, opportunityKind);

  let commercialStrength = "弱";
  let commercialRank = 1;
  if (
    opportunityKind === "招采订单"
    || /预算金额|投资估算|合同估算价|采购人|招标人|中标候选人/.test(haystack)
    || priorityLabel === "S"
    || priorityLabel === "A"
  ) {
    commercialStrength = "强";
    commercialRank = 3;
  } else if (
    opportunityKind === "招商项目"
    || opportunityKind === "政策窗口"
    || /重点项目|项目库|立项|实施方案|前期工作|招商引资/.test(haystack)
    || priorityLabel === "B"
  ) {
    commercialStrength = "中";
    commercialRank = 2;
  }

  const structuredBrief = [
    opportunityKind,
    businessStage,
    commercialStrength + "机会",
    targetOrg ? `甲方:${targetOrg}` : "",
    budget ? `预算:${budget}` : "",
  ].filter(Boolean).join("｜");

  return {
    opportunityKind,
    businessStage,
    commercialStrength,
    commercialRank,
    structuredBrief,
  };
}

function readJson(filePath: string): AnyRecord | null {
  if (!filePath || !existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function walkJsonFiles(rootDir: string): string[] {
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(fullPath);
    }
  }
  return files;
}

function listAggregateFiles(researchDir: string): string[] {
  return readdirSync(researchDir)
    .filter((name) => name.endsWith(".json") && name.includes("产业与机会总览"))
    .map((name) => path.join(researchDir, name));
}

function listCountyIntelFiles(researchDir: string): string[] {
  return walkJsonFiles(researchDir)
    .filter((filePath) => /-county-intel-\d{4}-\d{2}-\d{2}\.json$/i.test(path.basename(filePath)))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function buildLocationIndex(countyFiles: string[], aggregateFiles: string[]) {
  const countyMap = new Map<string, string>();
  const cityMap = new Map<string, string>();
  for (const countyFile of countyFiles) {
    const countyData = readJson(countyFile);
    const province = asText(countyData?.meta?.province);
    const city = asText(countyData?.meta?.city);
    const county = asText(countyData?.meta?.county);
    if (city && province && !cityMap.has(city)) cityMap.set(city, province);
    if (city && county && province) countyMap.set(`${city}|${county}`, province);
  }
  for (const aggregatePath of aggregateFiles) {
    const aggregate = readJson(aggregatePath);
    const province = asText(aggregate?.meta?.province);
    for (const item of asArray(aggregate?.countyStats)) {
      const city = asText(item.city);
      const county = asText(item.county);
      if (city && province && !cityMap.has(city)) cityMap.set(city, province);
      if (city && county && province) countyMap.set(`${city}|${county}`, province);
    }
  }
  return { countyMap, cityMap };
}

function resolveProvince(locationIndex: ReturnType<typeof buildLocationIndex>, city: string, county: string, fallback: string): string {
  return (
    locationIndex.countyMap.get(`${city}|${county}`) ||
    locationIndex.cityMap.get(city) ||
    CITY_PROVINCE_HINTS[city] ||
    fallback
  );
}

async function upsertRun(pool: Awaited<ReturnType<typeof createPool>>, run: {
  id: string;
  scopeType: string;
  scopeName: string;
  province: string;
  city: string;
  county: string;
  sourceFile: string;
  generatedAt: string;
  documentCount: number;
  opportunityCount: number;
  meta: AnyRecord;
}) {
  await pool.query(
    `INSERT INTO opc_intel_runs (
      id, scope_type, scope_name, province, city, county, source_file, generated_at, document_count, opportunity_count, meta_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      scope_type = EXCLUDED.scope_type,
      scope_name = EXCLUDED.scope_name,
      province = EXCLUDED.province,
      city = EXCLUDED.city,
      county = EXCLUDED.county,
      source_file = EXCLUDED.source_file,
      generated_at = EXCLUDED.generated_at,
      document_count = EXCLUDED.document_count,
      opportunity_count = EXCLUDED.opportunity_count,
      meta_json = EXCLUDED.meta_json,
      imported_at = NOW()`,
    [
      run.id,
      run.scopeType,
      run.scopeName,
      run.province,
      run.city,
      run.county,
      run.sourceFile,
      run.generatedAt,
      run.documentCount,
      run.opportunityCount,
      json(run.meta),
    ],
  );
}

async function upsertRegion(pool: Awaited<ReturnType<typeof createPool>>, region: {
  id: string;
  regionKey: string;
  scopeType: string;
  scopeName: string;
  province: string;
  city: string;
  county: string;
  centerAddress: string;
  longitude: number;
  latitude: number;
  documentCount: number;
  opportunityCount: number;
  topDemands: any[];
  assessment: any[];
  meta: AnyRecord;
}) {
  await pool.query(
    `INSERT INTO opc_intel_regions (
      id, region_key, scope_type, scope_name, province, city, county, center_address, longitude, latitude,
      document_count, opportunity_count, top_demands, assessment, meta_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (id) DO UPDATE SET
      region_key = EXCLUDED.region_key,
      scope_type = EXCLUDED.scope_type,
      scope_name = EXCLUDED.scope_name,
      province = EXCLUDED.province,
      city = EXCLUDED.city,
      county = EXCLUDED.county,
      center_address = EXCLUDED.center_address,
      longitude = EXCLUDED.longitude,
      latitude = EXCLUDED.latitude,
      document_count = EXCLUDED.document_count,
      opportunity_count = EXCLUDED.opportunity_count,
      top_demands = EXCLUDED.top_demands,
      assessment = EXCLUDED.assessment,
      meta_json = EXCLUDED.meta_json,
      updated_at = NOW()`,
    [
      region.id,
      region.regionKey,
      region.scopeType,
      region.scopeName,
      region.province,
      region.city,
      region.county,
      region.centerAddress,
      region.longitude,
      region.latitude,
      region.documentCount,
      region.opportunityCount,
      json(region.topDemands),
      json(region.assessment),
      json(region.meta),
    ],
  );
}

async function upsertDocument(pool: Awaited<ReturnType<typeof createPool>>, doc: {
  id: string;
  runId: string;
  regionId: string;
  province: string;
  city: string;
  county: string;
  title: string;
  url: string;
  sourceType: string;
  date: string;
  summary: string;
  keyPoints: any[];
  tags: any[];
  targetOrgs: any[];
  money: any[];
  fullText: string;
  discoveredByQuery: string;
  host: string;
  official: boolean;
  fallbackUsed: boolean;
  opportunityScore: number;
  raw: AnyRecord;
}) {
  await pool.query(
    `INSERT INTO opc_intel_documents (
      id, run_id, region_id, province, city, county, title, url, source_type, date, summary,
      key_points, tags, target_orgs, money, full_text, discovered_by_query, host, official, fallback_used,
      opportunity_score, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      region_id = EXCLUDED.region_id,
      province = EXCLUDED.province,
      city = EXCLUDED.city,
      county = EXCLUDED.county,
      title = EXCLUDED.title,
      url = EXCLUDED.url,
      source_type = EXCLUDED.source_type,
      date = EXCLUDED.date,
      summary = EXCLUDED.summary,
      key_points = EXCLUDED.key_points,
      tags = EXCLUDED.tags,
      target_orgs = EXCLUDED.target_orgs,
      money = EXCLUDED.money,
      full_text = EXCLUDED.full_text,
      discovered_by_query = EXCLUDED.discovered_by_query,
      host = EXCLUDED.host,
      official = EXCLUDED.official,
      fallback_used = EXCLUDED.fallback_used,
      opportunity_score = EXCLUDED.opportunity_score,
      raw_json = EXCLUDED.raw_json,
      updated_at = NOW()`,
    [
      doc.id,
      doc.runId,
      doc.regionId,
      doc.province,
      doc.city,
      doc.county,
      doc.title,
      doc.url,
      doc.sourceType,
      doc.date,
      doc.summary,
      json(doc.keyPoints),
      json(doc.tags),
      json(doc.targetOrgs),
      json(doc.money),
      doc.fullText,
      doc.discoveredByQuery,
      doc.host,
      doc.official,
      doc.fallbackUsed,
      doc.opportunityScore,
      json(doc.raw),
    ],
  );
}

async function upsertOpportunity(pool: Awaited<ReturnType<typeof createPool>>, opp: {
  id: string;
  runId: string;
  regionId: string;
  datasetKind: string;
  sourceRecordId: string;
  province: string;
  city: string;
  county: string;
  title: string;
  url: string;
  sourceType: string;
  date: string;
  category: string;
  type: string;
  targetOrg: string;
  targetOrgs: any[];
  address: string;
  longitude: number;
  latitude: number;
  budget: string;
  money: any[];
  summary: string;
  keyPoints: any[];
  tags: any[];
  services: any[];
  fitProfiles: any[];
  stageTag: string;
  entryFocus: string;
  nextActions: any[];
  priorityLabel: string;
  priorityText: string;
  priorityScore: number;
  sourceUrl: string;
  score: number;
  discoveredByQuery: string;
  host: string;
  official: boolean;
  fallbackUsed: boolean;
  opportunityScore: number;
  battle: AnyRecord;
  opportunityKind: string;
  businessStage: string;
  commercialStrength: string;
  commercialRank: number;
  structuredBrief: string;
  raw: AnyRecord;
}) {
  await pool.query(
    `INSERT INTO opc_intel_opportunities (
      id, run_id, region_id, dataset_kind, source_record_id, province, city, county, title, url, source_type, date,
      category, type, target_org, target_orgs, address, longitude, latitude, budget, money, summary, key_points, tags,
      services, fit_profiles, stage_tag, entry_focus, next_actions, priority_label, priority_text, priority_score,
      source_url, score, discovered_by_query, host, official, fallback_used, opportunity_score, battle_json,
      opportunity_kind, business_stage, commercial_strength, commercial_rank, structured_brief, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46)
    ON CONFLICT (id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      region_id = EXCLUDED.region_id,
      dataset_kind = EXCLUDED.dataset_kind,
      source_record_id = EXCLUDED.source_record_id,
      province = EXCLUDED.province,
      city = EXCLUDED.city,
      county = EXCLUDED.county,
      title = EXCLUDED.title,
      url = EXCLUDED.url,
      source_type = EXCLUDED.source_type,
      date = EXCLUDED.date,
      category = EXCLUDED.category,
      type = EXCLUDED.type,
      target_org = EXCLUDED.target_org,
      target_orgs = EXCLUDED.target_orgs,
      address = EXCLUDED.address,
      longitude = EXCLUDED.longitude,
      latitude = EXCLUDED.latitude,
      budget = EXCLUDED.budget,
      money = EXCLUDED.money,
      summary = EXCLUDED.summary,
      key_points = EXCLUDED.key_points,
      tags = EXCLUDED.tags,
      services = EXCLUDED.services,
      fit_profiles = EXCLUDED.fit_profiles,
      stage_tag = EXCLUDED.stage_tag,
      entry_focus = EXCLUDED.entry_focus,
      next_actions = EXCLUDED.next_actions,
      priority_label = EXCLUDED.priority_label,
      priority_text = EXCLUDED.priority_text,
      priority_score = EXCLUDED.priority_score,
      source_url = EXCLUDED.source_url,
      score = EXCLUDED.score,
      discovered_by_query = EXCLUDED.discovered_by_query,
      host = EXCLUDED.host,
      official = EXCLUDED.official,
      fallback_used = EXCLUDED.fallback_used,
      opportunity_score = EXCLUDED.opportunity_score,
      battle_json = EXCLUDED.battle_json,
      opportunity_kind = EXCLUDED.opportunity_kind,
      business_stage = EXCLUDED.business_stage,
      commercial_strength = EXCLUDED.commercial_strength,
      commercial_rank = EXCLUDED.commercial_rank,
      structured_brief = EXCLUDED.structured_brief,
      raw_json = EXCLUDED.raw_json,
      updated_at = NOW()`,
    [
      opp.id,
      opp.runId,
      opp.regionId,
      opp.datasetKind,
      opp.sourceRecordId,
      opp.province,
      opp.city,
      opp.county,
      opp.title,
      opp.url,
      opp.sourceType,
      opp.date,
      opp.category,
      opp.type,
      opp.targetOrg,
      json(opp.targetOrgs),
      opp.address,
      opp.longitude,
      opp.latitude,
      opp.budget,
      json(opp.money),
      opp.summary,
      json(opp.keyPoints),
      json(opp.tags),
      json(opp.services),
      json(opp.fitProfiles),
      opp.stageTag,
      opp.entryFocus,
      json(opp.nextActions),
      opp.priorityLabel,
      opp.priorityText,
      opp.priorityScore,
      opp.sourceUrl,
      opp.score,
      opp.discoveredByQuery,
      opp.host,
      opp.official,
      opp.fallbackUsed,
      opp.opportunityScore,
      json(opp.battle),
      opp.opportunityKind,
      opp.businessStage,
      opp.commercialStrength,
      opp.commercialRank,
      opp.structuredBrief,
      json(opp.raw),
    ],
  );
}

async function upsertIndustry(pool: Awaited<ReturnType<typeof createPool>>, item: {
  id: string;
  runId: string;
  regionId: string;
  sourceRecordId: string;
  province: string;
  city: string;
  county: string;
  name: string;
  title: string;
  type: string;
  category: string;
  address: string;
  longitude: number;
  latitude: number;
  summary: string;
  services: any[];
  topDemands: any[];
  documentCount: number;
  opportunityCount: number;
  score: number;
  raw: AnyRecord;
}) {
  await pool.query(
    `INSERT INTO opc_intel_industries (
      id, run_id, region_id, source_record_id, province, city, county, name, title, type, category, address,
      longitude, latitude, summary, services, top_demands, document_count, opportunity_count, score, raw_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      region_id = EXCLUDED.region_id,
      source_record_id = EXCLUDED.source_record_id,
      province = EXCLUDED.province,
      city = EXCLUDED.city,
      county = EXCLUDED.county,
      name = EXCLUDED.name,
      title = EXCLUDED.title,
      type = EXCLUDED.type,
      category = EXCLUDED.category,
      address = EXCLUDED.address,
      longitude = EXCLUDED.longitude,
      latitude = EXCLUDED.latitude,
      summary = EXCLUDED.summary,
      services = EXCLUDED.services,
      top_demands = EXCLUDED.top_demands,
      document_count = EXCLUDED.document_count,
      opportunity_count = EXCLUDED.opportunity_count,
      score = EXCLUDED.score,
      raw_json = EXCLUDED.raw_json,
      updated_at = NOW()`,
    [
      item.id,
      item.runId,
      item.regionId,
      item.sourceRecordId,
      item.province,
      item.city,
      item.county,
      item.name,
      item.title,
      item.type,
      item.category,
      item.address,
      item.longitude,
      item.latitude,
      item.summary,
      json(item.services),
      json(item.topDemands),
      item.documentCount,
      item.opportunityCount,
      item.score,
      json(item.raw),
    ],
  );
}

async function importCountyFile(pool: Awaited<ReturnType<typeof createPool>>, countyFilePath: string) {
  const countyData = readJson(countyFilePath);
  if (!countyData?.meta) return { runs: 0, regions: 0, documents: 0, opportunities: 0 };

  const province = asText(countyData.meta?.province);
  const city = asText(countyData.meta?.city);
  const county = asText(countyData.meta?.county);
  const runId = stableId("intelrun", ["county", province, city, county, countyData.meta?.generatedAt || countyFilePath]);
  const regionId = stableId("region", ["county", province, city, county]);
  const documents = asArray(countyData.documents);
  const opportunities = asArray(countyData.opportunityPool);
  const topDemands = asArray(countyData.opportunityGraph).map((item) => asText(item?.label)).filter(Boolean);

  await upsertRun(pool, {
    id: runId,
    scopeType: "county",
    scopeName: county || city || province,
    province,
    city,
    county,
    sourceFile: countyFilePath,
    generatedAt: asText(countyData.meta?.generatedAt),
    documentCount: documents.length,
    opportunityCount: opportunities.length,
    meta: countyData.meta || {},
  });

  await upsertRegion(pool, {
    id: regionId,
    regionKey: ["county", province, city, county].join(":"),
    scopeType: "county",
    scopeName: county || city || province,
    province,
    city,
    county,
    centerAddress: `${province}${city}${county}`,
    longitude: 0,
    latitude: 0,
    documentCount: documents.length,
    opportunityCount: opportunities.length,
    topDemands,
    assessment: asArray(countyData.assessment),
    meta: { countyFilePath, countyMeta: countyData.meta || {} },
  });

  let importedDocuments = 0;
  let importedOpportunities = 0;

  for (const doc of documents) {
    await upsertDocument(pool, {
      id: stableId("doc", [province, city, county, doc.url, doc.title, doc.date]),
      runId,
      regionId,
      province,
      city,
      county,
      title: asText(doc.title),
      url: asText(doc.url),
      sourceType: asText(doc.sourceType),
      date: asText(doc.date),
      summary: asText(doc.summary),
      keyPoints: asArray(doc.keyPoints),
      tags: asArray(doc.tags),
      targetOrgs: asArray(doc.targetOrgs),
      money: asArray(doc.money),
      fullText: asText(doc.text),
      discoveredByQuery: asText(doc.discoveredByQuery),
      host: asText(doc.host),
      official: asBool(doc.official),
      fallbackUsed: asBool(doc.fallbackUsed),
      opportunityScore: asNumber(doc.opportunityScore),
      raw: doc,
    });
    importedDocuments += 1;
  }

  for (const opp of opportunities) {
    const structured = deriveStructuredOpportunityFields(opp);
    await upsertOpportunity(pool, {
      id: stableId("opp", ["county_pool", province, city, county, opp.url, opp.title, opp.date]),
      runId,
      regionId,
      datasetKind: "county_pool",
      sourceRecordId: "",
      province,
      city,
      county,
      title: asText(opp.title),
      url: asText(opp.url),
      sourceType: asText(opp.sourceType),
      date: asText(opp.date),
      category: asText(opp.category || opp.sourceType),
      type: asText(opp.type || opp.sourceType),
      targetOrg: asText(opp.targetOrg),
      targetOrgs: asArray(opp.targetOrgs),
      address: "",
      longitude: 0,
      latitude: 0,
      budget: asText(opp.budget),
      money: asArray(opp.money),
      summary: asText(opp.summary),
      keyPoints: asArray(opp.keyPoints),
      tags: asArray(opp.tags),
      services: asArray(opp.services),
      fitProfiles: asArray(opp.fitProfiles),
      stageTag: asText(opp.stageTag),
      entryFocus: asText(opp.entryFocus),
      nextActions: asArray(opp.nextActions),
      priorityLabel: asText(opp.priorityLabel),
      priorityText: asText(opp.priorityText),
      priorityScore: asNumber(opp.priorityScore),
      sourceUrl: asText(opp.sourceUrl || opp.url),
      score: asNumber(opp.score),
      discoveredByQuery: asText(opp.discoveredByQuery),
      host: asText(opp.host),
      official: asBool(opp.official),
      fallbackUsed: asBool(opp.fallbackUsed),
      opportunityScore: asNumber(opp.opportunityScore),
      battle: opp.battle || {},
      opportunityKind: structured.opportunityKind,
      businessStage: structured.businessStage,
      commercialStrength: structured.commercialStrength,
      commercialRank: structured.commercialRank,
      structuredBrief: structured.structuredBrief,
      raw: opp,
    });
    importedOpportunities += 1;
  }

  return { runs: 1, regions: 1, documents: importedDocuments, opportunities: importedOpportunities };
}

async function importAggregate(pool: Awaited<ReturnType<typeof createPool>>, aggregatePath: string) {
  const payload = readJson(aggregatePath);
  if (!payload?.meta) return { runs: 0, regions: 0 };
  const meta = payload.meta || {};
  const province = asText(meta.province || meta.scopeName);

  await upsertRun(pool, {
    id: stableId("intelrun", ["aggregate", province, meta.generatedAt || aggregatePath]),
    scopeType: "province",
    scopeName: province,
    province,
    city: "",
    county: "",
    sourceFile: aggregatePath,
    generatedAt: asText(meta.generatedAt),
    documentCount: asNumber(meta.documentCount),
    opportunityCount: asNumber(meta.opportunityCount),
    meta,
  });

  await upsertRegion(pool, {
    id: stableId("region", ["province", province]),
    regionKey: ["province", province].join(":"),
    scopeType: "province",
    scopeName: province,
    province,
    city: "",
    county: "",
    centerAddress: province,
    longitude: 0,
    latitude: 0,
    documentCount: asNumber(meta.documentCount),
    opportunityCount: asNumber(meta.opportunityCount),
    topDemands: [],
    assessment: [],
    meta: payload,
  });

  return { runs: 1, regions: 1 };
}

async function importMap(
  pool: Awaited<ReturnType<typeof createPool>>,
  mapPath: string,
  locationIndex: ReturnType<typeof buildLocationIndex>,
) {
  const payload = readJson(mapPath);
  if (!payload?.meta) return { runs: 0, regions: 0, opportunities: 0 };
  const meta = payload.meta || {};
  const province = asText(meta.province);
  const runId = stableId("intelrun", ["map", meta.scopeName || province, meta.generatedAt || mapPath]);

  await upsertRun(pool, {
    id: runId,
    scopeType: asText(meta.scopeType || "province"),
    scopeName: asText(meta.scopeName || province),
    province,
    city: "",
    county: "",
    sourceFile: mapPath,
    generatedAt: asText(meta.generatedAt),
    documentCount: asNumber(meta.rawDocumentCount),
    opportunityCount: asArray(payload.opportunities).length,
    meta,
  });

  let regions = 0;
  let opportunities = 0;
  let industries = 0;
  for (const item of asArray(payload.industries)) {
    const itemCity = asText(item.city);
    const itemCounty = asText(item.county);
    const itemProvince = resolveProvince(locationIndex, itemCity, itemCounty, asText(item.province || province));
    const regionId = stableId("region", ["county", itemProvince, itemCity, itemCounty]);
    await upsertRegion(pool, {
      id: regionId,
      regionKey: ["county", itemProvince, itemCity, itemCounty].join(":"),
      scopeType: "county",
      scopeName: itemCounty || itemCity || itemProvince,
      province: itemProvince,
      city: itemCity,
      county: itemCounty,
      centerAddress: asText(item.address),
      longitude: asNumber(item.longitude),
      latitude: asNumber(item.latitude),
      documentCount: asNumber(item.documentCount),
      opportunityCount: asNumber(item.opportunityCount),
      topDemands: asArray(item.topDemands),
      assessment: [],
      meta: {},
    });
    regions += 1;
    await upsertIndustry(pool, {
      id: stableId("industry", ["map", item.id || "", item.title || item.name, item.address]),
      runId,
      regionId,
      sourceRecordId: asText(item.id),
      province: itemProvince,
      city: itemCity,
      county: itemCounty,
      name: asText(item.name),
      title: asText(item.title || item.name),
      type: asText(item.type),
      category: asText(item.category),
      address: asText(item.address),
      longitude: asNumber(item.longitude),
      latitude: asNumber(item.latitude),
      summary: asText(item.summary),
      services: asArray(item.services),
      topDemands: asArray(item.topDemands),
      documentCount: asNumber(item.documentCount),
      opportunityCount: asNumber(item.opportunityCount),
      score: asNumber(item.score),
      raw: item,
    });
    industries += 1;
  }
  for (const opp of asArray(payload.opportunities)) {
    const structured = deriveStructuredOpportunityFields(opp);
    const oppCity = asText(opp.city);
    const oppCounty = asText(opp.county);
    const oppProvince = resolveProvince(locationIndex, oppCity, oppCounty, asText(opp.province || province));
    const regionId = stableId("region", ["county", oppProvince, oppCity, oppCounty]);

    await upsertRegion(pool, {
      id: regionId,
      regionKey: ["county", oppProvince, oppCity, oppCounty].join(":"),
      scopeType: "county",
      scopeName: oppCounty || oppCity || oppProvince,
      province: oppProvince,
      city: oppCity,
      county: oppCounty,
      centerAddress: asText(opp.address),
      longitude: asNumber(opp.longitude),
      latitude: asNumber(opp.latitude),
      documentCount: 0,
      opportunityCount: 0,
      topDemands: [],
      assessment: [],
      meta: {},
    });
    regions += 1;

    await upsertOpportunity(pool, {
      id: stableId("opp", ["map", opp.id || "", opp.title, opp.sourceUrl || opp.url]),
      runId,
      regionId,
      datasetKind: "map_opportunity",
      sourceRecordId: asText(opp.id),
      province: oppProvince,
      city: oppCity,
      county: oppCounty,
      title: asText(opp.title || opp.name),
      url: asText(opp.url || opp.sourceUrl),
      sourceType: asText(opp.sourceType || opp.type),
      date: asText(opp.date),
      category: asText(opp.category),
      type: asText(opp.type),
      targetOrg: asText(opp.targetOrg),
      targetOrgs: asArray(opp.targetOrgs),
      address: asText(opp.address),
      longitude: asNumber(opp.longitude),
      latitude: asNumber(opp.latitude),
      budget: asText(opp.budget),
      money: asArray(opp.money),
      summary: asText(opp.summary),
      keyPoints: asArray(opp.keyPoints),
      tags: asArray(opp.tags),
      services: asArray(opp.services),
      fitProfiles: asArray(opp.fitProfiles),
      stageTag: asText(opp.stageTag),
      entryFocus: asText(opp.entryFocus),
      nextActions: asArray(opp.nextActions),
      priorityLabel: asText(opp.priorityLabel),
      priorityText: asText(opp.priorityText),
      priorityScore: asNumber(opp.priorityScore),
      sourceUrl: asText(opp.sourceUrl || opp.url),
      score: asNumber(opp.score),
      discoveredByQuery: "",
      host: "",
      official: false,
      fallbackUsed: false,
      opportunityScore: asNumber(opp.opportunityScore),
      battle: opp.battle || {},
      opportunityKind: structured.opportunityKind,
      businessStage: structured.businessStage,
      commercialStrength: structured.commercialStrength,
      commercialRank: structured.commercialRank,
      structuredBrief: structured.structuredBrief,
      raw: opp,
    });
    opportunities += 1;
  }

  return { runs: 1, regions, opportunities, industries };
}

async function main() {
  const researchDir = path.resolve(argValue("--research-dir", "research"));
  const mapFile = path.resolve(argValue("--map-file", path.join(researchDir, "southwest-opportunity-map.json")));
  const skipMap = hasArg("--skip-map");
  const countyFiles = listCountyIntelFiles(researchDir);
  const aggregateFiles = listAggregateFiles(researchDir);
  const locationIndex = buildLocationIndex(countyFiles, aggregateFiles);

  const pool = await createPool({
    host: env("DB_HOST", "127.0.0.1"),
    port: parseInt(env("DB_PORT", "5432"), 10),
    user: env("DB_USER", "postgres"),
    password: env("DB_PASSWORD", ""),
    database: env("DB_NAME", "opc_db"),
  });
  await initDatabase(pool);

  const total = { runs: 0, regions: 0, documents: 0, opportunities: 0 };

  for (const countyFilePath of countyFiles) {
    const result = await importCountyFile(pool, countyFilePath);
    total.runs += result.runs;
    total.regions += result.regions;
    total.documents += result.documents;
    total.opportunities += result.opportunities;
    console.log(`[intel:import-db] county imported: ${countyFilePath}`);
  }

  for (const aggregatePath of aggregateFiles) {
    const result = await importAggregate(pool, aggregatePath);
    total.runs += result.runs;
    total.regions += result.regions;
    console.log(`[intel:import-db] aggregate imported: ${aggregatePath}`);
  }

  if (!skipMap && existsSync(mapFile)) {
    const result = await importMap(pool, mapFile, locationIndex);
    total.runs += result.runs;
    total.regions += result.regions;
    total.opportunities += result.opportunities;
    console.log(`[intel:import-db] map imported: ${mapFile}`);
  }

  const [{ rows: runRows }, { rows: regionRows }, { rows: docRows }, { rows: oppRows }] = await Promise.all([
    pool.query("SELECT COUNT(*) AS count FROM opc_intel_runs"),
    pool.query("SELECT COUNT(*) AS count FROM opc_intel_regions"),
    pool.query("SELECT COUNT(*) AS count FROM opc_intel_documents"),
    pool.query("SELECT COUNT(*) AS count FROM opc_intel_opportunities"),
  ]);

  console.log("[intel:import-db] done", {
    importedRuns: total.runs,
    importedRegions: total.regions,
    importedDocuments: total.documents,
    importedOpportunities: total.opportunities,
    dbRuns: Number(runRows[0]?.count || 0),
    dbRegions: Number(regionRows[0]?.count || 0),
    dbDocuments: Number(docRows[0]?.count || 0),
    dbOpportunities: Number(oppRows[0]?.count || 0),
  });

  await pool.end();
}

main().catch((error) => {
  console.error("[intel:import-db] failed", error);
  process.exit(1);
});
