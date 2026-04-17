#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";

function parseArgs(argv) {
  const args = {
    province: "",
    centerAddress: "",
    city: "",
    outputDir: "",
    targetsPath: "",
    limit: 5,
    delayMs: 800,
    maxTargets: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--province" && next) {
      args.province = next.trim();
      i += 1;
    } else if (token === "--center-address" && next) {
      args.centerAddress = next.trim();
      i += 1;
    } else if (token === "--city" && next) {
      args.city = next.trim();
      i += 1;
    } else if (token === "--output-dir" && next) {
      args.outputDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--targets" && next) {
      args.targetsPath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--limit" && next) {
      args.limit = Math.max(1, Number.parseInt(next, 10) || 5);
      i += 1;
    } else if (token === "--delay-ms" && next) {
      args.delayMs = Math.max(0, Number.parseInt(next, 10) || 800);
      i += 1;
    } else if (token === "--max-targets" && next) {
      args.maxTargets = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    }
  }
  if (!args.province) throw new Error("缺少 --province");
  const slug = String(args.province).replace(/省|市|自治区|回族|壮族|维吾尔|特别行政区/g, "").trim() || "province";
  if (!args.outputDir) args.outputDir = path.resolve(process.cwd(), "research", slug);
  if (!args.targetsPath) args.targetsPath = path.resolve(process.cwd(), "research", `${slug}-targets.json`);
  if (!args.centerAddress) args.centerAddress = args.province;
  return { ...args, slug };
}

function runNodeScript(scriptName, args) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(process.cwd(), "scripts", scriptName);
    execFile(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      timeout: 24 * 60 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 16,
      windowsHide: true,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: true, raw: stdout });
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = new Date().toISOString().slice(0, 10);
  const aggregatePath = path.resolve(process.cwd(), "research", `${args.province}-产业与机会总览-${date}.json`);
  const mapPath = path.resolve(process.cwd(), "research", `${args.slug}-opportunity-map.json`);

  const results = {};
  results.targets = await runNodeScript("build-province-targets.mjs", [
    "--province", args.province,
    "--output", path.relative(process.cwd(), args.targetsPath),
    ...(args.city ? ["--city", args.city] : []),
    ...(args.maxTargets > 0 ? ["--limit", String(args.maxTargets)] : []),
  ]);
  results.collect = await runNodeScript("collect-province-intel.mjs", [
    "--targets", path.relative(process.cwd(), args.targetsPath),
    "--output-dir", path.relative(process.cwd(), args.outputDir),
    "--limit", String(args.limit),
    "--delay-ms", String(args.delayMs),
    ...(args.city ? ["--city", args.city] : []),
    ...(args.maxTargets > 0 ? ["--max-targets", String(args.maxTargets)] : []),
  ]);
  results.aggregate = await runNodeScript("aggregate-province-intel.mjs", [
    "--input-dir", path.relative(process.cwd(), args.outputDir),
    "--output-dir", "research",
    "--province", args.province,
  ]);
  results.map = await runNodeScript("build-province-opportunity-map.mjs", [
    "--input-dir", path.relative(process.cwd(), args.outputDir),
    "--aggregate", path.relative(process.cwd(), aggregatePath),
    "--province", args.province,
    "--center-address", args.centerAddress,
    "--output", path.relative(process.cwd(), mapPath),
  ]);

  console.log(JSON.stringify({
    ok: true,
    province: args.province,
    targetsPath: args.targetsPath,
    outputDir: args.outputDir,
    aggregatePath,
    mapPath,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error("[run-province-intel-pipeline] failed:", error);
  process.exitCode = 1;
});
