import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  type AsyncDirectoryGuard,
  createAsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";

export type AbsolutePathSymlinkPolicy = "reject" | "follow";

export type ResolvedAbsolutePath = {
  path: string;
  canonicalPath: string;
};

export type ResolvedWritableAbsolutePath = ResolvedAbsolutePath & {
  parentDir: string;
  parentExists: boolean;
};

export type EnsureAbsoluteDirectoryOptions = {
  scopeLabel?: string;
  mode?: number;
};

export type EnsureAbsoluteDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; code: FsSafeErrorCode; error: FsSafeError };

type EnsureAbsoluteDirectoryFailure = Extract<EnsureAbsoluteDirectoryResult, { ok: false }>;
type DirectoryGuardCheckResult = { ok: true } | EnsureAbsoluteDirectoryFailure;
type DirectoryGuardCreateResult =
  | { ok: true; guard: AsyncDirectoryGuard }
  | EnsureAbsoluteDirectoryFailure;

function ensureDirectoryFailure(
  code: FsSafeErrorCode,
  message: string,
  cause?: unknown,
): EnsureAbsoluteDirectoryFailure {
  return {
    ok: false,
    code,
    error: new FsSafeError(code, message, { cause }),
  };
}

async function assertGuardResult(
  guard: AsyncDirectoryGuard,
): Promise<DirectoryGuardCheckResult> {
  try {
    await assertAsyncDirectoryGuard(guard);
    return { ok: true };
  } catch (err) {
    if (err instanceof FsSafeError) {
      return { ok: false, code: err.code, error: err };
    }
    throw err;
  }
}

async function createDirectoryGuardResult(
  dir: string,
): Promise<DirectoryGuardCreateResult> {
  try {
    return { ok: true, guard: await createAsyncDirectoryGuard(dir) };
  } catch (err) {
    if (err instanceof FsSafeError) {
      return { ok: false, code: err.code, error: err };
    }
    throw err;
  }
}

export function assertAbsolutePathInput(filePath: string): string {
  if (!filePath) {
    throw new FsSafeError("invalid-path", "path is required");
  }
  if (filePath.includes("\0")) {
    throw new FsSafeError("invalid-path", "path must not contain NUL bytes");
  }
  if (!path.isAbsolute(filePath)) {
    throw new FsSafeError("invalid-path", "path must be absolute");
  }
  return path.normalize(filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findExistingAncestor(filePath: string): Promise<string | null> {
  return (await findExistingAncestorWithStat(filePath))?.path ?? null;
}

async function findExistingAncestorWithStat(filePath: string): Promise<{
  path: string;
  stat: Stats;
} | null> {
  let current = path.resolve(filePath);
  while (true) {
    try {
      return { path: current, stat: await fs.lstat(current) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function ensureAbsoluteDirectory(
  dirPath: string,
  options: EnsureAbsoluteDirectoryOptions = {},
): Promise<EnsureAbsoluteDirectoryResult> {
  const scopeLabel = options.scopeLabel ?? "directory";
  let targetPath: string;
  try {
    targetPath = assertAbsolutePathInput(dirPath);
  } catch (err) {
    if (err instanceof FsSafeError) {
      return { ok: false, code: err.code, error: err };
    }
    throw err;
  }

  const ancestor = await findExistingAncestorWithStat(targetPath);
  if (!ancestor) {
    return ensureDirectoryFailure(
      "not-found",
      `directory path must have a real existing ancestor within ${scopeLabel}`,
    );
  }

  if (ancestor.stat.isSymbolicLink()) {
    return ensureDirectoryFailure("symlink", `directory path traverses a symlink within ${scopeLabel}`);
  }
  if (!ancestor.stat.isDirectory()) {
    return ensureDirectoryFailure("not-file", `path must be a real directory within ${scopeLabel}`);
  }

  const ancestorDir = ancestor.path;
  const relativeDir = path.relative(ancestorDir, targetPath);
  let current = ancestorDir;
  let currentGuard: AsyncDirectoryGuard = {
    dir: ancestorDir,
    realPath: await fs.realpath(ancestorDir),
    stat: ancestor.stat,
  };
  for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    while (true) {
      const guardResult = await assertGuardResult(currentGuard);
      if (!guardResult.ok) {
        return guardResult;
      }
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          return ensureDirectoryFailure(
            "symlink",
            `directory path traverses a symlink within ${scopeLabel}`,
          );
        }
        if (!stat.isDirectory()) {
          return ensureDirectoryFailure(
            "not-file",
            `path must be a real directory within ${scopeLabel}`,
          );
        }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
        const parentStillValid = await assertGuardResult(currentGuard);
        if (!parentStillValid.ok) {
          return parentStillValid;
        }
        try {
          await fs.mkdir(current, { mode: options.mode });
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException).code === "EEXIST") {
            continue;
          }
          throw mkdirErr;
        }
      }
    }
    const nextGuard = await createDirectoryGuardResult(current);
    if (!nextGuard.ok) {
      return nextGuard;
    }
    const previousGuardStillValid = await assertGuardResult(currentGuard);
    if (!previousGuardStillValid.ok) {
      return previousGuardStillValid;
    }
    currentGuard = nextGuard.guard;
  }

  const finalGuardResult = await assertGuardResult(currentGuard);
  if (!finalGuardResult.ok) {
    return finalGuardResult;
  }
  return { ok: true, path: targetPath };
}

export async function canonicalPathFromExistingAncestor(filePath: string): Promise<string> {
  const ancestor = await findExistingAncestor(filePath);
  if (!ancestor) {
    return path.resolve(filePath);
  }
  let canonicalAncestor = ancestor;
  try {
    canonicalAncestor = await fs.realpath(ancestor);
  } catch {
    // Keep lexical path when the existing ancestor cannot be canonicalized.
  }
  const relative = path.relative(ancestor, filePath);
  return relative ? path.join(canonicalAncestor, relative) : canonicalAncestor;
}

export async function resolveAbsolutePathForRead(
  filePath: string,
  options: { symlinks?: AbsolutePathSymlinkPolicy } = {},
): Promise<ResolvedAbsolutePath> {
  const normalized = assertAbsolutePathInput(filePath);
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(normalized);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FsSafeError("not-found", "path not found", { cause: err });
    }
    throw err;
  }
  if ((options.symlinks ?? "reject") === "reject" && canonicalPath !== normalized) {
    throw new FsSafeError("symlink", "path traverses a symlink", { cause: { canonicalPath } });
  }
  return { path: normalized, canonicalPath };
}

export async function resolveAbsolutePathForWrite(
  filePath: string,
  options: { symlinks?: AbsolutePathSymlinkPolicy } = {},
): Promise<ResolvedWritableAbsolutePath> {
  const normalized = assertAbsolutePathInput(filePath);
  const parentDir = path.dirname(normalized);
  const parentExists = await pathExists(parentDir);
  if ((options.symlinks ?? "reject") === "reject") {
    const ancestor = await findExistingAncestor(parentDir);
    if (ancestor) {
      const canonicalAncestor = await fs.realpath(ancestor).catch(() => ancestor);
      if (canonicalAncestor !== ancestor) {
        const canonicalPath = path.join(canonicalAncestor, path.relative(ancestor, normalized));
        throw new FsSafeError("symlink", "path traverses a symlink", {
          cause: { canonicalPath },
        });
      }
    }
  }
  return {
    path: normalized,
    canonicalPath: await canonicalPathFromExistingAncestor(normalized),
    parentDir,
    parentExists,
  };
}
