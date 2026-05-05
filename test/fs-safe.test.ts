import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root as openRoot } from "../src/index.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("@openclaw/fs-safe", () => {
  it("reuses a root capability across filesystem operations", async () => {
    const rootPath = await tempRoot("fs-root-object-");
    const root = await openRoot(rootPath);

    await root.mkdir("nested");
    await root.write("nested/file.txt", "hello");
    await root.append("nested/file.txt", " world");

    await expect(root.readText("nested/file.txt")).resolves.toBe("hello world");
    await expect(root.readBytes("nested/file.txt")).resolves.toEqual(
      Buffer.from("hello world"),
    );

    const stat = await root.stat("nested/file.txt");
    expect(stat.isFile).toBe(true);

    await expect(root.list("nested")).resolves.toEqual(["file.txt"]);
    await root.move("nested/file.txt", "nested/renamed.txt");
    await expect(root.read("nested/renamed.txt")).resolves.toMatchObject({
      realPath: expect.stringContaining("renamed.txt"),
    });

    await root.remove("nested/renamed.txt");
    await expect(root.stat("nested/renamed.txt")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("applies per-root defaults", async () => {
    const rootPath = await tempRoot("fs-safe-defaults-");
    const root = await openRoot(rootPath, {
      hardlinks: "reject",
      mkdir: true,
    });

    await root.writeJson("nested/config.json", { ok: true }, { space: 2 });

    await expect(root.readJson("nested/config.json")).resolves.toEqual({ ok: true });
    await expect(readFile(path.join(rootPath, "nested/config.json"), "utf8")).resolves.toBe(
      '{\n  "ok": true\n}\n',
    );
  });

  it("creates files only when missing", async () => {
    const rootPath = await tempRoot("fs-safe-if-missing-");
    const root = await openRoot(rootPath);

    await expect(root.create("nested/file.txt", "first")).resolves.toBe(true);
    await expect(root.create("nested/file.txt", "second")).resolves.toBe(false);
    await expect(readFile(path.join(rootPath, "nested/file.txt"), "utf8")).resolves.toBe("first");

    await expect(root.createJson("state.json", { ok: true })).resolves.toBe(true);
    await expect(root.createJson("state.json", { ok: false })).resolves.toBe(false);
    await expect(readFile(path.join(rootPath, "state.json"), "utf8")).resolves.toBe(
      '{"ok":true}\n',
    );
  });

  it("writes, reads, stats, and lists files within a root", async () => {
    const root = await openRoot(await tempRoot("fs-safe-basic-"));

    await root.mkdir("nested");
    await root.write("nested/file.txt", "hello");

    const read = await root.read("nested/file.txt");
    expect(read.buffer.toString("utf8")).toBe("hello");

    const stat = await root.stat("nested/file.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(5);

    await expect(root.list("nested")).resolves.toEqual(["file.txt"]);
    const entries = await root.list("nested", { withFileTypes: true });
    expect(entries).toMatchObject([{ isFile: true, name: "file.txt" }]);
  });

  it("rejects traversal and absolute paths before touching the filesystem", async () => {
    const root = await openRoot(await tempRoot("fs-safe-traversal-"));

    await expect(root.stat("../outside")).rejects.toMatchObject({ code: "invalid-path" });
    await expect(root.read("/etc/passwd")).rejects.toMatchObject({ code: "outside-workspace" });
    await expect(root.write("../write", "")).rejects.toMatchObject({
      code: "outside-workspace",
    });
  });

  it("rejects symlink parents", async () => {
    const rootPath = await tempRoot("fs-safe-symlink-parent-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(rootPath, "link"), "dir");

    await expect(root.read("link/secret.txt")).rejects.toMatchObject({
      code: "outside-workspace",
    });
    await expect(root.list("link")).rejects.toMatchObject({ code: "path-alias" });
  });

  it("rejects symlink leaves for stat and read", async () => {
    const rootPath = await tempRoot("fs-safe-symlink-leaf-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(rootPath, "secret-link"), "file");

    await expect(root.stat("secret-link")).rejects.toMatchObject({ code: "path-alias" });
    await expect(root.read("secret-link")).rejects.toMatchObject({ code: "symlink" });
  });

  it("renames paths within the same root and rejects symlink sources", async () => {
    const rootPath = await tempRoot("fs-safe-rename-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    await root.write("from.txt", "move me");

    await root.move("from.txt", "to.txt");
    await expect(readFile(path.join(rootPath, "to.txt"), "utf8")).resolves.toBe("move me");

    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(rootPath, "link"), "file");
    await expect(root.move("link", "moved-link")).rejects.toMatchObject({
      code: "path-alias",
    });
  });

  it("removes symlink leaves without following them", async () => {
    const rootPath = await tempRoot("fs-safe-remove-");
    const root = await openRoot(rootPath);
    const outside = await tempRoot("fs-safe-outside-");
    const outsideFile = path.join(outside, "kept.txt");
    await writeFile(outsideFile, "kept");
    await symlink(outsideFile, path.join(rootPath, "link"), "file");

    await root.remove("link");

    await expect(readFile(outsideFile, "utf8")).resolves.toBe("kept");
    await expect(root.stat("link")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("opens a file handle for fast reads when kernel fd path validation is available", async () => {
    const root = await openRoot(await tempRoot("fs-safe-open-"));
    await root.write("file.txt", "fast");

    const opened = await root.open("file.txt");
    try {
      await expect(opened.handle.readFile("utf8")).resolves.toBe("fast");
    } finally {
      await opened.handle.close();
    }
  });
});
