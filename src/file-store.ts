import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FsSafeError } from "./errors.js";
import { root, type OpenResult, type ReadResult, type Root, type RootReadOptions } from "./root.js";
import { writeSiblingTempFile } from "./sibling-temp.js";
import { resolveSafeRelativePath } from "./path.js";

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
  readText(
    relativePath: string,
    options?: RootReadOptions & { encoding?: BufferEncoding },
  ): Promise<string>;
  readJson<T = unknown>(
    relativePath: string,
    options?: RootReadOptions & { encoding?: BufferEncoding },
  ): Promise<T>;
  remove(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  writeText(
    relativePath: string,
    data: string,
    options?: FileStoreWriteOptions,
  ): Promise<string>;
  writeJson(
    relativePath: string,
    data: unknown,
    options?: FileStoreWriteOptions & { trailingNewline?: boolean },
  ): Promise<string>;
  pruneExpired(options: FileStorePruneOptions): Promise<void>;
};

function assertRelativePath(relativePath: string): string {
  const raw = relativePath.trim();
  if (!raw) {
    throw new FsSafeError("invalid-path", "relative path must be non-empty");
  }
  return raw.replaceAll("\\", "/");
}

function resolveStorePath(rootDir: string, relativePath: string): string {
  return resolveSafeRelativePath(rootDir, assertRelativePath(relativePath));
}

async function ensureParent(filePath: string, mode: number): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode });
  await fs.chmod(dir, mode).catch(() => undefined);
}

function assertMaxBytes(size: number, maxBytes?: number): void {
  if (maxBytes !== undefined && size > maxBytes) {
    throw new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`);
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
  const destination = resolveStorePath(params.rootDir, params.relativePath);
  const sourceStat = await fs.lstat(params.sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new FsSafeError("not-file", "source path is not a file");
  }
  assertMaxBytes(sourceStat.size, params.maxBytes);
  await ensureParent(destination, params.dirMode ?? 0o700);
  const result = await writeSiblingTempFile({
    dir: path.dirname(destination),
    dirMode: params.dirMode ?? 0o700,
    mode: params.mode ?? 0o600,
    tempPrefix: params.tempPrefix ?? `.${path.basename(destination)}`,
    writeTemp: async (tempPath) => {
      await fs.copyFile(params.sourcePath, tempPath);
    },
    resolveFinalPath: () => destination,
    syncTempFile: true,
    syncParentDir: true,
  });
  return result.filePath;
}

export function fileStore(options: FileStoreOptions): FileStore {
  const rootDir = path.resolve(options.rootDir);
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const maxBytes = options.maxBytes;

  async function openRoot(): Promise<Root> {
    return await root(rootDir, { hardlinks: "reject", maxBytes });
  }

  async function write(
    relativePath: string,
    data: string | Buffer,
    writeOptions?: FileStoreWriteOptions,
  ): Promise<string> {
    const destination = resolveStorePath(rootDir, relativePath);
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
    await ensureParent(destination, writeOptions?.dirMode ?? dirMode);
    const result = await writeSiblingTempFile({
      dir: path.dirname(destination),
      dirMode: writeOptions?.dirMode ?? dirMode,
      mode: writeOptions?.mode ?? mode,
      tempPrefix: writeOptions?.tempPrefix ?? `.${path.basename(destination)}`,
      writeTemp: async (tempPath) => {
        await fs.writeFile(tempPath, content);
      },
      resolveFinalPath: () => destination,
      syncTempFile: true,
      syncParentDir: true,
    });
    return result.filePath;
  }

  return {
    rootDir,
    path: (relativePath) => resolveStorePath(rootDir, relativePath),
    root: openRoot,
    write,
    writeStream: async (relativePath, stream, writeOptions) => {
      const destination = resolveStorePath(rootDir, relativePath);
      const limit = writeOptions?.maxBytes ?? maxBytes;
      await ensureParent(destination, writeOptions?.dirMode ?? dirMode);
      let total = 0;
      const result = await writeSiblingTempFile({
        dir: path.dirname(destination),
        dirMode: writeOptions?.dirMode ?? dirMode,
        mode: writeOptions?.mode ?? mode,
        tempPrefix: writeOptions?.tempPrefix ?? `.${path.basename(destination)}`,
        writeTemp: async (tempPath) => {
          const writable = await fs.open(tempPath, "w", writeOptions?.mode ?? mode);
          try {
            const out = writable.createWriteStream();
            stream.on("data", (chunk: Buffer | string) => {
              total += Buffer.byteLength(chunk);
              if (limit !== undefined && total > limit) {
                stream.destroy(
                  new FsSafeError("too-large", `file exceeds maximum size of ${limit} bytes`),
                );
              }
            });
            await pipeline(stream, out);
          } finally {
            await writable.close().catch(() => undefined);
          }
        },
        resolveFinalPath: () => destination,
        syncTempFile: true,
        syncParentDir: true,
      });
      return result.filePath;
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
    readText: async (relativePath, readOptions) => {
      const { encoding = "utf8", ...options } = readOptions ?? {};
      return (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
        .toString(encoding);
    },
    readJson: async <T = unknown>(
      relativePath: string,
      readOptions?: RootReadOptions & { encoding?: BufferEncoding },
    ) => {
      const { encoding = "utf8", ...options } = readOptions ?? {};
      return JSON.parse(
        (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
          .toString(encoding),
      ) as T;
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
