import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
import { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
import { isNotFoundPathError } from "./path.js";
import { writeSiblingTempFile } from "./sibling-temp.js";
import { withTimeout } from "./timing.js";

export type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
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
export {
  loadZipArchiveWithPreflight,
  readZipCentralDirectoryEntryCount,
  type ZipArchiveWithFiles,
} from "./archive-zip-preflight.js";

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

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

type ZipEntry = {
  name: string;
  dir: boolean;
  unixPermissions?: number;
  nodeStream?: () => NodeJS.ReadableStream;
  async: (type: "nodebuffer") => Promise<Buffer>;
};

type ZipExtractBudget = ReturnType<typeof createByteBudgetTracker>;
type TarModule = {
  x(options: {
    file: string;
    cwd: string;
    strip: number;
    gzip?: boolean;
    preservePaths: false;
    strict: true;
    onReadEntry(this: unknown, entry: unknown): void;
  }): Promise<unknown>;
};

const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

function isZipSymlinkEntry(entry: ZipEntry): boolean {
  return (
    typeof entry.unixPermissions === "number" &&
    (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE
  );
}

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
  outPath: string;
  budget: ZipExtractBudget;
}): Promise<void> {
  params.budget.startEntry();
  const readable = await readZipEntryStream(params.entry);
  const destinationPath = params.outPath;

  let tempHandle: FileHandle | null = null;
  let handleClosedByStream = false;

  try {
    await writeSiblingTempFile({
      dir: path.dirname(destinationPath),
      tempPrefix: `.${path.basename(destinationPath)}.fs-safe-archive`,
      chmodDir: false,
      writeTemp: async (tempPath) => {
        tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, 0o666);
        const writable = tempHandle.createWriteStream();
        writable.once("close", () => {
          handleClosedByStream = true;
        });

        await pipeline(
          readable,
          createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }),
          writable,
        );
        if (!handleClosedByStream) {
          await tempHandle.close().catch(() => undefined);
          handleClosedByStream = true;
        }
        tempHandle = null;
        return destinationPath;
      },
      resolveFinalPath: (filePath) => filePath,
    });

    // Best-effort permission restore for zip entries created on unix.
    if (typeof params.entry.unixPermissions === "number") {
      const mode = params.entry.unixPermissions & 0o777;
      if (mode !== 0) {
        await fs.chmod(destinationPath, mode).catch(() => undefined);
      }
    }
  } catch (err) {
    await cleanupPartialRegularFile(destinationPath).catch(() => undefined);
    throw err;
  } finally {
    const openTempHandle = tempHandle as FileHandle | null;
    if (openTempHandle && !handleClosedByStream) {
      await openTempHandle.close().catch(() => undefined);
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

  await withStagedArchiveDestination({
    destinationRealDir,
    run: async (stagingDir) => {
      const stagingRealDir = await fs.realpath(stagingDir);
      for (const entry of entries) {
        const output = resolveZipOutputPath({
          entryPath: entry.name,
          strip,
          destinationDir: stagingRealDir,
        });
        if (!output) {
          continue;
        }

        await prepareZipOutputPath({
          destinationDir: stagingRealDir,
          destinationRealDir: stagingRealDir,
          relPath: output.relPath,
          outPath: output.outPath,
          originalPath: entry.name,
          isDirectory: entry.dir,
        });
        if (entry.dir) {
          continue;
        }
        if (isZipSymlinkEntry(entry)) {
          throw new Error(`zip entry is a link: ${entry.name}`);
        }

        await writeZipFileEntry({
          entry,
          outPath: output.outPath,
          budget,
        });
      }

      await mergeExtractedTreeIntoDestination({
        sourceDir: stagingRealDir,
        destinationDir: params.destDir,
        destinationRealDir,
      });
    },
  });
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
        const tar = await importOptionalTar();
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
              destinationDir: params.destDir,
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

async function importOptionalTar(): Promise<TarModule> {
  try {
    return await import("tar");
  } catch (err) {
    throw missingOptionalArchiveDependencyError("tar", err);
  }
}

function missingOptionalArchiveDependencyError(packageName: "tar", cause: unknown): Error {
  return new Error(
    `Optional archive dependency "${packageName}" is not installed. Install it to use TAR archive helpers from @openclaw/fs-safe/archive.`,
    { cause },
  );
}
