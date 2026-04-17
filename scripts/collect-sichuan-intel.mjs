#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";

const DEFAULT_TARGETS_PATH = path.resolve(process.cwd(), "research", "sichuan-targets.json");
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "research", "sichuan");

function parseArgs(argv) {
  const args = {
    targetsPath: DEFAULT_TARGETS_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    limit: 8,
    maxTargets: 0,
    city: "",
    countyIncludes: "",
    delayMs: 1200,
    resume: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--targets" && next) {
      args.targetsPath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--output-dir" && next) {
      args.outputDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (token === "--limit" && next) {
      args.limit = Math.max(1, Number.parseInt(next, 10) || 8);
      i += 1;
    } else if (token === "--max-targets" && next) {
      args.maxTargets = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (token === "--city" && next) {
      args.city = next.trim();
      i += 1;
    } else if (token === "--county-includes" && next) {
      args.countyIncludes = next.trim();
      i += 1;
    } else if (token === "--delay-ms" && next) {
      args.delayMs = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (token === "--no-resume") {
      args.resume = false;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCountyCollector({ province, city, county, outputDir, limit }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(process.cwd(), "scripts", "collect-county-intel.mjs");
    execFile(process.execPath, [
      scriptPath,
      "--province", province,
      "--city", city,
      "--county", county,
      "--output-dir", outputDir,
      "--limit", String(limit),
    ], {
      cwd: process.cwd(),
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8,
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
        reject(new Error(`无法解析采集输出: ${stdout}`));
      }
    });
  });
}

function toSafeDirName(city, county) {
  return `${city}-${county}`.replace(/[\\/:*?"<>|]/g, "-");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.targetsPath, "utf8");
  const payload = JSON.parse(raw.replace(/^\uFEFF/, ""));
  let targets = Array.isArray(payload.targets) ? payload.targets : [];

  if (args.city) targets = targets.filter((item) => item.city === args.city);
  if (args.countyIncludes) targets = targets.filter((item) => String(item.county || "").includes(args.countyIncludes));
  if (args.maxTargets > 0) targets = targets.slice(0, args.maxTargets);

  const manifest = {
    meta: {
      generatedAt: new Date().toISOString(),
      targetsPath: args.targetsPath,
      outputDir: args.outputDir,
      limit: args.limit,
      requestedCount: targets.length,
    },
    results: [],
  };

  await fs.mkdir(args.outputDir, { recursive: true });

  for (const target of targets) {
    const countyOutputDir = path.join(args.outputDir, toSafeDirName(target.city, target.county));
    const today = new Date().toISOString().slice(0, 10);
    const resumeFile = path.join(countyOutputDir, `${String(target.county).toLowerCase()}-county-intel-${today}.json`);
    if (args.resume && await exists(resumeFile)) {
      manifest.results.push({
        province: target.province,
        city: target.city,
        county: target.county,
        status: "skipped",
        reason: "resume-hit",
        outputDir: countyOutputDir,
      });
      continue;
    }

    try {
      await fs.mkdir(countyOutputDir, { recursive: true });
      const result = await runCountyCollector({
        province: target.province,
        city: target.city,
        county: target.county,
        outputDir: countyOutputDir,
        limit: args.limit,
      });
      manifest.results.push({
        province: target.province,
        city: target.city,
        county: target.county,
        status: "ok",
        outputDir: countyOutputDir,
        ...result,
      });
    } catch (error) {
      manifest.results.push({
        province: target.province,
        city: target.city,
        county: target.county,
        status: "error",
        outputDir: countyOutputDir,
        error: error.message || String(error),
      });
    }

    if (args.delayMs > 0) await sleep(args.delayMs);
  }

  const manifestPath = path.join(args.outputDir, `sichuan-intel-manifest-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    manifestPath,
    total: manifest.results.length,
    success: manifest.results.filter((item) => item.status === "ok").length,
    skipped: manifest.results.filter((item) => item.status === "skipped").length,
    failed: manifest.results.filter((item) => item.status === "error").length,
  }, null, 2));
}

main().catch((error) => {
  console.error("[collect-sichuan-intel] failed:", error);
  process.exitCode = 1;
});
