import { createHash } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import {
  pinDirectory,
  type DirectoryReceipt,
  type DirectorySyncOutcome,
} from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
import { syncNativeFileBestEffort } from "./native-operations.js";
import { getNativeBinding, requireNativeBinding, type NativeBinding } from "./native.js";

export type PublishFileExclusiveStrategy =
  | "link-or-copy"
  | "link-required"
  | "rename-noreplace";

export type PublishFileExclusiveResult = {
  method: "hardlink" | "exclusive-copy" | "rename-noreplace";
  identity: Stats;
  directorySync: DirectorySyncOutcome;
};

const HARDLINK_FALLBACK_CODES = new Set([
  "EPERM",
  "EXDEV",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
]);

export function isHardlinkFallbackError(error: unknown): boolean {
  return HARDLINK_FALLBACK_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

function sourceOpenFlags(): number {
  return (
    fsSync.constants.O_RDONLY |
    (process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
      ? fsSync.constants.O_NOFOLLOW
      : 0)
  );
}

function directoryOpenFlags(): number {
  return (
    fsSync.constants.O_RDONLY |
    (typeof fsSync.constants.O_DIRECTORY === "number" ? fsSync.constants.O_DIRECTORY : 0)
  );
}

async function openNativeParent(binding: NativeBinding, filePath: string): Promise<{
  basename: string;
  handle: FileHandle;
}> {
  const parentPath = path.dirname(filePath);
  const handle = await fs.open(parentPath, directoryOpenFlags());
  try {
    const pathname = await fs.lstat(parentPath);
    const opened = binding.fstatIdentity(handle.fd);
    if (pathname.isSymbolicLink() || !sameFileIdentity(pathname, opened)) {
      throw new FsSafeError("path-mismatch", "publication parent changed while opening");
    }
    return { basename: path.basename(filePath), handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertPinnedSourceCurrent(params: {
  sourcePath: string;
  handle: FileHandle;
  identity: Stats;
}): Promise<void> {
  const opened = await params.handle.stat();
  const current = await fs.lstat(params.sourcePath);
  if (
    !opened.isFile() ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameFileIdentity(opened, params.identity) ||
    !sameFileIdentity(current, opened)
  ) {
    throw new FsSafeError("path-mismatch", "publication source changed during operation");
  }
}

async function hashHandle(handle: FileHandle): Promise<{ bytes: number; digest: string }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return { bytes: position, digest: hash.digest("hex") };
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

async function copyPinnedSource(params: {
  source: FileHandle;
  targetPath: string;
}): Promise<{ handle: FileHandle; stat: Stats; digest: string; bytes: number }> {
  const target = await fs.open(params.targetPath, "wx+", 0o600);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await params.source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten <= 0) {
          throw new FsSafeError("helper-failed", "exclusive publication copy made no progress");
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await target.sync();
    return { handle: target, stat: await target.stat(), digest: hash.digest("hex"), bytes: position };
  } catch (error) {
    await target.close().catch(() => undefined);
    throw error;
  }
}

async function removeCreatedTargetIfUnchanged(targetPath: string, identity?: Stats): Promise<void> {
  if (!identity) {
    return;
  }
  try {
    const current = await fs.lstat(targetPath);
    if (!current.isSymbolicLink() && sameFileIdentity(current, identity)) {
      await fs.rm(targetPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function publishFileExclusive(params: {
  sourcePath: string;
  targetPath: string;
  expectedSourceIdentity?: FileIdentityStat;
  strategy: PublishFileExclusiveStrategy;
  parentReceipt?: DirectoryReceipt;
}): Promise<PublishFileExclusiveResult> {
  const sourcePath = path.resolve(params.sourcePath);
  const targetPath = path.resolve(params.targetPath);
  const parentPath = path.dirname(targetPath);
  if (params.parentReceipt && path.resolve(params.parentReceipt.path) !== parentPath) {
    throw new FsSafeError("path-mismatch", "publication parent receipt does not match target parent");
  }

  const sourcePathStat = await fs.lstat(sourcePath);
  if (sourcePathStat.isSymbolicLink() || !sourcePathStat.isFile()) {
    throw new FsSafeError("not-file", "publication source must be a regular file");
  }
  const source = await fs.open(sourcePath, sourceOpenFlags());
  const parent = await pinDirectory(params.parentReceipt ?? parentPath, {
    label: "publication parent",
  });
  let sourceNativeParent: Awaited<ReturnType<typeof openNativeParent>> | undefined;
  let targetNativeParent: Awaited<ReturnType<typeof openNativeParent>> | undefined;
  try {
    const sourceIdentity = await source.stat();
    if (
      !sameFileIdentity(sourcePathStat, sourceIdentity) ||
      (params.expectedSourceIdentity &&
        !sameFileIdentity(params.expectedSourceIdentity, sourceIdentity))
    ) {
      throw new FsSafeError("path-mismatch", "publication source identity did not match");
    }
    await parent.assertCurrent();
    await assertPinnedSourceCurrent({ sourcePath, handle: source, identity: sourceIdentity });

    const native = params.strategy === "rename-noreplace"
      ? requireNativeBinding()
      : getNativeBinding();
    if (native) {
      sourceNativeParent = await openNativeParent(native, sourcePath);
      targetNativeParent = await openNativeParent(native, targetPath);
    }

    if (params.strategy === "rename-noreplace") {
      const binding = requireNativeBinding();
      binding.renameNoReplace(
        sourceNativeParent!.handle.fd,
        sourceNativeParent!.basename,
        targetNativeParent!.handle.fd,
        targetNativeParent!.basename,
      );
      const targetIdentity = await fs.lstat(targetPath);
      if (
        targetIdentity.isSymbolicLink() ||
        !targetIdentity.isFile() ||
        !sameFileIdentity(targetIdentity, sourceIdentity)
      ) {
        throw new FsSafeError("path-mismatch", "no-replace publication target changed");
      }
      try {
        await fs.lstat(sourcePath);
        throw new FsSafeError("path-mismatch", "no-replace publication source still exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await parent.assertCurrent();
      syncNativeFileBestEffort(sourceNativeParent!.handle.fd);
      return {
        method: "rename-noreplace",
        identity: targetIdentity,
        directorySync: await parent.sync(),
      };
    }

    try {
      if (native) {
        native.linkBeneath(
          sourceNativeParent!.handle.fd,
          sourceNativeParent!.basename,
          targetNativeParent!.handle.fd,
          targetNativeParent!.basename,
        );
      } else {
        await fs.link(sourcePath, targetPath);
      }
      const targetIdentity = await fs.lstat(targetPath);
      if (
        targetIdentity.isSymbolicLink() ||
        !targetIdentity.isFile() ||
        !sameFileIdentity(targetIdentity, sourceIdentity)
      ) {
        throw new FsSafeError("path-mismatch", "hardlink publication target changed");
      }
      await assertPinnedSourceCurrent({ sourcePath, handle: source, identity: sourceIdentity });
      await parent.assertCurrent();
      return {
        method: "hardlink",
        identity: targetIdentity,
        directorySync: await parent.sync(),
      };
    } catch (error) {
      if (!isHardlinkFallbackError(error) || params.strategy === "link-required") {
        throw error;
      }
    }

    let target: FileHandle | undefined;
    let targetIdentity: Stats | undefined;
    try {
      const copied = await copyPinnedSource({ source, targetPath });
      target = copied.handle;
      targetIdentity = copied.stat;
      const targetPathStat = await fs.lstat(targetPath);
      const copiedBack = await hashHandle(target);
      const sourceAfter = await hashHandle(source);
      if (
        targetPathStat.isSymbolicLink() ||
        !sameFileIdentity(targetPathStat, targetIdentity) ||
        copiedBack.bytes !== copied.bytes ||
        copiedBack.digest !== copied.digest ||
        sourceAfter.bytes !== copied.bytes ||
        sourceAfter.digest !== copied.digest
      ) {
        throw new FsSafeError("path-mismatch", "exclusive publication copy failed content fencing");
      }
      await assertPinnedSourceCurrent({ sourcePath, handle: source, identity: sourceIdentity });
      await parent.assertCurrent();
      const directorySync = await parent.sync();
      return { method: "exclusive-copy", identity: targetPathStat, directorySync };
    } catch (error) {
      await target?.close().catch(() => undefined);
      target = undefined;
      await removeCreatedTargetIfUnchanged(targetPath, targetIdentity).catch(() => undefined);
      throw error;
    } finally {
      await target?.close().catch(() => undefined);
    }
  } finally {
    await sourceNativeParent?.handle.close().catch(() => undefined);
    await targetNativeParent?.handle.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    await parent.close().catch(() => undefined);
  }
}
