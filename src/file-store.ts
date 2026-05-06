import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FsSafeError } from "./errors.js";
import {
  resolveOpenedFileRealPathForHandle,
  root,
  type OpenResult,
  type ReadResult,
  type Root,
  type RootReadOptions,
} from "./root.js";
import { isPathInside, resolveSafeRelativePath } from "./path.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";

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

function createMaxBytesTransform(maxBytes: number | undefined): Transform | undefined {
  if (maxBytes === undefined) {
    return undefined;
  }
  let total = 0;
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        callback(new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`));
        return;
      }
      callback(null, buffer);
    },
  });
}

async function writeStreamToTempSource(params: {
  stream: Readable;
  maxBytes?: number;
  mode: number;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tempRoot = resolveSecureTempRoot({
    fallbackPrefix: "fs-safe-file-store",
    unsafeFallbackLabel: "file store temp dir",
    warn: () => undefined,
  });
  const dir = await fs.mkdtemp(path.join(tempRoot, "fs-safe-file-store-"));
  const filePath = path.join(dir, "payload");
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let handleClosedByStream = false;
  try {
    handle = await fs.open(filePath, "wx", params.mode);
    const writable = handle.createWriteStream();
    writable.once("close", () => {
      handleClosedByStream = true;
    });
    const limiter = createMaxBytesTransform(params.maxBytes);
    if (limiter) {
      await pipeline(params.stream, limiter, writable);
    } else {
      await pipeline(params.stream, writable);
    }
    if (!handleClosedByStream) {
      await handle.close().catch(() => undefined);
      handleClosedByStream = true;
    }
    await fs.chmod(filePath, params.mode).catch(() => undefined);
    return {
      path: filePath,
      cleanup: async () => {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (err) {
    if (handle && !handleClosedByStream) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
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
      const staged = await writeStreamToTempSource({
        stream,
        maxBytes: limit,
        mode: writeOptions?.mode ?? mode,
      });
      try {
        await copyIntoRoot({
          rootDir,
          relativePath: safeRelativePath,
          sourcePath: staged.path,
          maxBytes: limit,
          mode: writeOptions?.mode ?? mode,
          tempPrefix: writeOptions?.tempPrefix,
          dirMode: writeOptions?.dirMode ?? dirMode,
        });
      } finally {
        await staged.cleanup();
      }
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
