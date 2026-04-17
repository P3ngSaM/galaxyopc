#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = {
    maps: [],
    outputPath: path.resolve(process.cwd(), "research", "southwest-opportunity-map.json"),
    scopeName: "云贵川产业机会地图",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--map" && next) {
      args.maps.push(path.resolve(process.cwd(), next));
      i += 1;
    } else if (token === "--output" && next) {
      args.outputPath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--scope-name" && next) {
      args.scopeName = next.trim();
      i += 1;
    }
  }
  if (!args.maps.length) throw new Error("至少传入一个 --map");
  return args;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function dedupeBy(items, pick) {
  const map = new Map();
  for (const item of items) {
    const key = pick(item);
    if (!key || map.has(key)) continue;
    map.set(key, item);
  }
  return [...map.values()];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloads = [];
  for (const filePath of args.maps) {
    payloads.push(await readJson(filePath));
  }

  const industries = dedupeBy(payloads.flatMap((p) => p.industries || []), (item) => `${item.city || ""}::${item.county || ""}::${item.type || ""}::${item.title || item.name || ""}`);
  const opportunities = dedupeBy(
    payloads.flatMap((p) => p.opportunities || []),
    (item) => `${item.city || ""}::${item.county || ""}::${item.targetOrg || ""}::${item.sourceUrl || item.title || item.name || ""}`,
  )
    .sort((a, b) => Number(b.priorityScore || b.score || 0) - Number(a.priorityScore || a.score || 0));

  const centers = payloads
    .map((p) => ({
      lng: Number(p.meta?.centerLongitude || 0),
      lat: Number(p.meta?.centerLatitude || 0),
    }))
    .filter((v) => Number.isFinite(v.lng) && Number.isFinite(v.lat) && v.lng && v.lat);
  const centerLongitude = centers.length ? centers.reduce((sum, v) => sum + v.lng, 0) / centers.length : 103.5;
  const centerLatitude = centers.length ? centers.reduce((sum, v) => sum + v.lat, 0) / centers.length : 27.6;

  const meta = {
    province: "云贵川",
    scopeName: args.scopeName,
    scopeType: "multi-province",
    updatedAt: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    centerAddress: "中国西南地区",
    centerLongitude: Number(centerLongitude.toFixed(6)),
    centerLatitude: Number(centerLatitude.toFixed(6)),
    rawDocumentCount: payloads.reduce((sum, p) => sum + Number(p.meta?.rawDocumentCount || 0), 0),
    opportunityPoolCount: payloads.reduce((sum, p) => sum + Number(p.meta?.opportunityPoolCount || 0), 0),
    rawOpportunityPoolCount: payloads.reduce((sum, p) => sum + Number(p.meta?.rawOpportunityPoolCount || p.meta?.opportunityPoolCount || 0), 0),
    mappedIndustryCount: industries.length,
    mappedOpportunityCount: opportunities.length,
    cityCount: new Set(industries.map((item) => item.city).filter(Boolean)).size,
    countyCount: new Set(industries.map((item) => `${item.city}::${item.county}`).filter(Boolean)).size,
    provinces: payloads.map((p) => ({
      province: p.meta?.province || "",
      rawDocumentCount: Number(p.meta?.rawDocumentCount || 0),
      opportunityPoolCount: Number(p.meta?.opportunityPoolCount || 0),
      mappedOpportunityCount: Number((p.opportunities || []).length),
    })),
    description: "汇总四川、云南、贵州三省区县产业与商机线索，用于一张地图统一筛选、指派和推进。",
  };

  const output = { meta, industries, opportunities };
  await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
  await fs.writeFile(args.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    outputPath: args.outputPath,
    industryCount: industries.length,
    opportunityCount: opportunities.length,
    cityCount: meta.cityCount,
    countyCount: meta.countyCount,
  }, null, 2));
}

main().catch((error) => {
  console.error("[build-southwest-opportunity-map] failed:", error);
  process.exitCode = 1;
});
