import path from "node:path";
import { FsSafeError } from "./errors.js";
import { resolveRootPath } from "./root-path.js";
import type { DirEntry } from "./types.js";

export type RootWalkSymlinkPolicy = "skip" | "follow-within-root";
export type RootWalkLimitBehavior = "truncate" | "throw";
export type RootWalkEntryKind = "file" | "directory" | "other" | "truncated";

export type RootWalkEntry = {
  relativePath: string;
  kind: RootWalkEntryKind;
  size: number;
};

export type RootWalkOptions = {
  maxDepth?: number;
  maxEntries?: number;
  symlinkPolicy: RootWalkSymlinkPolicy;
  signal?: AbortSignal;
  limitBehavior?: RootWalkLimitBehavior;
};

type RootWalkCapability = {
  rootReal: string;
  list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
};

function validateBudget(name: string, value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function entryKind(entry: DirEntry): Exclude<RootWalkEntryKind, "truncated"> | "symlink" {
  if (entry.isSymbolicLink) return "symlink";
  if (entry.isDirectory) return "directory";
  if (entry.isFile) return "file";
  return "other";
}

function limitEntry(relativePath: string): RootWalkEntry {
  return { relativePath, kind: "truncated", size: 0 };
}

export async function* walkRoot(
  root: RootWalkCapability,
  relativePath: string,
  options: RootWalkOptions,
): AsyncGenerator<RootWalkEntry> {
  const maxDepth = validateBudget("maxDepth", options.maxDepth);
  const maxEntries = validateBudget("maxEntries", options.maxEntries);
  const visitedDirectories = new Set<string>();
  let yielded = 0;

  const onLimit = (atPath: string): RootWalkEntry => {
    if ((options.limitBehavior ?? "truncate") === "throw") {
      throw new FsSafeError("too-large", `root walk budget exceeded at ${atPath || "."}`);
    }
    return limitEntry(atPath);
  };

  async function* visit(directory: string, depth: number): AsyncGenerator<RootWalkEntry> {
    options.signal?.throwIfAborted();
    const resolvedDirectory = await resolveRootPath({
      absolutePath: path.resolve(root.rootReal, directory),
      rootPath: root.rootReal,
      rootCanonicalPath: root.rootReal,
      boundaryLabel: "root walk",
    });
    if (!resolvedDirectory.exists || resolvedDirectory.kind !== "directory") {
      throw new FsSafeError("not-file", `root walk path is not a directory: ${directory || "."}`);
    }
    if (visitedDirectories.has(resolvedDirectory.canonicalPath)) {
      return;
    }
    visitedDirectories.add(resolvedDirectory.canonicalPath);

    const listingDirectory = path
      .relative(root.rootReal, resolvedDirectory.canonicalPath)
      .split(path.sep)
      .join(path.posix.sep);
    const entries = await root.list(listingDirectory, { withFileTypes: true });
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const child = directory
        ? path.posix.join(directory.split(path.sep).join(path.posix.sep), entry.name)
        : entry.name;
      if (yielded >= maxEntries) {
        yield onLimit(child);
        return;
      }

      let kind = entryKind(entry);
      let size = entry.size;
      if (kind === "symlink") {
        if (options.symlinkPolicy === "skip") {
          continue;
        }
        const resolved = await resolveRootPath({
          absolutePath: path.resolve(root.rootReal, child),
          rootPath: root.rootReal,
          rootCanonicalPath: root.rootReal,
          boundaryLabel: "root walk",
        });
        if (!resolved.exists) {
          continue;
        }
        kind = resolved.kind === "directory" ? "directory" : resolved.kind === "file" ? "file" : "other";
        size = entry.size;
      }

      yielded += 1;
      yield { relativePath: child, kind, size };
      if (kind !== "directory") {
        continue;
      }
      if (depth >= maxDepth) {
        yield onLimit(child);
        return;
      }
      yield* visit(child, depth + 1);
    }
  }

  yield* visit(relativePath, 0);
}
