import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { configureFsSafeNative, root } from "../dist/index.js";

const mode = process.argv[2];
if (!new Set(["auto", "require", "off"]).has(mode)) {
  throw new Error("usage: native-mode-smoke.mjs <auto|require|off>");
}
configureFsSafeNative({ mode });
if (mode !== "off") {
  const require = createRequire(import.meta.url);
  const binding = require("../native");
  if (typeof binding.openBeneath !== "function") throw new Error("native binding did not load");
} else {
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path.join(os.tmpdir(), "must-not-load.node");
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), `fs-safe-mode-${mode}-`));
try {
  const capability = await root(directory);
  await capability.create("value.txt", mode);
  const value = await capability.readText("value.txt");
  if (value !== mode) throw new Error("mode smoke content mismatch");
  console.log(JSON.stringify({ mode, bindingExpected: mode !== "off", result: "PASS" }));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
