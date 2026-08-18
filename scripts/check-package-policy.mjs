#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(process.argv[2] ?? "package.json");
const lockPath = resolve(process.argv[3] ?? "package-lock.json");

function fail(message) {
  console.error(`Package policy check failed: ${message}`);
  process.exitCode = 1;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function packageName(packagePath) {
  return packagePath.split("node_modules/").at(-1);
}

const manifest = readJson(manifestPath);
const lock = readJson(lockPath);
if (manifest && lock?.packages && typeof lock.packages === "object") {
  const approvedScripts = new Set(Object.entries(manifest.allowScripts ?? {})
    .filter(([, approved]) => approved === true)
    .map(([identity]) => identity));
  const installScripts = new Set(Object.entries(lock.packages)
    .filter(([packagePath, metadata]) => packagePath !== "" && metadata?.hasInstallScript === true)
    .map(([packagePath, metadata]) => `${packageName(packagePath)}@${metadata.version}`));
  const missingApprovals = [...installScripts].filter((identity) => !approvedScripts.has(identity));
  const staleApprovals = [...approvedScripts].filter((identity) => !installScripts.has(identity));
  if (missingApprovals.length > 0) fail(`install scripts lack explicit approval: ${missingApprovals.sort().join(", ")}`);
  if (staleApprovals.length > 0) fail(`allowScripts contains stale or mismatched approvals: ${staleApprovals.sort().join(", ")}`);

  const dshDependencies = Object.entries(manifest.dependencies ?? {})
    .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"));
  const floatingDsh = dshDependencies.filter(([, version]) => !/^\d+\.\d+\.\d+-rc\.\d+$/.test(String(version)));
  if (floatingDsh.length > 0) fail(`DSH preview dependencies must use exact RC versions: ${floatingDsh.map(([name]) => name).join(", ")}`);
  const lockMismatches = dshDependencies.filter(([name, version]) => lock.packages[`node_modules/${name}`]?.version !== version);
  if (lockMismatches.length > 0) fail(`DSH manifest/lock versions differ: ${lockMismatches.map(([name]) => name).join(", ")}`);

  if (process.exitCode !== 1) {
    console.log(`Package policy passed: ${installScripts.size} approved install scripts; ${dshDependencies.length} exact DSH RC pins`);
  }
}
