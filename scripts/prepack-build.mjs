#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tscBin = process.platform === "win32" ? "node_modules/.bin/tsc.cmd" : "node_modules/.bin/tsc";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(tscBin)) {
  run("pnpm", [
    "add",
    "--save-dev",
    "typescript@^5.8.3",
    "@types/node@^22.15.19",
    "--ignore-scripts",
    "--lockfile=false",
  ]);
}

run(tscBin, ["-p", "tsconfig.json"]);
