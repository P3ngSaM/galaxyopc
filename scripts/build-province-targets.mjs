#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CITY_DATA_PATH = path.resolve(process.cwd(), "ChinaCitys.json");

function parseArgs(argv) {
  const args = {
    province: "",
    outputPath: "",
    city: "",
    limit: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--province" && next) {
      args.province = next.trim();
      i += 1;
    } else if (token === "--output" && next) {
      args.outputPath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--city" && next) {
      args.city = next.trim();
      i += 1;
    } else if (token === "--limit" && next) {
      args.limit = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    }
  }
  if (!args.province) throw new Error("缺少 --province");
  if (!args.outputPath) {
    const slug = String(args.province).replace(/省|市|自治区|回族|壮族|维吾尔|特别行政区/g, "").trim() || "province";
    args.outputPath = path.resolve(process.cwd(), "research", `${slug}-targets.json`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(CITY_DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  const provinceItem = data.find((item) => item.province === args.province);
  if (!provinceItem) throw new Error(`未找到 ${args.province} 行政区划数据`);

  const targets = [];
  for (const cityItem of provinceItem.citys || []) {
    const city = String(cityItem.city || "").trim();
    if (args.city && city !== args.city) continue;
    const areas = Array.isArray(cityItem.areas) ? cityItem.areas : [];
    for (const areaItem of areas) {
      const county = String(areaItem.area || "").trim();
      if (!county) continue;
      targets.push({
        province: args.province,
        city,
        county,
        areaCode: String(areaItem.code || ""),
        cityCode: String(cityItem.code || ""),
      });
    }
  }

  const sliced = args.limit > 0 ? targets.slice(0, args.limit) : targets;
  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      province: args.province,
      cityFilter: args.city || "",
      count: sliced.length,
    },
    targets: sliced,
  };

  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    outputPath: args.outputPath,
    count: sliced.length,
    first: sliced[0] || null,
  }, null, 2));
}

main().catch((error) => {
  console.error("[build-province-targets] failed:", error);
  process.exitCode = 1;
});
