import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { root as openRoot } from "./root.js";

type InvalidPathResult = { ok: false; error: string };
type ResolvePathsWithinRootParams = {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
};
type ResolvePathsWithinRootResult = { ok: true; paths: string[] } | InvalidPathResult;
export type PathScopeResolveOptions = {
  defaultName?: string;
};
export type PathScopeOptions = {
  label: string;
};
export type PathScope = {
  rootDir: string;
  label: string;
  resolve(
    requestedPath: string,
    options?: PathScopeResolveOptions,
  ): { ok: true; path: string } | { ok: false; error: string };
  resolveAll(requestedPaths: string[]): ResolvePathsWithinRootResult;
  existing(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
  files(requestedPaths: string[]): Promise<ResolvePathsWithinRootResult>;
  writable(
    requestedPath: string,
    options?: PathScopeResolveOptions,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  ensureDir(
    requestedPath: string,
    options?: PathScopeResolveOptions & { mode?: number },
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
};

function invalidPath(scopeLabel: string): InvalidPathResult {
  return {
    ok: false,
    error: `Invalid path: must stay within ${scopeLabel}`,
  };
}

async function resolveRealPathIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return undefined;
  }
}

async function resolveTrustedRootRealPath(rootDir: string): Promise<string | undefined> {
  try {
    const rootLstat = await fs.lstat(rootDir);
    if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) {
      return undefined;
    }
    return await fs.realpath(rootDir);
  } catch {
    return undefined;
  }
}

async function validateCanonicalPathWithinRoot(params: {
  rootRealPath: string;
  candidatePath: string;
  expect: "directory" | "file";
}): Promise<"ok" | "not-found" | "invalid"> {
  try {
    const candidateLstat = await fs.lstat(params.candidatePath);
    if (candidateLstat.isSymbolicLink()) {
      return "invalid";
    }
    if (params.expect === "directory" && !candidateLstat.isDirectory()) {
      return "invalid";
    }
    if (params.expect === "file" && !candidateLstat.isFile()) {
      return "invalid";
    }
    if (params.expect === "file" && candidateLstat.nlink > 1) {
      return "invalid";
    }
    const candidateRealPath = await fs.realpath(params.candidatePath);
    return isPathInside(params.rootRealPath, candidateRealPath) ? "ok" : "invalid";
  } catch (err) {
    return isNotFoundPathError(err) ? "not-found" : "invalid";
  }
}

export function resolvePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const root = path.resolve(params.rootDir);
  const raw = params.requestedPath.trim();
  if (!raw) {
    if (!params.defaultFileName) {
      return { ok: false, error: "path is required" };
    }
    return { ok: true, path: path.join(root, params.defaultFileName) };
  }
  const resolved = path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
  }
  return { ok: true, path: resolved };
}

export async function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const lexical = resolvePathWithinRoot(params);
  if (!lexical.ok) {
    return lexical;
  }

  const rootDir = path.resolve(params.rootDir);
  const rootRealPath = await resolveTrustedRootRealPath(rootDir);
  if (!rootRealPath) {
    return invalidPath(params.scopeLabel);
  }

  const requestedPath = lexical.path;
  const parentDir = path.dirname(requestedPath);
  const parentStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: parentDir,
    expect: "directory",
  });
  if (parentStatus !== "ok") {
    return invalidPath(params.scopeLabel);
  }

  const targetStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: requestedPath,
    expect: "file",
  });
  if (targetStatus === "invalid") {
    return invalidPath(params.scopeLabel);
  }

  return lexical;
}

async function resolveNearestExistingPath(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`failed to resolve existing path for ${targetPath}`);
    }
    current = parent;
  }
}

async function assertNoSymlinkSegments(params: {
  rootDir: string;
  targetPath: string;
  scopeLabel: string;
}): Promise<void> {
  const relative = path.relative(params.rootDir, params.targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid path: must stay within ${params.scopeLabel}`);
  }
  let current = params.rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Invalid path: must not traverse symlinks within ${params.scopeLabel}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(
          `Invalid path: existing segment must be a directory within ${params.scopeLabel}`,
        );
      }
    } catch (err) {
      if (isNotFoundPathError(err)) {
        return;
      }
      throw err;
    }
  }
}

export async function ensureDirectoryWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultDirName?: string;
  mode?: number;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const lexical = resolvePathWithinRoot({
    rootDir: params.rootDir,
    requestedPath: params.requestedPath,
    scopeLabel: params.scopeLabel,
    defaultFileName: params.defaultDirName,
  });
  if (!lexical.ok) {
    return lexical;
  }

  const rootDir = path.resolve(params.rootDir);
  const targetPath = path.resolve(lexical.path);
  try {
    const rootStat = await fs.lstat(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return invalidPath(params.scopeLabel);
    }
    await assertNoSymlinkSegments({ rootDir, targetPath, scopeLabel: params.scopeLabel });
    const rootReal = await fs.realpath(rootDir);
    const nearestExistingPath = await resolveNearestExistingPath(targetPath);
    const nearestExistingReal = await fs.realpath(nearestExistingPath);
    if (!isPathInside(rootReal, nearestExistingReal)) {
      return invalidPath(params.scopeLabel);
    }
    const relative = path.relative(rootDir, targetPath);
    let current = rootDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      while (true) {
        try {
          const stat = await fs.lstat(current);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return invalidPath(params.scopeLabel);
          }
          break;
        } catch (err) {
          if (!isNotFoundPathError(err)) {
            throw err;
          }
          try {
            await fs.mkdir(current, { mode: params.mode });
          } catch (mkdirErr) {
            if (isNotFoundPathError(mkdirErr)) {
              throw mkdirErr;
            }
            if ((mkdirErr as NodeJS.ErrnoException).code === "EEXIST") {
              continue;
            }
            throw mkdirErr;
          }
        }
      }
    }
    const targetReal = await fs.realpath(targetPath);
    if (!isPathInside(rootReal, targetReal)) {
      return invalidPath(params.scopeLabel);
    }
    return { ok: true, path: targetPath };
  } catch {
    return invalidPath(params.scopeLabel);
  }
}

export function resolvePathsWithinRoot(
  params: ResolvePathsWithinRootParams,
): ResolvePathsWithinRootResult {
  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const pathResult = resolvePathWithinRoot({
      rootDir: params.rootDir,
      requestedPath: raw,
      scopeLabel: params.scopeLabel,
    });
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }
    resolvedPaths.push(pathResult.path);
  }
  return { ok: true, paths: resolvedPaths };
}

export async function resolveExistingPathsWithinRoot(
  params: ResolvePathsWithinRootParams,
): Promise<ResolvePathsWithinRootResult> {
  return await resolveCheckedPathsWithinRoot(params, true);
}

export async function resolveStrictExistingPathsWithinRoot(
  params: ResolvePathsWithinRootParams,
): Promise<ResolvePathsWithinRootResult> {
  return await resolveCheckedPathsWithinRoot(params, false);
}

export function pathScope(rootDir: string, options: PathScopeOptions): PathScope {
  const base = { rootDir, scopeLabel: options.label };
  return {
    rootDir,
    label: options.label,
    resolve: (requestedPath, pathOptions) =>
      resolvePathWithinRoot({
        ...base,
        requestedPath,
        defaultFileName: pathOptions?.defaultName,
      }),
    resolveAll: (requestedPaths) =>
      resolvePathsWithinRoot({
        ...base,
        requestedPaths,
      }),
    existing: (requestedPaths) =>
      resolveExistingPathsWithinRoot({
        ...base,
        requestedPaths,
      }),
    files: (requestedPaths) =>
      resolveStrictExistingPathsWithinRoot({
        ...base,
        requestedPaths,
      }),
    writable: (requestedPath, pathOptions) =>
      resolveWritablePathWithinRoot({
        ...base,
        requestedPath,
        defaultFileName: pathOptions?.defaultName,
      }),
    ensureDir: (requestedPath, pathOptions) =>
      ensureDirectoryWithinRoot({
        ...base,
        requestedPath,
        defaultDirName: pathOptions?.defaultName,
        mode: pathOptions?.mode,
      }),
  };
}

async function resolveCheckedPathsWithinRoot(
  params: ResolvePathsWithinRootParams,
  allowMissingFallback: boolean,
): Promise<ResolvePathsWithinRootResult> {
  const rootDir = path.resolve(params.rootDir);
  const rootRealPath = await resolveRealPathIfExists(rootDir);
  const root = rootRealPath ? await openRoot(rootDir) : undefined;

  const isInRoot = (relativePath: string) =>
    Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);

  const resolveExistingRelativePath = async (
    requestedPath: string,
  ): Promise<
    { ok: true; relativePath: string; fallbackPath: string } | { ok: false; error: string }
  > => {
    const raw = requestedPath.trim();
    const lexicalPathResult = resolvePathWithinRoot({
      rootDir,
      requestedPath,
      scopeLabel: params.scopeLabel,
    });
    if (lexicalPathResult.ok) {
      return {
        ok: true,
        relativePath: path.relative(rootDir, lexicalPathResult.path),
        fallbackPath: lexicalPathResult.path,
      };
    }
    if (!rootRealPath || !raw || !path.isAbsolute(raw)) {
      return lexicalPathResult;
    }
    try {
      const resolvedExistingPath = await fs.realpath(raw);
      const relativePath = path.relative(rootRealPath, resolvedExistingPath);
      if (!isInRoot(relativePath)) {
        return lexicalPathResult;
      }
      return {
        ok: true,
        relativePath,
        fallbackPath: resolvedExistingPath,
      };
    } catch {
      return lexicalPathResult;
    }
  };

  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const pathResult = await resolveExistingRelativePath(raw);
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }

    let opened: Awaited<ReturnType<NonNullable<typeof root>["open"]>> | undefined;
    try {
      if (!root) {
        throw new FsSafeError("not-found", "root dir not found");
      }
      opened = await root.open(pathResult.relativePath);
      resolvedPaths.push(opened.realPath);
    } catch (err) {
      if (allowMissingFallback && err instanceof FsSafeError && err.code === "not-found") {
        resolvedPaths.push(pathResult.fallbackPath);
        continue;
      }
      if (err instanceof FsSafeError && err.code === "outside-workspace") {
        return {
          ok: false,
          error: `File is outside ${params.scopeLabel}`,
        };
      }
      return {
        ok: false,
        error: `Invalid path: must stay within ${params.scopeLabel} and be a regular non-symlink file`,
      };
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }
  return { ok: true, paths: resolvedPaths };
}
