import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStore } from "../src/file-store.js";
import { loadPendingJsonDurableQueueEntries } from "../src/json-durable-queue.js";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { replaceFileAtomic } from "../src/replace-file.js";
import { writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { buildRandomTempFilePath } from "../src/temp-target.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("deepsec regressions", () => {
  it("keeps caller-provided temp tokens as single path segments", async () => {
    const base = await tempRoot("fs-safe-temp-token-");
    const target = path.join(base, "out.txt");

    expect(() =>
      buildRandomTempFilePath({ rootDir: base, prefix: "tmp", uuid: "../escape" }),
    ).toThrow();
    await expect(
      replaceFileAtomic({ filePath: target, content: "x", tempPrefix: "../escape" }),
    ).rejects.toThrow();
    await expect(
      writeViaSiblingTempPath({
        rootDir: base,
        targetPath: target,
        tempPrefix: "../escape",
        writeTemp: async (tempPath) => {
          await fsp.writeFile(tempPath, "x");
        },
      }),
    ).rejects.toThrow();
    await expect(fsp.stat(path.join(path.dirname(base), "escape"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      writeViaSiblingTempPath({
        rootDir: base,
        targetPath: target,
        tempPrefix: ".derived file prefix",
        writeTemp: async (tempPath) => {
          await fsp.writeFile(tempPath, "ok");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(fsp.readFile(target, "utf8")).resolves.toBe("ok");
  });

  it.runIf(process.platform !== "win32")(
    "does not treat dangling symlinks as safe missing local-root paths",
    async () => {
      const base = await tempRoot("fs-safe-local-roots-");
      const outside = await tempRoot("fs-safe-local-roots-outside-");
      const linkPath = path.join(base, "dangling");
      await fsp.symlink(path.join(outside, "missing.txt"), linkPath, "file");

      expect(
        resolveLocalPathFromRootsSync({
          filePath: linkPath,
          roots: [base],
          allowMissing: true,
        }),
      ).toBeNull();
    },
  );

  it("preserves Root's default read cap for local-root reads", async () => {
    const base = await tempRoot("fs-safe-local-root-cap-");
    const filePath = path.join(base, "large.bin");
    await fsp.writeFile(filePath, Buffer.alloc(16 * 1024 * 1024 + 1));

    await expect(readLocalFileFromRoots({ filePath, roots: [base] })).resolves.toBeNull();
    const uncapped = await readLocalFileFromRoots({
      filePath,
      roots: [base],
      maxBytes: 16 * 1024 * 1024 + 1,
    });
    expect(uncapped?.buffer.byteLength).toBe(16 * 1024 * 1024 + 1);
  });

  it.runIf(process.platform !== "win32")("pins private copyIn sources after validation", async () => {
    const base = await tempRoot("fs-safe-private-copyin-");
    const sourceDir = await tempRoot("fs-safe-private-copyin-source-");
    const outside = await tempRoot("fs-safe-private-copyin-outside-");
    const sourcePath = path.join(sourceDir, "upload.txt");
    const outsideFile = path.join(outside, "secret.txt");
    await fsp.writeFile(sourcePath, "upload");
    await fsp.writeFile(outsideFile, "secret");
    const originalLstat = fsp.lstat;
    let swapped = false;
    vi.spyOn(fsp, "lstat").mockImplementation(async (candidate, options) => {
      const stat = await originalLstat(candidate, options as never);
      if (!swapped && candidate === sourcePath) {
        swapped = true;
        await fsp.rm(sourcePath);
        await fsp.symlink(outsideFile, sourcePath, "file");
      }
      return stat;
    });

    const store = fileStore({ rootDir: base, private: true });
    await expect(store.copyIn("copied.txt", sourcePath)).rejects.toBeTruthy();
    await expect(fsp.stat(path.join(base, "copied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("preserves private copyIn source error codes", async () => {
    const base = await tempRoot("fs-safe-private-copyin-codes-");
    const sourceDir = await tempRoot("fs-safe-private-copyin-codes-source-");
    const source = path.join(sourceDir, "source.txt");
    const link = path.join(sourceDir, "source-link.txt");
    await fsp.writeFile(source, "1234567890");
    await fsp.symlink(source, link, "file");
    const store = fileStore({ rootDir: base, private: true });

    await expect(store.copyIn("dir.txt", sourceDir)).rejects.toMatchObject({ code: "not-file" });
    await expect(store.copyIn("link.txt", link)).rejects.toMatchObject({ code: "not-file" });
    await expect(store.copyIn("large.txt", source, { maxBytes: 4 })).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it.runIf(process.platform !== "win32")("skips symlinked durable queue entries", async () => {
    const base = await tempRoot("fs-safe-queue-symlink-");
    const queueDir = path.join(base, "queue");
    const outside = await tempRoot("fs-safe-queue-outside-");
    await fsp.mkdir(queueDir);
    await fsp.writeFile(path.join(outside, "outside.json"), JSON.stringify({ leaked: true }));
    await fsp.symlink(path.join(outside, "outside.json"), path.join(queueDir, "leak.json"), "file");

    await expect(
      loadPendingJsonDurableQueueEntries<{ leaked: boolean }>({ queueDir, tempPrefix: "queue" }),
    ).resolves.toEqual([]);
  });

  it("rejects oversized durable queue entries before parsing", async () => {
    const base = await tempRoot("fs-safe-queue-size-");
    const queueDir = path.join(base, "queue");
    await fsp.mkdir(queueDir);
    await fsp.writeFile(path.join(queueDir, "large.json"), JSON.stringify({ data: "0123456789" }));

    await expect(
      loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue", maxBytes: 4 }),
    ).resolves.toEqual([]);
  });
});
