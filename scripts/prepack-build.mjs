#!/usr/bin/env node
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolveTypeScriptCompiler() {
  try {
    return require.resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

let tscBin = resolveTypeScriptCompiler();

if (!tscBin || !existsSync(tscBin)) {
  throw new Error("TypeScript compiler is unavailable; run pnpm install before packing");
}

rmSync("dist", { recursive: true, force: true });
run(process.execPath, [tscBin, "-p", "tsconfig.json"]);
