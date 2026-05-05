import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import { isPathInside } from "./path.js";
import { readRegularFileSync } from "./regular-file.js";
import { root } from "./root.js";
import { writeSecretFileAtomic } from "./secret-file.js";

export type PrivateStateStoreOptions = {
  rootDir: string;
};

export type PrivateStateStore = {
  rootDir: string;
  path(relativePath: string): string;
  readText(relativePath: string, options?: { maxBytes?: number }): Promise<string | null>;
  readJson<T = unknown>(relativePath: string, options?: { maxBytes?: number }): Promise<T | null>;
  writeText(relativePath: string, content: string | Uint8Array): Promise<void>;
  writeJson(relativePath: string, value: unknown, options?: { trailingNewline?: boolean }): Promise<void>;
};

function resolvePrivateStorePath(rootDir: string, relativePath: string): string {
  const root = path.resolve(rootDir);
  const raw = relativePath.trim();
  if (!raw || path.isAbsolute(raw) || raw.includes("\0")) {
    throw new Error("Private file path must be a relative path.");
  }
  const resolved = path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Private file path must stay under the private store root.");
  }
  return resolved;
}

export async function writePrivateTextAtomic(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
}): Promise<void> {
  await writeSecretFileAtomic(params);
}

export async function readPrivateText(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): Promise<string | null> {
  const rootDir = path.resolve(params.rootDir);
  const filePath = path.resolve(params.filePath);
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Private file path must stay under the private store root.");
  }
  try {
    const storeRoot = await root(rootDir, { hardlinks: "reject", maxBytes: params.maxBytes });
    const result = await storeRoot.read(relative);
    return result.buffer.toString("utf8");
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "not-found") {
      return null;
    }
    throw err;
  }
}

function assertPrivateReadPathSync(params: { rootDir: string; filePath: string }): void {
  const rootDir = path.resolve(params.rootDir);
  const filePath = path.resolve(params.filePath);
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Private file path must stay under the private store root.");
  }
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Private file root must be a directory: ${rootDir}`);
  }
  const rootReal = fs.realpathSync(rootDir);
  const fileReal = fs.realpathSync(filePath);
  if (!isPathInside(rootReal, fileReal)) {
    throw new Error("Private file path must stay under the private store root.");
  }
}

export function readPrivateTextSync(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): string | null {
  try {
    assertPrivateReadPathSync(params);
    const result = readRegularFileSync({
      filePath: path.resolve(params.filePath),
      maxBytes: params.maxBytes,
    });
    if (result.stat.nlink > 1) {
      throw new Error(`Private file target must not be hardlinked: ${params.filePath}`);
    }
    return result.buffer.toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function readPrivateJson<T = unknown>(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): Promise<T | null> {
  const raw = await readPrivateText(params);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export function readPrivateJsonSync<T = unknown>(params: {
  rootDir: string;
  filePath: string;
  maxBytes?: number;
}): T | null {
  const raw = readPrivateTextSync(params);
  return raw === null ? null : (JSON.parse(raw) as T);
}

function ensurePrivateDirectorySync(rootDir: string, targetDir: string): void {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetDir);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Private file directory must stay under the private store root.");
  }
  let current = root;
  fs.mkdirSync(current, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Private file root must be a directory: ${current}`);
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Private file directory component must be a directory: ${current}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      fs.mkdirSync(current, { mode: 0o700 });
    }
    try {
      fs.chmodSync(current, 0o700);
    } catch {
      // Best-effort on platforms that do not enforce POSIX modes.
    }
  }
}

export function writePrivateTextAtomicSync(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
}): void {
  const root = path.resolve(params.rootDir);
  const filePath = path.resolve(params.filePath);
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Private file path must stay under the private store root.");
  }
  ensurePrivateDirectorySync(root, path.dirname(filePath));
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Private file target must be a regular file: ${filePath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const tempPath = path.join(path.dirname(filePath), `.tmp-${process.pid}-${randomUUID()}`);
  let created = false;
  try {
    fs.writeFileSync(tempPath, params.content, { mode: 0o600, flag: "wx" });
    created = true;
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // Best-effort on platforms that do not enforce POSIX modes.
    }
    fs.renameSync(tempPath, filePath);
    created = false;
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort on platforms that do not enforce POSIX modes.
    }
  } finally {
    if (created) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The temp file is best-effort cleanup after write failure.
      }
    }
  }
}

export async function writePrivateJsonAtomic(params: {
  rootDir: string;
  filePath: string;
  value: unknown;
  trailingNewline?: boolean;
}): Promise<void> {
  const json = JSON.stringify(params.value, null, 2);
  await writeSecretFileAtomic({
    rootDir: params.rootDir,
    filePath: params.filePath,
    content: params.trailingNewline && !json.endsWith("\n") ? `${json}\n` : json,
  });
}

export function writePrivateJsonAtomicSync(params: {
  rootDir: string;
  filePath: string;
  value: unknown;
  trailingNewline?: boolean;
}): void {
  const json = JSON.stringify(params.value, null, 2);
  writePrivateTextAtomicSync({
    rootDir: params.rootDir,
    filePath: params.filePath,
    content: params.trailingNewline && !json.endsWith("\n") ? `${json}\n` : json,
  });
}

export function privateStateStore(options: PrivateStateStoreOptions): PrivateStateStore {
  const root = path.resolve(options.rootDir);
  return {
    rootDir: root,
    path: (relativePath) => resolvePrivateStorePath(root, relativePath),
    readText: async (relativePath, options) =>
      await readPrivateText({
        rootDir: root,
        filePath: resolvePrivateStorePath(root, relativePath),
        maxBytes: options?.maxBytes,
      }),
    readJson: async (relativePath, options) =>
      await readPrivateJson({
        rootDir: root,
        filePath: resolvePrivateStorePath(root, relativePath),
        maxBytes: options?.maxBytes,
      }),
    writeText: async (relativePath, content) => {
      await writePrivateTextAtomic({
        rootDir: root,
        filePath: resolvePrivateStorePath(root, relativePath),
        content,
      });
    },
    writeJson: async (relativePath, value, options) => {
      await writePrivateJsonAtomic({
        rootDir: root,
        filePath: resolvePrivateStorePath(root, relativePath),
        value,
        trailingNewline: options?.trailingNewline,
      });
    },
  };
}
