import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import {
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  assertArchiveEntryCountWithinLimit,
  createByteBudgetTracker,
  createExtractBudgetTransform,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import { resolveArchiveKind, type ArchiveKind } from "./archive-kind.js";
import {
  createArchiveSymlinkTraversalError,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
} from "./archive-staging.js";
import {
  createTarEntryPreflightChecker,
  readTarEntryInfo,
  type TarEntryInfo,
} from "./archive-tar.js";
import { withTimeout } from "./archive-utils.js";
import { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
import { sameFileIdentity } from "./file-identity.js";
import { FsSafeError } from "./errors.js";
import { root } from "./root.js";
import { isNotFoundPathError } from "./path.js";

export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export { resolveArchiveKind, resolvePackedRootDir, type ArchiveKind } from "./archive-kind.js";
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  type ArchiveExtractLimits,
  type ArchiveLimitErrorCode,
} from "./archive-limits.js";
export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-staging.js";
export {
  createArchiveSymlinkTraversalError,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
} from "./archive-staging.js";
export { createTarEntryPreflightChecker, type TarEntryInfo } from "./archive-tar.js";
export { fileExists, withTimeout } from "./archive-utils.js";
export {
  loadZipArchiveWithPreflight,
  readZipCentralDirectoryEntryCount,
} from "./archive-zip-preflight.js";

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

function symlinkTraversalError(originalPath: string) {
  return createArchiveSymlinkTraversalError(originalPath);
}

type OpenZipOutputFileResult = {
  handle: FileHandle;
  createdForWrite: boolean;
  realPath: string;
  stat: Stats;
};

async function openZipOutputFile(params: {
  relPath: string;
  originalPath: string;
  destinationRealDir: string;
}): Promise<OpenZipOutputFileResult> {
  try {
    const targetRoot = await root(params.destinationRealDir);
    return await targetRoot.openWritable(params.relPath, {
      mkdir: false,
      mode: 0o666,
    });
  } catch (err) {
    if (
      err instanceof FsSafeError &&
      (err.code === "invalid-path" ||
        err.code === "outside-workspace" ||
        err.code === "path-mismatch")
    ) {
      throw symlinkTraversalError(params.originalPath);
    }
    throw err;
  }
}

async function cleanupPartialRegularFile(filePath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  if (stat.isFile()) {
    await fs.unlink(filePath).catch(() => undefined);
  }
}

function buildArchiveAtomicTempPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

async function verifyZipWriteResult(params: {
  destinationRealDir: string;
  relPath: string;
  expectedStat: Stats;
}): Promise<string> {
  const targetRoot = await root(params.destinationRealDir);
  const opened = await targetRoot.open(params.relPath, {
    hardlinks: "reject",
  });
  try {
    if (!sameFileIdentity(opened.stat, params.expectedStat)) {
      throw new FsSafeError("path-mismatch", "path changed during zip extract");
    }
    return opened.realPath;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

type ZipEntry = {
  name: string;
  dir: boolean;
  unixPermissions?: number;
  nodeStream?: () => NodeJS.ReadableStream;
  async: (type: "nodebuffer") => Promise<Buffer>;
};

type ZipExtractBudget = ReturnType<typeof createByteBudgetTracker>;

async function readZipEntryStream(entry: ZipEntry): Promise<NodeJS.ReadableStream> {
  if (typeof entry.nodeStream === "function") {
    return entry.nodeStream();
  }
  // Old JSZip: fall back to buffering, but still extract via a stream.
  const buf = await entry.async("nodebuffer");
  return Readable.from(buf);
}

function resolveZipOutputPath(params: {
  entryPath: string;
  strip: number;
  destinationDir: string;
}): { relPath: string; outPath: string } | null {
  validateArchiveEntryPath(params.entryPath);
  const relPath = stripArchivePath(params.entryPath, params.strip);
  if (!relPath) {
    return null;
  }
  validateArchiveEntryPath(relPath);
  return {
    relPath,
    outPath: resolveArchiveOutputPath({
      rootDir: params.destinationDir,
      relPath,
      originalPath: params.entryPath,
    }),
  };
}

async function prepareZipOutputPath(params: {
  destinationDir: string;
  destinationRealDir: string;
  relPath: string;
  outPath: string;
  originalPath: string;
  isDirectory: boolean;
}): Promise<void> {
  await prepareArchiveOutputPath(params);
}

async function writeZipFileEntry(params: {
  entry: ZipEntry;
  relPath: string;
  destinationRealDir: string;
  budget: ZipExtractBudget;
}): Promise<void> {
  const opened = await openZipOutputFile({
    relPath: params.relPath,
    originalPath: params.entry.name,
    destinationRealDir: params.destinationRealDir,
  });
  params.budget.startEntry();
  const readable = await readZipEntryStream(params.entry);
  const destinationPath = opened.realPath;
  const targetMode = opened.stat.mode & 0o777;
  await opened.handle.close().catch(() => undefined);

  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let tempStat: Stats | null = null;
  let handleClosedByStream = false;

  try {
    tempPath = buildArchiveAtomicTempPath(destinationPath);
    tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, targetMode || 0o666);
    const writable = tempHandle.createWriteStream();
    writable.once("close", () => {
      handleClosedByStream = true;
    });

    await pipeline(
      readable,
      createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }),
      writable,
    );
    tempStat = await fs.stat(tempPath);
    if (!tempStat) {
      throw new Error("zip temp write did not produce file metadata");
    }
    if (!handleClosedByStream) {
      await tempHandle.close().catch(() => undefined);
      handleClosedByStream = true;
    }
    tempHandle = null;
    await fs.rename(tempPath, destinationPath);
    tempPath = null;
    const verifiedPath = await verifyZipWriteResult({
      destinationRealDir: params.destinationRealDir,
      relPath: params.relPath,
      expectedStat: tempStat,
    });

    // Best-effort permission restore for zip entries created on unix.
    if (typeof params.entry.unixPermissions === "number") {
      const mode = params.entry.unixPermissions & 0o777;
      if (mode !== 0) {
        await fs.chmod(verifiedPath, mode).catch(() => undefined);
      }
    }
  } catch (err) {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    } else {
      await cleanupPartialRegularFile(destinationPath).catch(() => undefined);
    }
    if (err instanceof FsSafeError) {
      throw symlinkTraversalError(params.entry.name);
    }
    throw err;
  } finally {
    if (tempHandle && !handleClosedByStream) {
      await tempHandle.close().catch(() => undefined);
    }
  }
}

async function extractZip(params: {
  archivePath: string;
  destDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
}): Promise<void> {
  const limits = resolveExtractLimits(params.limits);
  const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
  const stat = await fs.stat(params.archivePath);
  if (stat.size > limits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }

  const buffer = await fs.readFile(params.archivePath);
  const zip = await loadZipArchiveWithPreflight(buffer, limits);
  const entries = Object.values(zip.files) as ZipEntry[];
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));

  assertArchiveEntryCountWithinLimit(entries.length, limits);

  const budget = createByteBudgetTracker(limits);

  for (const entry of entries) {
    const output = resolveZipOutputPath({
      entryPath: entry.name,
      strip,
      destinationDir: params.destDir,
    });
    if (!output) {
      continue;
    }

    await prepareZipOutputPath({
      destinationDir: params.destDir,
      destinationRealDir,
      relPath: output.relPath,
      outPath: output.outPath,
      originalPath: entry.name,
      isDirectory: entry.dir,
    });
    if (entry.dir) {
      continue;
    }

    await writeZipFileEntry({
      entry,
      relPath: output.relPath,
      destinationRealDir,
      budget,
    });
  }
}

export async function extractArchive(params: {
  archivePath: string;
  destDir: string;
  timeoutMs: number;
  kind?: ArchiveKind;
  stripComponents?: number;
  tarGzip?: boolean;
  limits?: ArchiveExtractLimits;
  logger?: ArchiveLogger;
}): Promise<void> {
  const kind = params.kind ?? resolveArchiveKind(params.archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${params.archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  if (kind === "tar") {
    await withTimeout(
      (async () => {
        const limits = resolveExtractLimits(params.limits);
        const stat = await fs.stat(params.archivePath);
        if (stat.size > limits.maxArchiveBytes) {
          throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
        }

        const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
        await withStagedArchiveDestination({
          destinationRealDir,
          run: async (stagingDir) => {
            const checkTarEntrySafety = createTarEntryPreflightChecker({
              rootDir: destinationRealDir,
              stripComponents: params.stripComponents,
              limits,
            });
            // A canonical cwd is not enough here: tar can still follow
            // pre-existing child symlinks in the live destination tree.
            // Extract into a private staging dir first, then merge through
            // the same safe-open boundary checks used by direct file writes.
            await tar.x({
              file: params.archivePath,
              cwd: stagingDir,
              strip: Math.max(0, Math.floor(params.stripComponents ?? 0)),
              gzip: params.tarGzip,
              preservePaths: false,
              strict: true,
              onReadEntry(entry) {
                try {
                  checkTarEntrySafety(readTarEntryInfo(entry));
                } catch (err) {
                  const error = err instanceof Error ? err : new Error(String(err));
                  // Node's EventEmitter calls listeners with `this` bound to the
                  // emitter (tar.Unpack), which exposes Parser.abort().
                  const emitter = this as unknown as { abort?: (error: Error) => void };
                  emitter.abort?.(error);
                }
              },
            });
            await mergeExtractedTreeIntoDestination({
              sourceDir: stagingDir,
              destinationDir: destinationRealDir,
              destinationRealDir,
            });
          },
        });
      })(),
      params.timeoutMs,
      label,
    );
    return;
  }

  await withTimeout(
    extractZip({
      archivePath: params.archivePath,
      destDir: params.destDir,
      stripComponents: params.stripComponents,
      limits: params.limits,
    }),
    params.timeoutMs,
    label,
  );
}
