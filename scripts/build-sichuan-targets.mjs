#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const CITY_DATA_PATH = path.resolve(process.cwd(), "ChinaCitys.json");
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), "research", "sichuan-targets.json");

function parseArgs(argv) {
  const args = {
    outputPath: DEFAULT_OUTPUT_PATH,
    city: "",
    limit: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--output" && next) {
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
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(CITY_DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  const sichuan = data.find((item) => item.province === "四川省");
  if (!sichuan) throw new Error("未找到四川省行政区划数据");

  const targets = [];
  for (const cityItem of sichuan.citys || []) {
    const city = String(cityItem.city || "").trim();
    if (args.city && city !== args.city) continue;
    const areas = Array.isArray(cityItem.areas) ? cityItem.areas : [];
    for (const areaItem of areas) {
      const county = String(areaItem.area || "").trim();
      if (!county) continue;
      targets.push({
        province: "四川省",
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
      province: "四川省",
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
  console.error("[build-sichuan-targets] failed:", error);
  process.exitCode = 1;
});
