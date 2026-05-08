import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainFileLockManagerForTest, resetFileLockManagerForTest } from "../src/file-lock.js";
import { sameFileIdentity } from "../src/file-identity.js";
import { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { resolveSecureTempRoot, type ResolveSecureTempRootOptions } from "../src/secure-temp-dir.js";
import { writeSiblingTempFile, writeViaSiblingTempPath } from "../src/sibling-temp.js";
import {
  buildRandomTempFilePath,
  sanitizeTempFileName,
  tempFile,
  withTempFile,
} from "../src/temp-target.js";

type SecureDirStat = NonNullable<ResolveSecureTempRootOptions["lstatSync"]> extends (
  path: string,
) => infer Result
  ? Result
  : never;

const tempDirs = new Set<string>();

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function nodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function dirStat(params?: {
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  mode?: number;
  uid?: number;
}): SecureDirStat {
  return {
    isDirectory: () => params?.isDirectory ?? true,
    isSymbolicLink: () => params?.isSymbolicLink ?? false,
    mode: params?.mode ?? 0o40700,
    uid: params?.uid,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("secure temp root fallback coverage", () => {
  it("creates the uid-less fallback when no preferred directory is configured", () => {
    const fallbackPath = path.join("/tmp", "fs-safe-test");
    let created = false;

    const resolved = resolveSecureTempRoot({
      fallbackPrefix: "fs-safe-test",
      getuid: () => undefined,
      lstatSync: vi.fn((candidate: string) => {
        if (candidate === fallbackPath && !created) {
          throw nodeError("ENOENT");
        }
        return dirStat();
      }),
      mkdirSync: vi.fn((candidate: string) => {
        if (candidate === fallbackPath) {
          created = true;
        }
      }),
      chmodSync: vi.fn(),
      accessSync: vi.fn(),
      tmpdir: () => "/tmp",
      warn: vi.fn(),
    });

    expect(resolved).toBe(fallbackPath);
  });

  it("rejects an unsafe fallback directory that cannot be repaired", () => {
    expect(() =>
      resolveSecureTempRoot({
        fallbackPrefix: "fs-safe-test",
        getuid: () => 501,
        lstatSync: vi.fn(() => dirStat({ isSymbolicLink: true, uid: 501 })),
        mkdirSync: vi.fn(),
        chmodSync: vi.fn(),
        accessSync: vi.fn(),
        tmpdir: () => "/tmp",
        unsafeFallbackLabel: "test temp",
        warn: vi.fn(),
      }),
    ).toThrow("Unsafe fallback test temp");
  });

  it("accepts a fallback directory after a chmod-denied recheck proves it safe", () => {
    const fallbackPath = path.join("/tmp", "fs-safe-test-501");
    let calls = 0;

    const resolved = resolveSecureTempRoot({
      fallbackPrefix: "fs-safe-test",
      getuid: () => 501,
      lstatSync: vi.fn((candidate: string) => {
        expect(candidate).toBe(fallbackPath);
        calls += 1;
        return dirStat({ mode: calls < 3 ? 0o40777 : 0o40700, uid: 501 });
      }),
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(() => {
        throw nodeError("EPERM");
      }),
      accessSync: vi.fn(),
      tmpdir: () => "/tmp",
      warn: vi.fn(),
    });

    expect(resolved).toBe(fallbackPath);
  });
});

describe("small identity and lock wrappers", () => {
  it("compares file identities across POSIX and Windows zero-device stats", async () => {
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }, "linux")).toBe(true);
    expect(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }, "linux")).toBe(false);
    expect(sameFileIdentity({ dev: 0, ino: 2 }, { dev: 99, ino: 2 }, "win32")).toBe(true);
    expect(sameFileIdentity({ dev: 0n, ino: 2n }, { dev: 99n, ino: 2n }, "linux")).toBe(false);

    const root = await tempRoot("fs-safe-file-lock-wrapper-");
    const targetPath = path.join(root, "state.json");
    await drainFileLockManagerForTest(targetPath, "coverage-lock-wrapper");
    resetFileLockManagerForTest(targetPath, "coverage-lock-wrapper");
  });
});

describe("sibling temp coverage", () => {
  it("syncs temp files and parent dirs when requested", async () => {
    const root = await tempRoot("fs-safe-sibling-more-");
    const result = await writeSiblingTempFile({
      dir: root,
      mode: 0o600,
      syncParentDir: true,
      syncTempFile: true,
      tempPrefix: ".coverage",
      writeTemp: async (tempPath) => {
        await fs.writeFile(tempPath, "synced", "utf8");
        return { name: "final.txt" };
      },
      resolveFinalPath: ({ name }) => path.join(root, name),
    });

    expect(result.filePath).toBe(path.join(root, "final.txt"));
    await expect(fs.readFile(result.filePath, "utf8")).resolves.toBe("synced");
    if (process.platform !== "win32") {
      // POSIX file modes don't fully apply on Windows.
      expect((await fs.stat(result.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes sibling temp files when copy-in rejects the staged source", async () => {
    const root = await tempRoot("fs-safe-sibling-copyin-");
    const outside = await tempRoot("fs-safe-sibling-copyin-outside-");
    const targetPath = path.join(root, "nested", "out.txt");
    let stagedPath = "";
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    await expect(
      writeViaSiblingTempPath({
        rootDir: root,
        targetPath,
        writeTemp: async (candidate) => {
          stagedPath = candidate;
          await fs.writeFile(candidate, "bad", "utf8");
          await fs.symlink(outside, path.dirname(targetPath), "dir");
        },
      }),
    ).rejects.toBeTruthy();

    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
});

describe("temp target edge coverage", () => {
  it("normalizes empty temp names, extensions, timestamps, and cleanup on thrown callbacks", async () => {
    const root = await tempRoot("fs-safe-temp-more-");

    expect(sanitizeTempFileName("???")).toBe("download.bin");
    const built = buildRandomTempFilePath({
      rootDir: root,
      prefix: "!!!",
      extension: "._-",
      now: Number.NaN,
      uuid: "id",
    });
    expect(path.dirname(built)).toBe(root);
    expect(path.basename(built)).toMatch(/^tmp-\d+-id$/);

    const tmp = await tempFile({ rootDir: root, prefix: "???", fileName: "???" });
    expect(path.basename(tmp.dir)).toMatch(/^tmp-/);
    expect(path.basename(tmp.path)).toBe("download.bin");
    await tmp.cleanup();

    let scopedPath = "";
    await expect(
      withTempFile({ rootDir: root, prefix: "throwing", fileName: "x.txt" }, async (tmpPath) => {
        scopedPath = tmpPath;
        await fs.writeFile(tmpPath, "cleanup", "utf8");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(path.dirname(scopedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("local roots edge coverage", () => {
  it("rejects invalid root entries and file URL inputs", async () => {
    const root = await tempRoot("fs-safe-local-roots-more-");
    await expect(async () =>
      resolveLocalPathFromRootsSync({ filePath: root, roots: [" "], label: "media roots" }),
    ).rejects.toThrow("media roots entry is required");
    expect(() =>
      resolveLocalPathFromRootsSync({ filePath: root, roots: ["relative"], label: "media roots" }),
    ).toThrow("absolute paths");
    expect(() =>
      resolveLocalPathFromRootsSync({
        filePath: root,
        roots: [`${root}\0bad`],
        label: "media roots",
      }),
    ).toThrow("NUL");
    expect(() =>
      resolveLocalPathFromRootsSync({
        filePath: "file://remote.example/path.txt",
        roots: [root],
      }),
    ).toThrow("Invalid file:// URL");
  });

  it("skips unusable roots and non-file candidates", async () => {
    const root = await tempRoot("fs-safe-local-roots-valid-");
    const missingRoot = path.join(root, "missing-root");
    const realRoot = path.join(root, "real-root");
    const childDir = path.join(realRoot, "child");
    const filePath = path.join(realRoot, "ok.txt");
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(filePath, "ok", "utf8");

    expect(
      resolveLocalPathFromRootsSync({
        filePath,
        roots: [missingRoot, realRoot],
        requireFile: true,
      }),
    ).toMatchObject({ path: fsSync.realpathSync(filePath) });
    expect(
      resolveLocalPathFromRootsSync({
        filePath: childDir,
        roots: [realRoot],
        requireFile: true,
      }),
    ).toBeNull();
    await expect(
      readLocalFileFromRoots({ filePath: realRoot, roots: [missingRoot, realRoot] }),
    ).resolves.toBeNull();
  });
});
