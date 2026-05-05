import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isPinnedPathHelperSpawnError, runPinnedPathHelper } from "./pinned-path.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import { expandHomePrefix } from "./home-dir.js";
import { assertNoPathAliasEscape, PATH_ALIAS_POLICIES } from "./path-policy.js";
import {
  hasNodeErrorCode,
  isNotFoundPathError,
  isPathInside,
  isSymlinkOpenError,
} from "./path.js";
import { helperReaddir, helperStat, runPinnedHelper } from "./pinned-helper.js";
import { resolveRootPath } from "./root-path.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import type { DirEntry, PathStat } from "./types.js";

export type OpenResult = {
  handle: FileHandle;
  realPath: string;
  stat: Stats;
};

export type ReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: Stats;
};

type RootContext = {
  rootDir: string;
  rootReal: string;
  rootWithSep: string;
};

export type RootOptions = {
  rootDir: string;
  defaults?: RootDefaults;
};

export type SymlinkPolicy = "reject" | "follow-within-root";
export type HardlinkPolicy = "reject" | "allow";

export type RootDefaults = {
  encoding?: BufferEncoding;
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  mkdir?: boolean;
  nonBlockingRead?: boolean;
  symlinks?: SymlinkPolicy;
};

export type RootReadOptions = Pick<
  RootDefaults,
  "hardlinks" | "maxBytes" | "nonBlockingRead" | "symlinks"
>;

export type RootOpenOptions = Omit<RootReadOptions, "maxBytes">;

export type RootWriteOptions = Pick<RootDefaults, "encoding" | "mkdir">;

export type RootOpenWritableOptions = Pick<RootDefaults, "mkdir"> & {
  mode?: number;
  truncateExisting?: boolean;
  append?: boolean;
};

export type RootCopyOptions = Pick<RootDefaults, "maxBytes" | "mkdir"> & {
  sourceHardlinks?: HardlinkPolicy;
};

export type RootWriteJsonOptions = RootWriteOptions & {
  replacer?: Parameters<typeof JSON.stringify>[1];
  space?: Parameters<typeof JSON.stringify>[2];
  trailingNewline?: boolean;
};

export type RootCreateOptions = RootWriteOptions;
export type RootCreateJsonOptions = RootWriteJsonOptions;

export type RootAppendOptions = RootWriteOptions & {
  prependNewlineIfNeeded?: boolean;
};

type RootReadParams = RootReadOptions;

function logWarn(message: string): void {
  if (process.env.FS_SAFE_DEBUG_WARNINGS === "1") {
    console.warn(message);
  }
}

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const NONBLOCK_OPEN_FLAG = "O_NONBLOCK" in fsConstants ? fsConstants.O_NONBLOCK : 0;
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_READ_NONBLOCK_FLAGS = OPEN_READ_FLAGS | NONBLOCK_OPEN_FLAG;
const OPEN_READ_FOLLOW_FLAGS = fsConstants.O_RDONLY;
const OPEN_READ_FOLLOW_NONBLOCK_FLAGS = OPEN_READ_FOLLOW_FLAGS | NONBLOCK_OPEN_FLAG;
const OPEN_WRITE_EXISTING_FLAGS =
  fsConstants.O_WRONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_APPEND | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_CREATE_FLAGS =
  fsConstants.O_RDWR |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

const ensureTrailingSep = (value: string) => (value.endsWith(path.sep) ? value : value + path.sep);

let cachedHomePath: { raw: string; real: string } | undefined;

async function expandRelativePathWithHome(relativePath: string): Promise<string> {
  const rawHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (cachedHomePath?.raw !== rawHome) {
    let realHome = rawHome;
    try {
      realHome = await fs.realpath(rawHome);
    } catch {
      // If the home dir cannot be canonicalized, keep lexical expansion behavior.
    }
    cachedHomePath = { raw: rawHome, real: realHome };
  }
  return expandHomePrefix(relativePath, { home: cachedHomePath.real });
}

async function openVerifiedLocalFile(
  filePath: string,
  options?: {
    hardlinks?: HardlinkPolicy;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
  },
): Promise<OpenResult> {
  const fsSafeTestHooks = getFsSafeTestHooks();
  // Reject directories before opening so we never surface EISDIR to callers (e.g. tool
  // results that get sent to messaging channels). See openclaw/openclaw#31186.
  try {
    const preStat = await fs.lstat(filePath);
    if (preStat.isDirectory()) {
      throw new FsSafeError("not-file", "not a file");
    }
    await fsSafeTestHooks?.afterPreOpenLstat?.(filePath);
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    // ENOENT and other lstat errors: fall through and let fs.open handle.
  }

  let handle: FileHandle;
  try {
    const openFlags = options?.symlinks === "follow-within-root"
      ? options?.nonBlockingRead
        ? OPEN_READ_FOLLOW_NONBLOCK_FLAGS
        : OPEN_READ_FOLLOW_FLAGS
      : options?.nonBlockingRead
        ? OPEN_READ_NONBLOCK_FLAGS
        : OPEN_READ_FLAGS;
    await fsSafeTestHooks?.beforeOpen?.(filePath, openFlags);
    handle = await fs.open(filePath, openFlags);
    try {
      await fsSafeTestHooks?.afterOpen?.(filePath, handle);
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "file not found");
    }
    if (isSymlinkOpenError(err)) {
      throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
    }
    // Defensive: if open still throws EISDIR (e.g. race), sanitize so it never leaks.
    if (hasNodeErrorCode(err, "EISDIR")) {
      throw new FsSafeError("not-file", "not a file");
    }
    throw err;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "not a file");
    }
    if (options?.hardlinks === "reject" && stat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }

    if (options?.symlinks === "follow-within-root") {
      const pathStat = await fs.stat(filePath);
      if (!sameFileIdentity(stat, pathStat)) {
        throw new FsSafeError("path-mismatch", "path changed during read");
      }
    } else {
      const pathStat = await fs.lstat(filePath);
      if (pathStat.isSymbolicLink()) {
        throw new FsSafeError("symlink", "symlink not allowed");
      }
      if (!sameFileIdentity(stat, pathStat)) {
        throw new FsSafeError("path-mismatch", "path changed during read");
      }
    }

    const realPath = await resolveOpenedFileRealPathForHandle(handle, filePath);
    const realStat = await fs.stat(realPath);
    if (options?.hardlinks === "reject" && realStat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }
    if (!sameFileIdentity(stat, realStat)) {
      throw new FsSafeError("path-mismatch", "path mismatch");
    }

    return { handle, realPath, stat };
  } catch (err) {
    await handle.close().catch(() => {});
    if (err instanceof FsSafeError) {
      throw err;
    }
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "file not found");
    }
    throw err;
  }
}

async function resolveRootContext(rootDir: string): Promise<RootContext> {
  let rootReal: string;
  try {
    rootReal = await fs.realpath(rootDir);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "root dir not found");
    }
    throw err;
  }
  return {
    rootDir: path.resolve(rootDir),
    rootReal,
    rootWithSep: ensureTrailingSep(rootReal),
  };
}

async function resolvePathInRoot(
  root: RootContext,
  relativePath: string,
): Promise<{ rootReal: string; rootWithSep: string; resolved: string }> {
  const expanded = await expandRelativePathWithHome(relativePath);
  const resolved = path.resolve(root.rootWithSep, expanded);
  if (!isPathInside(root.rootWithSep, resolved)) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }
  return { rootReal: root.rootReal, rootWithSep: root.rootWithSep, resolved };
}

async function resolvePathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
}): Promise<{ rootReal: string; rootWithSep: string; resolved: string }> {
  return await resolvePathInRoot(
    await resolveRootContext(params.rootDir),
    params.relativePath,
  );
}

export interface Root {
  readonly rootDir: string;
  readonly rootReal: string;
  readonly rootWithSep: string;
  readonly defaults: RootDefaults;

  resolve(relativePath: string): Promise<string>;
  open(relativePath: string, options?: RootOpenOptions): Promise<OpenResult>;
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
  readPath(filePath: string, options?: RootReadOptions): Promise<ReadResult>;
  reader(options?: RootReadOptions): (filePath: string) => Promise<Buffer>;
  openWritable(
    relativePath: string,
    options?: RootOpenWritableOptions,
  ): Promise<WritableOpenResult>;
  append(
    relativePath: string,
    data: string | Buffer,
    options?: RootAppendOptions,
  ): Promise<void>;
  remove(relativePath: string): Promise<void>;
  mkdir(relativePath: string): Promise<void>;
  ensureRoot(): Promise<void>;
  write(
    relativePath: string,
    data: string | Buffer,
    options?: RootWriteOptions,
  ): Promise<void>;
  create(
    relativePath: string,
    data: string | Buffer,
    options?: RootCreateOptions,
  ): Promise<void>;
  writeJson(
    relativePath: string,
    data: unknown,
    options?: RootWriteJsonOptions,
  ): Promise<void>;
  createJson(
    relativePath: string,
    data: unknown,
    options?: RootCreateJsonOptions,
  ): Promise<void>;
  copyIn(relativePath: string, sourcePath: string, options?: RootCopyOptions): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<PathStat>;
  list(relativePath: string, options?: { withFileTypes?: false }): Promise<string[]>;
  list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  move(
    fromRelative: string,
    toRelative: string,
    options?: { overwrite?: boolean },
  ): Promise<void>;
}

class RootHandle implements Root {
  readonly rootDir: string;
  readonly rootReal: string;
  readonly rootWithSep: string;
  readonly defaults: RootDefaults;

  constructor(context: RootContext, defaults: RootDefaults = {}) {
    this.rootDir = context.rootDir;
    this.rootReal = context.rootReal;
    this.rootWithSep = context.rootWithSep;
    this.defaults = defaults;
  }

  private get context(): RootContext {
    return {
      rootDir: this.rootDir,
      rootReal: this.rootReal,
      rootWithSep: this.rootWithSep,
    };
  }

  async resolve(relativePath: string): Promise<string> {
    return (await resolvePathInRoot(this.context, relativePath)).resolved;
  }

  async open(relativePath: string, options: RootOpenOptions = {}): Promise<OpenResult> {
    return await openFileInRoot(this.context, {
      relativePath,
      ...readDefaults(this.defaults),
      ...options,
    });
  }

  async read(
    relativePath: string,
    options: RootReadOptions = {},
  ): Promise<ReadResult> {
    return await readFileInRoot(this.context, {
      relativePath,
      ...readDefaults(this.defaults),
      ...options,
    });
  }

  async readBytes(relativePath: string, options: RootReadOptions = {}): Promise<Buffer> {
    return (await this.read(relativePath, options)).buffer;
  }

  async readText(
    relativePath: string,
    options: RootReadOptions & { encoding?: BufferEncoding } = {},
  ): Promise<string> {
    const { encoding = this.defaults.encoding ?? "utf8", ...readOptions } = options;
    return (await this.read(relativePath, readOptions)).buffer.toString(encoding);
  }

  async readJson<T = unknown>(
    relativePath: string,
    options: RootReadOptions & { encoding?: BufferEncoding } = {},
  ): Promise<T> {
    return JSON.parse(await this.readText(relativePath, options)) as T;
  }

  async readPath(
    filePath: string,
    options: RootReadOptions = {},
  ): Promise<ReadResult> {
    return await readPathInRoot(this.context, {
      filePath,
      ...readDefaults(this.defaults),
      ...options,
    });
  }

  reader(options: RootReadOptions = {}) {
    return async (filePath: string): Promise<Buffer> => {
      return (await this.readPath(filePath, options)).buffer;
    };
  }

  async openWritable(
    relativePath: string,
    options: RootOpenWritableOptions = {},
  ): Promise<WritableOpenResult> {
    return await openWritableFileInRoot(this.context, {
      relativePath,
      mkdir: this.defaults.mkdir,
      ...options,
    });
  }

  async append(
    relativePath: string,
    data: string | Buffer,
    options: RootAppendOptions = {},
  ): Promise<void> {
    await appendFileInRoot(this.context, {
      relativePath,
      data,
      encoding: this.defaults.encoding,
      mkdir: this.defaults.mkdir,
      ...options,
    });
  }

  async remove(relativePath: string): Promise<void> {
    await removePathInRoot(this.context, relativePath);
  }

  async mkdir(relativePath: string): Promise<void> {
    await mkdirPathInRoot(this.context, { relativePath });
  }

  async ensureRoot(): Promise<void> {
    await mkdirPathInRoot(this.context, { relativePath: "", allowRoot: true });
  }

  async write(
    relativePath: string,
    data: string | Buffer,
    options: RootWriteOptions = {},
  ): Promise<void> {
    await writeFileInRoot(this.context, {
      relativePath,
      data,
      encoding: this.defaults.encoding,
      mkdir: this.defaults.mkdir,
      ...options,
    });
  }

  async create(
    relativePath: string,
    data: string | Buffer,
    options: RootCreateOptions = {},
  ): Promise<void> {
    await writeFileInRoot(this.context, {
      relativePath,
      data,
      encoding: this.defaults.encoding,
      mkdir: this.defaults.mkdir,
      ...options,
      overwrite: false,
    });
  }

  async writeJson(
    relativePath: string,
    data: unknown,
    options: RootWriteJsonOptions = {},
  ): Promise<void> {
    const { replacer, space, trailingNewline = true, ...writeOptions } = options;
    const json = JSON.stringify(data, replacer, space);
    await this.write(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
  }

  async createJson(
    relativePath: string,
    data: unknown,
    options: RootCreateJsonOptions = {},
  ): Promise<void> {
    const { replacer, space, trailingNewline = true, ...writeOptions } = options;
    const json = JSON.stringify(data, replacer, space);
    await this.create(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
  }

  async copyIn(
    relativePath: string,
    sourcePath: string,
    options: RootCopyOptions = {},
  ): Promise<void> {
    await copyFileInRoot(this.context, {
      sourcePath,
      relativePath,
      maxBytes: this.defaults.maxBytes,
      mkdir: this.defaults.mkdir,
      ...options,
    });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.stat(relativePath);
      return true;
    } catch (err) {
      if (err instanceof FsSafeError && err.code === "not-found") {
        return false;
      }
      throw err;
    }
  }

  async stat(relativePath: string): Promise<PathStat> {
    return await helperStat(this.rootReal, relativePath);
  }

  async list(relativePath: string, options?: { withFileTypes?: false }): Promise<string[]>;
  async list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  async list(
    relativePath: string,
    options: { withFileTypes?: boolean } = {},
  ): Promise<string[] | DirEntry[]> {
    return options.withFileTypes === true
      ? await helperReaddir(this.rootReal, relativePath, true)
      : await helperReaddir(this.rootReal, relativePath, false);
  }

  async move(
    fromRelative: string,
    toRelative: string,
    options: { overwrite?: boolean } = {},
  ): Promise<void> {
    await runPinnedHelper<void>("rename", this.rootReal, {
      from: fromRelative,
      overwrite: options.overwrite ?? false,
      to: toRelative,
    });
  }
}

function readDefaults(defaults: RootDefaults): RootReadParams {
  return {
    hardlinks: defaults.hardlinks,
    maxBytes: defaults.maxBytes,
    nonBlockingRead: defaults.nonBlockingRead,
    symlinks: defaults.symlinks,
  };
}

export async function root(
  rootDir: string,
  defaults: RootDefaults = {},
): Promise<Root> {
  return new RootHandle(await resolveRootContext(rootDir), defaults);
}

async function openFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    hardlinks?: HardlinkPolicy;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
  },
): Promise<OpenResult> {
  const { rootWithSep, resolved } = await resolvePathInRoot(root, params.relativePath);

  let opened: OpenResult;
  try {
    opened = await openVerifiedLocalFile(resolved, {
      nonBlockingRead: params.nonBlockingRead,
      symlinks: params.symlinks,
    });
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    throw err;
  }

  if (params.hardlinks !== "allow" && opened.stat.nlink > 1) {
    await opened.handle.close().catch(() => {});
    throw new FsSafeError("hardlink", "hardlinked path not allowed");
  }

  if (!isPathInside(rootWithSep, opened.realPath)) {
    await opened.handle.close().catch(() => {});
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }

  return opened;
}

async function readFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    hardlinks?: HardlinkPolicy;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
    maxBytes?: number;
  },
): Promise<ReadResult> {
  const opened = await openFileInRoot(root, params);
  try {
    return await readOpenedFileSafely({ opened, maxBytes: params.maxBytes });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function readPathInRoot(
  root: RootContext,
  params: {
    filePath: string;
    hardlinks?: HardlinkPolicy;
    maxBytes?: number;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
  },
): Promise<ReadResult> {
  const rootDir = root.rootDir;
  const candidatePath = path.isAbsolute(params.filePath)
    ? path.resolve(params.filePath)
    : path.resolve(rootDir, params.filePath);
  const relativePath = path.relative(rootDir, candidatePath);
  return await readFileInRoot(root, {
    relativePath,
    hardlinks: params.hardlinks,
    maxBytes: params.maxBytes,
    nonBlockingRead: params.nonBlockingRead,
    symlinks: params.symlinks,
  });
}

export async function readLocalFileSafely(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<ReadResult> {
  const opened = await openLocalFileSafely({ filePath: params.filePath });
  try {
    return await readOpenedFileSafely({ opened, maxBytes: params.maxBytes });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function openLocalFileSafely(params: { filePath: string }): Promise<OpenResult> {
  return await openVerifiedLocalFile(params.filePath);
}

async function readOpenedFileSafely(params: {
  opened: OpenResult;
  maxBytes?: number;
}): Promise<ReadResult> {
  if (params.maxBytes !== undefined && params.opened.stat.size > params.maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`,
    );
  }
  const buffer = await params.opened.handle.readFile();
  return {
    buffer,
    realPath: params.opened.realPath,
    stat: params.opened.stat,
  };
}

export type WritableOpenResult = {
  handle: FileHandle;
  createdForWrite: boolean;
  realPath: string;
  stat: Stats;
};

function emitWriteBoundaryWarning(reason: string) {
  logWarn(`security: fs-safe write boundary warning (${reason})`);
}

function buildAtomicWriteTempPath(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}

function createMaxBytesTransform(maxBytes: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(
          new FsSafeError(
            "too-large",
            `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`,
          ),
        );
        return;
      }
      callback(null, buffer);
    },
  });
}

function createBoundedReadStream(opened: OpenResult, maxBytes: number | undefined) {
  const stream = opened.handle.createReadStream();
  return maxBytes === undefined ? stream : stream.pipe(createMaxBytesTransform(maxBytes));
}

async function writeTempFileForAtomicReplace(params: {
  tempPath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mode: number;
}): Promise<Stats> {
  const tempHandle = await fs.open(params.tempPath, OPEN_WRITE_CREATE_FLAGS, params.mode);
  try {
    if (typeof params.data === "string") {
      await tempHandle.writeFile(params.data, params.encoding ?? "utf8");
    } else {
      await tempHandle.writeFile(params.data);
    }
    return await tempHandle.stat();
  } finally {
    await tempHandle.close().catch(() => {});
  }
}

async function verifyAtomicWriteResult(params: {
  root: RootContext;
  targetPath: string;
  expectedIdentity: { dev: number | bigint; ino: number | bigint };
}): Promise<void> {
  const opened = await openVerifiedLocalFile(params.targetPath, { hardlinks: "reject" });
  try {
    if (!sameFileIdentity(opened.stat, params.expectedIdentity)) {
      throw new FsSafeError("path-mismatch", "path changed during write");
    }
    if (!isPathInside(params.root.rootWithSep, opened.realPath)) {
      throw new FsSafeError("outside-workspace", "file is outside workspace root");
    }
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function resolveOpenedFileRealPathForHandle(
  handle: FileHandle,
  ioPath: string,
): Promise<string> {
  const handleStat = await handle.stat();
  const fdCandidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${handle.fd}`];
  for (const fdPath of fdCandidates) {
    try {
      const fdRealPath = await fs.realpath(fdPath);
      const fdRealStat = await fs.stat(fdRealPath);
      if (sameFileIdentity(handleStat, fdRealStat)) {
        return fdRealPath;
      }
    } catch {
      // try next fd path
    }
  }

  try {
    const ioRealPath = await fs.realpath(ioPath);
    const ioRealStat = await fs.stat(ioRealPath);
    if (sameFileIdentity(handleStat, ioRealStat)) {
      return ioRealPath;
    }
  } catch (err) {
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }
  const parentResolved = await resolveOpenedFileRealPathFromParent(handleStat, ioPath);
  if (parentResolved) {
    return parentResolved;
  }
  throw new FsSafeError("path-mismatch", "unable to resolve opened file path");
}

async function resolveOpenedFileRealPathFromParent(
  handleStat: Stats,
  ioPath: string,
): Promise<string | null> {
  let parentReal: string;
  try {
    parentReal = await fs.realpath(path.dirname(ioPath));
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return null;
    }
    throw err;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(parentReal);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return null;
    }
    throw err;
  }

  for (const entry of entries.toSorted()) {
    const candidatePath = path.join(parentReal, entry);
    try {
      const candidateStat = await fs.lstat(candidatePath);
      if (candidateStat.isFile() && sameFileIdentity(handleStat, candidateStat)) {
        return await fs.realpath(candidatePath);
      }
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
    }
  }
  return null;
}

async function openWritableFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    mkdir?: boolean;
    mode?: number;
    truncateExisting?: boolean;
    append?: boolean;
  },
): Promise<WritableOpenResult> {
  const { rootReal, rootWithSep, resolved } = await resolvePathInRoot(
    root,
    params.relativePath,
  );
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }
  if (params.mkdir !== false) {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
  }

  let ioPath = resolved;
  try {
    const resolvedRealPath = await fs.realpath(resolved);
    if (!isPathInside(rootWithSep, resolvedRealPath)) {
      throw new FsSafeError("outside-workspace", "file is outside workspace root");
    }
    ioPath = resolvedRealPath;
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }

  const fileMode = params.mode ?? 0o600;

  let handle: FileHandle;
  let createdForWrite = false;
  const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
  const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
  try {
    try {
      handle = await fs.open(ioPath, existingFlags, fileMode);
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
      handle = await fs.open(ioPath, createFlags, fileMode);
      createdForWrite = true;
    }
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "file not found");
    }
    if (isSymlinkOpenError(err)) {
      throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
    }
    throw err;
  }

  let realPathForCleanup: string | null = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new FsSafeError("invalid-path", "path is not a regular file under root");
    }
    if (stat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }

    try {
      const lstat = await fs.lstat(ioPath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        throw new FsSafeError(
          lstat.isSymbolicLink() ? "symlink" : "not-file",
          "path is not a regular file under root",
        );
      }
      if (!sameFileIdentity(stat, lstat)) {
        throw new FsSafeError("path-mismatch", "path changed during write");
      }
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
    }

    const realPath = await resolveOpenedFileRealPathForHandle(handle, ioPath);
    realPathForCleanup = realPath;
    const realStat = await fs.stat(realPath);
    if (!sameFileIdentity(stat, realStat)) {
      throw new FsSafeError("path-mismatch", "path mismatch");
    }
    if (realStat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }
    if (!isPathInside(rootWithSep, realPath)) {
      throw new FsSafeError("outside-workspace", "file is outside workspace root");
    }

    // Truncate only after boundary and identity checks complete. This avoids
    // irreversible side effects if a symlink target changes before validation.
    if (params.append !== true && params.truncateExisting !== false && !createdForWrite) {
      await handle.truncate(0);
    }
    return {
      handle,
      createdForWrite,
      realPath,
      stat,
    };
  } catch (err) {
    const cleanupCreatedPath = createdForWrite && err instanceof FsSafeError;
    const cleanupPath = realPathForCleanup ?? ioPath;
    await handle.close().catch(() => {});
    if (cleanupCreatedPath) {
      await fs.rm(cleanupPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

async function appendFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    prependNewlineIfNeeded?: boolean;
  },
): Promise<void> {
  const target = await openWritableFileInRoot(root, {
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    truncateExisting: false,
    append: true,
  });
  try {
    let prefix = "";
    if (
      params.prependNewlineIfNeeded === true &&
      !target.createdForWrite &&
      target.stat.size > 0 &&
      ((typeof params.data === "string" && !params.data.startsWith("\n")) ||
        (Buffer.isBuffer(params.data) && params.data.length > 0 && params.data[0] !== 0x0a))
    ) {
      const lastByte = Buffer.alloc(1);
      const { bytesRead } = await target.handle.read(lastByte, 0, 1, target.stat.size - 1);
      if (bytesRead === 1 && lastByte[0] !== 0x0a) {
        prefix = "\n";
      }
    }

    if (typeof params.data === "string") {
      await target.handle.appendFile(`${prefix}${params.data}`, params.encoding ?? "utf8");
      return;
    }

    const payload =
      prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
    await target.handle.appendFile(payload);
  } finally {
    await target.handle.close().catch(() => {});
  }
}

async function removePathInRoot(root: RootContext, relativePath: string): Promise<void> {
  const resolved = await resolvePinnedRemovePathInRoot(root, relativePath);
  if (process.platform === "win32") {
    await removePathFallback(resolved);
    return;
  }
  try {
    await runPinnedPathHelper({
      operation: "remove",
      rootPath: resolved.rootReal,
      relativePath: resolved.relativePosix,
    });
  } catch (error) {
    if (isPinnedPathHelperSpawnError(error)) {
      await removePathFallback(resolved);
      return;
    }
    throw normalizePinnedPathError(error);
  }
}

async function mkdirPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    allowRoot?: boolean;
  },
): Promise<void> {
  const resolved = await resolvePinnedPathInRoot(root, params);
  if (process.platform === "win32") {
    await mkdirPathFallback(resolved);
    return;
  }
  try {
    await runPinnedPathHelper({
      operation: "mkdirp",
      rootPath: resolved.rootReal,
      relativePath: resolved.relativePosix,
    });
  } catch (error) {
    if (isPinnedPathHelperSpawnError(error)) {
      await mkdirPathFallback(resolved);
      return;
    }
    throw normalizePinnedPathError(error);
  }
}

async function writeFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    overwrite?: boolean;
  },
): Promise<void> {
  if (process.platform === "win32") {
    await writeFileFallback(root, params);
    return;
  }

  const pinned = await resolvePinnedWriteTargetInRoot(root, params.relativePath);

  let identity;
  try {
    identity = await runPinnedWriteHelper({
      rootPath: pinned.rootReal,
      relativeParentPath: pinned.relativeParentPath,
      basename: pinned.basename,
      mkdir: params.mkdir !== false,
      mode: pinned.mode,
      overwrite: params.overwrite,
      input: {
        kind: "buffer",
        data: params.data,
        encoding: params.encoding,
      },
    });
  } catch (error) {
    if (params.overwrite === false && isAlreadyExistsError(error)) {
      throw new FsSafeError("already-exists", "file already exists", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw normalizePinnedWriteError(error);
  }

  try {
    await verifyAtomicWriteResult({
      root,
      targetPath: pinned.targetPath,
      expectedIdentity: identity,
    });
  } catch (err) {
    emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
    throw err;
  }
}

async function copyFileInRoot(
  root: RootContext,
  params: {
    sourcePath: string;
    relativePath: string;
    maxBytes?: number;
    mkdir?: boolean;
    sourceHardlinks?: HardlinkPolicy;
  },
): Promise<void> {
  const source = await openVerifiedLocalFile(params.sourcePath, {
    hardlinks: params.sourceHardlinks,
  });
  if (params.maxBytes !== undefined && source.stat.size > params.maxBytes) {
    await source.handle.close().catch(() => {});
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`,
    );
  }

  try {
    if (process.platform === "win32") {
      await copyFileFallback(root, params, source);
      return;
    }

    const pinned = await resolvePinnedWriteTargetInRoot(root, params.relativePath);
    const sourceStream = createBoundedReadStream(source, params.maxBytes);
    const identity = await runPinnedWriteHelper({
      rootPath: pinned.rootReal,
      relativeParentPath: pinned.relativeParentPath,
      basename: pinned.basename,
      mkdir: params.mkdir !== false,
      mode: pinned.mode,
      overwrite: true,
      input: {
        kind: "stream",
        stream: sourceStream,
      },
    }).catch((error) => {
      throw normalizePinnedWriteError(error);
    });
    try {
      await verifyAtomicWriteResult({
        root,
        targetPath: pinned.targetPath,
        expectedIdentity: identity,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
      throw err;
    }
  } finally {
    await source.handle.close().catch(() => {});
  }
}

async function resolvePinnedWriteTargetInRoot(
  root: RootContext,
  relativePath: string,
): Promise<{
  rootReal: string;
  targetPath: string;
  relativeParentPath: string;
  basename: string;
  mode: number;
}> {
  const { rootReal, rootWithSep, resolved } = await resolvePathInRoot(root, relativePath);
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }

  const relativeResolved = path.relative(rootReal, resolved);
  if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }
  const relativePosix = relativeResolved
    ? relativeResolved.split(path.sep).join(path.posix.sep)
    : "";
  const basename = path.posix.basename(relativePosix);
  if (!basename || basename === "." || basename === "/") {
    throw new FsSafeError("invalid-path", "invalid target path");
  }
  let mode = 0o600;
  try {
    const opened = await openFileInRoot(root, {
      relativePath,
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    try {
      mode = opened.stat.mode & 0o777;
      if (!isPathInside(rootWithSep, opened.realPath)) {
        throw new FsSafeError("outside-workspace", "file is outside workspace root");
      }
    } finally {
      await opened.handle.close().catch(() => {});
    }
  } catch (err) {
    if (!(err instanceof FsSafeError) || err.code !== "not-found") {
      throw err;
    }
  }

  return {
    rootReal,
    targetPath: resolved,
    relativeParentPath:
      path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix),
    basename,
    mode: mode || 0o600,
  };
}

async function resolvePinnedPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    allowRoot?: boolean;
  },
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  const resolved = await resolvePinnedRootPathInRoot(root, {
    relativePath: params.relativePath,
    policy: PATH_ALIAS_POLICIES.strict,
  });
  const relativeResolved = path.relative(resolved.rootReal, resolved.canonicalPath);
  if ((relativeResolved === "" || relativeResolved === ".") && params.allowRoot === true) {
    return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix: "" };
  }
  if (
    relativeResolved === "" ||
    relativeResolved === "." ||
    relativeResolved.startsWith("..") ||
    path.isAbsolute(relativeResolved)
  ) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }

  const relativePosix = relativeResolved.split(path.sep).join(path.posix.sep);
  if (!isPathInside(resolved.rootWithSep, resolved.canonicalPath)) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }

  return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix };
}

async function resolvePinnedRemovePathInRoot(
  root: RootContext,
  relativePath: string,
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  const resolved = await resolvePinnedRootPathInRoot(root, {
    relativePath,
    policy: PATH_ALIAS_POLICIES.unlinkTarget,
  });
  const relativeResolved = path.relative(resolved.rootReal, resolved.canonicalPath);
  if (
    relativeResolved === "" ||
    relativeResolved === "." ||
    relativeResolved.startsWith("..") ||
    path.isAbsolute(relativeResolved)
  ) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }
  const relativePosix = relativeResolved.split(path.sep).join(path.posix.sep);
  if (!isPathInside(resolved.rootWithSep, resolved.canonicalPath)) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }

  const parentRelative = path.posix.dirname(relativePosix);
  if (parentRelative === "." || parentRelative === "") {
    return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix };
  }
  return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix };
}

async function resolvePinnedRootPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    policy: (typeof PATH_ALIAS_POLICIES)[keyof typeof PATH_ALIAS_POLICIES];
  },
): Promise<{ rootReal: string; rootWithSep: string; canonicalPath: string }> {
  const rootReal = root.rootReal;
  let resolved;
  try {
    resolved = await resolveRootPath({
      absolutePath: path.resolve(rootReal, await expandRelativePathWithHome(params.relativePath)),
      rootPath: rootReal,
      rootCanonicalPath: rootReal,
      boundaryLabel: "root",
      policy: params.policy,
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }
  const rootWithSep = ensureTrailingSep(resolved.rootCanonicalPath);
  return {
    rootReal: resolved.rootCanonicalPath,
    rootWithSep,
    canonicalPath: resolved.canonicalPath,
  };
}

function normalizePinnedWriteError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  return new FsSafeError("invalid-path", "path is not a regular file under root", {
    cause: error instanceof Error ? error : undefined,
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasNodeErrorCode(error, "EEXIST") || /File exists|EEXIST/i.test(String(error));
}

function normalizePinnedPathError(error: unknown): Error {
  if (error instanceof FsSafeError) {
    return error;
  }
  return new FsSafeError("path-alias", "path is not under root", {
    cause: error instanceof Error ? error : undefined,
  });
}

async function removePathFallback(resolved: { resolved: string }): Promise<void> {
  await fs.rm(resolved.resolved);
}

async function mkdirPathFallback(resolved: { resolved: string }): Promise<void> {
  await fs.mkdir(resolved.resolved, { recursive: true });
}

async function writeFileFallback(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    overwrite?: boolean;
  },
): Promise<void> {
  if (params.overwrite === false) {
    await writeMissingFileFallback(root, params);
    return;
  }

  const target = await openWritableFileInRoot(root, {
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    truncateExisting: false,
  });
  const destinationPath = target.realPath;
  const targetMode = target.stat.mode & 0o777;
  await target.handle.close().catch(() => {});
  let tempPath: string | null = null;
  try {
    tempPath = buildAtomicWriteTempPath(destinationPath);
    const writtenStat = await writeTempFileForAtomicReplace({
      tempPath,
      data: params.data,
      encoding: params.encoding,
      mode: targetMode || 0o600,
    });
    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    try {
      await verifyAtomicWriteResult({
        root,
        targetPath: destinationPath,
        expectedIdentity: writtenStat,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
      throw err;
    }
  } finally {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

async function writeMissingFileFallback(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
  },
): Promise<void> {
  const { rootReal, resolved } = await resolvePathInRoot(root, params.relativePath);
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }
  if (params.mkdir !== false) {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
  }

  let handle: FileHandle | null = null;
  let created = false;
  try {
    handle = await fs.open(resolved, OPEN_WRITE_CREATE_FLAGS, 0o600);
    created = true;
    if (typeof params.data === "string") {
      await handle.writeFile(params.data, params.encoding ?? "utf8");
    } else {
      await handle.writeFile(params.data);
    }
    const writtenStat = await handle.stat();
    await handle.close();
    handle = null;
    await verifyAtomicWriteResult({
      root,
      targetPath: resolved,
      expectedIdentity: writtenStat,
    });
    created = false;
  } catch (err) {
    if (hasNodeErrorCode(err, "EEXIST")) {
      throw new FsSafeError("already-exists", "file already exists", {
        cause: err instanceof Error ? err : undefined,
      });
    }
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
    if (created) {
      await fs.rm(resolved, { force: true }).catch(() => undefined);
    }
  }
}

async function copyFileFallback(
  root: RootContext,
  params: {
    sourcePath: string;
    relativePath: string;
    maxBytes?: number;
    mkdir?: boolean;
    sourceHardlinks?: HardlinkPolicy;
  },
  source: OpenResult,
): Promise<void> {
  let target: WritableOpenResult | null = null;
  let sourceClosedByStream = false;
  let targetClosedByUs = false;
  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let tempClosedByStream = false;
  try {
    target = await openWritableFileInRoot(root, {
      relativePath: params.relativePath,
      mkdir: params.mkdir,
      truncateExisting: false,
    });
    const destinationPath = target.realPath;
    const targetMode = target.stat.mode & 0o777;
    await target.handle.close().catch(() => {});
    targetClosedByUs = true;

    tempPath = buildAtomicWriteTempPath(destinationPath);
    tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 0o600);
    const sourceStream = createBoundedReadStream(source, params.maxBytes);
    const targetStream = tempHandle.createWriteStream();
    sourceStream.once("close", () => {
      sourceClosedByStream = true;
    });
    targetStream.once("close", () => {
      tempClosedByStream = true;
    });
    await pipeline(sourceStream, targetStream);
    const writtenStat = await fs.stat(tempPath);
    if (!tempClosedByStream) {
      await tempHandle.close().catch(() => {});
      tempClosedByStream = true;
    }
    tempHandle = null;
    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    try {
      await verifyAtomicWriteResult({
        root,
        targetPath: destinationPath,
        expectedIdentity: writtenStat,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
      throw err;
    }
  } catch (err) {
    if (target?.createdForWrite) {
      await fs.rm(target.realPath, { force: true }).catch(() => {});
    }
    throw err;
  } finally {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    if (!sourceClosedByStream) {
      await source.handle.close().catch(() => {});
    }
    if (tempHandle && !tempClosedByStream) {
      await tempHandle.close().catch(() => {});
    }
    if (target && !targetClosedByUs) {
      await target.handle.close().catch(() => {});
    }
  }
}
