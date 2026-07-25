import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const packageIndex = process.argv.indexOf("--package");
const artifactsIndex = process.argv.indexOf("--artifacts");
const packageName = packageIndex >= 0 ? process.argv[packageIndex + 1] : undefined;
const artifactsDir = resolve(artifactsIndex >= 0 ? process.argv[artifactsIndex + 1] : "release-artifacts");
if (!packageName) throw new Error("--package is required");

const manifest = JSON.parse(readFileSync(join(artifactsDir, "manifest.json"), "utf8"));
const artifact = manifest.find((entry) => entry.name === packageName);
if (!artifact) throw new Error(`release manifest has no entry for ${packageName}`);
const spec = `${artifact.name}@${artifact.version}`;

function registryState() {
  try {
    const raw = execFileSync("npm", ["view", spec, "dist", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dist = JSON.parse(raw);
    if (dist.integrity !== artifact.integrity) {
      throw new Error(`${spec} exists with different package bytes`);
    }
    if (!dist.attestations?.url) {
      throw new Error(`${spec} exists without npm provenance`);
    }
    return "verified";
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("E404")) return "missing";
    throw error;
  }
}

if (registryState() === "verified") {
  console.log(`verified ${spec} integrity and provenance`);
  process.exit(0);
}

const published = spawnSync(
  "npm",
  ["publish", join(artifactsDir, artifact.filename), "--access", "public", "--provenance"],
  { stdio: "inherit" },
);
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    if (registryState() === "verified") {
      console.log(`verified ${spec} integrity and provenance`);
      process.exit(0);
    }
  } catch (error) {
    if (attempt === 12) throw error;
  }
  console.log(`registry verification attempt ${attempt}/12 has not confirmed ${spec}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
}
throw new Error(`npm publish exited ${published.status}; registry never confirmed ${spec}`);
