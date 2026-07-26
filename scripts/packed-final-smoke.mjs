import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractArchive } from "@openclaw/fs-safe/archive";
import { configureFsSafeNative, root as createRoot } from "@openclaw/fs-safe";
import { publishFileExclusive } from "@openclaw/fs-safe/durability";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

process.env.NODE_ENV = "test";
configureFsSafeNative({ mode: "off" });

const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-final-smoke-"));
const results = { archive: null, publication: [], walk: null };

try {
  const archivePath = path.join(root, "fleet-restore.tar");
  const destination = path.join(root, "restore");
  await fs.writeFile(archivePath, symlinkTar("fleet/link", "../outside"));
  await fs.mkdir(destination);
  const started = performance.now();
  await assert.rejects(
    settleWithin(
      extractArchive({
        archivePath,
        destDir: destination,
        timeoutMs: 10_000,
        entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
      }),
    ),
    (error) => error?.name === "ArchiveSecurityError" && error?.code === "entry-filtered",
  );
  results.archive = {
    mode: "off",
    errorCode: "entry-filtered",
    settledMs: Number((performance.now() - started).toFixed(2)),
  };

  const deepArchivePath = path.join(root, "deep-path.tar");
  const deepDestination = path.join(root, "deep-restore");
  await fs.writeFile(
    deepArchivePath,
    regularTar("one/two/three/four/value.txt", "payload"),
  );
  await fs.mkdir(deepDestination);
  await assert.rejects(
    extractArchive({
      archivePath: deepArchivePath,
      destDir: deepDestination,
      timeoutMs: 10_000,
      limits: { maxEntryPathComponents: 4 },
    }),
    (error) => error?.code === "archive-entry-path-components-exceeds-limit",
  );
  results.archive.pathLimitCode = "archive-entry-path-components-exceeds-limit";

  const walkDirectory = path.join(root, "walk");
  await fs.mkdir(path.join(walkDirectory, "healthy"), { recursive: true });
  await fs.mkdir(path.join(walkDirectory, "pruned"));
  await fs.mkdir(path.join(walkDirectory, "failed"));
  await fs.writeFile(path.join(walkDirectory, "healthy", "value.txt"), "healthy");
  await fs.writeFile(path.join(walkDirectory, "pruned", "hidden.txt"), "hidden");
  const capability = await createRoot(walkDirectory);
  const walked = [];
  for await (const entry of capability.walk("", {
    symlinkPolicy: "skip",
    onDirectoryError: "skip-and-report",
    entryFilter(entry) {
      if (entry.relativePath === "pruned") return "skip-subtree";
      if (entry.relativePath === "failed") {
        fsSync.rmSync(path.join(walkDirectory, "failed"), { recursive: true });
      }
      return "include";
    },
  })) {
    walked.push({ relativePath: entry.relativePath, kind: entry.kind });
  }
  assert(walked.some((entry) => entry.relativePath === "healthy/value.txt"));
  assert(!walked.some((entry) => entry.relativePath.startsWith("pruned")));
  assert(walked.some((entry) => entry.relativePath === "failed" && entry.kind === "directory-error"));
  results.walk = {
    prunedSubtree: true,
    directoryErrorReported: true,
    healthyEntryPreserved: true,
  };

  for (const cleanup of ["removed", "preserved", "unknown"]) {
    const directory = path.join(root, `publish-${cleanup}`);
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    const originalLinkPath = path.join(directory, "original-link");
    await fs.mkdir(directory);
    await fs.writeFile(sourcePath, "source-content");
    __setFsSafeTestHooksForTest({
      async afterPublishTargetCreated(method) {
        assert.equal(method, "hardlink");
        if (cleanup === "preserved") {
          await fs.rename(targetPath, originalLinkPath);
          await fs.writeFile(targetPath, "replacement-content");
        }
        throw new Error("post-publication guard failed");
      },
    });
    const originalRm = fs.rm;
    if (cleanup === "unknown") {
      fs.rm = async () => {
        throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      };
    }
    try {
      await assert.rejects(
        publishFileExclusive({ sourcePath, targetPath, strategy: "link-required" }),
        (error) =>
          error?.name === "FsSafeError" &&
          error?.details?.phase === "hardlink-verify" &&
          error?.details?.targetCreated === true &&
          error?.details?.targetIdentity?.ino !== undefined &&
          error?.details?.cleanup === cleanup,
      );
    } finally {
      fs.rm = originalRm;
      __setFsSafeTestHooksForTest();
    }
    results.publication.push({ cleanup, phase: "hardlink-verify", targetCreated: true });
  }

  for (const onSyncFailure of ["rollback", "preserve"]) {
    const directory = path.join(root, `publish-sync-${onSyncFailure}`);
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.mkdir(directory);
    await fs.writeFile(sourcePath, "complete-archive");
    __setFsSafeTestHooksForTest({
      beforePublishDirectorySync() {
        throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      },
    });
    const expectedCleanup = onSyncFailure === "preserve" ? "preserved" : "removed";
    try {
      await assert.rejects(
        publishFileExclusive({
          sourcePath,
          targetPath,
          strategy: "link-required",
          onSyncFailure,
        }),
        (error) =>
          error?.details?.phase === "directory-sync" &&
          error?.details?.targetCreated === true &&
          error?.details?.cleanup === expectedCleanup &&
          error?.details?.directorySync?.status === "failed" &&
          error?.details?.directorySync?.code === "EIO",
      );
    } finally {
      __setFsSafeTestHooksForTest();
    }
    assert.equal(await pathExists(targetPath), onSyncFailure === "preserve");
    results.publication.push({
      onSyncFailure,
      cleanup: expectedCleanup,
      directorySync: { status: "failed", code: "EIO" },
    });
  }

  console.log(JSON.stringify(results));
} finally {
  __setFsSafeTestHooksForTest();
  await fs.rm(root, { recursive: true, force: true });
}

async function settleWithin(promise, milliseconds = 2_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`archive rejection did not settle within ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function symlinkTar(entryPath, linkPath) {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, entryPath);
  writeOctal(header, 100, 8, 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "2");
  writeString(header, 157, 100, linkPath);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return Buffer.concat([header, Buffer.alloc(1024)]);
}

function regularTar(entryPath, bodyText) {
  const body = Buffer.from(bodyText);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, entryPath);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

function writeOctal(block, offset, length, value) {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function writeString(block, offset, length, value) {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
