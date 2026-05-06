import { randomUUID } from "node:crypto";
import syncFs, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { createJsonStore, type JsonFileStoreOptions, type JsonStore } from "./json-document-store.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import { isPathInside, resolveSafeRelativePath } from "./path.js";
import {
  resolveOpenedFileRealPathForHandle,
  root,
  type OpenResult,
  type ReadResult,
  type Root,
  type RootReadOptions,
} from "./root.js";
import { writeSecretFileAtomic } from "./secret-file.js";

export type FileStoreOptions = {
  rootDir: string;
  private?: boolean;
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

export type FileStoreReadOptions = RootReadOptions & { encoding?: BufferEncoding };

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
    data: string | Uint8Array,
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
  readText(
    relativePath: string,
    options?: FileStoreReadOptions,
  ): Promise<string>;
  readTextIfExists(relativePath: string, options?: FileStoreReadOptions): Promise<string | null>;
  readJson<T = unknown>(relativePath: string, options?: FileStoreReadOptions): Promise<T>;
  readJsonIfExists<T = unknown>(
    relativePath: string,
    options?: FileStoreReadOptions,
  ): Promise<T | null>;
  remove(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  writeText(
    relativePath: string,
    data: string | Uint8Array,
    options?: FileStoreWriteOptions,
  ): Promise<string>;
  writeJson(
    relativePath: string,
    data: unknown,
    options?: FileStoreWriteOptions & { trailingNewline?: boolean },
  ): Promise<string>;
  json<T = unknown>(relativePath: string, options?: JsonFileStoreOptions): JsonStore<T>;
  pruneExpired(options: FileStorePruneOptions): Promise<void>;
};

export type FileStoreSync = {
  readonly rootDir: string;
  path(relativePath: string): string;
  readTextIfExists(relativePath: string, options?: { maxBytes?: number }): string | null;
  readJsonIfExists<T = unknown>(relativePath: string, options?: { maxBytes?: number }): T | null;
  write(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
  writeText(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
  writeJson(
    relativePath: string,
    data: unknown,
    options?: FileStoreWriteOptions & { trailingNewline?: boolean },
  ): string;
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

function assertStoreFilePath(rootDir: string, filePath: string): void {
  if (!isPathInside(rootDir, filePath)) {
    throw new FsSafeError("outside-workspace", "file path escapes store root");
  }
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

async function readStreamIntoBuffer(stream: Readable, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    assertMaxBytes(total, maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

  if (process.platform === "win32") {
    await params.scopedRoot.write(
      relativePath,
      await readStreamIntoBuffer(params.stream, params.maxBytes),
      {
        mkdir: false,
        mode: params.mode,
      },
    );
    return;
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

function isNotFound(error: unknown): boolean {
  return error instanceof FsSafeError
    ? error.code === "not-found"
    : (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR";
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
  const privateMode = options.private ?? false;
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const maxBytes = options.maxBytes;

  async function openRoot(): Promise<Root> {
    return await root(rootDir, { hardlinks: "reject", maxBytes });
  }

  async function write(
    relativePath: string,
    data: string | Uint8Array,
    writeOptions?: FileStoreWriteOptions,
  ): Promise<string> {
    const safeRelativePath = assertRelativePath(relativePath);
    const destination = resolveStorePath(rootDir, safeRelativePath);
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
    if (privateMode) {
      await writeSecretFileAtomic({
        rootDir,
        filePath: destination,
        content,
        dirMode: writeOptions?.dirMode ?? dirMode,
        mode: writeOptions?.mode ?? mode,
      });
      return destination;
    }
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
  }

  return {
    rootDir,
    path: (relativePath) => resolveStorePath(rootDir, relativePath),
    root: openRoot,
    write,
    writeStream: async (relativePath, stream, writeOptions) => {
      const safeRelativePath = assertRelativePath(relativePath);
      const destination = resolveStorePath(rootDir, safeRelativePath);
      const limit = writeOptions?.maxBytes ?? maxBytes;
      if (privateMode) {
        await writeSecretFileAtomic({
          rootDir,
          filePath: destination,
          content: await readStreamIntoBuffer(stream, limit),
          dirMode: writeOptions?.dirMode ?? dirMode,
          mode: writeOptions?.mode ?? mode,
        });
        return destination;
      }
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
      privateMode
        ? await (async () => {
            const sourceStat = await fs.lstat(sourcePath);
            if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
              throw new FsSafeError("not-file", "source path is not a file");
            }
            assertMaxBytes(sourceStat.size, writeOptions?.maxBytes ?? maxBytes);
            return await write(relativePath, await fs.readFile(sourcePath), writeOptions);
          })()
        : await copyIntoRoot({
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
    readText: async (relativePath, readOptions) => {
      const { encoding = "utf8", ...options } = readOptions ?? {};
      return (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
        .toString(encoding);
    },
    readTextIfExists: async (relativePath, readOptions) => {
      try {
        return await (await openRoot()).readText(assertRelativePath(relativePath), readOptions);
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    readJson: async <T = unknown>(relativePath: string, readOptions?: FileStoreReadOptions) => {
      const { encoding = "utf8", ...options } = readOptions ?? {};
      return JSON.parse(
        (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
          .toString(encoding),
      ) as T;
    },
    readJsonIfExists: async <T = unknown>(
      relativePath: string,
      readOptions?: FileStoreReadOptions,
    ) => {
      try {
        return await (await openRoot()).readJson<T>(assertRelativePath(relativePath), readOptions);
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    remove: async (relativePath) => {
      await (await openRoot()).remove(assertRelativePath(relativePath));
    },
    exists: async (relativePath) => await (await openRoot()).exists(assertRelativePath(relativePath)),
    writeText: async (relativePath, data, writeOptions) => await write(relativePath, data, writeOptions),
    writeJson: async (relativePath, data, writeOptions) => {
      const json = JSON.stringify(data, null, 2);
      return await write(
        relativePath,
        writeOptions?.trailingNewline === false ? json : `${json}\n`,
        writeOptions,
      );
    },
    json: <T = unknown>(relativePath: string, jsonOptions?: JsonFileStoreOptions) => {
      const filePath = resolveStorePath(rootDir, relativePath);
      return createJsonStore<T>(
        {
          filePath,
          readIfExists: async () => {
            try {
              return await (await openRoot()).readJson<T>(assertRelativePath(relativePath));
            } catch (error) {
              if (isNotFound(error)) {
                return null;
              }
              throw error;
            }
          },
          readRequired: async () =>
            await (await openRoot()).readJson<T>(assertRelativePath(relativePath)),
          write: async (value, options) => {
            const json = JSON.stringify(value, null, 2);
            await write(
              relativePath,
              options?.trailingNewline === false ? json : `${json}\n`,
            );
          },
        },
        jsonOptions,
      );
    },
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

function chmodDirectorySyncBestEffort(dir: string, mode: number): void {
  try {
    syncFs.chmodSync(dir, mode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
}

function assertDirectoryInsideRootSync(params: {
  rootReal: string;
  dir: string;
  messagePrefix: string;
}): string {
  const stat = syncFs.lstatSync(params.dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", `${params.messagePrefix} must be a directory: ${params.dir}`);
  }
  const realPath = syncFs.realpathSync(params.dir);
  if (!isPathInside(params.rootReal, realPath)) {
    throw new FsSafeError("outside-workspace", `${params.messagePrefix} escapes root`);
  }
  return realPath;
}

function ensureStoreDirectorySync(params: {
  rootDir: string;
  targetDir: string;
  mode: number;
  privateMode: boolean;
}): string {
  const root = path.resolve(params.rootDir);
  const target = path.resolve(params.targetDir);
  const label = params.privateMode ? "private store directory" : "store directory";
  assertStoreFilePath(root, target);
  syncFs.mkdirSync(root, { recursive: true, mode: params.mode });
  const rootStat = syncFs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FsSafeError("not-file", `${label} root must be a directory: ${root}`);
  }
  const rootReal = syncFs.realpathSync(root);
  chmodDirectorySyncBestEffort(root, params.mode);

  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = syncFs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError("not-file", `${label} component must be a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      syncFs.mkdirSync(current, { mode: params.mode });
      const createdStat = syncFs.lstatSync(current);
      if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
        throw new FsSafeError("not-file", `${label} component must be a directory: ${current}`);
      }
    }
    assertDirectoryInsideRootSync({
      rootReal,
      dir: current,
      messagePrefix: label,
    });
    chmodDirectorySyncBestEffort(current, params.mode);
  }

  return assertDirectoryInsideRootSync({
    rootReal,
    dir: target,
    messagePrefix: label,
  });
}

function ensurePrivateDirectorySync(rootDir: string, targetDir: string, mode: number): void {
  ensureStoreDirectorySync({ rootDir, targetDir, mode, privateMode: true });
}

function writeFileSyncAtomic(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
  privateMode: boolean;
  dirMode: number;
  mode: number;
}): string {
  const filePath = path.resolve(params.filePath);
  assertStoreFilePath(params.rootDir, filePath);
  const parentDir = path.dirname(filePath);
  const parentRealPath = params.privateMode
    ? undefined
    : ensureStoreDirectorySync({
        rootDir: params.rootDir,
        targetDir: parentDir,
        mode: params.dirMode,
        privateMode: false,
      });
  if (params.privateMode) {
    ensurePrivateDirectorySync(params.rootDir, path.dirname(filePath), params.dirMode);
    try {
      const stat = syncFs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new FsSafeError("not-file", `private store target must be a regular file: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  const tempPath = path.join(parentDir, `.fs-safe-${process.pid}-${randomUUID()}.tmp`);
  let tempExists = false;
  try {
    syncFs.writeFileSync(tempPath, params.content, { flag: "wx", mode: params.mode });
    tempExists = true;
    try {
      syncFs.chmodSync(tempPath, params.mode);
    } catch {
      // Best-effort on platforms that do not enforce POSIX modes.
    }
    if (parentRealPath !== undefined && syncFs.realpathSync(parentDir) !== parentRealPath) {
      throw new FsSafeError("path-mismatch", "store parent directory changed during write");
    }
    syncFs.renameSync(tempPath, filePath);
    tempExists = false;
    try {
      syncFs.chmodSync(filePath, params.mode);
    } catch {
      // Best-effort on platforms that do not enforce POSIX modes.
    }
    return filePath;
  } finally {
    if (tempExists) {
      try {
        syncFs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup after write failure.
      }
    }
  }
}

export function fileStoreSync(options: FileStoreOptions): FileStoreSync {
  const rootDir = path.resolve(options.rootDir);
  const privateMode = options.private ?? false;
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const maxBytes = options.maxBytes;

  function write(
    relativePath: string,
    data: string | Uint8Array,
    writeOptions?: FileStoreWriteOptions,
  ): string {
    const destination = resolveStorePath(rootDir, relativePath);
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
    return writeFileSyncAtomic({
      rootDir,
      filePath: destination,
      content,
      privateMode,
      dirMode: writeOptions?.dirMode ?? dirMode,
      mode: writeOptions?.mode ?? mode,
    });
  }

  return {
    rootDir,
    path: (relativePath) => resolveStorePath(rootDir, relativePath),
    readTextIfExists: (relativePath, readOptions) => {
      const targetPath = resolveStorePath(rootDir, relativePath);
      try {
        const stat = syncFs.lstatSync(targetPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new FsSafeError("not-file", "store target is not a file");
        }
        assertMaxBytes(stat.size, readOptions?.maxBytes ?? maxBytes);
        if (privateMode && stat.nlink > 1) {
          throw new FsSafeError("hardlink", "private store target must not be hardlinked");
        }
        return syncFs.readFileSync(targetPath, "utf8");
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
    readJsonIfExists: <T = unknown>(relativePath: string, readOptions?: { maxBytes?: number }) => {
      const raw = fileStoreSync({ rootDir, private: privateMode, dirMode, mode, maxBytes })
        .readTextIfExists(relativePath, readOptions);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    write,
    writeText: (relativePath, data, writeOptions) => write(relativePath, data, writeOptions),
    writeJson: (relativePath, data, writeOptions) => {
      const json = JSON.stringify(data, null, 2);
      return write(
        relativePath,
        writeOptions?.trailingNewline === false ? json : `${json}\n`,
        writeOptions,
      );
    },
  };
}
