import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { expandHomePrefix, resolveUserPath } from "./home-dir.js";
import { safeFileURLToPath } from "./local-file-access.js";
import { isPathInside } from "./path.js";
import { root, type HardlinkPolicy, type ReadResult, type SymlinkPolicy } from "./root.js";

export type LocalRootsPathResult = {
  path: string;
  root: string;
};

export type LocalRootsReadResult = ReadResult & {
  root: string;
};

export type LocalRootsInputOptions = {
  filePath: string;
  roots: readonly string[];
  label?: string;
};

export type ResolveLocalPathFromRootsSyncOptions = LocalRootsInputOptions & {
  allowMissing?: boolean;
  requireFile?: boolean;
};

export type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & {
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  nonBlockingRead?: boolean;
  symlinks?: SymlinkPolicy;
};

function resolveLocalPathInput(input: string, label: string): string {
  if (input.startsWith("file://")) {
    try {
      return safeFileURLToPath(input);
    } catch {
      const location = label === "file path" ? "" : ` in ${label}`;
      throw new Error(`Invalid file:// URL${location}: ${input}`);
    }
  }
  if (input.includes("\0")) {
    throw new FsSafeError("invalid-path", `${label} must not contain NUL bytes`);
  }
  return resolveUserPath(input);
}

function resolveLocalRootInput(input: string, label: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new FsSafeError("invalid-path", `${label} entry is required`);
  }
  const resolved = trimmed.startsWith("file://")
    ? resolveLocalPathInput(trimmed, label)
    : expandHomePrefix(trimmed);
  if (resolved.includes("\0")) {
    throw new FsSafeError("invalid-path", `${label} entry must not contain NUL bytes`);
  }
  if (!path.isAbsolute(resolved)) {
    throw new FsSafeError("invalid-path", `${label} entries must be absolute paths: ${input}`);
  }
  return path.resolve(resolved);
}

function isPathInsideRoot(candidate: string, rootDir: string): boolean {
  return isPathInside(rootDir, candidate);
}

function resolveRootRealSync(rootDir: string): string | null {
  try {
    const stat = fsSync.lstatSync(rootDir);
    if (!stat.isDirectory()) {
      return null;
    }
    return fsSync.realpathSync(rootDir);
  } catch {
    return null;
  }
}

function resolveCandidateCanonicalSync(
  filePath: string,
): { exists: true; canonicalPath: string; isFile: boolean } | { exists: false; canonicalPath: string } {
  try {
    const stat = fsSync.lstatSync(filePath);
    return {
      exists: true,
      canonicalPath: fsSync.realpathSync(filePath),
      isFile: stat.isFile(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  let cursor = filePath;
  const missingSegments: string[] = [];
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return { exists: false, canonicalPath: filePath };
    }
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
    try {
      fsSync.lstatSync(cursor);
      const ancestorReal = fsSync.realpathSync(cursor);
      return {
        exists: false,
        canonicalPath: path.join(ancestorReal, ...missingSegments),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

export function resolveLocalPathFromRootsSync(
  options: ResolveLocalPathFromRootsSyncOptions,
): LocalRootsPathResult | null {
  const label = options.label ?? "local roots";
  const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));

  for (const rootEntry of options.roots) {
    const rootDir = resolveLocalRootInput(rootEntry, label);
    const rootReal = resolveRootRealSync(rootDir);
    if (!rootReal) {
      continue;
    }

    let candidate: ReturnType<typeof resolveCandidateCanonicalSync>;
    try {
      candidate = resolveCandidateCanonicalSync(requestedPath);
    } catch {
      continue;
    }
    if (!candidate.exists && options.allowMissing !== true) {
      continue;
    }
    if (candidate.exists && options.requireFile === true && !candidate.isFile) {
      continue;
    }
    if (isPathInsideRoot(candidate.canonicalPath, rootReal)) {
      return { path: candidate.canonicalPath, root: rootReal };
    }
  }

  return null;
}

export async function readLocalFileFromRoots(
  options: ReadLocalFileFromRootsOptions,
): Promise<LocalRootsReadResult | null> {
  const label = options.label ?? "local roots";
  const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));

  for (const rootEntry of options.roots) {
    const rootDir = resolveLocalRootInput(rootEntry, label);
    let scopedRoot: Awaited<ReturnType<typeof root>>;
    try {
      scopedRoot = await root(rootDir);
    } catch {
      continue;
    }

    const relativePath = path.relative(scopedRoot.rootDir, requestedPath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      continue;
    }

    try {
      const result = await scopedRoot.read(relativePath, {
        hardlinks: options.hardlinks,
        maxBytes: options.maxBytes,
        nonBlockingRead: options.nonBlockingRead,
        symlinks: options.symlinks,
      });
      return { ...result, root: scopedRoot.rootReal };
    } catch {
      continue;
    }
  }

  return null;
}
