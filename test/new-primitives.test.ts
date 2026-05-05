import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  privateFileStore,
  readPrivateJson,
  readPrivateJsonSync,
  readPrivateText,
  readPrivateTextSync,
  writePrivateJsonAtomicSync,
} from "../src/private-file-store.js";
import {
  appendRegularFile,
  appendRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
} from "../src/regular-file.js";
import {
  createPrivateTempWorkspace,
  createPrivateTempWorkspaceSync,
  tempWorkspace,
  withPrivateTempWorkspace,
  withPrivateTempWorkspaceSync,
} from "../src/private-temp-workspace.js";
import {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
} from "../src/symlink-parents.js";
import { pathScope } from "../src/root-paths.js";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/replace-file.js";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-new-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("private temp workspaces", () => {
  it("writes private files and removes the workspace", async () => {
    let workspaceDir = "";
    const content = await withPrivateTempWorkspace({ rootDir: root, prefix: "work-" }, async (tmp) => {
      workspaceDir = tmp.dir;
      const filePath = await tmp.writePrivate("input.txt", "hello");
      expect(await fs.readFile(filePath, "utf8")).toBe("hello");
      return await tmp.read("input.txt");
    });

    expect(content.toString("utf8")).toBe("hello");
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects path-like file names", async () => {
    const tmp = await createPrivateTempWorkspace({ rootDir: root, prefix: "work-" });
    try {
      await expect(tmp.writePrivate("../escape.txt", "nope")).rejects.toThrow(/Invalid/);
    } finally {
      await tmp.cleanup();
    }
  });

  it("supports sync temp workspaces", async () => {
    let workspaceDir = "";
    const result = withPrivateTempWorkspaceSync({ rootDir: root, prefix: "sync-" }, (tmp) => {
      workspaceDir = tmp.dir;
      const filePath = tmp.writePrivate("input.txt", "hello");
      expect(tmp.read("input.txt").toString("utf8")).toBe("hello");
      return filePath;
    });
    expect(path.basename(result)).toBe("input.txt");
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });

    const tmp = createPrivateTempWorkspaceSync({ rootDir: root, prefix: "sync-" });
    try {
      expect(tmp.writePrivate("again.txt", "ok")).toContain("again.txt");
    } finally {
      tmp.cleanup();
    }
  });

  it("supports the compact tempWorkspace factory and await using cleanup", async () => {
    let workspaceDir = "";
    {
      await using tmp = await tempWorkspace({ rootDir: root, prefix: "compact-" });
      workspaceDir = tmp.dir;
      const filePath = await tmp.writePrivate("input.txt", "hello");
      expect(filePath).toBe(tmp.file("input.txt"));
      expect(tmp.path("input.txt")).toBe(filePath);
    }

    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("private file store", () => {
  it("writes JSON under the store root", async () => {
    const store = privateFileStore(root);
    await store.writeJson("nested/state.json", { ok: true }, { trailingNewline: true });
    expect(await fs.readFile(path.join(root, "nested", "state.json"), "utf8")).toBe(
      '{\n  "ok": true\n}\n',
    );
    await expect(store.readJson("nested/state.json")).resolves.toEqual({ ok: true });
  });

  it("rejects paths outside the store root", async () => {
    const store = privateFileStore(root);
    await expect(store.writeText("../escape.txt", "nope")).rejects.toThrow(/stay under/);
    await expect(store.readText("../escape.txt")).rejects.toThrow(/stay under/);
  });

  it("supports sync JSON writes", async () => {
    const filePath = path.join(root, "sync.json");
    writePrivateJsonAtomicSync({ rootDir: root, filePath, value: { ok: true } });
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ ok: true });
  });

  it("reads private text and JSON by absolute path", async () => {
    const textPath = path.join(root, "state.txt");
    const jsonPath = path.join(root, "state.json");
    await fs.writeFile(textPath, "hello", "utf8");
    await fs.writeFile(jsonPath, '{"ok":true}', "utf8");

    await expect(readPrivateText({ rootDir: root, filePath: textPath })).resolves.toBe("hello");
    await expect(readPrivateJson({ rootDir: root, filePath: jsonPath })).resolves.toEqual({
      ok: true,
    });
    await expect(readPrivateText({ rootDir: root, filePath: path.join(root, "missing") }))
      .resolves
      .toBeNull();
  });

  it("reads private text and JSON synchronously", async () => {
    const textPath = path.join(root, "sync-state.txt");
    const jsonPath = path.join(root, "sync-state.json");
    await fs.writeFile(textPath, "hello", "utf8");
    await fs.writeFile(jsonPath, '{"ok":true}', "utf8");

    expect(readPrivateTextSync({ rootDir: root, filePath: textPath })).toBe("hello");
    expect(readPrivateJsonSync({ rootDir: root, filePath: jsonPath })).toEqual({ ok: true });
    expect(readPrivateTextSync({ rootDir: root, filePath: path.join(root, "missing") })).toBeNull();
  });
});

describe("sidecar locks", () => {
  it("supports await using cleanup", async () => {
    const manager = createSidecarLockManager(`test-${Date.now()}-${Math.random()}`);
    const targetPath = path.join(root, "locked.txt");
    let lockPath = "";

    {
      await using lock = await manager.acquire({
        targetPath,
        staleMs: 60_000,
        payload: () => ({ owner: "test" }),
      });
      lockPath = lock.lockPath;
      await expect(fs.stat(lockPath)).resolves.toMatchObject({});
    }

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("regular file append", () => {
  it("keeps append flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveRegularFileAppendFlags({
        O_APPEND: 0x01,
        O_CREAT: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });

  it("appends with restrictive permissions and honors max bytes", async () => {
    const filePath = path.join(root, "events.jsonl");
    await appendRegularFile({ filePath, content: "12345\n", maxFileBytes: 6 });
    await appendRegularFile({ filePath, content: "after\n", maxFileBytes: 6 });

    expect(await fs.readFile(filePath, "utf8")).toBe("12345\n");
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("appends synchronously with restrictive permissions and honors max bytes", async () => {
    const filePath = path.join(root, "sync-events.jsonl");
    appendRegularFileSync({ filePath, content: "12345\n", maxFileBytes: 6 });
    appendRegularFileSync({ filePath, content: "after\n", maxFileBytes: 6 });

    expect(await fs.readFile(filePath, "utf8")).toBe("12345\n");
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform !== "win32")("rejects symlink leaves synchronously", async () => {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(target, "secret", "utf8");
    await fs.symlink(target, link);

    expect(() => appendRegularFileSync({ filePath: link, content: "line\n" })).toThrow(/symlink/);
    expect(await fs.readFile(target, "utf8")).toBe("secret");
  });

  it.runIf(process.platform !== "win32")("rejects symlink parents", async () => {
    const targetDir = path.join(root, "target");
    const linkDir = path.join(root, "link");
    await fs.mkdir(targetDir);
    await fs.symlink(targetDir, linkDir);

    await expect(
      appendRegularFile({
        filePath: path.join(linkDir, "events.jsonl"),
        content: "line\n",
        rejectSymlinkParents: true,
      }),
    ).rejects.toThrow(/symlinked directory/);
    await expect(fs.stat(path.join(targetDir, "events.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("atomic file replacement", () => {
  it("retries transient rename failures and preserves destination spelling", async () => {
    const filePath = path.join(root, "state.json");
    const originalRename = fs.rename.bind(fs);
    const destinations: string[] = [];
    let busyCount = 0;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
      destinations.push(String(dest));
      if (busyCount < 2) {
        busyCount++;
        const error = new Error("busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return await originalRename(src, dest);
    });

    try {
      await replaceFileAtomic({
        filePath,
        content: "ok",
        renameMaxRetries: 2,
        renameRetryBaseDelayMs: 0,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(busyCount).toBe(2);
    expect(destinations).toEqual([filePath, filePath, filePath]);
    expect(await fs.readFile(filePath, "utf8")).toBe("ok");
  });

  it("can fall back to copy/unlink for permission-style rename failures", async () => {
    const filePath = path.join(root, "windows.json");
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const error = new Error("permission") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      await replaceFileAtomic({
        filePath,
        content: "copied",
        copyFallbackOnPermissionError: true,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(await fs.readFile(filePath, "utf8")).toBe("copied");
  });

  it("cleans the temp file after failed replacement", async () => {
    const filePath = path.join(root, "fail.json");
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    try {
      await expect(
        replaceFileAtomic({
          filePath,
          content: "nope",
          tempPrefix: ".cron-store",
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      renameSpy.mockRestore();
    }

    const entries = await fs.readdir(root);
    expect(entries.filter((entry) => entry.startsWith(".cron-store"))).toEqual([]);
  });

  it("applies requested directory and file modes", async () => {
    const filePath = path.join(root, "nested", "mode.txt");
    await replaceFileAtomic({
      filePath,
      content: "mode",
      dirMode: 0o755,
      fileMode: 0o644,
    });

    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    }
  });

  it("supports sync replacement", async () => {
    const filePath = path.join(root, "sync", "state.txt");
    replaceFileAtomicSync({
      filePath,
      content: "sync",
      dirMode: 0o755,
      fileMode: 0o644,
      tempPrefix: ".sync-replace",
    });

    expect(await fs.readFile(filePath, "utf8")).toBe("sync");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    }
  });

  it("preserves an existing destination mode when requested", async () => {
    const filePath = path.join(root, "preserve-mode.txt");
    await fs.writeFile(filePath, "old", { mode: 0o640 });

    await replaceFileAtomic({
      filePath,
      content: "new",
      preserveExistingMode: true,
    });

    expect(await fs.readFile(filePath, "utf8")).toBe("new");
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o640);
    }
  });

  it("syncs the temp file before rename when requested", async () => {
    const filePath = path.join(root, "sync-temp.txt");
    let syncCalls = 0;
    const fileSystem = {
      promises: {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          return {
            sync: async () => {
              syncCalls += 1;
            },
            close: async () => await handle.close(),
          } as Awaited<ReturnType<typeof fs.open>>;
        },
      },
    };

    await replaceFileAtomic({
      filePath,
      content: "durable",
      syncTempFile: true,
      fileSystem,
    });

    expect(syncCalls).toBe(1);
    expect(await fs.readFile(filePath, "utf8")).toBe("durable");
  });

  it("can use injected async filesystem operations", async () => {
    const filePath = path.join(root, "injected.txt");
    const renamed: string[] = [];
    const fileSystem = {
      promises: {
        ...fs,
        rename: async (src: string, dest: string) => {
          renamed.push(dest);
          await fs.rename(src, dest);
        },
      },
    };

    await replaceFileAtomic({
      filePath,
      content: "injected",
      fileSystem,
    });

    expect(renamed).toEqual([filePath]);
    expect(await fs.readFile(filePath, "utf8")).toBe("injected");
  });

  it("syncs the parent directory when requested", async () => {
    const filePath = path.join(root, "parent-sync.txt");
    let openedDir = "";
    const fileSystem = {
      promises: {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          openedDir = String(args[0]);
          const handle = await fs.open(...args);
          return {
            sync: async () => undefined,
            close: async () => await handle.close(),
          } as Awaited<ReturnType<typeof fs.open>>;
        },
      },
    };

    await replaceFileAtomic({
      filePath,
      content: "durable-parent",
      syncParentDir: true,
      fileSystem,
    });

    expect(openedDir).toBe(root);
  });

  it("cleans the sync temp file after failed replacement", async () => {
    const filePath = path.join(root, "sync-fail.json");
    const renameSpy = vi.spyOn(syncFs, "renameSync").mockImplementation(() => {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    try {
      expect(() =>
        replaceFileAtomicSync({
          filePath,
          content: "nope",
          tempPrefix: ".sync-store",
        }),
      ).toThrow();
    } finally {
      renameSpy.mockRestore();
    }

    const entries = await fs.readdir(root);
    expect(entries.filter((entry) => entry.startsWith(".sync-store"))).toEqual([]);
  });
});

describe("path moves", () => {
  it("moves paths with rename", async () => {
    const from = path.join(root, "from.txt");
    const to = path.join(root, "to.txt");
    await fs.writeFile(from, "moved");

    await movePathWithCopyFallback({ from, to });

    await expect(fs.access(from)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(to, "utf8")).toBe("moved");
  });
});

describe("sibling temp files", () => {
  it("writes through a sibling temp file and cleans failures", async () => {
    const finalPath = path.join(root, "download.bin");
    const writtenTempPaths: string[] = [];
    const result = await writeSiblingTempFile({
      dir: root,
      fileMode: 0o644,
      writeTemp: async (tempPath) => {
        writtenTempPaths.push(tempPath);
        await fs.writeFile(tempPath, "streamed");
        return { name: "download.bin" };
      },
      resolveFinalPath: (value) => path.join(root, value.name),
    });

    expect(result.filePath).toBe(finalPath);
    expect(await fs.readFile(finalPath, "utf8")).toBe("streamed");
    await expect(fs.access(writtenTempPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects final paths outside the temp directory", async () => {
    await expect(
      writeSiblingTempFile({
        dir: root,
        writeTemp: async (tempPath) => {
          await fs.writeFile(tempPath, "escape");
          return "escape";
        },
        resolveFinalPath: () => path.join(path.dirname(root), "escape.txt"),
      }),
    ).rejects.toThrow(/sibling temp directory/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("regular file helpers", () => {
  it("rejects directories", async () => {
    await expect(statRegularFile(root)).rejects.toThrow(/regular file/);
  });
});

describe("path scope directory creation", () => {
  it("creates directories inside the root", async () => {
    const result = await pathScope(root, { label: "test root" }).ensureDir("a/b", { mode: 0o700 });
    expect(result).toEqual({ ok: true, path: path.join(root, "a", "b") });
    await expect(fs.stat(path.join(root, "a", "b"))).resolves.toMatchObject({});
  });

  it("rejects escapes", async () => {
    const result = await pathScope(root, { label: "test root" }).ensureDir("../out");
    expect(result.ok).toBe(false);
  });
});

describe("symlink parent guards", () => {
  it("rejects symlink path components", async () => {
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(link, "file.txt"),
        requireDirectories: true,
      }),
    ).rejects.toThrow(/symlinked/);
  });

  it("has a sync variant", async () => {
    const real = path.join(root, "real-sync");
    const link = path.join(root, "link-sync");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    expect(() =>
      assertNoSymlinkParentsSync({
        rootDir: root,
        targetPath: path.join(link, "file.txt"),
        requireDirectories: true,
      }),
    ).toThrow(/symlinked/);
  });
});
