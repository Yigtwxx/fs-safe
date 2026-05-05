import { randomUUID } from "node:crypto";
import syncFs from "node:fs";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { registerTempPathForExit } from "./temp-cleanup.js";
import { serializePathWrite } from "./write-queue.js";

export type ReplaceFileAtomicFileSystem = {
  promises: Pick<
    typeof fs,
    | "mkdir"
    | "chmod"
    | "writeFile"
    | "rename"
    | "copyFile"
    | "unlink"
    | "rm"
    | "open"
    | "stat"
    | "lstat"
  >;
};

export type ReplaceFileAtomicSyncFileSystem = Pick<
  typeof syncFs,
  | "mkdirSync"
  | "chmodSync"
  | "writeFileSync"
  | "renameSync"
  | "copyFileSync"
  | "unlinkSync"
  | "rmSync"
  | "openSync"
  | "fsyncSync"
  | "closeSync"
  | "statSync"
  | "lstatSync"
>;

type ReplaceFileAtomicBaseOptions = {
  filePath: string;
  content: string | Uint8Array;
  dirMode?: number;
  mode?: number;
  preserveExistingMode?: boolean;
  tempPrefix?: string;
  renameMaxRetries?: number;
  renameRetryBaseDelayMs?: number;
  copyFallbackOnPermissionError?: boolean;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
  throwOnCleanupError?: boolean;
};

export type ReplaceFileAtomicOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicFileSystem;
  beforeRename?: (params: { filePath: string; tempPath: string }) => Promise<void>;
};

export type ReplaceFileAtomicSyncOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicSyncFileSystem;
  beforeRename?: (params: { filePath: string; tempPath: string }) => void;
};

export type ReplaceFileAtomicResult = {
  method: "rename" | "copy-fallback";
};

function isRetryableRenameError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EBUSY";
}

function isPermissionRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EEXIST";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(params: {
  fsModule: ReplaceFileAtomicFileSystem["promises"];
  src: string;
  dest: string;
  maxRetries: number;
  baseDelayMs: number;
  copyFallbackOnPermissionError: boolean;
}): Promise<ReplaceFileAtomicResult> {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    try {
      await params.fsModule.rename(params.src, params.dest);
      return { method: "rename" };
    } catch (error) {
      if (isRetryableRenameError(error) && attempt < params.maxRetries) {
        await sleep(params.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (params.copyFallbackOnPermissionError && isPermissionRenameError(error)) {
        const stat = await params.fsModule.lstat(params.dest).catch((lstatError) => {
          if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw lstatError;
        });
        if (stat?.isSymbolicLink()) {
          throw new Error(`Refusing copy fallback through symlink destination: ${params.dest}`);
        }
        await params.fsModule.copyFile(params.src, params.dest);
        await params.fsModule.unlink(params.src).catch(() => undefined);
        return { method: "copy-fallback" };
      }
      throw error;
    }
  }
  throw new Error("Atomic rename retry loop exhausted.");
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetrySync(params: {
  fsModule: ReplaceFileAtomicSyncFileSystem;
  src: string;
  dest: string;
  maxRetries: number;
  baseDelayMs: number;
  copyFallbackOnPermissionError: boolean;
}): ReplaceFileAtomicResult {
  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    try {
      params.fsModule.renameSync(params.src, params.dest);
      return { method: "rename" };
    } catch (error) {
      if (isRetryableRenameError(error) && attempt < params.maxRetries) {
        sleepSync(params.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (params.copyFallbackOnPermissionError && isPermissionRenameError(error)) {
        let stat: Stats | null = null;
        try {
          stat = params.fsModule.lstatSync(params.dest);
        } catch (lstatError) {
          if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw lstatError;
          }
        }
        if (stat?.isSymbolicLink()) {
          throw new Error(`Refusing copy fallback through symlink destination: ${params.dest}`);
        }
        params.fsModule.copyFileSync(params.src, params.dest);
        try {
          params.fsModule.unlinkSync(params.src);
        } catch {
          // Best-effort cleanup after fallback replacement.
        }
        return { method: "copy-fallback" };
      }
      throw error;
    }
  }
  throw new Error("Atomic rename retry loop exhausted.");
}

function validateReplaceFilePath(filePath: string): void {
  if (!filePath || filePath.includes("\0")) {
    throw new Error("Atomic replace file path must be non-empty.");
  }
}

function buildReplaceTempPath(filePath: string, tempPrefix?: string): string {
  const dir = path.dirname(filePath);
  return path.join(dir, `${tempPrefix ?? ".fs-safe-replace"}.${process.pid}.${randomUUID()}.tmp`);
}

async function resolveMode(options: ReplaceFileAtomicOptions): Promise<number> {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  const stat = await (options.fileSystem?.promises ?? fs).stat(options.filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  return stat ? stat.mode : defaultMode;
}

function resolveModeSync(options: ReplaceFileAtomicSyncOptions): number {
  const defaultMode = options.mode ?? 0o600;
  if (!options.preserveExistingMode) {
    return defaultMode;
  }
  const fsModule = options.fileSystem ?? syncFs;
  let stat: Stats | undefined;
  try {
    stat = fsModule.statSync(options.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return stat ? stat.mode : defaultMode;
}

async function syncTempFile(fsModule: ReplaceFileAtomicFileSystem["promises"], tempPath: string) {
  const handle = await fsModule.open(tempPath, "r+");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function syncTempFileSync(fsModule: ReplaceFileAtomicSyncFileSystem, tempPath: string): void {
  const fd = fsModule.openSync(tempPath, "r+");
  try {
    fsModule.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  } finally {
    fsModule.closeSync(fd);
  }
}

async function syncDirectoryBestEffort(
  fsModule: ReplaceFileAtomicFileSystem["promises"],
  dirPath: string,
): Promise<void> {
  let handle: Awaited<ReturnType<ReplaceFileAtomicFileSystem["promises"]["open"]>> | undefined;
  try {
    handle = await fsModule.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Best-effort on platforms/filesystems that do not support directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function syncDirectoryBestEffortSync(
  fsModule: ReplaceFileAtomicSyncFileSystem,
  dirPath: string,
): void {
  let fd: number | undefined;
  try {
    fd = fsModule.openSync(dirPath, "r");
    fsModule.fsyncSync(fd);
  } catch {
    // Best-effort on platforms/filesystems that do not support directory fsync.
  } finally {
    if (fd !== undefined) {
      try {
        fsModule.closeSync(fd);
      } catch {
        // Best-effort close after directory fsync.
      }
    }
  }
}

async function cleanupTempFile(params: {
  fsModule: ReplaceFileAtomicFileSystem["promises"];
  tempPath: string;
  originalError?: unknown;
  throwOnCleanupError: boolean;
}): Promise<void> {
  const cleanupError = await params.fsModule
    .rm(params.tempPath, { force: true })
    .catch((error) => error);
  if (cleanupError && params.throwOnCleanupError && params.originalError !== undefined) {
    throw new Error(
      `Atomic file replace failed (${String(params.originalError)}); cleanup also failed (${String(cleanupError)})`,
      { cause: params.originalError },
    );
  }
}

export async function replaceFileAtomic(
  options: ReplaceFileAtomicOptions,
): Promise<ReplaceFileAtomicResult> {
  const filePath = options.filePath;
  validateReplaceFilePath(filePath);
  return await serializePathWrite(path.resolve(filePath), async () => {
    return await replaceFileAtomicUnserialized(options);
  });
}

async function replaceFileAtomicUnserialized(
  options: ReplaceFileAtomicOptions,
): Promise<ReplaceFileAtomicResult> {
  const filePath = options.filePath;
  const fsModule = options.fileSystem?.promises ?? fs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = await resolveMode(options);
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const unregisterTempPath = registerTempPathForExit(tempPath);
  let tempExists = false;
  let originalError: unknown;

  await fsModule.mkdir(dir, { recursive: true, mode: dirMode });
  await fsModule.chmod(dir, dirMode).catch(() => undefined);
  try {
    tempExists = true;
    await fsModule.writeFile(tempPath, options.content, { mode, flag: "wx" });
    if (options.syncTempFile) {
      await syncTempFile(fsModule, tempPath);
    }
    if (options.beforeRename) {
      await options.beforeRename({ filePath, tempPath });
    }
    const result = await renameWithRetry({
      fsModule,
      src: tempPath,
      dest: filePath,
      maxRetries: options.renameMaxRetries ?? 0,
      baseDelayMs: options.renameRetryBaseDelayMs ?? 50,
      copyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true,
    });
    tempExists = false;
    unregisterTempPath();
    await fsModule.chmod(filePath, mode).catch(() => undefined);
    if (options.syncParentDir) {
      await syncDirectoryBestEffort(fsModule, dir);
    }
    return result;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    if (tempExists) {
      await cleanupTempFile({
        fsModule,
        tempPath,
        originalError,
        throwOnCleanupError: options.throwOnCleanupError === true,
      });
    }
    unregisterTempPath();
  }
}

export function replaceFileAtomicSync(
  options: ReplaceFileAtomicSyncOptions,
): ReplaceFileAtomicResult {
  const filePath = options.filePath;
  validateReplaceFilePath(filePath);
  const fsModule = options.fileSystem ?? syncFs;
  const dir = path.dirname(filePath);
  const dirMode = options.dirMode ?? 0o700;
  const mode = resolveModeSync(options);
  const tempPath = buildReplaceTempPath(filePath, options.tempPrefix);
  const unregisterTempPath = registerTempPathForExit(tempPath);
  let tempExists = false;
  let originalError: unknown;

  fsModule.mkdirSync(dir, { recursive: true, mode: dirMode });
  try {
    fsModule.chmodSync(dir, dirMode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
  try {
    tempExists = true;
    fsModule.writeFileSync(tempPath, options.content, { mode, flag: "wx" });
    if (options.syncTempFile) {
      syncTempFileSync(fsModule, tempPath);
    }
    if (options.beforeRename) {
      options.beforeRename({ filePath, tempPath });
    }
    const result = renameWithRetrySync({
      fsModule,
      src: tempPath,
      dest: filePath,
      maxRetries: options.renameMaxRetries ?? 0,
      baseDelayMs: options.renameRetryBaseDelayMs ?? 50,
      copyFallbackOnPermissionError: options.copyFallbackOnPermissionError === true,
    });
    tempExists = false;
    unregisterTempPath();
    try {
      fsModule.chmodSync(filePath, mode);
    } catch {
      // Best-effort on platforms that do not enforce POSIX modes.
    }
    if (options.syncParentDir) {
      syncDirectoryBestEffortSync(fsModule, dir);
    }
    return result;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    if (tempExists) {
      try {
        fsModule.rmSync(tempPath, { force: true });
      } catch (cleanupError) {
        if (options.throwOnCleanupError && originalError !== undefined) {
          throw new Error(
            `Atomic file replace failed (${String(originalError)}); cleanup also failed (${String(cleanupError)})`,
            { cause: originalError },
          );
        }
        // The temp file is best-effort cleanup after write failure.
      }
    }
    unregisterTempPath();
  }
}
