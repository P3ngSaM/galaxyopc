#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";

function parseArgs(argv) {
  const args = {
    limit: 6,
    delayMs: 800,
    maxTargets: 0,
    skipSichuan: false,
    skipYunnan: false,
    skipGuizhou: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--limit" && next) {
      args.limit = Math.max(1, Number.parseInt(next, 10) || 6);
      i += 1;
    } else if (token === "--delay-ms" && next) {
      args.delayMs = Math.max(0, Number.parseInt(next, 10) || 800);
      i += 1;
    } else if (token === "--max-targets" && next) {
      args.maxTargets = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (token === "--skip-sichuan") {
      args.skipSichuan = true;
    } else if (token === "--skip-yunnan") {
      args.skipYunnan = true;
    } else if (token === "--skip-guizhou") {
      args.skipGuizhou = true;
    }
  }
  return args;
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
  const provinces = [
    { province: "四川省", centerAddress: "四川省成都市", slug: "sichuan", skip: args.skipSichuan },
    { province: "云南省", centerAddress: "云南省昆明市", slug: "yunnan", skip: args.skipYunnan },
    { province: "贵州省", centerAddress: "贵州省贵阳市", slug: "guizhou", skip: args.skipGuizhou },
  ].filter((item) => !item.skip);

  const results = [];
  for (const item of provinces) {
    results.push(await runNodeScript("run-province-intel-pipeline.mjs", [
      "--province", item.province,
      "--center-address", item.centerAddress,
      "--targets", path.join("research", `${item.slug}-targets.json`),
      "--output-dir", path.join("research", item.slug),
      "--limit", String(args.limit),
      "--delay-ms", String(args.delayMs),
      ...(args.maxTargets > 0 ? ["--max-targets", String(args.maxTargets)] : []),
    ]));
  }

  const southwestMap = await runNodeScript("build-southwest-opportunity-map.mjs", [
    "--map", path.join("research", "sichuan-opportunity-map.json"),
    "--map", path.join("research", "yunnan-opportunity-map.json"),
    "--map", path.join("research", "guizhou-opportunity-map.json"),
    "--output", path.join("research", "southwest-opportunity-map.json"),
  ]);

  console.log(JSON.stringify({
    ok: true,
    results,
    southwestMap,
  }, null, 2));
}

main().catch((error) => {
  console.error("[run-southwest-intel-pipeline] failed:", error);
  process.exitCode = 1;
});
