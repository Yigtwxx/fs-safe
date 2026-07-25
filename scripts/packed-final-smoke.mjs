import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractArchive } from "@openclaw/fs-safe/archive";
import { configureFsSafeNative } from "@openclaw/fs-safe";
import { publishFileExclusive } from "@openclaw/fs-safe/durability";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

process.env.NODE_ENV = "test";
configureFsSafeNative({ mode: "off" });

const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-final-smoke-"));
const results = { archive: null, publication: [] };

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

function writeOctal(block, offset, length, value) {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function writeString(block, offset, length, value) {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}
