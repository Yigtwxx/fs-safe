import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function replaceParentAfterOpen(params: {
  targetPath: string;
  parentPath: string;
  movedParentPath: string;
  symlinkTargetPath: string;
}): Promise<() => void> {
  const originalOpen = fs.open;
  let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === params.targetPath) {
      closeSpy = vi.spyOn(handle, "close");
      await fs.rename(params.parentPath, params.movedParentPath);
      await fs.symlink(params.symlinkTargetPath, params.parentPath, "dir");
    }
    return handle;
  });
  return () => {
    openSpy.mockRestore();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("guarded fallback write cleanup", () => {
  it.runIf(process.platform !== "win32")("closes pinned no-overwrite handles when post guards fail", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    configureFsSafeNative({ mode: "off" });
    const base = await tempRoot("fs-safe-pinned-post-guard-");
    const parentPath = path.join(base, "nested");
    const movedParentPath = path.join(base, "nested-real");
    const targetPath = path.join(parentPath, "created.txt");
    const outside = await tempRoot("fs-safe-pinned-post-guard-outside-");
    const outsideFile = path.join(outside, "created.txt");
    await fs.mkdir(parentPath);
    await fs.writeFile(outsideFile, "outside");
    const assertClosed = await replaceParentAfterOpen({
      targetPath,
      parentPath,
      movedParentPath,
      symlinkTargetPath: outside,
    });

    await expect(
      runPinnedWriteHelper({
        rootPath: base,
        relativeParentPath: "nested",
        basename: "created.txt",
        mkdir: false,
        mode: 0o600,
        overwrite: false,
        input: { kind: "buffer", data: "payload" },
      }),
    ).rejects.toBeTruthy();

    assertClosed();
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  it.runIf(process.platform !== "win32")("closes root no-overwrite handles when post guards fail", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const { root: openRoot } = await import("../src/index.js");
    const base = await tempRoot("fs-safe-root-post-guard-");
    const parentPath = path.join(base, "nested");
    const movedParentPath = path.join(base, "nested-real");
    const outside = await tempRoot("fs-safe-root-post-guard-outside-");
    const outsideFile = path.join(outside, "created.txt");
    await fs.mkdir(parentPath);
    await fs.writeFile(outsideFile, "outside");
    const targetPath = path.join(await fs.realpath(parentPath), "created.txt");
    const assertClosed = await replaceParentAfterOpen({
      targetPath,
      parentPath,
      movedParentPath,
      symlinkTargetPath: outside,
    });
    const scoped = await openRoot(base);

    await expect(scoped.create("nested/created.txt", "payload")).rejects.toBeTruthy();

    assertClosed();
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });
});
