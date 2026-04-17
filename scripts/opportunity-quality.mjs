function textOf(doc) {
  return `${doc.title || ""}\n${doc.summary || ""}\n${doc.text || ""}`.replace(/\s+/g, " ").trim();
}

function hasMoneyHint(doc) {
  return Array.isArray(doc.money) && doc.money.length > 0;
}

function hasTargetOrg(doc) {
  return Array.isArray(doc.targetOrgs) && doc.targetOrgs.length > 0;
}

const STRONG_INTENT_PATTERN = /招标|采购|中标|成交|比选|遴选|磋商|询价|竞谈|项目|立项|可研|勘察|设计|施工|监理|总承包|EPC|预算金额|投资估算|合同估算价|补助资金|资金分配|专项资金|服务主体|实施主体|项目业主|采购人|招标人|招商引资|招商推介|签约|开工|竣工|实施方案/;
const PROCUREMENT_PATTERN = /招标|采购|中标|成交|比选|遴选|磋商|询价|竞谈|施工|监理|设计|总承包|EPC/;
const COMMERCIAL_INTENT_PATTERN = /招标|采购|中标|成交|比选|遴选|磋商|询价|竞谈|施工|监理|设计|总承包|EPC|项目库|项目清单|项目计划|实施方案|建设项目|招商引资|招商推介|签约|拍卖公告|采砂权|衔接推进乡村振兴补助资金|资金分配方案|项目安排|医共体建设|整县推进/;
const GENERIC_NOISE_TITLE_PATTERNS = [
  /^政府信息公开$/,
  /^信息公开指南$/,
  /^信息公开制度$/,
  /^法定主动公开内容$/,
  /^财政预决算$/,
  /^财政预决算公开目录$/,
  /^通知公告$/,
  /^公示公告$/,
  /^政务公开$/,
  /^政务服务$/,
  /^办事指南$/,
  /^门户网站$/,
  /人民政府$/,
  /人民政府_通知公告$/,
  /通知公告$/,
  /公示公告$/,
  /窗口$/,
  /门户网站$/,
  /政府信息公开/,
  /信息公开目录/,
  /公开专栏/,
];
const LOW_VALUE_TITLE_PATTERNS = [
  /雨露计划/,
  /补贴发放公示/,
  /生活补助费公示/,
  /基本生活补贴发放公示/,
  /春季强制免疫/,
  /代表风采/,
  /一周动态/,
  /工作综述/,
  /会议隆重开幕/,
  /预算执行情况.*预算草案/,
  /预算草案公开目录/,
  /基金收支情况公示/,
  /行政许可公示/,
  /规划许可证批前公示/,
];
const GENERIC_NOISE_URL_PATTERNS = [
  /\/Rss\//i,
  /\/catalog\//i,
  /\/col\/col\d+\/index\.html/i,
  /\/index(?:_\d+)?\.html?$/i,
  /\/zfxxgk(?:\/|$)/i,
  /\/xxgk(?:\/|$)/i,
  /\/channel\//i,
];

export function isHighIntentOpportunity(doc) {
  const haystack = textOf(doc);
  const hasEvidence = hasMoneyHint(doc) || hasTargetOrg(doc) || /项目|资金|签约|招商/.test(haystack);
  return PROCUREMENT_PATTERN.test(haystack) && hasEvidence;
}

export function shouldKeepOpportunity(doc) {
  const title = String(doc.title || "").trim();
  const url = String(doc.url || "").trim();
  const haystack = textOf(doc);
  const titleIntent = STRONG_INTENT_PATTERN.test(title);
  const titleCommercialIntent = COMMERCIAL_INTENT_PATTERN.test(title);
  const strongIntent = STRONG_INTENT_PATTERN.test(haystack);
  const evidence = hasMoneyHint(doc) || hasTargetOrg(doc);
  const genericTitle = GENERIC_NOISE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const genericUrl = GENERIC_NOISE_URL_PATTERNS.some((pattern) => pattern.test(url));
  const commercialIntent = COMMERCIAL_INTENT_PATTERN.test(title) || COMMERCIAL_INTENT_PATTERN.test(haystack);
  const lowValueTitle = LOW_VALUE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const policyProjectIntent = /政府工作报告|预算执行情况|预算报告|国民经济和社会发展计划|营商环境|经营主体培育|融资难|风险补偿基金|项目库建设|前期工作经费/.test(title)
    || /政府工作报告|预算执行情况|预算报告|国民经济和社会发展计划|营商环境|经营主体培育|融资难|风险补偿基金|项目库建设|前期工作经费/.test(haystack);
  const strongPolicyEvidence = doc.sourceType === "policy"
    && (
      hasMoneyHint(doc)
      || hasTargetOrg(doc)
      || /项目库|项目建设|重点项目|招商引资|营商环境|经营主体|融资|风险补偿基金|前期工作经费|专项资金|资金分配/.test(haystack)
    );

  if (/^政府信息公开$/.test(title)) return false;
  if (/人民政府$/.test(title) && !titleIntent) return false;
  if (/(通知公告|公示公告|窗口|门户网站)$/.test(title) && !titleIntent) return false;
  if (/(政府信息公开|信息公开目录|公开专栏)/.test(title) && !titleIntent) return false;
  if (lowValueTitle && !titleCommercialIntent) return false;
  if (/补助资金/.test(title) && !/分配方案|项目安排|实施方案|项目库|项目计划/.test(title)) return false;
  if (/预算公开|预算公开说明|部门预算公开|政府工作报告/.test(title) && !policyProjectIntent && !strongPolicyEvidence) return false;
  if (/公示$/.test(title) && !commercialIntent && !hasTargetOrg(doc)) return false;
  if (strongIntent) return true;
  if (policyProjectIntent && strongPolicyEvidence) return true;
  if (!commercialIntent && !hasTargetOrg(doc)) return false;
  if (genericTitle && !evidence) return false;
  if (genericUrl && !evidence && !/招商|签约|项目/.test(haystack)) return false;
  return evidence || strongPolicyEvidence;
}

export function filterOpportunities(items) {
  return (items || []).filter((item) => shouldKeepOpportunity(item));
}
