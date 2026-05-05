import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceDirectoryAtomic,
  replaceFileAtomic,
  replaceFileAtomicSync,
} from "../src/atomic.js";
import {
  __cleanupRegisteredTempPathForTest,
  registerTempPathForExit,
} from "../src/temp-cleanup.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("atomic helpers", () => {
  it("replaces a file through a sibling temp path", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const filePath = path.join(root, "nested", "state.txt");
    let observedTempPath: string | undefined;

    const result = await replaceFileAtomic({
      filePath,
      content: "new",
      syncTempFile: true,
      syncParentDir: true,
      beforeRename: async ({ tempPath }) => {
        observedTempPath = tempPath;
        await expect(fs.readFile(tempPath, "utf8")).resolves.toBe("new");
      },
    });

    expect(result).toEqual({ method: "rename" });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
    await expect(fs.stat(observedTempPath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent replacements for the same target", async () => {
    const root = await tempRoot("fs-safe-atomic-queue-");
    const filePath = path.join(root, "state.txt");
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = replaceFileAtomic({
      filePath,
      content: "first",
      beforeRename: async () => {
        events.push("first-before");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push("first-release");
      },
    });
    while (!releaseFirst) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const second = replaceFileAtomic({
      filePath,
      content: "second",
      beforeRename: async () => {
        events.push("second-before");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first-before"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first-before", "first-release", "second-before"]);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second");
  });

  it("registers temp paths for best-effort exit cleanup", async () => {
    const root = await tempRoot("fs-safe-temp-cleanup-");
    const tempPath = path.join(root, "leftover.tmp");
    await fs.writeFile(tempPath, "temp", "utf8");
    const unregister = registerTempPathForExit(tempPath);

    __cleanupRegisteredTempPathForTest(tempPath);

    await expect(fs.access(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    unregister();
  });

  it("uses the permission-error copy fallback when requested", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const filePath = path.join(root, "state.txt");
    await fs.writeFile(filePath, "old", "utf8");

    const result = await replaceFileAtomic({
      filePath,
      content: "new",
      copyFallbackOnPermissionError: true,
      fileSystem: {
        promises: {
          ...fs,
          rename: async () => {
            const error = new Error("rename denied") as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          },
        },
      },
    });

    expect(result).toEqual({ method: "copy-fallback" });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
  });

  it.runIf(process.platform !== "win32")(
    "does not copy fallback through destination symlinks",
    async () => {
      const root = await tempRoot("fs-safe-atomic-link-");
      const filePath = path.join(root, "state.txt");
      const outsidePath = path.join(root, "outside.txt");
      await fs.writeFile(outsidePath, "outside", "utf8");
      await fs.symlink(outsidePath, filePath);

      await expect(
        replaceFileAtomic({
          filePath,
          content: "new",
          copyFallbackOnPermissionError: true,
          fileSystem: {
            promises: {
              ...fs,
              rename: async () => {
                const error = new Error("rename denied") as NodeJS.ErrnoException;
                error.code = "EPERM";
                throw error;
              },
            },
          },
        }),
      ).rejects.toThrow("Refusing copy fallback through symlink destination");

      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
      expect((await fs.lstat(filePath)).isSymbolicLink()).toBe(true);
      expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".fs-safe-replace")))
        .toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not sync-copy fallback through destination symlinks",
    async () => {
      const root = await tempRoot("fs-safe-atomic-link-sync-");
      const filePath = path.join(root, "state.txt");
      const outsidePath = path.join(root, "outside.txt");
      await fs.writeFile(outsidePath, "outside", "utf8");
      await fs.symlink(outsidePath, filePath);

      expect(() =>
        replaceFileAtomicSync({
          filePath,
          content: "new",
          copyFallbackOnPermissionError: true,
          fileSystem: {
            ...fsSync,
            renameSync: () => {
              const error = new Error("rename denied") as NodeJS.ErrnoException;
              error.code = "EPERM";
              throw error;
            },
          },
        }),
      ).toThrow("Refusing copy fallback through symlink destination");

      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
      expect((await fs.lstat(filePath)).isSymbolicLink()).toBe(true);
      expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".fs-safe-replace")))
        .toEqual([]);
    },
  );

  it("supports the synchronous replace variant", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const filePath = path.join(root, "sync", "state.txt");

    const result = replaceFileAtomicSync({
      filePath,
      content: "sync",
      syncTempFile: true,
      syncParentDir: true,
    });

    expect(result).toEqual({ method: "rename" });
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("sync");
  });

  it("replaces directories through a staged directory", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const targetDir = path.join(root, "target");
    const stagedDir = path.join(root, "staged");
    await fs.mkdir(targetDir);
    await fs.writeFile(path.join(targetDir, "old.txt"), "old", "utf8");
    await fs.mkdir(stagedDir);
    await fs.writeFile(path.join(stagedDir, "new.txt"), "new", "utf8");

    await replaceDirectoryAtomic({ stagedDir, targetDir });

    await expect(fs.readFile(path.join(targetDir, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.stat(path.join(targetDir, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stagedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
