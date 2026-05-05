import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  replaceDirectoryStaged,
  replaceFileAtomic,
  replaceFileAtomicSync,
} from "../src/atomic.js";

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

    await replaceDirectoryStaged({ stagedDir, targetDir });

    await expect(fs.readFile(path.join(targetDir, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.stat(path.join(targetDir, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stagedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
