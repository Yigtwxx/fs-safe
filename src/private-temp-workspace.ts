import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { copyIntoRoot } from "./file-store.js";

export type TempWorkspaceOptions = {
  rootDir: string;
  prefix: string;
  dirMode?: number;
  mode?: number;
};

export type TempWorkspace = {
  dir: string;
  file(fileName: string): string;
  path(fileName: string): string;
  writePrivate(fileName: string, data: string | Uint8Array): Promise<string>;
  writeText(fileName: string, data: string): Promise<string>;
  writeJson(
    fileName: string,
    data: unknown,
    options?: { trailingNewline?: boolean },
  ): Promise<string>;
  copyIn(fileName: string, sourcePath: string): Promise<string>;
  read(fileName: string): Promise<Buffer>;
  cleanup(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type TempWorkspaceSync = {
  dir: string;
  file(fileName: string): string;
  path(fileName: string): string;
  writePrivate(fileName: string, data: string | Uint8Array): string;
  writeText(fileName: string, data: string): string;
  writeJson(fileName: string, data: unknown, options?: { trailingNewline?: boolean }): string;
  read(fileName: string): Buffer;
  cleanup(): void;
  [Symbol.dispose](): void;
};

function sanitizeTempPrefix(prefix: string): string {
  const sanitized = prefix.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "fs-safe-";
  }
  return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}

function resolveWorkspaceLeaf(dir: string, fileName: string): string {
  const raw = fileName.trim();
  if (
    !raw ||
    raw === "." ||
    raw === ".." ||
    raw.includes("\0") ||
    raw.includes("/") ||
    raw.includes("\\") ||
    path.basename(raw) !== raw
  ) {
    throw new Error(`Invalid temp workspace file name: ${JSON.stringify(fileName)}`);
  }
  return path.join(dir, raw);
}

async function ensurePrivateDirectory(dir: string, mode: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Temp root must be a directory: ${dir}`);
  }
  await fs.chmod(dir, mode).catch(() => undefined);
}

function ensurePrivateDirectorySync(dir: string, mode: number): void {
  fsSync.mkdirSync(dir, { recursive: true, mode });
  const stat = fsSync.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Temp root must be a directory: ${dir}`);
  }
  try {
    fsSync.chmodSync(dir, mode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
}

async function createTempWorkspace(
  options: TempWorkspaceOptions,
): Promise<TempWorkspace> {
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const requestedRoot = path.resolve(options.rootDir);
  const root = await fs.realpath(requestedRoot).catch(() => requestedRoot);
  await ensurePrivateDirectory(root, dirMode);
  const dir = await fs.mkdtemp(path.join(root, sanitizeTempPrefix(options.prefix)));
  await fs.chmod(dir, dirMode).catch(() => undefined);
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Temp workspace must be a directory: ${dir}`);
  }

  return {
    dir,
    file: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    writePrivate: async (fileName, data) => {
      const filePath = resolveWorkspaceLeaf(dir, fileName);
      await fs.writeFile(filePath, data, { mode, flag: "wx" });
      await fs.chmod(filePath, mode).catch(() => undefined);
      return filePath;
    },
    writeText: async (fileName, data) => {
      const filePath = resolveWorkspaceLeaf(dir, fileName);
      await fs.writeFile(filePath, data, { encoding: "utf8", mode, flag: "wx" });
      await fs.chmod(filePath, mode).catch(() => undefined);
      return filePath;
    },
    writeJson: async (fileName, data, writeOptions) => {
      const json = JSON.stringify(data, null, 2);
      const payload = writeOptions?.trailingNewline === false ? json : `${json}\n`;
      const filePath = resolveWorkspaceLeaf(dir, fileName);
      await fs.writeFile(filePath, payload, { encoding: "utf8", mode, flag: "wx" });
      await fs.chmod(filePath, mode).catch(() => undefined);
      return filePath;
    },
    copyIn: async (fileName, sourcePath) => {
      const filePath = resolveWorkspaceLeaf(dir, fileName);
      await copyIntoRoot({
        rootDir: dir,
        relativePath: fileName,
        sourcePath,
        mode,
      });
      return filePath;
    },
    read: async (fileName) => await fs.readFile(resolveWorkspaceLeaf(dir, fileName)),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
    [Symbol.asyncDispose]: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function tempWorkspace(
  options: TempWorkspaceOptions,
): Promise<TempWorkspace> {
  return await createTempWorkspace(options);
}

export async function withTempWorkspace<T>(
  options: TempWorkspaceOptions,
  run: (workspace: TempWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await createTempWorkspace({
    ...options,
    prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`,
  });
  try {
    return await run(workspace);
  } finally {
    await workspace.cleanup();
  }
}

export function tempWorkspaceSync(
  options: TempWorkspaceOptions,
): TempWorkspaceSync {
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const requestedRoot = path.resolve(options.rootDir);
  let root = requestedRoot;
  try {
    root = fsSync.realpathSync.native(requestedRoot);
  } catch {
    root = requestedRoot;
  }
  ensurePrivateDirectorySync(root, dirMode);
  const dir = fsSync.mkdtempSync(path.join(root, sanitizeTempPrefix(options.prefix)));
  try {
    fsSync.chmodSync(dir, dirMode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
  const stat = fsSync.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Temp workspace must be a directory: ${dir}`);
  }

  return {
    dir,
    file: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    writePrivate: (fileName, data) => {
      const filePath = resolveWorkspaceLeaf(dir, fileName);
      fsSync.writeFileSync(filePath, data, { mode, flag: "wx" });
      try {
        fsSync.chmodSync(filePath, mode);
      } catch {
        // Best-effort on platforms that do not enforce POSIX modes.
      }
      return filePath;
    },
    writeText: (fileName, data) => {
      const filePath = resolveWorkspaceLeaf(dir, fileName);
      fsSync.writeFileSync(filePath, data, { encoding: "utf8", mode, flag: "wx" });
      try {
        fsSync.chmodSync(filePath, mode);
      } catch {
        // Best-effort on platforms that do not enforce POSIX modes.
      }
      return filePath;
    },
    writeJson: (fileName, data, writeOptions) => {
      const json = JSON.stringify(data, null, 2);
      const payload = writeOptions?.trailingNewline === false ? json : `${json}\n`;
      const filePath = resolveWorkspaceLeaf(dir, fileName);
      fsSync.writeFileSync(filePath, payload, { encoding: "utf8", mode, flag: "wx" });
      try {
        fsSync.chmodSync(filePath, mode);
      } catch {
        // Best-effort on platforms that do not enforce POSIX modes.
      }
      return filePath;
    },
    read: (fileName) => fsSync.readFileSync(resolveWorkspaceLeaf(dir, fileName)),
    cleanup: () => {
      try {
        fsSync.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    },
    [Symbol.dispose]: () => {
      try {
        fsSync.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}

export function withTempWorkspaceSync<T>(
  options: TempWorkspaceOptions,
  run: (workspace: TempWorkspaceSync) => T,
): T {
  const workspace = tempWorkspaceSync({
    ...options,
    prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`,
  });
  try {
    return run(workspace);
  } finally {
    workspace.cleanup();
  }
}
