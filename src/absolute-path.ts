import fs from "node:fs/promises";
import path from "node:path";
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
  let current = path.resolve(filePath);
  while (true) {
    try {
      await fs.lstat(current);
      return current;
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
