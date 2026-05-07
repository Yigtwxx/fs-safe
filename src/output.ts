import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sanitizeUntrustedFileName } from "./filename.js";
import { isPathInside } from "./path.js";
import { root } from "./root.js";
import { tempFile } from "./temp-target.js";

export type ExternalFileWriteOptions<T = void> = {
  rootDir: string;
  path: string;
  write: (filePath: string) => Promise<T>;
  maxBytes?: number;
  mode?: number;
};

export type ExternalFileWriteResult<T = void> = {
  path: string;
  result: T;
};

function tempFileNameForTarget(targetPath: string): string {
  return sanitizeUntrustedFileName(path.basename(targetPath), "output.bin");
}

function ensureTrailingSep(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function toRootPathInput(params: {
  rootDir: string;
  rootReal: string;
  targetPath: string;
}): string {
  if (!path.isAbsolute(params.targetPath)) {
    return params.targetPath;
  }

  const absoluteTarget = path.resolve(params.targetPath);
  const rootDir = path.resolve(params.rootDir);
  if (isPathInside(ensureTrailingSep(rootDir), absoluteTarget)) {
    return path.relative(rootDir, absoluteTarget);
  }
  if (isPathInside(ensureTrailingSep(params.rootReal), absoluteTarget)) {
    return path.relative(params.rootReal, absoluteTarget);
  }
  return params.targetPath;
}

function assertFileTargetPath(targetPath: string): void {
  const basename = path.basename(targetPath);
  if (
    !targetPath ||
    targetPath === "." ||
    targetPath.endsWith("/") ||
    targetPath.endsWith("\\") ||
    !basename ||
    basename === "." ||
    basename === ".."
  ) {
    throw new FsSafeError("invalid-path", "target path must name a file");
  }
}

export async function writeExternalFileWithinRoot<T = void>(
  options: ExternalFileWriteOptions<T>,
): Promise<ExternalFileWriteResult<T>> {
  const targetRoot = await root(options.rootDir);
  const requestedTargetPath = options.path;
  if (requestedTargetPath.length === 0) {
    throw new FsSafeError("invalid-path", "target path is required");
  }
  const targetPath = toRootPathInput({
    rootDir: targetRoot.rootDir,
    rootReal: targetRoot.rootReal,
    targetPath: requestedTargetPath,
  });
  assertFileTargetPath(targetPath);
  const finalPath = await targetRoot.resolve(targetPath);
  const staged = await tempFile({
    prefix: "fs-safe-output",
    fileName: tempFileNameForTarget(targetPath),
  });

  try {
    const result = await options.write(staged.path);
    await targetRoot.copyIn(targetPath, staged.path, {
      maxBytes: options.maxBytes,
      mode: options.mode,
      mkdir: true,
      sourceHardlinks: "reject",
    });
    return { path: finalPath, result };
  } finally {
    await staged.cleanup();
  }
}
