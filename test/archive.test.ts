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
  sanitizeTempFileName,
  tempFile,
  withTempFile,
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

  it.runIf(process.platform !== "win32")("rejects zip symlink entries", async () => {
    const root = await tempRoot("fs-safe-archive-link-");
    const archivePath = path.join(root, "pkg.zip");
    const destDir = path.join(root, "dest");
    const outsidePath = path.join(root, "outside.txt");
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(outsidePath, "outside", "utf8");

    const zip = new JSZip();
    zip.file("link.txt", outsidePath, { unixPermissions: 0o120777 });
    await fs.writeFile(
      archivePath,
      await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }),
    );

    await expect(
      extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
    ).rejects.toThrow("zip entry is a link: link.txt");
    await expect(fs.readdir(destDir)).resolves.toEqual([]);
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
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
    await withTempFile(
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
    const target = await tempFile({ rootDir: root, prefix: "download" });
    expect(target.file("other.txt")).toBe(path.join(target.dir, "other.txt"));
    await fs.writeFile(target.path, "ok", "utf8");
    await target.cleanup();
    await expect(fs.stat(target.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("disposes explicit temp file targets", async () => {
    const root = await tempRoot("fs-safe-temp-target-");
    let dir = "";
    {
      await using target = await tempFile({ rootDir: root, prefix: "download" });
      dir = target.dir;
      await fs.writeFile(target.path, "ok", "utf8");
    }
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
