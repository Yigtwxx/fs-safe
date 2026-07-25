import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const outputIndex = process.argv.indexOf("--output");
const outputDir = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : "release-artifacts");
mkdirSync(outputDir, { recursive: true });

const packageDirs = [
  "npm/linux-x64-gnu",
  "npm/linux-x64-musl",
  "npm/linux-arm64-gnu",
  "npm/linux-arm64-musl",
  "npm/darwin-x64",
  "npm/darwin-arm64",
  "npm/win32-x64-msvc",
  "native",
  ".",
];

const packages = packageDirs.map((directory) => ({
  directory,
  packageJson: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
}));
const rootVersion = packages.at(-1).packageJson.version;

function normalizeRepository(repository) {
  const value = typeof repository === "string" ? repository : repository?.url;
  return String(value ?? "")
    .replace(/^github:/u, "https://github.com/")
    .replace(/^git\+/u, "")
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "");
}

for (const entry of packages) {
  const pkg = entry.packageJson;
  if (pkg.version !== rootVersion) {
    throw new Error(`${pkg.name} version ${pkg.version} does not match ${rootVersion}`);
  }
  if (pkg.author !== "OpenClaw Team <dev@openclaw.ai>") {
    throw new Error(`${pkg.name} has unexpected author metadata`);
  }
  if (normalizeRepository(pkg.repository) !== "https://github.com/openclaw/fs-safe") {
    throw new Error(`${pkg.name} has unexpected repository metadata`);
  }
  if (pkg.publishConfig?.access !== "public" || pkg.publishConfig?.provenance !== true) {
    throw new Error(`${pkg.name} must publish publicly with provenance`);
  }
}

const nativePackage = packages.find((entry) => entry.directory === "native").packageJson;
for (const [name, version] of Object.entries(nativePackage.optionalDependencies ?? {})) {
  if (version !== rootVersion || !packages.some((entry) => entry.packageJson.name === name)) {
    throw new Error(`native optional dependency ${name}@${version} is not a release package`);
  }
}
const rootPackage = packages.at(-1).packageJson;
if (rootPackage.optionalDependencies?.["@openclaw/fs-safe-native"] !== rootVersion) {
  throw new Error("root package must depend on the matching native package version");
}

const manifest = [];
for (const entry of packages) {
  const packed = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDir],
    { cwd: resolve(entry.directory), encoding: "utf8" },
  ));
  const [artifact] = packed;
  if (!artifact?.filename || !artifact?.integrity || artifact.version !== rootVersion) {
    throw new Error(`npm pack returned incomplete metadata for ${entry.packageJson.name}`);
  }
  const paths = new Set(artifact.files.map((file) => file.path));
  if (entry.directory.startsWith("npm/")) {
    const binary = entry.packageJson.main;
    if (!paths.has(binary) || !existsSync(join(entry.directory, binary))) {
      throw new Error(`${entry.packageJson.name} is missing ${binary}`);
    }
    if (statSync(join(entry.directory, binary)).size === 0) {
      throw new Error(`${entry.packageJson.name} contains an empty native binary`);
    }
  } else if (entry.directory === "native") {
    for (const expected of ["index.js", "index.d.ts", "package.json"]) {
      if (!paths.has(expected)) throw new Error(`${entry.packageJson.name} is missing ${expected}`);
    }
  } else {
    for (const expected of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
      if (!paths.has(expected)) throw new Error(`${entry.packageJson.name} is missing ${expected}`);
    }
  }
  manifest.push({
    name: entry.packageJson.name,
    version: rootVersion,
    filename: artifact.filename,
    integrity: artifact.integrity,
  });
}

writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const smoke = mkdtempSync(join(tmpdir(), "fs-safe-release-smoke-"));
try {
  writeFileSync(join(smoke, "package.json"), '{"private":true,"type":"module"}\n');
  const wanted = [
    "@openclaw/fs-safe",
    "@openclaw/fs-safe-native",
    "@openclaw/fs-safe-native-linux-x64-gnu",
  ].map((name) => join(outputDir, manifest.find((entry) => entry.name === name).filename));
  execFileSync(
    "npm",
    ["install", "--force", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", ...wanted],
    { cwd: smoke, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", "await import('@openclaw/fs-safe'); await import('@openclaw/fs-safe/config');"],
    { cwd: smoke, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    ["--eval", "const n=require('@openclaw/fs-safe-native'); if(typeof n.openBeneath!=='function') process.exit(1)"],
    { cwd: smoke, stdio: "pipe" },
  );
} finally {
  rmSync(smoke, { recursive: true, force: true });
}
