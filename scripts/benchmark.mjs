#!/usr/bin/env node
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_ITERATIONS = 1000;
const DEFAULT_SAMPLES = 1;
const DEFAULT_WARMUP = 25;
const BYTES_PER_PAYLOAD = 128;

function parsePositiveInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const args = {
    iterations: parsePositiveInteger(process.env.FS_SAFE_BENCHMARK_ITERATIONS, DEFAULT_ITERATIONS),
    samples: parsePositiveInteger(process.env.FS_SAFE_BENCHMARK_SAMPLES, DEFAULT_SAMPLES),
    warmup: parsePositiveInteger(process.env.FS_SAFE_BENCHMARK_WARMUP, DEFAULT_WARMUP),
    json: process.env.FS_SAFE_BENCHMARK_JSON,
    markdown: process.env.FS_SAFE_BENCHMARK_MARKDOWN,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--iterations") {
      args.iterations = parsePositiveInteger(argv[++i], args.iterations);
    } else if (arg === "--samples") {
      args.samples = parsePositiveInteger(argv[++i], args.samples);
    } else if (arg === "--warmup") {
      args.warmup = parsePositiveInteger(argv[++i], args.warmup);
    } else if (arg === "--json") {
      args.json = argv[++i];
    } else if (arg === "--markdown") {
      args.markdown = argv[++i];
    } else {
      throw new Error(`Unknown benchmark argument: ${arg}`);
    }
  }

  return args;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function formatMs(value) {
  return value.toFixed(2);
}

function formatRatio(value) {
  return value.toFixed(2);
}

async function ensureDistIsBuilt() {
  const required = ["dist/root.js", "dist/regular-file.js", "dist/atomic.js", "dist/json.js"];
  const missing = required.filter((filePath) => !fsSync.existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(`Benchmark needs built dist files. Run pnpm build first. Missing: ${missing.join(", ")}`);
  }
}

async function timeCase(params) {
  for (let i = 0; i < params.warmup; i += 1) {
    await params.run(i);
  }

  const sampleMs = [];
  for (let sample = 0; sample < params.samples; sample += 1) {
    await params.beforeSample?.(sample);
    const startedAt = performance.now();
    for (let i = 0; i < params.iterations; i += 1) {
      await params.run(i);
    }
    sampleMs.push(performance.now() - startedAt);
  }

  return {
    group: params.group,
    name: params.name,
    baseline: params.baseline,
    iterations: params.iterations,
    samples: params.samples,
    sampleMs,
    bestMs: Math.min(...sampleMs),
    medianMs: median(sampleMs),
    meanMs: mean(sampleMs),
  };
}

function renderMarkdown(metadata, results) {
  const baselineByGroup = new Map();
  for (const result of results) {
    if (result.baseline) {
      baselineByGroup.set(result.group, result.bestMs);
    }
  }

  const lines = [
    "# fs-safe benchmark",
    "",
    `Report-only microbenchmark. Each row times ${metadata.iterations} sequential iterations; lower is better.`,
    "",
    `Node ${metadata.node} on ${metadata.platform}/${metadata.arch}. Samples per case: ${metadata.samples}.`,
    "",
    "| Group | Case | Best ms | Median ms | Mean ms | vs raw best | Samples |",
    "|---|---:|---:|---:|---:|---:|---|",
  ];

  for (const result of results) {
    const baseline = baselineByGroup.get(result.group) ?? result.bestMs;
    const ratio = baseline > 0 ? result.bestMs / baseline : 1;
    lines.push(
      `| ${result.group} | ${result.name} | ${formatMs(result.bestMs)} | ${formatMs(result.medianMs)} | ${formatMs(result.meanMs)} | ${formatRatio(ratio)}x | ${result.sampleMs.map(formatMs).join(", ")} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function writeFileEnsuringDir(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function main() {
  await ensureDistIsBuilt();
  const [
    { replaceFileAtomic },
    { readRegularFile },
    { root },
    { tryReadJson, writeJson },
  ] = await Promise.all([
    import("../dist/atomic.js"),
    import("../dist/regular-file.js"),
    import("../dist/root.js"),
    import("../dist/json.js"),
  ]);
  const args = parseArgs(process.argv.slice(2));
  const iterations = args.iterations;
  const samples = args.samples;
  const warmup = Math.min(args.warmup, iterations);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-benchmark-"));
  const payload = Buffer.from("x".repeat(BYTES_PER_PAYLOAD));
  const jsonPayload = { ok: true, count: 42, label: "fs-safe benchmark" };
  const jsonText = `${JSON.stringify(jsonPayload, null, 2)}\n`;

  try {
    const safe = await root(workspace, { mkdir: true, hardlinks: "allow" });
    const readPath = path.join(workspace, "read.txt");
    const readRelPath = "read.txt";
    const jsonPath = path.join(workspace, "state.json");
    await fs.writeFile(readPath, payload);
    await fs.writeFile(jsonPath, jsonText);

    const cases = [
      {
        group: "read file",
        name: "raw fs.readFile",
        baseline: true,
        run: async () => {
          await fs.readFile(readPath);
        },
      },
      {
        group: "read file",
        name: "readRegularFile",
        run: async () => {
          await readRegularFile({ filePath: readPath });
        },
      },
      {
        group: "read file",
        name: "root.readBytes",
        run: async () => {
          await safe.readBytes(readRelPath);
        },
      },
      {
        group: "write file",
        name: "raw fs.writeFile",
        baseline: true,
        run: async (i) => {
          await fs.writeFile(path.join(workspace, "raw-write.txt"), `${i}:${payload.toString("utf8")}`);
        },
      },
      {
        group: "write file",
        name: "replaceFileAtomic",
        run: async (i) => {
          await replaceFileAtomic({
            filePath: path.join(workspace, "atomic-write.txt"),
            content: `${i}:${payload.toString("utf8")}`,
          });
        },
      },
      {
        group: "write file",
        name: "root.write",
        run: async (i) => {
          await safe.write("root-write.txt", `${i}:${payload.toString("utf8")}`);
        },
      },
      {
        group: "read json",
        name: "raw readFile + JSON.parse",
        baseline: true,
        run: async () => {
          JSON.parse(await fs.readFile(jsonPath, "utf8"));
        },
      },
      {
        group: "read json",
        name: "tryReadJson",
        run: async () => {
          await tryReadJson(jsonPath);
        },
      },
      {
        group: "write json",
        name: "raw writeFile + stringify",
        baseline: true,
        run: async (i) => {
          await fs.writeFile(
            path.join(workspace, "raw-json.json"),
            `${JSON.stringify({ ...jsonPayload, count: i }, null, 2)}\n`,
          );
        },
      },
      {
        group: "write json",
        name: "writeJson",
        run: async (i) => {
          await writeJson(path.join(workspace, "safe-json.json"), { ...jsonPayload, count: i }, {
            trailingNewline: true,
          });
        },
      },
    ];

    const results = [];
    for (const benchCase of cases) {
      console.error(`benchmark: ${benchCase.group} / ${benchCase.name}`);
      const result = await timeCase({
        ...benchCase,
        iterations,
        samples,
        warmup,
      });
      console.error(`benchmark: ${benchCase.name} best=${formatMs(result.bestMs)}ms`);
      results.push(result);
    }

    const metadata = {
      iterations,
      samples,
      warmup,
      payloadBytes: payload.byteLength,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      date: new Date().toISOString(),
    };
    const output = {
      metadata,
      results,
    };
    const markdown = renderMarkdown(metadata, results);
    process.stdout.write(markdown);

    if (args.json) {
      await writeFileEnsuringDir(args.json, `${JSON.stringify(output, null, 2)}\n`);
    }
    if (args.markdown) {
      await writeFileEnsuringDir(args.markdown, markdown);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}`);
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
