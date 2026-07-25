import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const proofPath = resolve(repositoryRoot, process.env.FS_SAFE_RELEASE_GRAPH_PROOF ?? "release-graph-proof.json");
const workspace = mkdtempSync(join(tmpdir(), "fs-safe-release-graph-"));
const packsDirectory = join(workspace, "packs");
const scratchDirectory = join(workspace, "consumer");
const pnpmCli = process.env.npm_execpath;

if (!pnpmCli || !existsSync(pnpmCli) || !basename(pnpmCli).startsWith("pnpm")) {
  throw new Error("release graph smoke must run through pnpm");
}

const npmCli = resolveNpmCli();
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
);

const host = resolveHostPackage();
const nativeBinary = join(repositoryRoot, "native", host.binary);
const packageBinary = join(repositoryRoot, host.directory, host.binary);
const previousPackageBinary = existsSync(packageBinary) ? readFileSync(packageBinary) : undefined;

try {
  mkdirSync(packsDirectory);
  mkdirSync(scratchDirectory);
  if (!existsSync(nativeBinary)) {
    throw new Error(`host native binary was not built: native/${host.binary}`);
  }
  copyFileSync(nativeBinary, packageBinary);

  const packageDirectories = [
    ...readdirSync(join(repositoryRoot, "npm"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `npm/${entry.name}`)
      .toSorted(),
    "native",
    ".",
  ];
  const tarballs = new Map();
  for (const directory of packageDirectories) {
    const packageRoot = resolve(repositoryRoot, directory);
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const before = new Set(existsSync(packsDirectory) ? readdirSync(packsDirectory) : []);
    runPnpm(["--dir", packageRoot, "pack", "--pack-destination", packsDirectory]);
    const filename = readdirSync(packsDirectory).find((candidate) => !before.has(candidate));
    if (!filename) {
      throw new Error(`pnpm pack did not produce an artifact for ${packageJson.name}`);
    }
    tarballs.set(packageJson.name, join(packsDirectory, filename));
  }

  const dependencies = Object.fromEntries(
    ["@openclaw/fs-safe", "@openclaw/fs-safe-native", host.packageName].map((name) => [
      name,
      `file:${tarballs.get(name)}`,
    ]),
  );
  writeFileSync(
    join(scratchDirectory, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`,
  );
  runNpm(["install", "--force", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], {
    cwd: scratchDirectory,
  });
  copyFileSync(
    join(repositoryRoot, "scripts", "packed-final-smoke.mjs"),
    join(scratchDirectory, "packed-final-smoke.mjs"),
  );

  const nativeOutput = runNode(
    `const imported=await import('@openclaw/fs-safe-native');const n=imported.default??imported;` +
      `if(typeof n.openBeneath!=='function')throw new Error('openBeneath missing');` +
      `console.log(JSON.stringify({nativeBinding:'loaded',openBeneath:typeof n.openBeneath}));`,
  );
  const offOutput = runNode(
    `import fs from 'node:fs';import os from 'node:os';import path from 'node:path';` +
      `import {configureFsSafeNative} from '@openclaw/fs-safe';` +
      `import {publishFileExclusive} from '@openclaw/fs-safe/durability';` +
      `configureFsSafeNative({mode:'off'});` +
      `const d=fs.mkdtempSync(path.join(os.tmpdir(),'fs-safe-off-'));` +
      `try{const s=path.join(d,'source');const t=path.join(d,'target');fs.writeFileSync(s,'fallback');` +
      `const r=await publishFileExclusive({sourcePath:s,targetPath:t,strategy:'link-or-copy'});` +
      `if(fs.readFileSync(t,'utf8')!=='fallback')throw new Error('fallback content mismatch');` +
      `console.log(JSON.stringify({nativeMode:'off',fallback:r.method}));}` +
      `finally{fs.rmSync(d,{recursive:true,force:true});}`,
    { NAPI_RS_NATIVE_LIBRARY_PATH: join(workspace, "must-not-load.node") },
  );
  const finalRoundOutput = runNodeFile("packed-final-smoke.mjs");

  rmSync(join(scratchDirectory, "node_modules", "@openclaw", "fs-safe-native"), {
    force: true,
    recursive: true,
  });
  rmSync(join(scratchDirectory, "node_modules", "@openclaw", host.packageName.slice("@openclaw/".length)), {
    force: true,
    recursive: true,
  });
  const requireOutput = runNode(
    `import fs from 'node:fs';import os from 'node:os';import path from 'node:path';` +
      `import {configureFsSafeNative} from '@openclaw/fs-safe';` +
      `import {publishFileExclusive} from '@openclaw/fs-safe/durability';` +
      `configureFsSafeNative({mode:'require'});` +
      `const d=fs.mkdtempSync(path.join(os.tmpdir(),'fs-safe-require-'));` +
      `try{const s=path.join(d,'source');fs.writeFileSync(s,'require');` +
      `try{await publishFileExclusive({sourcePath:s,targetPath:path.join(d,'target'),strategy:'rename-noreplace'});` +
      `throw new Error('required native binding unexpectedly available');}` +
      `catch(e){if(e.code!=='helper-unavailable')throw e;` +
      `console.log(JSON.stringify({nativeMode:'require',bindingRemoved:true,errorCode:e.code}));}}` +
      `finally{fs.rmSync(d,{recursive:true,force:true});}`,
  );

  const proof = {
    schemaVersion: 1,
    platform: `${process.platform}-${process.arch}`,
    packagesPacked: packageDirectories.length,
    hostPackage: host.packageName,
    native: JSON.parse(nativeOutput),
    fallback: JSON.parse(offOutput),
    finalRound: JSON.parse(finalRoundOutput),
    missingRequiredBinding: JSON.parse(requireOutput),
  };
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  console.log("release graph smoke: PASS");
  console.log(JSON.stringify(proof, null, 2));
} finally {
  if (previousPackageBinary) {
    writeFileSync(packageBinary, previousPackageBinary);
  } else {
    rmSync(packageBinary, { force: true });
  }
  rmSync(workspace, { force: true, recursive: true });
}

function resolveHostPackage() {
  const key = `${process.platform}-${process.arch}`;
  const hosts = {
    "darwin-arm64": {
      directory: "npm/darwin-arm64",
      packageName: "@openclaw/fs-safe-native-darwin-arm64",
      binary: "fs-safe-native.darwin-arm64.node",
    },
    "darwin-x64": {
      directory: "npm/darwin-x64",
      packageName: "@openclaw/fs-safe-native-darwin-x64",
      binary: "fs-safe-native.darwin-x64.node",
    },
    "linux-arm64": {
      directory: "npm/linux-arm64-gnu",
      packageName: "@openclaw/fs-safe-native-linux-arm64-gnu",
      binary: "fs-safe-native.linux-arm64-gnu.node",
    },
    "linux-x64": {
      directory: "npm/linux-x64-gnu",
      packageName: "@openclaw/fs-safe-native-linux-x64-gnu",
      binary: "fs-safe-native.linux-x64-gnu.node",
    },
    "win32-x64": {
      directory: "npm/win32-x64-msvc",
      packageName: "@openclaw/fs-safe-native-win32-x64-msvc",
      binary: "fs-safe-native.win32-x64-msvc.node",
    },
  };
  const hostPackage = hosts[key];
  if (!hostPackage) {
    throw new Error(`release graph smoke does not support ${key}`);
  }
  return hostPackage;
}

function runPnpm(args) {
  return execFileSync(process.execPath, [pnpmCli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: cleanEnvironment,
    stdio: "pipe",
  });
}

function runNpm(args, options) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    ...options,
    encoding: "utf8",
    env: cleanEnvironment,
    stdio: "pipe",
  });
}

function runNode(source, additionalEnvironment = {}) {
  return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: scratchDirectory,
    encoding: "utf8",
    env: { ...cleanEnvironment, ...additionalEnvironment },
    stdio: "pipe",
  }).trim();
}

function runNodeFile(filename) {
  return execFileSync(process.execPath, [filename], {
    cwd: scratchDirectory,
    encoding: "utf8",
    env: cleanEnvironment,
    stdio: "pipe",
  }).trim();
}

function resolveNpmCli() {
  const candidates = [
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npm = candidates.find((candidate) => existsSync(candidate));
  if (!npm) {
    throw new Error("could not resolve npm-cli.js from the current Node installation");
  }
  return npm;
}
