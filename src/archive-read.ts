import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { readFileHandleBounded } from "./bounded-read.js";
import {
  normalizeArchiveEntryPath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import { resolveArchiveKind, type ArchiveKind } from "./archive-kind.js";
import {
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  ArchiveLimitError,
  ARCHIVE_LIMIT_ERROR_CODE,
} from "./archive-limits.js";
import { readTarEntryInfo } from "./archive-tar.js";
import { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
import { sameFileIdentity } from "./file-identity.js";
import { tempFile } from "./temp-target.js";

type ZipEntry = {
  name: string;
  dir: boolean;
  unixPermissions?: number;
  nodeStream?: () => NodeJS.ReadableStream;
  async(type: "nodebuffer"): Promise<Buffer>;
};

type TarReadEntry = AsyncIterable<unknown> & { resume(): void };
type TarModule = {
  t(options: {
    file: string;
    strict: true;
    onReadEntry(entry: TarReadEntry): void;
  }): Promise<unknown>;
};

const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

function normalizedRequestedEntry(entryPath: string): string {
  validateArchiveEntryPath(entryPath, { escapeLabel: "archive root" });
  const normalized = normalizeArchiveEntryPath(entryPath).replace(/^\.\//, "");
  if (!normalized || normalized.endsWith("/")) {
    throw new Error(`archive entry is not a file: ${entryPath}`);
  }
  return normalized;
}

async function readStreamBounded(
  stream: NodeJS.ReadableStream | AsyncIterable<unknown>,
  maxBytes: number,
): Promise<Buffer> {
  if (!(Symbol.asyncIterator in Object(stream))) {
    return await new Promise<Buffer>((resolve, reject) => {
      const readable = stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      let total = 0;
      readable.on("data", (chunk: unknown) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.length;
        if (total > maxBytes) {
          readable.pause();
          reject(
            new ArchiveLimitError(
              ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
            ),
          );
          return;
        }
        chunks.push(buffer);
      });
      readable.once("end", () => resolve(Buffer.concat(chunks, total)));
      readable.once("error", reject);
    });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function stageArchiveInput(archivePath: string): Promise<{
  path: string;
  buffer: Buffer;
  cleanup(): Promise<void>;
}> {
  const resolved = await fs.realpath(archivePath);
  const before = await fs.lstat(archivePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`archive is not a regular file: ${archivePath}`);
  }
  const noFollow =
    process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
      ? fsSync.constants.O_NOFOLLOW
      : 0;
  const handle = await fs.open(resolved, fsSync.constants.O_RDONLY | noFollow);
  const staged = await tempFile({ prefix: "fs-safe-archive-read", fileName: "archive.bin" });
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(resolved);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(current, opened)
    ) {
      throw new Error("archive changed during validation");
    }
    const buffer = await readFileHandleBounded(handle, DEFAULT_MAX_ARCHIVE_BYTES_ZIP);
    await fs.writeFile(staged.path, buffer, { flag: "wx", mode: 0o600 });
    return { path: staged.path, buffer, cleanup: staged.cleanup };
  } catch (error) {
    await staged.cleanup().catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readZipEntry(buffer: Buffer, entryPath: string, maxBytes: number): Promise<Buffer> {
  const archive = await loadZipArchiveWithPreflight(buffer, {
    maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
    maxEntryBytes: maxBytes,
    maxExtractedBytes: maxBytes,
  });
  const entry = (archive.files as Record<string, ZipEntry>)[entryPath];
  if (!entry || entry.dir) {
    throw new Error(`archive entry not found: ${entryPath}`);
  }
  if (
    typeof entry.unixPermissions === "number" &&
    (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE
  ) {
    throw new Error(`archive entry is a link: ${entryPath}`);
  }
  const stream =
    typeof entry.nodeStream === "function"
      ? entry.nodeStream()
      : Readable.from(await entry.async("nodebuffer"));
  return await readStreamBounded(stream, maxBytes);
}

async function readTarEntry(archivePath: string, entryPath: string, maxBytes: number): Promise<Buffer> {
  const tar = await importOptionalTar();
  let matched: Promise<Buffer> | undefined;
  await tar.t({
    file: archivePath,
    strict: true,
    onReadEntry(entry) {
      const info = readTarEntryInfo(entry);
      validateArchiveEntryPath(info.path, { escapeLabel: "archive root" });
      const normalized = normalizeArchiveEntryPath(info.path).replace(/^\.\//, "");
      if (normalized !== entryPath) {
        entry.resume();
        return;
      }
      if (info.type !== "File" && info.type !== "OldFile" && info.type !== "ContiguousFile") {
        matched = Promise.reject(new Error(`archive entry is not a file: ${entryPath}`));
        entry.resume();
        return;
      }
      if (info.size > maxBytes) {
        matched = Promise.reject(
          new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT),
        );
        entry.resume();
        return;
      }
      matched = readStreamBounded(entry, maxBytes);
    },
  });
  if (!matched) {
    throw new Error(`archive entry not found: ${entryPath}`);
  }
  return await matched;
}

export async function readArchiveEntry(
  archivePath: string,
  entryPath: string,
  options: { maxBytes: number; kind?: ArchiveKind },
): Promise<Buffer> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const kind = options.kind ?? resolveArchiveKind(archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${archivePath}`);
  }
  const requestedEntry = normalizedRequestedEntry(entryPath);
  const staged = await stageArchiveInput(archivePath);
  try {
    return kind === "zip"
      ? await readZipEntry(staged.buffer, requestedEntry, options.maxBytes)
      : await readTarEntry(staged.path, requestedEntry, options.maxBytes);
  } finally {
    await staged.cleanup();
  }
}

async function importOptionalTar(): Promise<TarModule> {
  try {
    return await import("tar");
  } catch (cause) {
    throw new Error(
      'Optional archive dependency "tar" is not installed. Install it to use TAR archive helpers from @openclaw/fs-safe/archive.',
      { cause },
    );
  }
}
