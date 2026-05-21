import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { root as openRoot } from "../src/index.js";

const skipOnWindows = process.platform === "win32";
const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("root mutation policies", () => {
  it("denies root mutations by exact mutation policy", async () => {
    const rootPath = await tempRoot("fs-safe-deny-exact-");
    const sourceRoot = await tempRoot("fs-safe-deny-exact-source-");
    const sourcePath = path.join(sourceRoot, "source.txt");
    const deniedPath = path.join(rootPath, "secret.txt");
    const root = await openRoot(rootPath, {
      mkdir: true,
      mutationPolicy: { denyExact: [deniedPath] },
    });
    await writeFile(sourcePath, "source");

    for (const operation of [
      () => root.write("secret.txt", "write"),
      () => root.append("secret.txt", "append"),
      () => root.create("secret.txt", "create"),
      () => root.openWritable("secret.txt"),
      () => root.copyIn("secret.txt", sourcePath),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "denied-path" });
    }

    await expect(root.exists("secret.txt")).resolves.toBe(false);
  });

  it("denies root mutations by prefix mutation policy", async () => {
    const rootPath = await tempRoot("fs-safe-deny-prefix-");
    const deniedDir = path.join(rootPath, "private");
    await mkdir(deniedDir, { recursive: true });
    await writeFile(path.join(deniedDir, "seed.txt"), "seed");
    await writeFile(path.join(deniedDir, "source.txt"), "source");
    await writeFile(path.join(rootPath, "safe.txt"), "safe");
    const root = await openRoot(rootPath, {
      mutationPolicy: { denyPrefixes: [deniedDir] },
    });

    await expect(root.write("private/file.txt", "write")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.mkdir("private/nested")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.remove("private/seed.txt")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.move("safe.txt", "private/moved.txt")).rejects.toMatchObject({
      code: "denied-path",
    });
    await expect(root.move("private/source.txt", "moved-out.txt")).rejects.toMatchObject({
      code: "denied-path",
    });

    await expect(readFile(path.join(rootPath, "safe.txt"), "utf8")).resolves.toBe("safe");
    await expect(readFile(path.join(deniedDir, "seed.txt"), "utf8")).resolves.toBe("seed");
    await expect(readFile(path.join(deniedDir, "source.txt"), "utf8")).resolves.toBe("source");
  });

  it("merges root and per-call mutation policies without weakening defaults", async () => {
    const rootPath = await tempRoot("fs-safe-deny-merge-");
    const rootDeniedPath = path.join(rootPath, "root-denied.txt");
    const callDeniedPath = path.join(rootPath, "call-denied.txt");
    const root = await openRoot(rootPath, {
      mutationPolicy: { denyExact: [rootDeniedPath] },
    });

    await expect(
      root.write("root-denied.txt", "write", { mutationPolicy: { denyExact: [] } }),
    ).rejects.toMatchObject({ code: "denied-path" });
    await expect(
      root.write("call-denied.txt", "write", {
        mutationPolicy: { denyExact: [callDeniedPath] },
      }),
    ).rejects.toMatchObject({ code: "denied-path" });
    await expect(
      root.ensureRoot({ mutationPolicy: { denyExact: [rootPath] } }),
    ).rejects.toMatchObject({ code: "denied-path" });

    await expect(
      root.write("allowed.txt", "ok", { mutationPolicy: { denyExact: [callDeniedPath] } }),
    ).resolves.toBeUndefined();
    await expect(root.readText("allowed.txt")).resolves.toBe("ok");
  });

  it("rejects relative mutation policy entries", async () => {
    const root = await openRoot(await tempRoot("fs-safe-deny-relative-"));

    await expect(
      root.write("file.txt", "write", { mutationPolicy: { denyExact: ["file.txt"] } }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it.skipIf(skipOnWindows)("matches mutation policies through existing symlink ancestors", async () => {
    const rootPath = await tempRoot("fs-safe-deny-symlink-");
    const deniedDir = path.join(rootPath, "private");
    await mkdir(deniedDir, { recursive: true });
    await symlink(deniedDir, path.join(rootPath, "link"), "dir");
    const root = await openRoot(rootPath, {
      mutationPolicy: { denyPrefixes: [deniedDir] },
    });

    await expect(root.write("link/file.txt", "write")).rejects.toMatchObject({
      code: "denied-path",
    });
  });
});
