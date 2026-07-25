import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { publishFileExclusive } from "../dist/publish-file.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../dist/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
} from "../dist/native.js";

const require = createRequire(import.meta.url);
const native = require("../native");
const sizes = [
  { label: "4 KiB", bytes: 4 * 1024, iterations: 7 },
  { label: "1 MiB", bytes: 1024 * 1024, iterations: 5 },
  { label: "64 MiB", bytes: 64 * 1024 * 1024, iterations: 2 },
];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-bench-publish-"));
const originalLink = fs.link;
const rows = [];

try {
  for (const fixture of sizes) {
    const sourcePath = path.join(root, `source-${fixture.bytes}`);
    const source = await fs.open(sourcePath, "w", 0o600);
    try {
      await source.truncate(fixture.bytes);
      if (fixture.bytes > 0) {
        await source.write(Buffer.from([0x5a]), 0, 1, fixture.bytes - 1);
      }
      await source.sync();
    } finally {
      await source.close();
    }

    for (const mode of ["javascript", "native"]) {
      __resetFsSafeNativeConfigForTest();
      __resetNativeLoaderForTest();
      if (mode === "javascript") {
        configureFsSafeNative({ mode: "off" });
        fs.link = async () => {
          throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EXDEV" });
        };
      } else {
        fs.link = originalLink;
        __setNativeLoaderForTest(() => ({
          ...native,
          linkBeneath() {
            throw Object.assign(new Error("benchmark forces copy fallback"), { code: "EXDEV" });
          },
        }));
        configureFsSafeNative({ mode: "require" });
      }

      const samples = [];
      for (let iteration = 0; iteration < fixture.iterations; iteration += 1) {
        const targetPath = path.join(root, `target-${mode}-${fixture.bytes}-${iteration}`);
        const started = performance.now();
        const result = await publishFileExclusive({
          sourcePath,
          targetPath,
          strategy: "link-or-copy",
        });
        samples.push(performance.now() - started);
        if (result.method !== "exclusive-copy") {
          throw new Error(`unexpected publication method: ${result.method}`);
        }
        const stat = await fs.stat(targetPath);
        if (stat.size !== fixture.bytes) throw new Error("benchmark publication size mismatch");
        await fs.rm(targetPath);
      }
      samples.sort((a, b) => a - b);
      const medianMs = samples[Math.floor(samples.length / 2)];
      rows.push({
        size: fixture.label,
        mode,
        medianMs: Number(medianMs.toFixed(2)),
        throughputMiBs: Number(
          ((fixture.bytes / (1024 * 1024)) / (medianMs / 1000)).toFixed(1),
        ),
      });
    }
  }
} finally {
  fs.link = originalLink;
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  await fs.rm(root, { recursive: true, force: true });
}

console.log(`publish benchmark (${process.platform}-${process.arch}, Node ${process.version})`);
console.log("| Size | Path | Median ms | MiB/s |");
console.log("|---:|:---|---:|---:|");
for (const row of rows) {
  console.log(`| ${row.size} | ${row.mode} | ${row.medianMs.toFixed(2)} | ${row.throughputMiBs.toFixed(1)} |`);
}
console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, rows }));
