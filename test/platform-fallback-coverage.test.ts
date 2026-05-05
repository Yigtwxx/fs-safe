import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = new Set<string>();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

async function importRootForPlatform(platform: NodeJS.Platform) {
  vi.resetModules();
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
  return await import("../src/root.js");
}

afterEach(async () => {
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  vi.resetModules();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("platform fallback coverage", () => {
  it("exercises root write, copy, mkdir, and remove fallbacks used on Windows", async () => {
    const { root: openRoot } = await importRootForPlatform("win32");
    const rootDir = await tempRoot("fs-safe-win-fallback-");
    const sourceDir = await tempRoot("fs-safe-win-fallback-source-");
    const source = path.join(sourceDir, "source.txt");
    await fs.writeFile(source, "copied", "utf8");
    const scoped = await openRoot(rootDir, { mkdir: true });

    await scoped.mkdir("nested");
    await scoped.write("nested/file.txt", "first");
    await expect(fs.readFile(path.join(rootDir, "nested", "file.txt"), "utf8")).resolves.toBe(
      "first",
    );

    await scoped.write("nested/file.txt", Buffer.from("second"));
    await expect(fs.readFile(path.join(rootDir, "nested", "file.txt"), "utf8")).resolves.toBe(
      "second",
    );
    await expect(scoped.create("nested/file.txt", "third")).rejects.toMatchObject({
      code: "already-exists",
    });
    await scoped.create("nested/created.txt", "created");
    await expect(fs.readFile(path.join(rootDir, "nested", "created.txt"), "utf8")).resolves.toBe(
      "created",
    );

    await scoped.copyIn("nested/copied.txt", source, { maxBytes: 16 });
    await expect(fs.readFile(path.join(rootDir, "nested", "copied.txt"), "utf8")).resolves.toBe(
      "copied",
    );
    await expect(scoped.copyIn("nested/too-large.txt", source, { maxBytes: 3 })).rejects
      .toMatchObject({ code: "too-large" });

    await scoped.remove("nested/copied.txt");
    await expect(fs.stat(path.join(rootDir, "nested", "copied.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
