#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import "dotenv/config";
import { shouldKeepOpportunity } from "./opportunity-quality.mjs";

const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "research");
let lastSearchRequestAt = 0;

const COUNTY_PRESETS = {
  dazhu: {
    county: "大竹县",
    city: "达州市",
    province: "四川省",
    policyUrls: [
      {
        url: "https://dzsdzx.sczwfw.gov.cn/art/2024/11/28/art_43910_274763.html",
        fallbackQuery: "site:dzsdzx.sczwfw.gov.cn 大竹县 惠企政策事项清单",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-222991.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 2024年重点项目名单",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-222103.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 成长劳动力 招工补贴",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-224538.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 2026 中央和省级财政衔接推进乡村振兴补助资金",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-225120.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 2026 农业社会化服务项目 服务主体",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-224327.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 永胜镇 2026 以工代赈 项目",
      },
    ],
    industryUrls: [
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-206887.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 十四五 重大项目",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-218874.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 服务业 222.6亿元",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-208301.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 竹产业 乡村振兴",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-219004.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 智改数转",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-220713.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 苎麻 产业联盟",
      },
      {
        url: "https://www.dazhu.gov.cn/xxgk-show-214659.html",
        fallbackQuery: "site:www.dazhu.gov.cn 大竹县 电子信息 产业",
      },
      {
        url: "https://www.dazhou.gov.cn/news-show-268687.html",
        fallbackQuery: "site:www.dazhou.gov.cn 大竹县 2026 经济工作 工业项目",
      },
      {
        url: "https://www.dazhou.gov.cn/news-show-269407.html",
        fallbackQuery: "site:www.dazhou.gov.cn 大竹县 2026 工业 开门红",
      },
    ],
    biddingUrls: [
      {
        url: "https://ggzyjy.sc.gov.cn/jyxx/002007/002007001/20250526/f85a8cba-d25f-469a-ab32-6a47ec081668.html",
        fallbackQuery: "site:ggzyjy.sc.gov.cn 大竹县 招标 2025",
      },
      {
        url: "https://ggzyjy.sc.gov.cn/jyxx/002008/002008001/20260120/5a5fb578-a914-4c73-98b1-f3f6fc4e02f2.html",
        fallbackQuery: "site:ggzyjy.sc.gov.cn 大竹县 中标 2026",
      },
      {
        url: "https://ggzyjy.sc.gov.cn/jyxx/002001/002001001/20251020/c47cdce0-0f41-489a-8ed8-2be47b91a99f.html",
        fallbackQuery: "site:ggzyjy.sc.gov.cn 大竹县 2026 高标准农田 设计",
      },
      {
        url: "https://www.ggzy.gov.cn/information/html/b//510000/0101/202601/19/005105c9c0119f2a410f939005413f5da58c.shtml",
        fallbackQuery: "site:ggzy.gov.cn 大竹县 2026 站前广场 监理",
      },
    ],
    companyKeywords: [
      "大竹 电子信息",
      "大竹 智能制造",
      "大竹 苎麻",
      "大竹 竹产业",
      "大竹 冷链物流",
    ],
    searchQueries: [
      "site:www.dazhu.gov.cn 大竹县 招商 产业",
      "site:www.dazhu.gov.cn 大竹县 招标 公告",
      "site:ggzyjy.sc.gov.cn 大竹县 招标",
      "site:ccgp-sichuan.gov.cn 大竹县 采购",
      "site:gpx.ccgp-sichuan.gov.cn 大竹县 2026 采购",
      "site:www.dazhou.gov.cn 大竹县 2026 产业 项目",
      "site:www.dazhou.gov.cn 大竹县 经开区 2026",
      "site:www.dazhu.gov.cn 大竹县 2026 公示 公告",
      "site:ggzyjy.sc.gov.cn 大竹县 人民医院 2026",
      "site:ggzyjy.sc.gov.cn 大竹县 职业中学 2026",
      "site:ggzyjy.sc.gov.cn 大竹县 教育局 2026",
      "site:ggzyjy.sc.gov.cn 大竹县 文旅集团 2026",
    ],
    searchDocumentQueries: [
      { sourceType: "policy", query: "site:dzsdzx.sczwfw.gov.cn 大竹县 政策 公告" },
      { sourceType: "policy", query: "site:www.dazhu.gov.cn 大竹县 惠企政策" },
      { sourceType: "policy", query: "site:www.dazhu.gov.cn 大竹县 科技计划 立项" },
      { sourceType: "policy", query: "site:www.dazhu.gov.cn 大竹县 乡村振兴 资金 公告" },
      { sourceType: "policy", query: "site:www.dazhu.gov.cn 大竹县 2026 资金 公告" },
      { sourceType: "policy", query: "site:www.dazhu.gov.cn 大竹县 2026 公示 公告" },
      { sourceType: "policy", query: "site:www.dazhou.gov.cn 大竹县 2026 政策 公告" },
      { sourceType: "policy", query: "site:www.dazhou.gov.cn 大竹县 2026 项目 公示" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 招商引资 项目" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 智改数转" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 电子信息 产业" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 苎麻 产业" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 服务业 集聚区" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 农业社会化服务" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 2026 招商引资 项目" },
      { sourceType: "industry", query: "site:www.dazhou.gov.cn 大竹县 2026 招商 项目" },
      { sourceType: "industry", query: "site:www.dazhou.gov.cn 大竹县 经开区 2026 产业" },
      { sourceType: "industry", query: "site:www.dazhou.gov.cn 大竹县 电子信息 2026" },
      { sourceType: "industry", query: "site:www.dazhu.gov.cn 大竹县 充电基础设施 2026" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 比选 公告" },
      { sourceType: "bidding", query: "site:ccgp-sichuan.gov.cn 大竹县 竞争性磋商" },
      { sourceType: "bidding", query: "site:ccgp-sichuan.gov.cn 大竹县 成交公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 2026 中标 公告" },
      { sourceType: "bidding", query: "site:gpx.ccgp-sichuan.gov.cn 大竹县 2026 采购" },
      { sourceType: "bidding", query: "site:gpx.ccgp-sichuan.gov.cn 大竹县 学校 采购 2026" },
      { sourceType: "bidding", query: "site:gpx.ccgp-sichuan.gov.cn 大竹县 医院 采购 2026" },
      { sourceType: "bidding", query: "site:gpx.ccgp-sichuan.gov.cn 大竹县 成交公告 2026" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 人民医院 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 中医院 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 职业中学 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 教育局 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 文旅集团 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 城投 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 农业农村局 2026 招标 公告" },
      { sourceType: "bidding", query: "site:ggzyjy.sc.gov.cn 大竹县 交通运输局 2026 招标 公告" },
    ],
  },
};

const CITY_DOMAIN_MAP = {
  "黔南布依族苗族自治州": "qiannan.gov.cn",
  "黔东南苗族侗族自治州": "qdn.gov.cn",
  "黔西南布依族苗族自治州": "qxnj.gov.cn",
  "保山市": "baoshan.gov.cn",
  "昭通市": "zt.gov.cn",
  "玉溪市": "yuxi.gov.cn",
  "曲靖市": "qj.gov.cn",
  "普洱市": "puershi.gov.cn",
};

const COUNTY_DOMAIN_MAP = {
  "惠水县": "gzhs.gov.cn",
  "罗甸县": "gzluodian.gov.cn",
  "平塘县": "gzpt.gov.cn",
  "兴仁市": "gzxr.gov.cn",
  "福泉市": "gzfuquan.gov.cn",
  "锦屏县": "jinping.gov.cn",
  "腾冲市": "tengchong.gov.cn",
  "会泽县": "huize.gov.cn",
  "宁洱哈尼族彝族自治县": "ne.gov.cn",
  "景东彝族自治县": "jingdong.gov.cn",
  "彝良县": "cnyl.gov.cn",
  "元江哈尼族彝族傣族自治县": "yjx.gov.cn",
};

const DEMAND_RULES = [
  {
    id: "industrial-digitalization",
    label: "工业数字化与设备改造",
    keywords: ["智改数转", "数字化", "智能制造", "电子信息", "5G工厂", "数字车间", "智能工厂"],
    services: ["ERP/MES", "设备联网", "BI 看板", "数据采集", "工业软件实施", "AI 运营助理"],
  },
  {
    id: "supply-chain-logistics",
    label: "供应链、冷链与物流协同",
    keywords: ["物流", "冷链", "农贸", "仓储", "配送", "贸易集散", "农产品交易"],
    services: ["冷链履约", "仓配系统", "采购协同", "商贸撮合", "客户开发", "订单匹配"],
  },
  {
    id: "agri-branding",
    label: "农业加工、品牌和渠道拓展",
    keywords: ["苎麻", "竹产业", "白茶", "香椿", "糯稻", "农业园区", "品牌", "展会", "跨境电商"],
    services: ["品牌包装", "电商代运营", "渠道分销", "产品追溯", "内容营销", "行业研究"],
  },
  {
    id: "gov-service-outsourcing",
    label: "政府采购与专业服务外包",
    keywords: ["招标公告", "竞争性磋商", "比选", "监测服务", "文化服务", "招标代理"],
    services: ["投标辅助", "资质梳理", "联合投标", "项目管理", "交付分包", "线索推送"],
  },
  {
    id: "hr-subsidy",
    label: "招聘、用工和补贴服务",
    keywords: ["招工补贴", "成长劳动力", "培训", "就业", "人力资源"],
    services: ["招聘外包", "灵活用工", "补贴申报", "员工管理", "薪税服务"],
  },
];

const BLOCKED_TITLE_PATTERNS = [
  /^高级搜索$/,
  /^四川省公共资源交易信息网$/,
  /^大竹县政务服务网/,
  /^办事指南-四川政务服务网$/,
];

const BLOCKED_URL_PATTERNS = [
  /\/fullsearchs\//i,
  /\/col\/col\d+\/index\.html/i,
  /m\.sohu\.com/i,
  /mnews\.tianyancha\.com/i,
  /baidu\.com\/link/i,
  /so\.com\//i,
];

const OFFICIAL_HOST_PATTERNS = [
  /(^|\.).+\.gov\.cn$/i,
  /(^|\.).+\.gov$/i,
  /(^|\.)ggzy\.gov\.cn$/i,
  /(^|\.)ggzyjy\.[^.]+\.gov\.cn$/i,
  /(^|\.)ggzyjyzx\.[^.]+\.gov\.cn$/i,
  /(^|\.)ccgp\.[^.]+\.gov\.cn$/i,
  /(^|\.)ccgp\.gov\.cn$/i,
  /(^|\.)invest\.[^.]+\.gov\.cn$/i,
  /(^|\.)dazhu\.gov\.cn$/i,
  /(^|\.)dazhou\.gov\.cn$/i,
  /(^|\.)ggzyjy\.sc\.gov\.cn$/i,
  /(^|\.)ggzy\.gov\.cn$/i,
  /(^|\.)ccgp-sichuan\.gov\.cn$/i,
  /(^|\.)gpx\.ccgp-sichuan\.gov\.cn$/i,
  /(^|\.)sczwfw\.gov\.cn$/i,
  /(^|\.)sczwfw\.cn$/i,
];

const TARGET_ORG_PATTERNS = [
  /采购人[:：]?\s*([^\n，。；]{4,60})/g,
  /采购单位[:：]?\s*([^\n，。；]{4,60})/g,
  /招标人[:：]?\s*([^\n，。；]{4,60})/g,
  /招标单位[:：]?\s*([^\n，。；]{4,60})/g,
  /项目业主[:：]?\s*([^\n，。；]{4,60})/g,
  /项目单位[:：]?\s*([^\n，。；]{4,60})/g,
  /业主为\s*([^\n，。；]{4,60})/g,
  /业主单位[:：]?\s*([^\n，。；]{4,60})/g,
  /信息来源[:：]?\s*([^\n，。；]{4,60})/g,
  /发布机构[:：]?\s*([^\n，。；]{4,60})/g,
];

const TARGET_NAME_HINTS = [
  "大竹县人民医院",
  "大竹县中医院",
  "大竹县农业农村局",
  "大竹县教育局",
  "大竹县交通运输局",
  "大竹县工务局",
  "大竹县财政局",
  "大竹县统计局",
  "大竹县泓泽农业服务有限公司",
  "大竹县润竹文旅开发集团有限公司",
  "大竹县经开区",
  "大竹县职业中学",
  "大竹县观音中学",
];

const FOLLOWUP_RULES = [
  {
    match: /(教育局|学校|中学|职校|职业中学)/,
    serviceFits: ["集采供货撮合", "印刷与物资供应", "校园信息化", "履约分包"],
    outreach: "优先跟教育局装备或后勤口，核对学期采购计划、预算批复和供应商名录。",
  },
  {
    match: /(人民医院|中医院|医疗|卫生)/,
    serviceFits: ["工程施工协同", "医疗后勤采购", "设备维保", "招投标陪跑"],
    outreach: "优先联系医院基建或后勤采购口，确认施工节点、维保与后续设备采购。",
  },
  {
    match: /(农业农村局|农业服务|农田|泓泽农业)/,
    serviceFits: ["测绘设计分包", "农业设备供应", "农业社会化服务", "项目申报与履约"],
    outreach: "优先对接农业农村局项目股室或项目业主公司，确认设计、施工、农资和服务外包需求。",
  },
  {
    match: /(财政局)/,
    serviceFits: ["预算项目线索订阅", "政府采购预算解析", "供应商撮合", "绩效材料服务"],
    outreach: "围绕预算编制和采购预算口径切入，先做项目库和预算线索订阅服务。",
  },
  {
    match: /(经开区|园区|文旅|城投|宏高建筑材料)/,
    serviceFits: ["工程配套撮合", "产业招商线索", "供应链拓展", "数字化系统实施"],
    outreach: "优先找园区招商、建设或平台公司，切工程配套、企业服务和招商协同。",
  },
  {
    match: /(统计局)/,
    serviceFits: ["企业库线索订阅", "服务业企业拓客", "数据报送辅助"],
    outreach: "从入库企业名单和服务业主体摸排切入，转化为企业商机线索包。",
  },
];

function isLowQualityDocument(doc) {
  const title = String(doc.title || "").trim();
  const url = String(doc.url || "").trim();
  if (!url) return true;
  if (BLOCKED_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return true;
  if (BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url))) return true;
  return false;
}

function parseArgs(argv) {
  const args = {
    preset: "dazhu",
    county: "",
    city: "",
    province: "",
    configPath: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    limit: 8,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--preset" && next) {
      args.preset = next;
      i += 1;
    } else if (token === "--county" && next) {
      args.county = next;
      i += 1;
    } else if (token === "--city" && next) {
      args.city = next;
      i += 1;
    } else if (token === "--province" && next) {
      args.province = next;
      i += 1;
    } else if (token === "--config" && next) {
      args.configPath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--output-dir" && next) {
      args.outputDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--limit" && next) {
      args.limit = Math.max(1, Number.parseInt(next, 10) || 8);
      i += 1;
    }
  }

  return args;
}

async function loadConfigPreset(configPath) {
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  return {
    county: String(config.county || "").trim(),
    city: String(config.city || "").trim(),
    province: String(config.province || "").trim(),
    policyUrls: Array.isArray(config.policyUrls) ? config.policyUrls : [],
    industryUrls: Array.isArray(config.industryUrls) ? config.industryUrls : [],
    biddingUrls: Array.isArray(config.biddingUrls) ? config.biddingUrls : [],
    companyKeywords: Array.isArray(config.companyKeywords) ? config.companyKeywords : [],
    searchQueries: Array.isArray(config.searchQueries) ? config.searchQueries : [],
    searchDocumentQueries: Array.isArray(config.searchDocumentQueries) ? config.searchDocumentQueries : [],
  };
}

function buildDefaultPreset({ county, city, province }) {
  if (!county || !city || !province) {
    throw new Error("通用模式下必须提供 --province --city --county");
  }
  const countyShort = buildPrimaryPlaceKeyword(county);
  const cityShort = buildPrimaryPlaceKeyword(city);
  const govSite = `site:gov.cn ${province} ${city} ${county}`;
  const ggzySite = `site:ggzyjy.sc.gov.cn ${city} ${county}`;
  const ccgpSite = `site:ccgp-sichuan.gov.cn ${city} ${county}`;
  const gpxSite = `site:gpx.ccgp-sichuan.gov.cn ${city} ${county}`;
  const commonSearchQueries = [
    `${province} ${city} ${county} 政策 公告`,
    `${province} ${city} ${county} 惠企政策`,
    `${province} ${city} ${county} 招商引资 项目`,
    `${province} ${city} ${county} 产业 园区`,
    `${province} ${city} ${county} 招标 公告`,
    `${province} ${city} ${county} 采购 公告`,
  ];
  const commonDocumentQueries = [
    { sourceType: "policy", query: `${province} ${city} ${county} 政策 公告` },
    { sourceType: "policy", query: `${province} ${city} ${county} 惠企政策` },
    { sourceType: "policy", query: `${province} ${city} ${county} 资金 公示` },
    { sourceType: "policy", query: `${province} ${city} ${county} 2026 公示 公告` },
    { sourceType: "industry", query: `${province} ${city} ${county} 招商引资 项目` },
    { sourceType: "industry", query: `${province} ${city} ${county} 产业 园区` },
    { sourceType: "industry", query: `${province} ${city} ${county} 重点项目` },
    { sourceType: "industry", query: `${province} ${city} ${county} 智改数转` },
    { sourceType: "bidding", query: `${province} ${city} ${county} 招标 公告` },
    { sourceType: "bidding", query: `${province} ${city} ${county} 中标 公告` },
    { sourceType: "bidding", query: `${province} ${city} ${county} 竞争性磋商` },
    { sourceType: "bidding", query: `${province} ${city} ${county} 成交公告` },
  ];

  if (province.includes("云南")) {
    const kmGovSite = `site:km.gov.cn ${city} ${county}`;
    const cityGovDomain = CITY_DOMAIN_MAP[city] || "";
    const cityGovSite = cityGovDomain ? `site:${cityGovDomain} ${city} ${county}` : "";
    const ynGovSite = `site:yn.gov.cn ${city} ${county}`;
    const ynInvestSite = `site:invest.yn.gov.cn ${city} ${county}`;
    const ynPrcSite = `site:ggzy.yn.gov.cn ${city} ${county}`;
    const nationalPrcSite = `site:ggzy.gov.cn ${city} ${county}`;
    const ynCcgpSite = `site:ccgp-yunnan.gov.cn ${city} ${county}`;
    const countyGovDomain = COUNTY_DOMAIN_MAP[county] || "";
    const countyGovSite = countyGovDomain ? `site:${countyGovDomain} ${county}` : "";
    return {
      county,
      city,
      province,
      policyUrls: [],
      industryUrls: [],
      biddingUrls: [],
      companyKeywords: [
        `${countyShort} 招商引资`,
        `${countyShort} 产业园区`,
        `${countyShort} 重点项目`,
        `${countyShort} 制造业`,
        `${countyShort} 文旅`,
      ],
      searchQueries: [
        ...commonSearchQueries,
        `${govSite} 利企惠民政策`,
        `${govSite} 政策找企业`,
        `${govSite} 公示公告`,
        `${govSite} 通知公告`,
        `${govSite} 招商信息`,
        `${govSite} 公共资源交易`,
        `${ynGovSite} 惠企政策`,
        `${ynGovSite} 招商引资`,
        `${ynInvestSite} 招商引资`,
        `${ynInvestSite} 重点项目`,
        `${kmGovSite} 惠企政策`,
        `${kmGovSite} 招商引资`,
        `${cityGovSite} 惠企政策`,
        `${cityGovSite} 招商引资`,
        `${countyGovSite} 政策 公告`,
        `${countyGovSite} 公示公告`,
        `${countyGovSite} 招商引资`,
        `${countyGovSite} 重点项目`,
        `${ynPrcSite} 招标 公告`,
        `${ynPrcSite} 中标 公告`,
        `${nationalPrcSite} 招标 公告`,
        `${nationalPrcSite} 中标 公告`,
        `${ynCcgpSite} 采购`,
        `${province} ${city} ${county} 政策找企业`,
        `${province} ${city} ${county} 利企惠民政策`,
        `${province} ${city} ${county} 公共资源交易`,
      ].filter(Boolean),
      searchDocumentQueries: [
        ...commonDocumentQueries,
        { sourceType: "policy", query: `${govSite} 政策找企业` },
        { sourceType: "policy", query: `${govSite} 利企惠民政策` },
        { sourceType: "policy", query: `${govSite} 公示公告` },
        { sourceType: "policy", query: `${govSite} 通知公告` },
        { sourceType: "policy", query: `${ynGovSite} 惠企政策` },
        { sourceType: "policy", query: `${ynInvestSite} 招商政策` },
        { sourceType: "policy", query: `${cityGovSite} 惠企政策` },
        { sourceType: "policy", query: `${countyGovSite} 政策文件` },
        { sourceType: "policy", query: `${countyGovSite} 公示公告` },
        { sourceType: "industry", query: `${govSite} 招商信息` },
        { sourceType: "industry", query: `${govSite} 产业项目` },
        { sourceType: "industry", query: `${govSite} 产业园区` },
        { sourceType: "industry", query: `${govSite} 重点建设项目` },
        { sourceType: "industry", query: `${ynInvestSite} 招商引资` },
        { sourceType: "industry", query: `${ynInvestSite} 重点项目` },
        { sourceType: "industry", query: `${countyGovSite} 招商引资` },
        { sourceType: "industry", query: `${countyGovSite} 重点项目` },
        { sourceType: "industry", query: `${province} ${city} ${county} 设备更新` },
        { sourceType: "bidding", query: `${ynPrcSite} 招标 公告` },
        { sourceType: "bidding", query: `${ynPrcSite} 中标 公告` },
        { sourceType: "bidding", query: `${nationalPrcSite} 招标公告` },
        { sourceType: "bidding", query: `${nationalPrcSite} 中标公告` },
        { sourceType: "bidding", query: `${ynCcgpSite} 采购公告` },
        { sourceType: "bidding", query: `${ynCcgpSite} 成交公告` },
        { sourceType: "bidding", query: `${countyGovSite} 招标公告` },
        { sourceType: "bidding", query: `${province} ${city} ${county} 比选 公告` },
      ].filter((item) => item.query && !/site:\.gov\.cn/.test(item.query)),
    };
  }

  if (province.includes("贵州")) {
    const gzGovSite = `site:guizhou.gov.cn ${city} ${county}`;
    const cityGovDomain = CITY_DOMAIN_MAP[city] || "";
    const cityGovSite = cityGovDomain ? `site:${cityGovDomain} ${city} ${county}` : "";
    const qdnGovSite = `site:qdn.gov.cn ${city} ${county}`;
    const gzPrcSite = `site:ggzy.guizhou.gov.cn ${city} ${county}`;
    const nationalPrcSite = `site:ggzy.gov.cn ${city} ${county}`;
    const gzCcgpSite = `site:ccgp-guizhou.gov.cn ${city} ${county}`;
    const countyGovDomain = COUNTY_DOMAIN_MAP[county] || "";
    const countyGovSite = countyGovDomain ? `site:${countyGovDomain} ${county}` : "";
    return {
      county,
      city,
      province,
      policyUrls: [],
      industryUrls: [],
      biddingUrls: [],
      companyKeywords: [
        `${countyShort} 招商引资`,
        `${countyShort} 重点项目`,
        `${countyShort} 产业园区`,
        `${countyShort} 文旅`,
        `${countyShort} 制造业`,
      ],
      searchQueries: [
        ...commonSearchQueries,
        `${govSite} 招商引资`,
        `${govSite} 重点项目`,
        `${govSite} 项目库`,
        `${govSite} 衔接推进乡村振兴补助资金`,
        `${gzGovSite} 惠企政策`,
        `${cityGovSite} 惠企政策`,
        `${qdnGovSite} 惠企政策`,
        `${qdnGovSite} 招商引资`,
        `${qdnGovSite} 项目库`,
        `${countyGovSite} 政策文件`,
        `${countyGovSite} 公示公告`,
        `${countyGovSite} 招商引资`,
        `${countyGovSite} 重点项目`,
        `${gzPrcSite} 招标 公告`,
        `${gzPrcSite} 中标 公告`,
        `${nationalPrcSite} 招标 公告`,
        `${nationalPrcSite} 中标 公告`,
        `${gzCcgpSite} 采购公告`,
        `${gzCcgpSite} 成交公告`,
      ].filter(Boolean),
      searchDocumentQueries: [
        ...commonDocumentQueries,
        { sourceType: "policy", query: `${govSite} 惠企政策` },
        { sourceType: "policy", query: `${govSite} 衔接推进乡村振兴补助资金` },
        { sourceType: "policy", query: `${govSite} 项目库` },
        { sourceType: "policy", query: `${gzGovSite} 惠企政策` },
        { sourceType: "policy", query: `${cityGovSite} 惠企政策` },
        { sourceType: "policy", query: `${qdnGovSite} 惠企政策` },
        { sourceType: "policy", query: `${countyGovSite} 政策文件` },
        { sourceType: "policy", query: `${countyGovSite} 公示公告` },
        { sourceType: "industry", query: `${govSite} 招商引资 项目` },
        { sourceType: "industry", query: `${govSite} 重点项目` },
        { sourceType: "industry", query: `${qdnGovSite} 招商引资 项目` },
        { sourceType: "industry", query: `${qdnGovSite} 重点项目` },
        { sourceType: "industry", query: `${countyGovSite} 招商引资` },
        { sourceType: "industry", query: `${countyGovSite} 重点项目` },
        { sourceType: "bidding", query: `${gzPrcSite} 招标 公告` },
        { sourceType: "bidding", query: `${gzPrcSite} 中标 公告` },
        { sourceType: "bidding", query: `${nationalPrcSite} 招标公告` },
        { sourceType: "bidding", query: `${nationalPrcSite} 中标公告` },
        { sourceType: "bidding", query: `${gzCcgpSite} 采购公告` },
        { sourceType: "bidding", query: `${gzCcgpSite} 成交公告` },
        { sourceType: "bidding", query: `${countyGovSite} 招标公告` },
      ].filter((item) => item.query && !/site:\.gov\.cn/.test(item.query)),
    };
  }

  return {
    county,
    city,
    province,
    policyUrls: [],
    industryUrls: [],
    biddingUrls: [],
    companyKeywords: [
      `${countyShort} 电子信息`,
      `${countyShort} 智能制造`,
      `${countyShort} 招商引资`,
      `${countyShort} 园区 企业`,
      `${countyShort} 重点项目`,
    ],
    searchQueries: [
      ...commonSearchQueries,
      `${govSite} 招商引资`,
      `${govSite} 产业 项目`,
      `${govSite} 惠企政策`,
      `${govSite} 资金 公示`,
      `${ggzySite} 招标 公告`,
      `${ggzySite} 中标 公告`,
      `${ccgpSite} 采购`,
      `${gpxSite} 采购`,
    ].filter(Boolean),
    searchDocumentQueries: [
      ...commonDocumentQueries,
      { sourceType: "policy", query: `${govSite} 政策 公告` },
      { sourceType: "policy", query: `${govSite} 惠企政策` },
      { sourceType: "policy", query: `${govSite} 资金 公示` },
      { sourceType: "policy", query: `${govSite} 2026 公示 公告` },
      { sourceType: "industry", query: `${govSite} 招商引资 项目` },
      { sourceType: "industry", query: `${govSite} 产业 园区` },
      { sourceType: "industry", query: `${govSite} 重点项目` },
      { sourceType: "industry", query: `${govSite} 智改数转` },
      { sourceType: "bidding", query: `${ggzySite} 招标 公告` },
      { sourceType: "bidding", query: `${ggzySite} 中标 公告` },
      { sourceType: "bidding", query: `${ccgpSite} 竞争性磋商` },
      { sourceType: "bidding", query: `${gpxSite} 成交公告` },
    ],
  };
}

async function ensurePreset(args) {
  if (args.configPath) {
    const configPreset = await loadConfigPreset(args.configPath);
    return {
      ...configPreset,
      county: args.county || configPreset.county,
      city: args.city || configPreset.city,
      province: args.province || configPreset.province,
    };
  }
  if (args.province || args.city || args.county) {
    return buildDefaultPreset({
      county: args.county,
      city: args.city,
      province: args.province,
    });
  }
  const preset = COUNTY_PRESETS[args.preset];
  if (!preset) {
    throw new Error(`未知 preset: ${args.preset}`);
  }
  return {
    ...preset,
    county: args.county || preset.county,
  };
}

function toSlug(value) {
  return String(value).trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number.parseInt(code, 10)));
}

function extractDdgTargetUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const normalized = value.startsWith("//") ? `https:${value}` : value;
    const url = new URL(normalized);
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : normalized;
  } catch {
    return value;
  }
}

async function searchViaBingRss(query, limit) {
  const endpoint = `https://www.bing.com/search?format=rss&setlang=zh-Hans&cc=cn&mkt=zh-CN&q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
    },
  });
  if (!response.ok) throw new Error(`Bing RSS 搜索失败 ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const results = [];
  for (const match of items) {
    const block = match[1];
    const title = decodeHtmlEntities((block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    const url = decodeHtmlEntities((block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    const snippet = decodeHtmlEntities((block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    const pubDate = decodeHtmlEntities((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "").trim());
    if (!title || !url) continue;
    results.push({
      title: stripLineNoise(title),
      url,
      snippet: stripLineNoise(snippet),
      date: pubDate,
      source: getHost(url),
      full_text: stripLineNoise(snippet),
    });
    if (results.length >= limit) break;
  }
  return { enabled: true, results };
}

function buildSearchVariants(query) {
  const base = String(query || "").trim();
  if (!base) return [];
  const variants = new Set([base]);
  const merged = base
    .replace(/\s+招标\s+公告/g, " 招标公告")
    .replace(/\s+中标\s+公告/g, " 中标公告")
    .replace(/\s+采购\s+公告/g, " 采购公告")
    .replace(/\s+成交\s+公告/g, " 成交公告")
    .replace(/\s+政策\s+公告/g, " 政策公告")
    .trim();
  variants.add(merged);

  const tokens = base.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) variants.add(tokens.slice(1).join(" "));
  if (tokens.length >= 4) variants.add(tokens.slice(2).join(" "));
  if (tokens.length >= 2) {
    const countyFirst = [tokens[tokens.length - 2], tokens[tokens.length - 1]].join(" ").trim();
    variants.add(countyFirst);
    variants.add(countyFirst.replace(/\s+/g, ""));
  }
  return [...variants].filter(Boolean);
}

function buildPlaceAliases(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const aliases = new Set([raw, raw.replace(/\s+/g, "")]);
  const stripped = raw
    .replace(/特别行政区$/g, "")
    .replace(/自治州$/g, "")
    .replace(/自治县$/g, "")
    .replace(/自治旗$/g, "")
    .replace(/新区$/g, "")
    .replace(/矿区$/g, "")
    .replace(/林区$/g, "")
    .replace(/地区$/g, "")
    .replace(/开发区$/g, "")
    .replace(/(?:蒙古族|回族|藏族|维吾尔族|苗族|彝族|壮族|布依族|侗族|瑶族|白族|土家族|哈尼族|傣族|傈僳族|佤族|畲族|高山族|拉祜族|水族|东乡族|纳西族|景颇族|柯尔克孜族|土族|达斡尔族|仫佬族|羌族|布朗族|撒拉族|毛南族|仡佬族|锡伯族|阿昌族|普米族|朝鲜族|塔吉克族|怒族|乌孜别克族|俄罗斯族|鄂温克族|德昂族|保安族|裕固族|京族|塔塔尔族|独龙族|鄂伦春族|赫哲族|门巴族|珞巴族|基诺族)+/g, "")
    .replace(/[省市县区州旗盟乡镇街道]$/g, "")
    .trim();
  if (stripped && stripped !== raw) {
    aliases.add(stripped);
    aliases.add(stripped.replace(/\s+/g, ""));
  }
  return [...aliases].filter(Boolean);
}

function buildPrimaryPlaceKeyword(value) {
  const aliases = buildPlaceAliases(value)
    .map((item) => String(item || "").trim())
    .filter((item) => item.length >= 2);
  if (aliases.length === 0) return String(value || "").trim();
  return aliases.sort((a, b) => a.length - b.length)[0];
}

async function searchViaCountyAliases(query, countyName, limit) {
  if (!countyName || !String(query || "").includes(countyName)) return null;
  const countyAliases = buildPlaceAliases(countyName)
    .filter((alias) => alias && alias !== countyName)
    .sort((a, b) => a.length - b.length);

  for (const alias of countyAliases) {
    const variantQuery = String(query).replaceAll(countyName, alias);
    if (!variantQuery || variantQuery === query) continue;
    try {
      const result = await searchViaApi(variantQuery, limit);
      if ((result.results || []).length > 0) {
        return {
          ...result,
          aliasQuery: variantQuery,
        };
      }
    } catch {
      // ignore alias retry failures
    }
  }

  return null;
}

function extractSiteConstraints(query) {
  return [...String(query || "").matchAll(/site:([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)]
    .map((match) => String(match[1] || "").toLowerCase())
    .filter(Boolean);
}

function matchesSiteConstraints(url, query) {
  const constraints = extractSiteConstraints(query);
  if (constraints.length === 0) return true;
  const host = getHost(url).toLowerCase();
  return constraints.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function hasRelevantSearchHit(results, query) {
  const tokens = String(query || "").split(/\s+/).filter((item) => item && /[\u4e00-\u9fa5A-Za-z0-9]/.test(item));
  return (results || []).some((item) => {
    const haystack = `${item.title || ""}\n${item.snippet || ""}\n${item.url || ""}`;
    return tokens.some((token) => token.length >= 2 && haystack.includes(token));
  });
}

async function searchViaDuckDuckGo(query, limit) {
  const variants = buildSearchVariants(query);
  for (const variant of variants) {
    const endpoint = `https://duckduckgo.com/html/?kl=cn-zh&q=${encodeURIComponent(variant)}`;
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
      },
    });
    if (!response.ok) continue;
    const html = await response.text();
    const results = [];
    const blocks = html.split(/<a rel="nofollow" class="result__a"/i).slice(1);
    for (const block of blocks) {
      const hrefMatch = block.match(/href="([^"]+)"/i);
      const titleMatch = block.match(/>([\s\S]*?)<\/a>/i);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
      const url = extractDdgTargetUrl(hrefMatch?.[1] || "");
      const title = stripLineNoise(decodeHtmlEntities(String(titleMatch?.[1] || "").replace(/<[^>]+>/g, "")));
      const snippet = stripLineNoise(decodeHtmlEntities(String(snippetMatch?.[1] || "").replace(/<[^>]+>/g, "")));
      if (!url || !title) continue;
      results.push({
        title,
        url,
        snippet,
        date: "",
        source: getHost(url),
        full_text: snippet,
      });
      if (results.length >= limit) break;
    }
    if (results.length > 0) return { enabled: true, results };
  }
  return { enabled: true, results: [] };
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function stripLineNoise(line) {
  return line
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-•·\s]+/, "")
    .trim();
}

function extractTitle(html, fallbackUrl) {
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    const title = stripLineNoise(htmlToText(h1Match[1]));
    if (title) return title;
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const title = stripLineNoise(htmlToText(titleMatch[1]));
    if (title) return title;
  }
  return fallbackUrl;
}

function extractDate(text, url) {
  const publishedPatterns = [
    /发布时间[:：]?\s*(20\d{2})[年\s/-]*(\d{1,2})[月\s/-]*(\d{1,2})/i,
    /发布日期[:：]?\s*(20\d{2})[年\s/-]*(\d{1,2})[月\s/-]*(\d{1,2})/i,
    /时间[:：]?\s*(20\d{2})[年\s/-]*(\d{1,2})[月\s/-]*(\d{1,2})/i,
  ];
  for (const pattern of publishedPatterns) {
    const matched = text.match(pattern);
    if (matched) {
      const [, y, m, d] = matched;
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  const direct = text.match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})/);
  if (direct) {
    const [, y, m, d] = direct;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const fromUrl = url.match(/\/(20\d{2})(\d{2})(\d{2})\//);
  if (fromUrl) {
    const [, y, m, d] = fromUrl;
    return `${y}-${m}-${d}`;
  }
  return "";
}

function compactText(text, limit = 6000) {
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function extractMoney(text) {
  const patterns = [
    /([0-9]+(?:\.[0-9]+)?)\s*万元/g,
    /([0-9]+(?:\.[0-9]+)?)\s*亿元/g,
    /¥\s*([0-9]+(?:\.[0-9]+)?)/g,
  ];
  const hits = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      hits.push(match[0]);
    }
  }
  return [...new Set(hits)].slice(0, 6);
}

function extractHighlightedSentences(text, keywords, limit = 8) {
  const sentences = text
    .split(/(?<=[。！？；;])/)
    .map((item) => stripLineNoise(item))
    .filter(Boolean);

  const picked = [];
  for (const sentence of sentences) {
    if (keywords.some((keyword) => sentence.includes(keyword))) {
      picked.push(sentence);
    }
    if (picked.length >= limit) break;
  }
  return picked;
}

function detectDemandTags(text) {
  const hits = [];
  for (const rule of DEMAND_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      hits.push(rule.id);
    }
  }
  return hits;
}

function extractTargetOrgs(text, title = "") {
  const haystack = `${title}\n${text || ""}`;
  const hits = [];

  for (const pattern of TARGET_ORG_PATTERNS) {
    for (const match of haystack.matchAll(pattern)) {
      const value = stripLineNoise(match[1] || "")
        .replace(/^为/, "")
        .replace(/[（(][^)）]{0,30}[)）]$/g, "")
        .slice(0, 60);
      if (
        value.length >= 4 &&
        !/招标文件|获取方式|投标文件|截止时间|联系电话|公告发布|媒介名称|行政监督部门/.test(value) &&
        /[\u4e00-\u9fa5]/.test(value)
      ) hits.push(value);
    }
  }

  for (const hint of TARGET_NAME_HINTS) {
    if (haystack.includes(hint)) hits.push(hint);
  }

  return [...new Set(hits)].slice(0, 5);
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/#.*$/, "").replace(/\/+$/, "");
}

function getHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isOfficialHost(url) {
  const host = getHost(url);
  if (!host) return false;
  if (host === "gov.cn" || host.endsWith(".gov.cn") || host === "gov" || host.endsWith(".gov")) return true;
  return OFFICIAL_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function mentionsTargetYear(doc, year = "2026") {
  const haystack = `${doc.title || ""}\n${doc.summary || ""}\n${doc.text || ""}`;
  return String(doc.date || "").startsWith(`${year}-`) || haystack.includes(year);
}

function scoreOpportunity(doc, year = "2026") {
  let score = 0;
  if (doc.sourceType === "bidding") score += 40;
  if (doc.sourceType === "policy") score += 18;
  if (doc.sourceType === "industry") score += 12;
  if (isOfficialHost(doc.url)) score += 20;
  if (mentionsTargetYear(doc, year)) score += 20;
  if ((doc.money || []).length > 0) score += 15;
  if ((doc.tags || []).length > 0) score += 10;
  if ((doc.targetOrgs || []).length > 0) score += 12;

  const haystack = `${doc.title || ""}\n${doc.summary || ""}\n${doc.text || ""}`;
  const highIntentKeywords = [
    "招标",
    "采购",
    "成交公告",
    "中标",
    "比选",
    "遴选",
    "竞争性磋商",
    "项目实施主体",
    "服务主体",
    "资金分配",
    "拟立项",
    "立项",
    "招商引资",
    "机会清单",
  ];
  for (const keyword of highIntentKeywords) {
    if (haystack.includes(keyword)) score += 6;
  }

  return score;
}

function buildOpportunityPool(documents, year = "2026") {
  const scoredDocuments = documents
    .map((doc) => ({
      ...doc,
      host: getHost(doc.url),
      official: isOfficialHost(doc.url),
      opportunityScore: scoreOpportunity(doc, year),
    }))
    .filter((doc) => shouldKeepOpportunity(doc));

  const strongFallbackDocuments = scoredDocuments.filter((doc) => {
    if (mentionsTargetYear(doc, year)) return false;
    const haystack = `${doc.title || ""}\n${doc.summary || ""}\n${doc.text || ""}`;
    return (
      doc.official
      && (
        doc.sourceType === "bidding"
        || doc.sourceType === "industry"
        || doc.opportunityScore >= 55
        || /项目|招标|采购|中标|成交|招商引资|招商推介|项目库|重点项目|建设项目/.test(haystack)
      )
    );
  });

  const primaryDocuments = scoredDocuments.filter((doc) => mentionsTargetYear(doc, year));
  const candidateDocuments = primaryDocuments.length >= 3
    ? primaryDocuments
    : dedupeDocuments([...primaryDocuments, ...strongFallbackDocuments]);

  const map = new Map();
  for (const doc of candidateDocuments) {
    const titleKey = stripLineNoise(doc.title).replace(/[“”"'‘’`·_\-:：\s]/g, "").slice(0, 50);
    const existing = map.get(titleKey);
    if (!existing || doc.opportunityScore > existing.opportunityScore) {
      map.set(titleKey, doc);
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.opportunityScore !== a.opportunityScore) return b.opportunityScore - a.opportunityScore;
    return String(b.date || "").localeCompare(String(a.date || ""));
  });
}

function buildDocFromSearchResult(result, sourceType, countyName, query) {
  const text = compactText(result.full_text || result.snippet || "", 12000);
  const title = result.title || result.url || query;
  const date = result.date ? String(result.date).slice(0, 10) : extractDate(text, result.url || "");
  const keyPoints = extractHighlightedSentences(text, [
    countyName,
    "产业",
    "项目",
    "招标",
    "采购",
    "补贴",
    "政策",
    "电子信息",
    "智能制造",
    "数字经济",
    "苎麻",
    "竹产业",
    "物流",
    "冷链",
    "服务业",
    "政府采购",
    "投标",
    "监测服务",
    "文化服务",
    "农业社会化服务",
    "乡村振兴",
  ]);
  const summary = keyPoints[0] || result.snippet || text.slice(0, 180);
  return {
    title,
    url: result.url || "",
    sourceType,
    date,
    money: extractMoney(text),
    summary,
    keyPoints,
    tags: detectDemandTags(`${title} ${summary} ${keyPoints.join(" ")}`),
    targetOrgs: extractTargetOrgs(text, title),
    text,
    discoveredByQuery: query,
    fallbackUsed: true,
  };
}

function dedupeDocuments(documents) {
  const map = new Map();
  for (const doc of documents) {
    if (isLowQualityDocument(doc)) continue;
    const urlKey = normalizeUrl(doc.url);
    const titleKey = stripLineNoise(doc.title).slice(0, 120);
    const key = urlKey || `${doc.sourceType}:${titleKey}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, doc);
      continue;
    }
    const existingScore = (existing.keyPoints?.length || 0) + (existing.text?.length || 0);
    const nextScore = (doc.keyPoints?.length || 0) + (doc.text?.length || 0);
    if (nextScore > existingScore) map.set(key, doc);
  }
  return [...map.values()];
}

function buildOpportunityGraph(documents) {
  const graph = new Map();
  for (const rule of DEMAND_RULES) {
    graph.set(rule.id, {
      id: rule.id,
      label: rule.label,
      services: rule.services,
      evidence: [],
    });
  }

  for (const doc of documents) {
    for (const tag of doc.tags) {
      const item = graph.get(tag);
      if (!item) continue;
      item.evidence.push({
        title: doc.title,
        date: doc.date,
        url: doc.url,
        sourceType: doc.sourceType,
        snippet: doc.keyPoints[0] || doc.summary || "",
      });
    }
  }

  return [...graph.values()]
    .map((item) => ({ ...item, evidence: item.evidence.slice(0, 5), score: item.evidence.length }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function buildLeadList(opportunities) {
  const leads = new Map();
  for (const doc of opportunities) {
    const orgs = doc.targetOrgs?.length ? doc.targetOrgs : [];
    for (const org of orgs) {
      const key = stripLineNoise(org);
      if (!key || key.length < 4 || !/[\u4e00-\u9fa5]/.test(key)) continue;
      const existing = leads.get(key) || {
        targetOrg: key,
        opportunityCount: 0,
        latestDate: "",
        totalScore: 0,
        sourceTypes: new Set(),
        money: new Set(),
        titles: [],
        urls: [],
      };
      existing.opportunityCount += 1;
      existing.totalScore += doc.opportunityScore || 0;
      existing.sourceTypes.add(doc.sourceType);
      for (const item of doc.money || []) existing.money.add(item);
      existing.titles.push(doc.title);
      existing.urls.push(doc.url);
      if (String(doc.date || "") > String(existing.latestDate || "")) existing.latestDate = doc.date || existing.latestDate;
      leads.set(key, existing);
    }
  }

  return [...leads.values()]
    .map((item) => ({
      targetOrg: item.targetOrg,
      opportunityCount: item.opportunityCount,
      latestDate: item.latestDate,
      leadScore: item.totalScore,
      sourceTypes: [...item.sourceTypes],
      money: [...item.money].slice(0, 6),
      sampleTitles: [...new Set(item.titles)].slice(0, 3),
      sampleUrls: [...new Set(item.urls)].slice(0, 3),
    }))
    .sort((a, b) => {
      if (b.leadScore !== a.leadScore) return b.leadScore - a.leadScore;
      return String(b.latestDate || "").localeCompare(String(a.latestDate || ""));
    });
}

function buildFollowupList(leads) {
  return leads.map((lead) => {
    const matchedRule = FOLLOWUP_RULES.find((rule) => rule.match.test(lead.targetOrg));
    const serviceFits = matchedRule?.serviceFits || ["线索订阅", "投标陪跑", "供应商撮合"];
    const outreach = matchedRule?.outreach || "先确认主体采购权限、年度预算和近期招采计划，再推送对应供应商与订单线索。";
    const urgency = lead.leadScore >= 100 ? "高" : lead.leadScore >= 75 ? "中" : "低";
    return {
      targetOrg: lead.targetOrg,
      urgency,
      leadScore: lead.leadScore,
      latestDate: lead.latestDate,
      opportunityCount: lead.opportunityCount,
      sourceTypes: lead.sourceTypes,
      money: lead.money,
      sampleTitles: lead.sampleTitles,
      sampleUrls: lead.sampleUrls,
      serviceFits,
      outreach,
    };
  });
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; GalaxyOPC-CountyIntel/1.0; +https://github.com/P3ngSaM/galaxy-opc)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || "";
    throw new Error(`redirect-loop:${location || "unknown"}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

async function collectFromSearchFallback(source, sourceType, countyName, originalError) {
  if (!source.fallbackQuery) {
    return {
      title: source.url,
      url: source.url,
      sourceType,
      date: "",
      money: [],
      summary: `直抓失败：${originalError.message}`,
      keyPoints: [`直抓失败：${originalError.message}`],
      tags: [],
      targetOrgs: [],
      text: "",
      fetchError: originalError.message,
    };
  }

  const result = await searchOne(source.fallbackQuery, countyName, source.url);
  if (!result) {
    return {
      title: source.url,
      url: source.url,
      sourceType,
      date: "",
      money: [],
      summary: `直抓失败，搜索兜底未命中：${originalError.message}`,
      keyPoints: [`直抓失败，搜索兜底未命中：${originalError.message}`],
      tags: [],
      targetOrgs: [],
      text: "",
      fetchError: originalError.message,
    };
  }

  const text = compactText(result.full_text || result.snippet || "", 12000);
  const date = result.date ? String(result.date).slice(0, 10) : extractDate(text, result.url);
  const title = result.title || source.url;
  const keyPoints = extractHighlightedSentences(text, [
    countyName,
    "产业",
    "项目",
    "招标",
    "采购",
    "补贴",
    "政策",
    "电子信息",
    "智能制造",
    "数字经济",
    "苎麻",
    "竹产业",
    "物流",
    "冷链",
    "服务业",
    "政府采购",
    "投标",
    "监测服务",
    "文化服务",
  ]);
  const summary = keyPoints[0] || result.snippet || `搜索兜底命中：${title}`;

  return {
    title,
    url: result.url || source.url,
    sourceType,
    date,
    money: extractMoney(text),
    summary,
    keyPoints,
    tags: detectDemandTags(`${title} ${summary} ${keyPoints.join(" ")}`),
    targetOrgs: extractTargetOrgs(text, title),
    text,
    fallbackUsed: true,
    fallbackQuery: source.fallbackQuery,
    fetchError: originalError.message,
  };
}

async function collectDocument(source, sourceType, countyName) {
  const normalized = typeof source === "string" ? { url: source, fallbackQuery: "" } : source;
  let html;
  try {
    html = await fetchHtml(normalized.url);
  } catch (error) {
    return await collectFromSearchFallback(normalized, sourceType, countyName, error);
  }
  const title = extractTitle(html, normalized.url);
  const text = compactText(htmlToText(html), 12000);
  const date = extractDate(text, normalized.url);
  const keyPoints = extractHighlightedSentences(text, [
    countyName,
    "产业",
    "项目",
    "招标",
    "采购",
    "补贴",
    "政策",
    "电子信息",
    "智能制造",
    "数字经济",
    "苎麻",
    "竹产业",
    "物流",
    "冷链",
    "服务业",
    "政府采购",
    "投标",
    "监测服务",
    "文化服务",
  ]);
  const summary = keyPoints[0] || text.slice(0, 180);
  return {
    title,
    url: normalized.url,
    sourceType,
    date,
    money: extractMoney(text),
    summary,
    keyPoints,
    tags: detectDemandTags(`${title} ${summary} ${keyPoints.join(" ")}`),
    targetOrgs: extractTargetOrgs(text, title),
    text,
  };
}

async function searchViaApi(query, limit) {
  const apiUrl = process.env.SEARCH_API_URL || process.env.UAPI_URL || "https://uapis.cn/api/v1/search/aggregate";
  const apiKey = process.env.SEARCH_API_KEY || process.env.UAPI_KEY;
  if (!apiUrl || !apiKey) {
    return searchViaBingRss(query, limit);
  }
  const throttleMs = Math.max(200, Number.parseInt(process.env.SEARCH_API_THROTTLE_MS || "900", 10) || 900);
  const maxRetries = Math.max(1, Number.parseInt(process.env.SEARCH_API_RETRIES || "4", 10) || 4);
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const waitMs = Math.max(0, throttleMs - (Date.now() - lastSearchRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastSearchRequestAt = Date.now();

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        timeout_ms: 15000,
        fetch_full: true,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const results = (data.results || []).slice(0, limit).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet || "",
        date: item.publish_time || "",
        source: item.domain || item.source || "",
        full_text: item.full_text || "",
      }));
      return { enabled: true, results };
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "0", 10);
      const backoffMs = retryAfter > 0 ? retryAfter * 1000 : throttleMs * (attempt + 2);
      await sleep(backoffMs);
      continue;
    }

    lastError = new Error(`搜索 API 失败 ${response.status}`);
    break;
  }

  try {
    const bing = await searchViaBingRss(query, limit);
    if ((bing.results || []).length > 0 && hasRelevantSearchHit(bing.results, query)) return bing;
  } catch (error) {
    lastError = error;
  }

  try {
    return await searchViaDuckDuckGo(query, limit);
  } catch (error) {
    lastError = error;
  }

  throw lastError || new Error("搜索 API 与兜底搜索均失败");
}

async function searchOne(query, countyName = "", sourceUrl = "") {
  const bundle = await searchViaApi(query, 8);
  const sourceHost = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : "";
  const countySlug = countyName ? toSlug(countyName) : "";
  const countyAliases = buildPlaceAliases(countyName);
  const constrainedResults = bundle.results.filter((item) => matchesSiteConstraints(item.url || "", query));
  const effectiveResults = constrainedResults.length > 0 ? constrainedResults : bundle.results;
  const scored = effectiveResults
    .map((item) => {
      let score = 0;
      const haystack = `${item.title || ""}\n${item.snippet || ""}\n${item.full_text || ""}`;
      if (countyAliases.some((alias) => alias && haystack.includes(alias))) score += 3;
      if (countySlug && String(item.url || "").toLowerCase().includes(countySlug)) score += 2;
      if (sourceHost && (item.url || "").includes(sourceHost)) score += 2;
      if (sourceHost && (item.source || "").includes(sourceHost)) score += 1;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.item || null;
}

async function collectSearchSignals(queries, limit, countyName = "") {
  const bundles = [];
  for (const query of queries) {
    try {
      let result = await searchViaApi(query, limit);
      if ((result.results || []).length === 0) {
        const aliasResult = await searchViaCountyAliases(query, countyName, limit);
        if (aliasResult) result = aliasResult;
      }
      bundles.push({ query, ...result });
    } catch (error) {
      bundles.push({ query, enabled: true, error: error.message, results: [] });
    }
  }
  return bundles;
}

async function collectSearchDocuments(searchDocumentQueries, countyName, limit) {
  const documents = [];
  const countySlug = countyName ? toSlug(countyName) : "";
  const countyAliases = buildPlaceAliases(countyName);
  for (const item of searchDocumentQueries) {
    try {
      let result = await searchViaApi(item.query, limit);
      if ((result.results || []).length === 0) {
        const aliasResult = await searchViaCountyAliases(item.query, countyName, limit);
        if (aliasResult) result = aliasResult;
      }
      const constrainedResults = result.results.filter((entry) => matchesSiteConstraints(entry.url || "", item.query));
      const effectiveResults = constrainedResults.length > 0 ? constrainedResults : result.results;
      for (const entry of effectiveResults) {
        const haystack = `${entry.title || ""}\n${entry.snippet || ""}\n${entry.full_text || ""}`;
        const aliasHit = countyAliases.some((alias) => alias && haystack.includes(alias));
        if (!aliasHit && !(countySlug && String(entry.url || "").toLowerCase().includes(countySlug))) continue;
        documents.push(buildDocFromSearchResult(entry, item.sourceType, countyName, item.query));
      }
    } catch {
      // ignore single-query failures
    }
  }
  return dedupeDocuments(documents);
}

async function queryTianyancha(keyword) {
  const url = process.env.TIANYANCHA_SEARCH_URL;
  const token = process.env.TIANYANCHA_TOKEN || process.env.TIANYANCHA_APPKEY;
  if (!url || !token) {
    return { enabled: false, keyword, items: [] };
  }

  const endpoint = new URL(url);
  endpoint.searchParams.set("keyword", keyword);

  const response = await fetch(endpoint, {
    headers: {
      Authorization: token,
    },
  });

  if (!response.ok) {
    throw new Error(`天眼查接口失败 ${response.status}`);
  }

  const data = await response.json();
  const items = (((data.result || {}).items) || []).slice(0, 8).map((item) => ({
    name: item.name,
    legalPersonName: item.legalPersonName,
    regStatus: item.regStatus,
    regCapital: item.regCapital,
    base: item.base,
    estiblishTime: item.estiblishTime,
    creditCode: item.creditCode,
  }));

  return { enabled: true, keyword, items };
}

async function collectCompanySignals(keywords) {
  const bundles = [];
  for (const keyword of keywords) {
    try {
      bundles.push(await queryTianyancha(keyword));
    } catch (error) {
      bundles.push({ enabled: true, keyword, error: error.message, items: [] });
    }
  }
  return bundles;
}

function buildAssessment(opportunityGraph, documents) {
  const reasons = [];
  const top = opportunityGraph.slice(0, 3);
  if (top.length > 0) {
    reasons.push(`前 3 个高频需求方向分别是：${top.map((item) => item.label).join("、")}。`);
  }

  const biddingCount = documents.filter((doc) => doc.sourceType === "bidding").length;
  const policyCount = documents.filter((doc) => doc.sourceType === "policy").length;
  const industryCount = documents.filter((doc) => doc.sourceType === "industry").length;
  reasons.push(`本次样本中抓到政策 ${policyCount} 篇、产业材料 ${industryCount} 篇、招采/比选 ${biddingCount} 篇。`);
  reasons.push("商业闭环成立的关键不是‘有多少信息’，而是能否把政策导向、项目预算、主体画像、交付能力映射到同一张供需图谱。");
  reasons.push("你说的‘连连看’是对的，但必须先把线索标准化成结构化字段，否则后续匹配、推荐、收费都会失真。");
  return reasons;
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push(`# ${payload.meta.county}县域商机情报报告`);
  lines.push("");
  lines.push(`- 生成时间: ${payload.meta.generatedAt}`);
  lines.push(`- 地区: ${payload.meta.province}${payload.meta.city}${payload.meta.county}`);
  lines.push(`- 样本来源数: ${payload.meta.documentCount}`);
  lines.push("");
  lines.push("## 判断");
  for (const item of payload.assessment) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("## 机会图谱");
  for (const item of payload.opportunityGraph) {
    lines.push(`### ${item.label}（命中 ${item.score}）`);
    lines.push(`- 可承接服务: ${item.services.join("、")}`);
    for (const evidence of item.evidence) {
      const dateText = evidence.date ? `${evidence.date} ` : "";
      lines.push(`- 证据: ${dateText}[${evidence.title}](${evidence.url})`);
      if (evidence.snippet) lines.push(`- 摘要: ${evidence.snippet}`);
    }
    lines.push("");
  }

  lines.push("## 政策与产业信号");
  for (const doc of payload.documents.filter((item) => item.sourceType !== "bidding")) {
    lines.push(`### ${doc.title}`);
    lines.push(`- 类型: ${doc.sourceType}`);
    if (doc.date) lines.push(`- 日期: ${doc.date}`);
    lines.push(`- 链接: ${doc.url}`);
    if (doc.money.length > 0) lines.push(`- 金额线索: ${doc.money.join("、")}`);
    for (const point of doc.keyPoints.slice(0, 5)) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  lines.push("## 招采信号");
  for (const doc of payload.documents.filter((item) => item.sourceType === "bidding")) {
    lines.push(`### ${doc.title}`);
    if (doc.date) lines.push(`- 日期: ${doc.date}`);
    lines.push(`- 链接: ${doc.url}`);
    if (doc.money.length > 0) lines.push(`- 金额线索: ${doc.money.join("、")}`);
    for (const point of doc.keyPoints.slice(0, 5)) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  lines.push("## 搜索发现");
  for (const bundle of payload.searchSignals) {
    lines.push(`### ${bundle.query}`);
    if (!bundle.enabled) {
      lines.push("- 未执行：未配置 `SEARCH_API_URL` / `SEARCH_API_KEY`。");
      lines.push("");
      continue;
    }
    if (bundle.error) {
      lines.push(`- 错误: ${bundle.error}`);
      lines.push("");
      continue;
    }
    for (const result of bundle.results) {
      lines.push(`- ${result.date || "无日期"} [${result.title}](${result.url})`);
      if (result.snippet) lines.push(`- 摘要: ${result.snippet}`);
    }
    lines.push("");
  }

  lines.push("## 企业画像");
  for (const bundle of payload.companySignals) {
    lines.push(`### ${bundle.keyword}`);
    if (!bundle.enabled) {
      lines.push("- 未执行：未配置 `TIANYANCHA_SEARCH_URL` / `TIANYANCHA_TOKEN`。");
      lines.push("");
      continue;
    }
    if (bundle.error) {
      lines.push(`- 错误: ${bundle.error}`);
      lines.push("");
      continue;
    }
    for (const item of bundle.items) {
      lines.push(`- ${item.name}｜${item.regStatus || "未知状态"}｜${item.base || "未知地区"}｜${item.regCapital || "未知注册资本"}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function renderOpportunityPoolMarkdown(payload) {
  const lines = [];
  lines.push(`# ${payload.meta.county}${payload.meta.targetYear}商机池`);
  lines.push("");
  lines.push(`- 生成时间: ${payload.meta.generatedAt}`);
  lines.push(`- 地区: ${payload.meta.province}${payload.meta.city}${payload.meta.county}`);
  lines.push(`- 目标年份: ${payload.meta.targetYear}`);
  lines.push(`- 商机条数: ${payload.meta.opportunityCount}`);
  lines.push(`- 甲方主体数: ${payload.meta.leadCount}`);
  lines.push("");

  lines.push("## 可跟进主体");
  for (const lead of payload.leads) {
    lines.push(`### ${lead.targetOrg}`);
    lines.push(`- 主体评分: ${lead.leadScore}`);
    if (lead.latestDate) lines.push(`- 最近日期: ${lead.latestDate}`);
    lines.push(`- 机会条数: ${lead.opportunityCount}`);
    if (lead.sourceTypes.length > 0) lines.push(`- 类型: ${lead.sourceTypes.join("、")}`);
    if (lead.money.length > 0) lines.push(`- 金额线索: ${lead.money.join("、")}`);
    for (const title of lead.sampleTitles) {
      lines.push(`- 样本: ${title}`);
    }
    lines.push("");
  }
  lines.push("");

  for (const doc of payload.opportunities) {
    lines.push(`## ${doc.title}`);
    lines.push(`- 评分: ${doc.opportunityScore}`);
    lines.push(`- 类型: ${doc.sourceType}`);
    if (doc.date) lines.push(`- 日期: ${doc.date}`);
    lines.push(`- 来源域名: ${doc.host || "未知"}`);
    lines.push(`- 官方来源: ${doc.official ? "是" : "否"}`);
    lines.push(`- 链接: ${doc.url}`);
    if (doc.money.length > 0) lines.push(`- 金额线索: ${doc.money.join("、")}`);
    if (doc.tags.length > 0) lines.push(`- 匹配方向: ${doc.tags.join("、")}`);
    if (doc.targetOrgs.length > 0) lines.push(`- 甲方主体: ${doc.targetOrgs.join("、")}`);
    for (const point of doc.keyPoints.slice(0, 4)) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderOpportunityPoolHtml(payload) {
  const leadRows = payload.leads
    .map((lead) => `
      <tr>
        <td>${escapeHtml(lead.targetOrg)}</td>
        <td>${lead.leadScore}</td>
        <td>${escapeHtml(lead.latestDate || "")}</td>
        <td>${lead.opportunityCount}</td>
        <td>${escapeHtml(lead.sourceTypes.join("、"))}</td>
        <td>${escapeHtml(lead.money.join("、"))}</td>
        <td>${escapeHtml(lead.sampleTitles.join(" | "))}</td>
      </tr>`)
    .join("\n");

  const rows = payload.opportunities
    .map((doc) => {
      const money = doc.money.length > 0 ? doc.money.join("、") : "";
      const tags = doc.tags.length > 0 ? doc.tags.join("、") : "";
      const targets = doc.targetOrgs.length > 0 ? doc.targetOrgs.join("、") : "";
      const summary = escapeHtml(doc.keyPoints[0] || doc.summary || "");
      return `
        <tr>
          <td>${escapeHtml(doc.date || "")}</td>
          <td>${doc.opportunityScore}</td>
          <td>${escapeHtml(doc.sourceType)}</td>
          <td>${escapeHtml(doc.host || "")}</td>
          <td><a href="${escapeHtml(doc.url)}" target="_blank" rel="noreferrer">${escapeHtml(doc.title)}</a></td>
          <td>${escapeHtml(money)}</td>
          <td>${escapeHtml(tags)}</td>
          <td>${escapeHtml(targets)}</td>
          <td>${summary}</td>
        </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(payload.meta.county)}${escapeHtml(payload.meta.targetYear)}商机池</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 24px; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1f2937; background: #f8fafc; }
    h1 { margin: 0 0 12px; font-size: 28px; }
    .meta { margin-bottom: 20px; color: #475569; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { border: 1px solid #cbd5e1; padding: 10px; vertical-align: top; text-align: left; font-size: 13px; }
    th { background: #e2e8f0; }
    a { color: #0f766e; text-decoration: none; }
  </style>
</head>
<body>
  <h1>${escapeHtml(payload.meta.county)}${escapeHtml(payload.meta.targetYear)}商机池</h1>
  <div class="meta">
    生成时间：${escapeHtml(payload.meta.generatedAt)}<br />
    地区：${escapeHtml(payload.meta.province)}${escapeHtml(payload.meta.city)}${escapeHtml(payload.meta.county)}<br />
    商机条数：${payload.meta.opportunityCount}<br />
    甲方主体数：${payload.meta.leadCount}
  </div>
  <h2>可跟进主体</h2>
  <table>
    <thead>
      <tr>
        <th>主体</th>
        <th>评分</th>
        <th>最近日期</th>
        <th>机会数</th>
        <th>类型</th>
        <th>金额线索</th>
        <th>样本标题</th>
      </tr>
    </thead>
    <tbody>${leadRows}</tbody>
  </table>
  <h2>商机明细</h2>
  <table>
    <thead>
      <tr>
        <th>日期</th>
        <th>评分</th>
        <th>类型</th>
        <th>来源</th>
        <th>标题</th>
        <th>金额线索</th>
        <th>匹配方向</th>
        <th>甲方主体</th>
        <th>摘要</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}

function renderFollowupMarkdown(payload) {
  const lines = [];
  lines.push(`# ${payload.meta.county}${payload.meta.targetYear}甲方跟进清单`);
  lines.push("");
  lines.push(`- 生成时间: ${payload.meta.generatedAt}`);
  lines.push(`- 地区: ${payload.meta.province}${payload.meta.city}${payload.meta.county}`);
  lines.push(`- 主体数: ${payload.meta.followupCount}`);
  lines.push("");

  for (const item of payload.followups) {
    lines.push(`## ${item.targetOrg}`);
    lines.push(`- 优先级: ${item.urgency}`);
    lines.push(`- 主体评分: ${item.leadScore}`);
    if (item.latestDate) lines.push(`- 最近日期: ${item.latestDate}`);
    lines.push(`- 机会条数: ${item.opportunityCount}`);
    if (item.sourceTypes.length > 0) lines.push(`- 类型: ${item.sourceTypes.join("、")}`);
    if (item.money.length > 0) lines.push(`- 金额线索: ${item.money.join("、")}`);
    lines.push(`- 可卖服务: ${item.serviceFits.join("、")}`);
    lines.push(`- 跟进建议: ${item.outreach}`);
    for (const title of item.sampleTitles) {
      lines.push(`- 样本项目: ${title}`);
    }
    for (const url of item.sampleUrls) {
      lines.push(`- 链接: ${url}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function renderFollowupHtml(payload) {
  const rows = payload.followups
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.targetOrg)}</td>
        <td>${escapeHtml(item.urgency)}</td>
        <td>${item.leadScore}</td>
        <td>${escapeHtml(item.latestDate || "")}</td>
        <td>${item.opportunityCount}</td>
        <td>${escapeHtml(item.serviceFits.join("、"))}</td>
        <td>${escapeHtml(item.outreach)}</td>
        <td>${escapeHtml(item.sampleTitles.join(" | "))}</td>
      </tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(payload.meta.county)}${escapeHtml(payload.meta.targetYear)}甲方跟进清单</title>
  <style>
    body { margin: 24px; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1f2937; background: #f8fafc; }
    h1 { margin: 0 0 12px; font-size: 28px; }
    .meta { margin-bottom: 20px; color: #475569; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { border: 1px solid #cbd5e1; padding: 10px; vertical-align: top; text-align: left; font-size: 13px; }
    th { background: #e2e8f0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(payload.meta.county)}${escapeHtml(payload.meta.targetYear)}甲方跟进清单</h1>
  <div class="meta">
    生成时间：${escapeHtml(payload.meta.generatedAt)}<br />
    地区：${escapeHtml(payload.meta.province)}${escapeHtml(payload.meta.city)}${escapeHtml(payload.meta.county)}<br />
    主体数：${payload.meta.followupCount}
  </div>
  <table>
    <thead>
      <tr>
        <th>主体</th>
        <th>优先级</th>
        <th>评分</th>
        <th>最近日期</th>
        <th>机会数</th>
        <th>可卖服务</th>
        <th>跟进建议</th>
        <th>样本项目</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const preset = await ensurePreset(args);
  const searchDocumentBudget = Math.max(8, Number.parseInt(process.env.SEARCH_DOC_QUERY_BUDGET || String(args.limit * 3), 10) || (args.limit * 3));
  const searchSignalBudget = Math.max(6, Number.parseInt(process.env.SEARCH_SIGNAL_QUERY_BUDGET || String(args.limit * 2), 10) || (args.limit * 2));

  const documents = [];
  for (const url of preset.policyUrls) {
    documents.push(await collectDocument(url, "policy", preset.county));
  }
  for (const url of preset.industryUrls) {
    documents.push(await collectDocument(url, "industry", preset.county));
  }
  for (const url of preset.biddingUrls) {
    documents.push(await collectDocument(url, "bidding", preset.county));
  }

  const expandedDocuments = await collectSearchDocuments(
    (preset.searchDocumentQueries || []).slice(0, searchDocumentBudget),
    preset.county,
    Math.max(args.limit, 8),
  );

  const mergedDocuments = dedupeDocuments([...documents, ...expandedDocuments]);

  const opportunityGraph = buildOpportunityGraph(mergedDocuments);
  const opportunityPool = buildOpportunityPool(mergedDocuments, "2026");
  const leads = buildLeadList(opportunityPool);
  const followups = buildFollowupList(leads);
  const searchSignals = await collectSearchSignals((preset.searchQueries || []).slice(0, searchSignalBudget), args.limit, preset.county);
  const companySignals = await collectCompanySignals(preset.companyKeywords);

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      county: preset.county,
      city: preset.city,
      province: preset.province,
      documentCount: mergedDocuments.length,
      seedDocumentCount: documents.length,
      expandedDocumentCount: expandedDocuments.length,
      preset: args.preset,
    },
    assessment: buildAssessment(opportunityGraph, mergedDocuments),
    documents: mergedDocuments,
    opportunityPool,
    opportunityGraph,
    searchSignals,
    companySignals,
  };

  await fs.mkdir(args.outputDir, { recursive: true });
  const baseName = `${toSlug(preset.county)}-county-intel-${new Date().toISOString().slice(0, 10)}`;
  const jsonPath = path.join(args.outputDir, `${baseName}.json`);
  const mdPath = path.join(args.outputDir, `${baseName}.md`);
  const opportunityBaseName = `${preset.county}-2026商机池-${new Date().toISOString().slice(0, 10)}`;
  const opportunityJsonPath = path.join(args.outputDir, `${opportunityBaseName}.json`);
  const opportunityMdPath = path.join(args.outputDir, `${opportunityBaseName}.md`);
  const opportunityHtmlPath = path.join(args.outputDir, `${opportunityBaseName}.html`);
  const followupBaseName = `${preset.county}-2026甲方跟进清单-${new Date().toISOString().slice(0, 10)}`;
  const followupJsonPath = path.join(args.outputDir, `${followupBaseName}.json`);
  const followupMdPath = path.join(args.outputDir, `${followupBaseName}.md`);
  const followupHtmlPath = path.join(args.outputDir, `${followupBaseName}.html`);

  const opportunityPayload = {
    meta: {
      generatedAt: new Date().toISOString(),
      county: preset.county,
      city: preset.city,
      province: preset.province,
      targetYear: "2026",
      opportunityCount: opportunityPool.length,
      leadCount: leads.length,
    },
    opportunities: opportunityPool,
    leads,
  };
  const followupPayload = {
    meta: {
      generatedAt: new Date().toISOString(),
      county: preset.county,
      city: preset.city,
      province: preset.province,
      targetYear: "2026",
      followupCount: followups.length,
    },
    followups,
  };

  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(payload), "utf8");
  await fs.writeFile(opportunityJsonPath, `${JSON.stringify(opportunityPayload, null, 2)}\n`, "utf8");
  await fs.writeFile(opportunityMdPath, renderOpportunityPoolMarkdown(opportunityPayload), "utf8");
  await fs.writeFile(opportunityHtmlPath, renderOpportunityPoolHtml(opportunityPayload), "utf8");
  await fs.writeFile(followupJsonPath, `${JSON.stringify(followupPayload, null, 2)}\n`, "utf8");
  await fs.writeFile(followupMdPath, renderFollowupMarkdown(followupPayload), "utf8");
  await fs.writeFile(followupHtmlPath, renderFollowupHtml(followupPayload), "utf8");

  console.log(JSON.stringify({
    ok: true,
    county: preset.county,
    jsonPath,
    mdPath,
    opportunityJsonPath,
    opportunityMdPath,
    opportunityHtmlPath,
    followupJsonPath,
    followupMdPath,
    followupHtmlPath,
    documentCount: mergedDocuments.length,
    opportunityCount: opportunityPool.length,
    followupCount: followups.length,
    topOpportunities: opportunityGraph.slice(0, 3).map((item) => item.label),
  }, null, 2));
}

main().catch((error) => {
  console.error("[collect-county-intel] failed:", error);
  process.exitCode = 1;
});
