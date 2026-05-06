import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import {
  resolveOpenedFileRealPathForHandle,
  root,
  type OpenResult,
  type ReadResult,
  type Root,
  type RootReadOptions,
} from "./root.js";
import { isPathInside, resolveSafeRelativePath } from "./path.js";

export type FileStoreOptions = {
  rootDir: string;
  dirMode?: number;
  mode?: number;
  maxBytes?: number;
};

export type FileStoreWriteOptions = {
  dirMode?: number;
  mode?: number;
  maxBytes?: number;
  tempPrefix?: string;
};

export type FileStorePruneOptions = {
  ttlMs: number;
  recursive?: boolean;
  maxDepth?: number;
  pruneEmptyDirs?: boolean;
};

export type FileStore = {
  readonly rootDir: string;
  path(relativePath: string): string;
  root(): Promise<Root>;
  write(
    relativePath: string,
    data: string | Buffer,
    options?: FileStoreWriteOptions,
  ): Promise<string>;
  writeStream(
    relativePath: string,
    stream: Readable,
    options?: FileStoreWriteOptions,
  ): Promise<string>;
  copyIn(
    relativePath: string,
    sourcePath: string,
    options?: FileStoreWriteOptions,
  ): Promise<string>;
  open(relativePath: string, options?: RootReadOptions): Promise<OpenResult>;
  read(relativePath: string, options?: RootReadOptions): Promise<ReadResult>;
  readBytes(relativePath: string, options?: RootReadOptions): Promise<Buffer>;
  remove(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  pruneExpired(options: FileStorePruneOptions): Promise<void>;
};

function assertRelativePath(relativePath: string): string {
  const raw = relativePath.trim();
  if (!raw) {
    throw new FsSafeError("invalid-path", "relative path must be non-empty");
  }
  return raw.replaceAll("\\", "/");
}

function assertMaxBytes(size: number, maxBytes?: number): void {
  if (maxBytes !== undefined && size > maxBytes) {
    throw new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`);
  }
}

function resolveStorePath(rootDir: string, relativePath: string): string {
  return resolveSafeRelativePath(rootDir, assertRelativePath(relativePath));
}

function parentRelativePath(relativePath: string): string {
  const parent = path.posix.dirname(assertRelativePath(relativePath));
  return parent === "." ? "" : parent;
}

async function chmodDirectoryInRootBestEffort(
  scopedRoot: Root,
  relativePath: string,
  mode: number,
): Promise<void> {
  if (!relativePath) {
    return;
  }
  const dirPath = await scopedRoot.resolve(relativePath);
  const directoryFlag = "O_DIRECTORY" in fsConstants ? (fsConstants.O_DIRECTORY as number) : 0;
  const noFollowFlag =
    process.platform !== "win32" && "O_NOFOLLOW" in fsConstants
      ? (fsConstants.O_NOFOLLOW as number)
      : 0;
  const handle = await fs.open(dirPath, fsConstants.O_RDONLY | directoryFlag | noFollowFlag);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      return;
    }
    const realPath = await resolveOpenedFileRealPathForHandle(handle, dirPath);
    if (!isPathInside(scopedRoot.rootWithSep, realPath)) {
      throw new FsSafeError("outside-workspace", "directory is outside store root");
    }
    await handle.chmod(mode).catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensureParentInRoot(
  scopedRoot: Root,
  relativePath: string,
  mode: number,
): Promise<void> {
  const parent = parentRelativePath(relativePath);
  if (!parent) {
    return;
  }
  await scopedRoot.mkdir(parent);
  await chmodDirectoryInRootBestEffort(scopedRoot, parent, mode).catch(() => undefined);
}

async function openWritableStoreRoot(params: {
  rootDir: string;
  dirMode: number;
  maxBytes?: number;
}): Promise<Root> {
  await fs.mkdir(params.rootDir, { recursive: true, mode: params.dirMode });
  await fs.chmod(params.rootDir, params.dirMode).catch(() => undefined);
  return await root(params.rootDir, { hardlinks: "reject", maxBytes: params.maxBytes });
}

function normalizePinnedStreamWriteError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  return new FsSafeError("path-alias", "path alias escape blocked", {
    cause: error instanceof Error ? error : undefined,
  });
}

async function writeStreamInRoot(params: {
  scopedRoot: Root;
  relativePath: string;
  stream: Readable;
  maxBytes?: number;
  mode: number;
}): Promise<void> {
  const relativePath = assertRelativePath(params.relativePath);
  const relativeParentPath = parentRelativePath(relativePath);
  const basename = path.posix.basename(relativePath);
  if (!basename || basename === "." || basename === "/") {
    throw new FsSafeError("invalid-path", "invalid target path");
  }

  let identity;
  try {
    identity = await runPinnedWriteHelper({
      rootPath: params.scopedRoot.rootReal,
      relativeParentPath,
      basename,
      mkdir: false,
      mode: params.mode,
      overwrite: true,
      maxBytes: params.maxBytes,
      input: {
        kind: "stream",
        stream: params.stream,
      },
    });
  } catch (error) {
    throw normalizePinnedStreamWriteError(error);
  }

  const opened = await params.scopedRoot.open(relativePath, {
    hardlinks: "reject",
    nonBlockingRead: true,
  });
  try {
    if (!sameFileIdentity(opened.stat, identity)) {
      throw new FsSafeError("path-mismatch", "path changed during write");
    }
    if (!isPathInside(params.scopedRoot.rootWithSep, opened.realPath)) {
      throw new FsSafeError("outside-workspace", "file is outside store root");
    }
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function copyIntoRoot(params: {
  rootDir: string;
  relativePath: string;
  sourcePath: string;
  dirMode?: number;
  maxBytes?: number;
  mode?: number;
  tempPrefix?: string;
}): Promise<string> {
  const relativePath = assertRelativePath(params.relativePath);
  const destination = resolveStorePath(params.rootDir, relativePath);
  const sourceStat = await fs.lstat(params.sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new FsSafeError("not-file", "source path is not a file");
  }
  assertMaxBytes(sourceStat.size, params.maxBytes);
  const dirMode = params.dirMode ?? 0o700;
  const scopedRoot = await openWritableStoreRoot({
    rootDir: params.rootDir,
    dirMode,
    maxBytes: params.maxBytes,
  });
  await ensureParentInRoot(scopedRoot, relativePath, dirMode);
  await scopedRoot.copyIn(relativePath, params.sourcePath, {
    maxBytes: params.maxBytes,
    mkdir: false,
    mode: params.mode ?? 0o600,
  });
  return destination;
}

export function fileStore(options: FileStoreOptions): FileStore {
  const rootDir = path.resolve(options.rootDir);
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const maxBytes = options.maxBytes;

  async function openRoot(): Promise<Root> {
    return await root(rootDir, { hardlinks: "reject", maxBytes });
  }

  return {
    rootDir,
    path: (relativePath) => resolveStorePath(rootDir, relativePath),
    root: openRoot,
    write: async (relativePath, data, writeOptions) => {
      const safeRelativePath = assertRelativePath(relativePath);
      const destination = resolveStorePath(rootDir, safeRelativePath);
      const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
      assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
      const writeDirMode = writeOptions?.dirMode ?? dirMode;
      const scopedRoot = await openWritableStoreRoot({
        rootDir,
        dirMode: writeDirMode,
        maxBytes: writeOptions?.maxBytes ?? maxBytes,
      });
      await ensureParentInRoot(scopedRoot, safeRelativePath, writeDirMode);
      await scopedRoot.write(safeRelativePath, content, {
        mkdir: false,
        mode: writeOptions?.mode ?? mode,
      });
      return destination;
    },
    writeStream: async (relativePath, stream, writeOptions) => {
      const safeRelativePath = assertRelativePath(relativePath);
      const destination = resolveStorePath(rootDir, safeRelativePath);
      const limit = writeOptions?.maxBytes ?? maxBytes;
      const writeDirMode = writeOptions?.dirMode ?? dirMode;
      const scopedRoot = await openWritableStoreRoot({
        rootDir,
        dirMode: writeDirMode,
        maxBytes: limit,
      });
      await ensureParentInRoot(scopedRoot, safeRelativePath, writeDirMode);
      await writeStreamInRoot({
        scopedRoot,
        relativePath: safeRelativePath,
        stream,
        maxBytes: limit,
        mode: writeOptions?.mode ?? mode,
      });
      return destination;
    },
    copyIn: async (relativePath, sourcePath, writeOptions) =>
      await copyIntoRoot({
        rootDir,
        relativePath,
        sourcePath,
        dirMode: writeOptions?.dirMode ?? dirMode,
        maxBytes: writeOptions?.maxBytes ?? maxBytes,
        mode: writeOptions?.mode ?? mode,
        tempPrefix: writeOptions?.tempPrefix,
      }),
    open: async (relativePath, readOptions) =>
      await (await openRoot()).open(assertRelativePath(relativePath), readOptions),
    read: async (relativePath, readOptions) =>
      await (await openRoot()).read(assertRelativePath(relativePath), readOptions),
    readBytes: async (relativePath, readOptions) =>
      await (await openRoot()).readBytes(assertRelativePath(relativePath), readOptions),
    remove: async (relativePath) => {
      await (await openRoot()).remove(assertRelativePath(relativePath));
    },
    exists: async (relativePath) => await (await openRoot()).exists(assertRelativePath(relativePath)),
    pruneExpired: async (pruneOptions) => {
      const now = Date.now();
      const recursive = pruneOptions.recursive ?? false;
      const maxDepth = pruneOptions.maxDepth;
      const pruneEmptyDirs =
        (recursive || maxDepth !== undefined) && (pruneOptions.pruneEmptyDirs ?? false);
      async function pruneDir(dir: string, depth: number): Promise<boolean> {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const stat = await fs.lstat(fullPath).catch(() => null);
          if (!stat || stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            const shouldDescend = maxDepth !== undefined ? depth < maxDepth : recursive;
            if (shouldDescend && (await pruneDir(fullPath, depth + 1))) {
              await fs.rmdir(fullPath).catch(() => undefined);
            }
            continue;
          }
          if (stat.isFile() && now - stat.mtimeMs > pruneOptions.ttlMs) {
            await fs.rm(fullPath, { force: true }).catch(() => undefined);
          }
        }
        if (!pruneEmptyDirs) {
          return false;
        }
        const remaining = await fs.readdir(dir).catch(() => null);
        return remaining !== null && remaining.length === 0;
      }
      await fs.mkdir(rootDir, { recursive: true, mode: dirMode });
      await pruneDir(rootDir, 0);
    },
  };
}
