import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRegularFile, readRegularFileSync } from "./regular-file.js";

const JSON_FILE_MODE = 0o600;
const JSON_DIR_MODE = 0o700;
const SUPPORTS_SYNC_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants;

function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

function trySetSecureMode(pathname: string) {
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(
      pathname,
      fsSync.constants.O_RDONLY |
        (SUPPORTS_SYNC_NOFOLLOW ? fsSync.constants.O_NOFOLLOW : 0),
    );
    fsSync.fchmodSync(fd, JSON_FILE_MODE);
  } catch {
    // best-effort on platforms without chmod support
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function trySyncDirectory(pathname: string) {
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(path.dirname(pathname), "r");
    fsSync.fsyncSync(fd);
  } catch {
    // best-effort; some platforms/filesystems do not support syncing directories.
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function renameJsonFileWithFallback(tmpPath: string, pathname: string) {
  try {
    fsSync.renameSync(tmpPath, pathname);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EEXIST") {
      const existing = (() => {
        try {
          return fsSync.lstatSync(pathname);
        } catch (lstatError) {
          if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw lstatError;
        }
      })();
      if (existing?.isSymbolicLink()) {
        fsSync.rmSync(pathname, { force: true });
        fsSync.renameSync(tmpPath, pathname);
        return;
      }
      fsSync.copyFileSync(tmpPath, pathname);
      fsSync.rmSync(tmpPath, { force: true });
      return;
    }
    throw error;
  }
}

function writeTempJsonFile(pathname: string, payload: string) {
  const fd = fsSync.openSync(pathname, "wx", JSON_FILE_MODE);
  try {
    fsSync.writeFileSync(fd, payload, "utf8");
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
}

export function tryReadJsonSync<T = unknown>(pathname: string): T | null {
  try {
    const raw = readRegularFileSync({ filePath: pathname }).buffer.toString("utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonSync(pathname: string, data: unknown) {
  const targetPath = pathname;
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  fsSync.mkdirSync(path.dirname(targetPath), { recursive: true, mode: JSON_DIR_MODE });
  try {
    writeTempJsonFile(tmpPath, payload);
    trySetSecureMode(tmpPath);
    renameJsonFileWithFallback(tmpPath, targetPath);
    trySetSecureMode(targetPath);
    trySyncDirectory(targetPath);
  } finally {
    try {
      fsSync.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup when rename does not happen
    }
  }
}

export class JsonFileReadError extends Error {
  readonly filePath: string;
  readonly reason: "read" | "parse";

  constructor(filePath: string, reason: "read" | "parse", cause: unknown) {
    super(`Failed to ${reason} JSON file: ${filePath}`, { cause });
    this.name = "JsonFileReadError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

async function replaceFileWithWindowsFallback(tempPath: string, filePath: string, mode: number) {
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    const code = getErrorCode(err);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw err;
    }
  }

  const existing = await fs.lstat(filePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
    return;
  }

  await fs.copyFile(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
}

export async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = (await readRegularFile({ filePath })).buffer.toString("utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  let raw: string;
  try {
    raw = (await readRegularFile({ filePath })).buffer.toString("utf8");
  } catch (err) {
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = (await readRegularFile({ filePath })).buffer.toString("utf8");
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") {
      return null;
    }
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export function readJsonSync<T = unknown>(filePath: string): T {
  let raw: string;
  try {
    raw = readRegularFileSync({ filePath }).buffer.toString("utf8");
  } catch (err) {
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export async function writeJson(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; dirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  await writeText(filePath, text, {
    mode: options?.mode,
    dirMode: options?.dirMode,
    trailingNewline: options?.trailingNewline,
  });
}

export async function writeText(
  filePath: string,
  content: string,
  options?: { mode?: number; dirMode?: number; trailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.dirMode === "number") {
    mkdirOptions.mode = options.dirMode;
  }
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const parentDir = path.dirname(filePath);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await replaceFileWithWindowsFallback(tmp, filePath, mode);
    try {
      const dirHandle = await fs.open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    } catch {
      // best-effort; some platforms/filesystems do not support syncing directories.
    }
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
