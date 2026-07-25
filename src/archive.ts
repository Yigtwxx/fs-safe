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
  createPipelineTimeoutError,
  waitForDeadline,
  withExtractionDeadline,
  type ExtractionDeadline,
} from "./archive-deadline.js";
import { writeFileHandleFully } from "./archive-file-io.js";
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
import {
  isZipSymlinkEntry,
  zipEntryDeclaredSize,
  zipEntryMode,
  type ZipEntry,
} from "./archive-zip-entry.js";
import { sameFileIdentity } from "./file-identity.js";
import {
  resolveArchiveEntryMode,
  shouldExtractArchiveEntry,
} from "./archive-policy.js";
import { importOptionalTar } from "./archive-tar-runtime.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import { writeSiblingTempFile } from "./sibling-temp.js";
import { tempFile } from "./temp-target.js";
export type { ArchiveLogger, ExtractArchiveOptions } from "./archive-options.js";
export type {
  ArchiveEntryFilter,
  ArchiveEntryKind,
  ArchiveEntryModePolicy,
  ArchiveFilteredEntryPolicy,
} from "./archive-policy.js";
export {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
export { resolveArchiveKind, resolvePackedRootDir, type ArchiveKind } from "./archive-kind.js";
export { readArchiveEntry } from "./archive-read.js";
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
type ZipExtractBudget = ReturnType<typeof createByteBudgetTracker>;
type StagedArchiveFile = { path: string; cleanup: () => Promise<void> };
async function cleanupStagedArchiveFile(staged: StagedArchiveFile | undefined): Promise<void> {
  if (staged) {
    await staged.cleanup().catch(() => undefined);
  }
}
async function closeFileHandle(handle: FileHandle | undefined): Promise<void> {
  if (handle) {
    await handle.close().catch(() => undefined);
  }
}
async function stageArchiveFileForExtraction(params: {
  archivePath: string;
  limits: ReturnType<typeof resolveExtractLimits>;
  deadline: ExtractionDeadline;
}): Promise<StagedArchiveFile> {
  params.deadline.check();
  const sourcePath = path.resolve(params.archivePath);
  const initialStat = await fs.lstat(sourcePath);
  if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
    throw new Error(`archive is not a regular file: ${params.archivePath}`);
  }
  if (initialStat.size > params.limits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const noFollow =
    process.platform !== "win32" && "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | noFollow);
  let staged: StagedArchiveFile | undefined;
  let output: FileHandle | undefined;
  try {
    staged = await tempFile({
      prefix: "fs-safe-archive-input",
      fileName: path.basename(sourcePath),
    });
    const openedStat = await handle.stat();
    const pathStat = await fs.lstat(sourcePath);
    if (
      !openedStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !sameFileIdentity(initialStat, openedStat) ||
      !sameFileIdentity(pathStat, openedStat)
    ) {
      throw new Error("archive changed during validation");
    }

    output = await fs.open(staged.path, OPEN_WRITE_CREATE_FLAGS, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let written = 0;
    while (true) {
      params.deadline.check();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      written += bytesRead;
      if (written > params.limits.maxArchiveBytes) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
      }
      await writeFileHandleFully({
        handle: output,
        buffer,
        bytes: bytesRead,
        deadline: params.deadline,
      });
      params.deadline.check();
    }
    await output.close();
    output = undefined;
    return staged;
  } catch (err) {
    await closeFileHandle(output);
    await cleanupStagedArchiveFile(staged);
    throw err;
  } finally {
    await closeFileHandle(handle);
  }
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
  deadline: ExtractionDeadline;
  mode: number;
}): Promise<void> {
  params.deadline.check();
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
      mode: params.mode,
      writeTemp: async (tempPath) => {
        tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, 0o666);
        const writable = tempHandle.createWriteStream();
        writable.once("close", () => {
          handleClosedByStream = true;
        });

        try {
          await pipeline(
            readable,
            createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }),
            writable,
            { signal: params.deadline.signal },
          );
        } catch (err) {
          throw createPipelineTimeoutError(err, params.deadline);
        }
        params.deadline.check();
        if (!handleClosedByStream) {
          await tempHandle.close().catch(() => undefined);
          handleClosedByStream = true;
        }
        tempHandle = null;
        return destinationPath;
      },
      resolveFinalPath: (filePath) => filePath,
    });
  } catch (err) {
    // Failures here happen before the temp has been committed. The destination
    // parent may already be untrusted, so cleanup must stay limited to temp state.
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
  deadline: ExtractionDeadline;
  entryModes?: ExtractArchiveOptions["entryModes"];
  entryFilter?: ExtractArchiveOptions["entryFilter"];
  onFiltered?: ExtractArchiveOptions["onFiltered"];
}): Promise<void> {
  const limits = resolveExtractLimits(params.limits);
  const stagedArchive = await stageArchiveFileForExtraction({
    archivePath: params.archivePath,
    limits,
    deadline: params.deadline,
  });
  try {
    const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
    params.deadline.check();
    const buffer = await fs.readFile(stagedArchive.path, { signal: params.deadline.signal });
    params.deadline.check();
    const zip = await waitForDeadline(loadZipArchiveWithPreflight(buffer, limits), params.deadline);
    params.deadline.check();
    const entries = Object.values(zip.files) as ZipEntry[];
    const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));

    assertArchiveEntryCountWithinLimit(entries.length, limits);

    const budget = createByteBudgetTracker(limits);

    await withStagedArchiveDestination({
      destinationRealDir,
      run: async (stagingDir) => {
        const stagingRealDir = await fs.realpath(stagingDir);
        for (const entry of entries) {
          params.deadline.check();
          const output = resolveZipOutputPath({
            entryPath: entry.name,
            strip,
            destinationDir: stagingRealDir,
          });
          if (!output) {
            continue;
          }

          const isSymlink = isZipSymlinkEntry(entry);
          const entryKind = isSymlink ? "symlink" : entry.dir ? "directory" : "file";
          const entrySize = zipEntryDeclaredSize(entry);
          if (
            !shouldExtractArchiveEntry({
              filter: params.entryFilter,
              onFiltered: params.onFiltered,
              entry: { path: entry.name, kind: entryKind, size: entrySize },
            })
          ) {
            continue;
          }
          const mode = zipEntryMode(entry, params.entryModes);

          await prepareZipOutputPath({
            destinationDir: stagingRealDir,
            destinationRealDir: stagingRealDir,
            relPath: output.relPath,
            outPath: output.outPath,
            originalPath: entry.name,
            isDirectory: entry.dir,
          });
          if (entry.dir) {
            await fs.chmod(output.outPath, mode);
            continue;
          }
          if (isSymlink) {
            throw new Error(`zip entry is a link: ${entry.name}`);
          }

          await writeZipFileEntry({
            entry,
            outPath: output.outPath,
            budget,
            deadline: params.deadline,
            mode,
          });
        }

        params.deadline.check();
        await mergeExtractedTreeIntoDestination({
          sourceDir: stagingRealDir,
          destinationDir: params.destDir,
          destinationRealDir,
        });
        params.deadline.check();
      },
    });
  } finally {
    await stagedArchive.cleanup();
  }
}

export async function extractArchive(params: ExtractArchiveOptions): Promise<void> {
  const kind = params.kind ?? resolveArchiveKind(params.archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${params.archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  if (kind === "tar") {
    await withExtractionDeadline(params.timeoutMs, label, async (deadline) => {
      const tar = await importOptionalTar();
      const limits = resolveExtractLimits(params.limits);
      const stagedArchive = await stageArchiveFileForExtraction({
        archivePath: params.archivePath,
        limits,
        deadline,
      });
      try {
        const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
        await withStagedArchiveDestination({
          destinationRealDir,
          run: async (stagingDir) => {
            deadline.check();
            const checkTarEntrySafety = createTarEntryPreflightChecker({
              rootDir: destinationRealDir,
              stripComponents: params.stripComponents,
              limits,
              entryFilter: params.entryFilter,
              onFiltered: params.onFiltered,
            });
            const acceptedEntries: Array<{ path: string; mode: number }> = [];
            // A canonical cwd is not enough here: tar can still follow
            // pre-existing child symlinks in the live destination tree.
            // Extract into a private staging dir first, then merge through
            // the same safe-open boundary checks used by direct file writes.
            await tar.x({
              file: stagedArchive.path,
              cwd: stagingDir,
              strip: Math.max(0, Math.floor(params.stripComponents ?? 0)),
              gzip: params.tarGzip,
              signal: deadline.signal,
              preservePaths: false,
              noChmod: true,
              preserveOwner: false,
              strict: true,
              filter(_entryPath, entry) {
                const info = readTarEntryInfo(entry);
                const accepted = checkTarEntrySafety(info);
                if (accepted) {
                  const relPath = stripArchivePath(
                    info.path,
                    Math.max(0, Math.floor(params.stripComponents ?? 0)),
                  );
                  if (relPath) {
                    acceptedEntries.push({
                      path: relPath,
                      mode: resolveArchiveEntryMode({
                        kind:
                          info.type === "Directory" || info.type === "GNUDumpDir"
                            ? "directory"
                            : "file",
                        archivedMode: info.mode,
                        policy: params.entryModes,
                      }),
                    });
                  }
                }
                return accepted;
              },
              onReadEntry(entry) {
                try {
                  deadline.check();
                } catch (err) {
                  const error = err instanceof Error ? err : new Error(String(err));
                  // Node's EventEmitter calls listeners with `this` bound to the
                  // emitter (tar.Unpack), which exposes Parser.abort().
                  const emitter = this as unknown as { abort?: (error: Error) => void };
                  emitter.abort?.(error);
                }
              },
            });
            for (const accepted of acceptedEntries) {
              const outputPath = resolveArchiveOutputPath({
                rootDir: stagingDir,
                relPath: accepted.path,
                originalPath: accepted.path,
              });
              await fs.chmod(outputPath, accepted.mode);
            }
            deadline.check();
            await mergeExtractedTreeIntoDestination({
              sourceDir: stagingDir,
              destinationDir: params.destDir,
              destinationRealDir,
            });
            deadline.check();
          },
        });
      } finally {
        await stagedArchive.cleanup();
      }
    });
    return;
  }

  await withExtractionDeadline(params.timeoutMs, label, async (deadline) =>
    extractZip({
      archivePath: params.archivePath,
      destDir: params.destDir,
      stripComponents: params.stripComponents,
      limits: params.limits,
      deadline,
      entryModes: params.entryModes,
      entryFilter: params.entryFilter,
      onFiltered: params.onFiltered,
    }),
  );
}
