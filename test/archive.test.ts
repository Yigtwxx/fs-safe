import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  type ArchiveSecurityError,
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

async function createRebindableDirectoryAlias(params: {
  aliasPath: string;
  targetPath: string;
}): Promise<void> {
  await fs.rm(params.aliasPath, { recursive: true, force: true });
  await fs.symlink(
    params.targetPath,
    params.aliasPath,
    process.platform === "win32" ? "junction" : undefined,
  );
}

async function withRealpathSymlinkRebindRace<T>(params: {
  shouldFlip: (realpathInput: string) => boolean;
  symlinkPath: string;
  symlinkTarget: string;
  run: () => Promise<T>;
}): Promise<T> {
  const realRealpath = fs.realpath.bind(fs);
  let flipped = false;
  const realpathSpy = vi
    .spyOn(fs, "realpath")
    .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const filePath = String(args[0]);
      if (!flipped && params.shouldFlip(filePath)) {
        flipped = true;
        const resolved = await realRealpath(...args);
        await createRebindableDirectoryAlias({
          aliasPath: params.symlinkPath,
          targetPath: params.symlinkTarget,
        });
        return resolved;
      }
      return await realRealpath(...args);
    });
  try {
    return await params.run();
  } finally {
    realpathSpy.mockRestore();
  }
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
    zip.file("package/my file.txt", "space");
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

    await extractArchive({ archivePath, destDir, timeoutMs: 15_000 });
    const packageDir = await resolvePackedRootDir(destDir);
    await expect(fs.readFile(path.join(packageDir, "hello.txt"), "utf8")).resolves.toBe("hi");
    await expect(fs.readFile(path.join(packageDir, "my file.txt"), "utf8")).resolves.toBe("space");
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

  it.runIf(process.platform !== "win32")(
    "does not clobber out-of-destination file when parent dir is symlink-rebound",
    async () => {
      const root = await tempRoot("fs-safe-archive-rebind-");
      const archivePath = path.join(root, "pkg.zip");
      const destDir = path.join(root, "dest");
      const outsideDir = path.join(root, "outside");
      const slotDir = path.join(destDir, "slot");
      await fs.mkdir(slotDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(outsideTarget, "SAFE", "utf8");

      const zip = new JSZip();
      zip.file("slot/target.txt", "owned");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      await withRealpathSymlinkRebindRace({
        shouldFlip: (realpathInput) => realpathInput === slotDir,
        symlinkPath: slotDir,
        symlinkTarget: outsideDir,
        run: async () => {
          await expect(
            extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
          ).rejects.toMatchObject({
            code: "destination-symlink-traversal",
          } satisfies Partial<ArchiveSecurityError>);
        },
      });

      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("SAFE");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not cleanup through a swapped zip entry parent before commit",
    async () => {
      const root = await tempRoot("fs-safe-archive-cleanup-race-");
      const archivePath = path.join(root, "pkg.zip");
      const destDir = path.join(root, "dest");
      const outsideDir = path.join(root, "outside");
      const outsideFile = path.join(outsideDir, "payload.txt");
      await fs.mkdir(destDir);
      await fs.mkdir(outsideDir);
      await fs.writeFile(outsideFile, "outside");
      const zip = new JSZip();
      zip.file("nested/payload.txt", "inside");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      const realMkdir = fs.mkdir.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "mkdir").mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        const candidate = String(args[0]);
        if (!swapped && path.basename(candidate) === "nested" && await fs.lstat(candidate).then(() => true, () => false)) {
          swapped = true;
          await fs.rename(candidate, path.join(path.dirname(candidate), "nested-real"));
          await fs.symlink(outsideDir, candidate, "dir");
        }
        return await realMkdir(...args);
      });

      await expect(extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }))
        .rejects.toBeTruthy();
      await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects zip extraction when a hardlink appears after write",
    async () => {
      const root = await tempRoot("fs-safe-archive-hardlink-");
      const archivePath = path.join(root, "pkg.zip");
      const destDir = path.join(root, "dest");
      const outsideDir = path.join(root, "outside");
      const outsideAlias = path.join(outsideDir, "payload.bin");
      const extractedPath = path.join(destDir, "package", "payload.bin");
      await fs.mkdir(destDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      const extractedRealPath = path.join(await fs.realpath(destDir), "package", "payload.bin");

      const zip = new JSZip();
      zip.file("package/payload.bin", "owned");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));

      const realLstat = fs.lstat.bind(fs);
      let linked = false;
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (!linked && String(args[0]) === extractedRealPath) {
          await fs.link(extractedRealPath, outsideAlias);
          linked = true;
        }
        return await realLstat(...args);
      });

      try {
        await expect(
          extractArchive({ archivePath, destDir, kind: "zip", timeoutMs: 15_000 }),
        ).rejects.toMatchObject({
          code: "destination-symlink-traversal",
        } satisfies Partial<ArchiveSecurityError>);
      } finally {
        lstatSpy.mockRestore();
      }

      await expect(fs.readFile(outsideAlias, "utf8")).resolves.toBe("owned");
      await expect(fs.stat(extractedPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
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
