import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeUntrustedFileName } from "./filename.js";
import { root } from "./root.js";

export type WriteSiblingTempFileOptions<T> = {
  dir: string;
  writeTemp: (tempPath: string) => Promise<T>;
  resolveFinalPath: (result: T) => string;
  tempPrefix?: string;
  dirMode?: number;
  fileMode?: number;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
};

export type WriteSiblingTempFileResult<T> = {
  filePath: string;
  result: T;
};

function buildTempPath(dir: string, tempPrefix?: string): string {
  return path.join(dir, `${tempPrefix ?? ".fs-safe-stream"}.${process.pid}.${randomUUID()}.tmp`);
}

async function syncFileBestEffort(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Best-effort on platforms/filesystems that do not support directory fsync.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertFinalPathIsSibling(dir: string, filePath: string): void {
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  if (path.dirname(resolvedFile) !== resolvedDir) {
    throw new Error("Final path must be in the sibling temp directory.");
  }
}

export async function writeSiblingTempFile<T>(
  options: WriteSiblingTempFileOptions<T>,
): Promise<WriteSiblingTempFileResult<T>> {
  const dir = path.resolve(options.dir);
  await fs.mkdir(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
  await fs.chmod(dir, options.dirMode ?? 0o700).catch(() => undefined);
  const tempPath = buildTempPath(dir, options.tempPrefix);
  let tempExists = false;
  try {
    tempExists = true;
    const result = await options.writeTemp(tempPath);
    if (options.fileMode !== undefined) {
      await fs.chmod(tempPath, options.fileMode).catch(() => undefined);
    }
    if (options.syncTempFile) {
      await syncFileBestEffort(tempPath);
    }
    const filePath = path.resolve(options.resolveFinalPath(result));
    assertFinalPathIsSibling(dir, filePath);
    await fs.rename(tempPath, filePath);
    tempExists = false;
    if (options.fileMode !== undefined) {
      await fs.chmod(filePath, options.fileMode).catch(() => undefined);
    }
    if (options.syncParentDir) {
      await syncDirectoryBestEffort(dir);
    }
    return { filePath, result };
  } finally {
    if (tempExists) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function buildSiblingTempPath(params: {
  targetPath: string;
  fallbackFileName: string;
  tempPrefix: string;
}): string {
  const id = crypto.randomUUID();
  const safeTail = sanitizeUntrustedFileName(
    path.basename(params.targetPath),
    params.fallbackFileName,
  );
  return path.join(path.dirname(params.targetPath), `${params.tempPrefix}${id}-${safeTail}.part`);
}

export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
  fallbackFileName?: string;
  tempPrefix?: string;
}): Promise<void> {
  const rootDir = await fs
    .realpath(path.resolve(params.rootDir))
    .catch(() => path.resolve(params.rootDir));
  const requestedTargetPath = path.resolve(params.targetPath);
  const targetPath = await fs
    .realpath(path.dirname(requestedTargetPath))
    .then((realDir) => path.join(realDir, path.basename(requestedTargetPath)))
    .catch(() => requestedTargetPath);
  const relativeTargetPath = path.relative(rootDir, targetPath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error("Target path is outside the allowed root");
  }
  const tempPath = buildSiblingTempPath({
    targetPath,
    fallbackFileName: params.fallbackFileName ?? "output.bin",
    tempPrefix: params.tempPrefix ?? ".fs-safe-output-",
  });
  try {
    await params.writeTemp(tempPath);
    const targetRoot = await root(rootDir);
    await targetRoot.copyIn(relativeTargetPath, tempPath, { mkdir: false });
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}
