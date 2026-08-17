#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const allowedLicenses = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);

const lockPath = resolve(process.argv[2] ?? "package-lock.json");

function fail(message) {
  console.error(`License policy check failed: ${message}`);
  process.exitCode = 1;
}

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (error) {
  fail(`cannot read ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
}

if (lock !== undefined) {
  if (lock.packages === null || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    fail(`${lockPath} does not contain an npm package-lock packages object`);
  } else {
    const violations = [];
    const counts = new Map();

    for (const [packagePath, metadata] of Object.entries(lock.packages)) {
      if (packagePath === "") continue;

      const packageName = packagePath.replace(/^node_modules\//, "");
      const license = typeof metadata.license === "string" ? metadata.license.trim() : "";

      if (license === "") {
        violations.push(`${packageName}@${metadata.version ?? "unknown"}: missing license metadata`);
        continue;
      }

      counts.set(license, (counts.get(license) ?? 0) + 1);
      if (!allowedLicenses.has(license)) {
        violations.push(`${packageName}@${metadata.version ?? "unknown"}: disallowed or unreviewed license ${license}`);
      }
    }

    if (violations.length > 0) {
      fail(violations.join("\n"));
      console.error(`Allowed SPDX identifiers: ${[...allowedLicenses].sort().join(", ")}`);
    } else {
      const summary = [...counts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([license, count]) => `${license}=${count}`)
        .join(", ");
      console.log(`License policy passed for ${[...counts.values()].reduce((sum, count) => sum + count, 0)} packages: ${summary}`);
    }
  }
}
