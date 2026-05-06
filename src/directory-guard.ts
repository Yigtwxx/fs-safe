import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";

export type AsyncDirectoryGuard = {
  dir: string;
  realPath: string;
  stat: Stats;
};

export async function createAsyncDirectoryGuard(dir: string): Promise<AsyncDirectoryGuard> {
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", "directory component must be a directory");
  }
  return { dir, realPath: await fs.realpath(dir), stat };
}

export async function assertAsyncDirectoryGuard(guard: AsyncDirectoryGuard): Promise<void> {
  const stat = await fs.lstat(guard.dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", "directory component must be a directory");
  }
  if (!sameFileIdentity(stat, guard.stat) || (await fs.realpath(guard.dir)) !== guard.realPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
}

export async function createNearestExistingDirectoryGuard(
  rootReal: string,
  targetPath: string,
): Promise<AsyncDirectoryGuard> {
  let current = path.resolve(targetPath);
  const root = path.resolve(rootReal);
  while (current !== root) {
    try {
      return await createAsyncDirectoryGuard(current);
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      current = path.dirname(current);
    }
  }
  return await createAsyncDirectoryGuard(root);
}
