import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  extractArchive,
  resolvePackedRootDir,
} from "../src/archive.js";
import {
  buildRandomTempFilePath,
  createTempFileTarget,
  sanitizeTempFileName,
  withTempFileTarget,
} from "../src/temp-target.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("archive extraction", () => {
  it("extracts zip archives through safe destination checks", async () => {
    const root = await tempRoot("fs-safe-archive-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });

    const zip = new JSZip();
    zip.file("package/hello.txt", "hi");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await extractArchive({ archivePath, destDir, timeoutMs: 15_000 });
    const packageDir = await resolvePackedRootDir(destDir);
    await expect(fs.readFile(path.join(packageDir, "hello.txt"), "utf8")).resolves.toBe("hi");
  });

  it("does not truncate existing destination files when zip extraction fails", async () => {
    const root = await tempRoot("fs-safe-archive-fail-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, "keep.txt"), "old-content");

    const zip = new JSZip();
    zip.file("keep.txt", "new-content-that-exceeds-the-entry-limit");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(
      extractArchive({
        archivePath,
        destDir,
        kind: "zip",
        timeoutMs: 15_000,
        limits: { maxEntryBytes: 4 },
      }),
    ).rejects.toMatchObject({
      code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
    });
    await expect(fs.readFile(path.join(destDir, "keep.txt"), "utf8")).resolves.toBe(
      "old-content",
    );
  });
});

describe("temp file targets", () => {
  it("sanitizes file names and cleans target directories", async () => {
    const root = await tempRoot("fs-safe-temp-target-");
    expect(sanitizeTempFileName("../bad name?.txt")).toBe("bad-name-.txt");
    expect(
      buildRandomTempFilePath({
        rootDir: root,
        prefix: "demo!",
        extension: "txt",
        now: 123,
        uuid: "abc",
      }),
    ).toBe(path.join(root, "demo-123-abc.txt"));

    let targetDir = "";
    await withTempFileTarget(
      { rootDir: root, prefix: "download", fileName: "../x.txt" },
      async (filePath) => {
        targetDir = path.dirname(filePath);
        await fs.writeFile(filePath, "ok", "utf8");
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("ok");
      },
    );
    await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates explicit temp file targets", async () => {
    const root = await tempRoot("fs-safe-temp-target-");
    const target = await createTempFileTarget({ rootDir: root, prefix: "download" });
    await fs.writeFile(target.path, "ok", "utf8");
    await target.cleanup();
    await expect(fs.stat(target.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
