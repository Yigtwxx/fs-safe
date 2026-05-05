#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync("node_modules/typescript/bin/tsc")) {
  run("pnpm", ["install", "--prod=false", "--ignore-scripts", "--frozen-lockfile=false"]);
}

run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"]);
