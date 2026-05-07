import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  type AsyncDirectoryGuard,
  createAsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";

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
  | { ok: false; error: string };

function invalidDirectoryPath(scopeLabel: string): EnsureAbsoluteDirectoryResult {
  return {
    ok: false,
    error: `Invalid path: must be a real directory within ${scopeLabel}`,
  };
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
      return { ok: false, error: err.message };
    }
    throw err;
  }

  try {
    const ancestor = await findExistingAncestorWithStat(targetPath);
    if (!ancestor) {
      return invalidDirectoryPath(scopeLabel);
    }

    if (ancestor.stat.isSymbolicLink() || !ancestor.stat.isDirectory()) {
      return invalidDirectoryPath(scopeLabel);
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
        try {
          await assertAsyncDirectoryGuard(currentGuard);
          const stat = await fs.lstat(current);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return invalidDirectoryPath(scopeLabel);
          }
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
          try {
            await assertAsyncDirectoryGuard(currentGuard);
            await fs.mkdir(current, { mode: options.mode });
          } catch (mkdirErr) {
            if ((mkdirErr as NodeJS.ErrnoException).code === "EEXIST") {
              continue;
            }
            throw mkdirErr;
          }
        }
      }
      const nextGuard = await createAsyncDirectoryGuard(current);
      await assertAsyncDirectoryGuard(currentGuard);
      currentGuard = nextGuard;
    }

    await assertAsyncDirectoryGuard(currentGuard);
    return { ok: true, path: targetPath };
  } catch {
    return invalidDirectoryPath(scopeLabel);
  }
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
