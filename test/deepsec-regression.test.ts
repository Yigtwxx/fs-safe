import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStore } from "../src/file-store.js";
import { configureFsSafePython, root as openRoot } from "../src/index.js";
import { loadPendingJsonDurableQueueEntries } from "../src/json-durable-queue.js";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { __resetPinnedPythonWorkerForTest, runPinnedPythonOperation } from "../src/pinned-python.js";
import { replaceFileAtomic } from "../src/replace-file.js";
import { resolveRootPath } from "../src/root-path.js";
import { assertNoSymlinkParents } from "../src/symlink-parents.js";
import { writeSecretFileAtomic } from "../src/secret-file.js";
import { writeViaSiblingTempPath } from "../src/sibling-temp.js";
import { buildRandomTempFilePath, tempFile } from "../src/temp-target.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  __resetPinnedPythonWorkerForTest();
  configureFsSafePython({ mode: "auto", pythonPath: undefined });
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

  it("preserves dot-prefixed relative paths in root path results", async () => {
    const rootDir = await tempRoot("fs-safe-dot-relative-");

    await expect(
      resolveRootPath({
        rootPath: rootDir,
        absolutePath: path.join(rootDir, "..data", "file.txt"),
        boundaryLabel: "root",
      }),
    ).resolves.toMatchObject({
      relativePath: path.join("..data", "file.txt"),
    });
    await expect(
      assertNoSymlinkParents({
        rootDir,
        targetPath: path.join(rootDir, "..data", "file.txt"),
      }),
    ).resolves.toBeUndefined();
  });

  it("normalizes caller-provided temp roots to absolute paths", async () => {
    const base = await tempRoot("fs-safe-relative-temp-root-");
    const oldCwd = process.cwd();
    process.chdir(base);
    try {
      const built = buildRandomTempFilePath({
        rootDir: "relative-temp",
        prefix: "payload",
        now: 1,
        uuid: "abc",
      });
      expect(path.isAbsolute(built)).toBe(true);
      expect(built.endsWith(path.join("relative-temp", "payload-1-abc"))).toBe(true);

      await fsp.mkdir("relative-temp");
      const tmp = await tempFile({ rootDir: "relative-temp", prefix: "payload" });
      try {
        expect(path.isAbsolute(tmp.dir)).toBe(true);
        expect(path.isAbsolute(tmp.path)).toBe(true);
      } finally {
        await tmp.cleanup();
      }
    } finally {
      process.chdir(oldCwd);
    }
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

  it.runIf(process.platform !== "win32")("rejects fallback writes when a missing parent is raced to a symlink", async () => {
    configureFsSafePython({ mode: "off" });
    const base = await tempRoot("fs-safe-fallback-mkdir-symlink-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    await fsp.mkdir(rootDir);
    await fsp.mkdir(outside);
    const racedParent = path.join(rootDir, "link");
    const realMkdir = fsp.mkdir;
    let raced = false;
    vi.spyOn(fsp, "mkdir").mockImplementation(async (target, options) => {
      if (!raced && String(target).endsWith(path.join("root", "link"))) {
        raced = true;
        await fsp.symlink(outside, racedParent, "dir");
      }
      return await realMkdir(target, options as never);
    });
    const scoped = await openRoot(rootDir, { mkdir: true });

    await expect(scoped.write("link/nested/payload.txt", "payload")).rejects.toBeTruthy();
    await expect(fsp.lstat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("rejects private secret writes when the root path is swapped", async () => {
    const base = await tempRoot("fs-safe-secret-root-swap-");
    const rootDir = path.join(base, "root");
    const originalRoot = path.join(base, "root-original");
    const outside = path.join(base, "outside");
    await fsp.mkdir(rootDir);
    await fsp.mkdir(outside);
    const secretPath = path.join(rootDir, "nested", "secret.txt");
    const realRealpath = fsp.realpath;
    let swapped = false;
    vi.spyOn(fsp, "realpath").mockImplementation(async (target, options) => {
      if (!swapped && target === path.join(rootDir, "nested")) {
        swapped = true;
        await fsp.rename(rootDir, originalRoot);
        await fsp.symlink(outside, rootDir, "dir");
      }
      return await realRealpath(target, options as never);
    });

    await expect(
      writeSecretFileAtomic({ rootDir, filePath: secretPath, content: "secret" }),
    ).rejects.toBeTruthy();
    await expect(fsp.lstat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("rejects private secret writes without the pinned helper", async () => {
    configureFsSafePython({ mode: "off" });
    const base = await tempRoot("fs-safe-secret-helper-required-");
    const rootDir = path.join(base, "root");
    await fsp.mkdir(rootDir);
    const secretPath = path.join(rootDir, "secret.txt");

    await expect(
      writeSecretFileAtomic({ rootDir, filePath: secretPath, content: "secret" }),
    ).rejects.toMatchObject({ code: "helper-unavailable" });
    await expect(fsp.lstat(secretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("rejects private secret writes when the pinned parent is swapped", async () => {
    const base = await tempRoot("fs-safe-secret-parent-swap-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    const movedParent = path.join(base, "nested-original");
    await fsp.mkdir(path.join(rootDir, "nested"), { recursive: true });
    await fsp.mkdir(outside);
    const secretPath = path.join(rootDir, "nested", "secret.txt");
    const realLstat = fsp.lstat;
    let swapped = false;
    vi.spyOn(fsp, "lstat").mockImplementation(async (target, options) => {
      if (!swapped && String(target).endsWith(path.join("nested", "secret.txt"))) {
        swapped = true;
        await fsp.rename(path.join(rootDir, "nested"), movedParent);
        await fsp.symlink(outside, path.join(rootDir, "nested"), "dir");
      }
      return await realLstat(target, options as never);
    });

    await expect(
      writeSecretFileAtomic({ rootDir, filePath: secretPath, content: "secret" }),
    ).rejects.toBeTruthy();
    await expect(fsp.lstat(path.join(outside, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("rejects private secret writes when the parent is swapped after commit", async () => {
    const base = await tempRoot("fs-safe-secret-parent-post-swap-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    const movedParent = path.join(base, "nested-original");
    const parentDir = path.join(rootDir, "nested");
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.mkdir(outside);
    const secretPath = path.join(parentDir, "secret.txt");
    const realLstat = fsp.lstat;
    let swapped = false;
    vi.spyOn(fsp, "lstat").mockImplementation(async (target, options) => {
      if (!swapped && target === rootDir) {
        try {
          await realLstat(secretPath);
          swapped = true;
          await fsp.rename(parentDir, movedParent);
          await fsp.symlink(outside, parentDir, "dir");
        } catch {
          // Wait until the helper has committed the file in the pinned parent.
        }
      }
      return await realLstat(target, options as never);
    });

    await expect(
      writeSecretFileAtomic({ rootDir, filePath: secretPath, content: "secret" }),
    ).rejects.toBeTruthy();
    await expect(fsp.lstat(path.join(outside, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("rejects private secret writes when the final path is swapped after commit", async () => {
    const base = await tempRoot("fs-safe-secret-final-post-swap-");
    const rootDir = path.join(base, "root");
    const outside = path.join(base, "outside");
    const outsideFile = path.join(outside, "outside.txt");
    await fsp.mkdir(rootDir);
    await fsp.mkdir(outside);
    await fsp.writeFile(outsideFile, "outside");
    await fsp.chmod(outsideFile, 0o600);
    const secretPath = path.join(rootDir, "secret.txt");
    const finalSecretPath = path.join(await fsp.realpath(rootDir), "secret.txt");
    const realOpen = fsp.open;
    let swapped = false;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      if (!swapped && args[0] === finalSecretPath) {
        swapped = true;
        await fsp.rm(finalSecretPath, { force: true });
        await fsp.symlink(outsideFile, finalSecretPath, "file");
      }
      return await realOpen(...args);
    });

    await expect(
      writeSecretFileAtomic({ rootDir, filePath: secretPath, content: "secret" }),
    ).rejects.toBeTruthy();
    expect((await fsp.stat(outsideFile)).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("rejects pinned helper operations after root swaps", async () => {
    const rootDir = await tempRoot("fs-safe-helper-root-identity-");
    const stat = await fsp.lstat(rootDir);

    await expect(
      runPinnedPythonOperation({
        operation: "stat",
        rootPath: rootDir,
        payload: { relativePath: "", rootDev: stat.dev + 1, rootIno: stat.ino },
      }),
    ).rejects.toMatchObject({ code: "path-mismatch" });
  });
});
