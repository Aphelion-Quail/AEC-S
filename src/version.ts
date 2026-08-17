import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type PackageMetadata = { version?: unknown };

export function aecSVersion(): string {
  const candidates = [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (!existsSync(path)) continue;
    const metadata = JSON.parse(readFileSync(path, "utf8")) as PackageMetadata;
    if (typeof metadata.version === "string" && metadata.version.length > 0) return metadata.version;
  }
  throw new Error("Unable to locate AEC-S package version");
}
