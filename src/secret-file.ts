import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { resolveHomeRelativePath } from "./home-dir.js";
import { openPinnedFileSync } from "./pinned-open.js";

export const DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;
export const PRIVATE_SECRET_DIR_MODE = 0o700;
export const PRIVATE_SECRET_FILE_MODE = 0o600;

export type SecretFileReadOptions = {
  maxBytes?: number;
  rejectSymlink?: boolean;
};

type SecretFileReadOutcome =
  | { ok: true; secret: string }
  | { ok: false; code: FsSafeErrorCode; message: string; error?: unknown };

function normalizeSecretReadError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveUserPath(input: string): string {
  return resolveHomeRelativePath(input);
}

function readSecretFileOutcomeSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): SecretFileReadOutcome {
  const trimmedPath = filePath.trim();
  const resolvedPath = resolveUserPath(trimmedPath);
  if (!resolvedPath) {
    return { ok: false, code: "invalid-path", message: `${label} file path is empty.` };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_SECRET_FILE_MAX_BYTES;

  let previewStat: fs.Stats;
  try {
    previewStat = fs.lstatSync(resolvedPath);
  } catch (error) {
    const normalized = normalizeSecretReadError(error);
    return {
      ok: false,
      code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "invalid-path",
      error: normalized,
      message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  }

  if (previewStat.isSymbolicLink()) {
    if (!options.rejectSymlink) {
      try {
        previewStat = fs.statSync(resolvedPath);
      } catch (error) {
        const normalized = normalizeSecretReadError(error);
        return {
          ok: false,
          code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "invalid-path",
          error: normalized,
          message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(normalized)}`,
        };
      }
    } else {
      return {
        ok: false,
        code: "symlink",
        message: `${label} file at ${resolvedPath} must not be a symlink.`,
      };
    }
  }
  if (!previewStat.isFile()) {
    return {
      ok: false,
      code: "not-file",
      message: `${label} file at ${resolvedPath} must be a regular file.`,
    };
  }
  if (previewStat.size > maxBytes) {
    return {
      ok: false,
      code: "too-large",
      message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`,
    };
  }

  const opened = openPinnedFileSync({
    filePath: resolvedPath,
    rejectPathSymlink: options.rejectSymlink,
    maxBytes,
  });
  if (!opened.ok) {
    const error = normalizeSecretReadError(
      opened.reason === "validation" ? new Error("security validation failed") : opened.error,
    );
    return {
      ok: false,
      code: opened.reason === "path" ? "not-found" : "path-mismatch",
      error,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`,
    };
  }

  try {
    const raw = fs.readFileSync(opened.fd, "utf8");
    const secret = raw.trim();
    if (!secret) {
      return {
        ok: false,
        code: "invalid-path",
        message: `${label} file at ${resolvedPath} is empty.`,
      };
    }
    return { ok: true, secret };
  } catch (error) {
    const normalized = normalizeSecretReadError(error);
    return {
      ok: false,
      code: "invalid-path",
      error: normalized,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function readSecretFileSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): string {
  const result = readSecretFileOutcomeSync(filePath, label, options);
  if (result.ok) {
    return result.secret;
  }
  throw new FsSafeError(result.code, result.message, {
    cause: result.error,
  });
}

export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: SecretFileReadOptions = {},
): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  const result = readSecretFileOutcomeSync(filePath, label, options);
  return result.ok ? result.secret : undefined;
}

function assertPathWithinRoot(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Private secret path must stay under ${rootDir}.`);
  }
}

function assertRealPathWithinRoot(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Private secret path must stay under ${rootDir}.`);
  }
}

async function enforcePrivatePathMode(
  resolvedPath: string,
  expectedMode: number,
  kind: "directory" | "file",
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await fsp.chmod(resolvedPath, expectedMode);
  const stat = await fsp.stat(resolvedPath);
  const actualMode = stat.mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(
      `Private secret ${kind} ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`,
    );
  }
}

async function ensurePrivateDirectory(
  rootDir: string,
  targetDir: string,
  mode: number,
): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetDir);
  if (resolvedTarget === resolvedRoot) {
    await fsp.mkdir(resolvedRoot, { recursive: true, mode });
    const rootStat = await fsp.lstat(resolvedRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error(`Private secret root ${resolvedRoot} must not be a symlink.`);
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`Private secret root ${resolvedRoot} must be a directory.`);
    }
    await enforcePrivatePathMode(resolvedRoot, mode, "directory");
    return;
  }

  assertPathWithinRoot(resolvedRoot, resolvedTarget);
  await ensurePrivateDirectory(resolvedRoot, resolvedRoot, mode);
  const resolvedRootReal = await fsp.realpath(resolvedRoot);

  let current = resolvedRoot;
  for (const segment of path
    .relative(resolvedRoot, resolvedTarget)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Private secret directory component ${current} must not be a symlink.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Private secret directory component ${current} must be a directory.`);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await fsp.mkdir(current, { mode });
    }
    const currentReal = await fsp.realpath(current);
    assertRealPathWithinRoot(resolvedRootReal, currentReal);
    await enforcePrivatePathMode(currentReal, mode, "directory");
  }
}

export async function writeSecretFileAtomic(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
  mode?: number;
  dirMode?: number;
}): Promise<void> {
  const mode = params.mode ?? PRIVATE_SECRET_FILE_MODE;
  const dirMode = params.dirMode ?? PRIVATE_SECRET_DIR_MODE;
  const resolvedRoot = path.resolve(params.rootDir);
  const resolvedFile = path.resolve(params.filePath);
  assertPathWithinRoot(resolvedRoot, resolvedFile);
  const intendedParentDir = path.dirname(resolvedFile);
  await ensurePrivateDirectory(resolvedRoot, intendedParentDir, dirMode);
  const resolvedRootReal = await fsp.realpath(resolvedRoot);
  const parentDir = await fsp.realpath(intendedParentDir);
  assertRealPathWithinRoot(resolvedRootReal, parentDir);
  const parentGuard = await createAsyncDirectoryGuard(parentDir);
  const fileName = path.basename(resolvedFile);
  const finalFilePath = path.join(parentDir, fileName);

  try {
    const stat = await fsp.lstat(finalFilePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Private secret file ${finalFilePath} must not be a symlink.`);
    }
    if (!stat.isFile()) {
      throw new Error(`Private secret file ${finalFilePath} must be a regular file.`);
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = path.join(
    parentDir,
    `.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`,
  );
  let createdTemp = false;
  try {
    const handle = await fsp.open(tempPath, "wx", mode);
    createdTemp = true;
    try {
      await handle.writeFile(params.content);
    } finally {
      await handle.close();
    }
    await enforcePrivatePathMode(tempPath, mode, "file");
    const refreshedParentReal = await fsp.realpath(intendedParentDir);
    if (refreshedParentReal !== parentDir) {
      throw new Error(`Private secret parent directory changed during write for ${finalFilePath}.`);
    }
    await withAsyncDirectoryGuards([parentGuard], async () => {
      await fsp.rename(tempPath, finalFilePath);
    });
    createdTemp = false;
    await enforcePrivatePathMode(finalFilePath, mode, "file");
  } finally {
    if (createdTemp) {
      await fsp.unlink(tempPath).catch(() => undefined);
    }
  }
}
