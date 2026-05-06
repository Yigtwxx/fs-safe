import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileStoreSync } from "../src/file-store.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sync file-store read validation failures", () => {
  it("surfaces directories as filesystem safety errors", async () => {
    const root = await tempRoot("fs-safe-sync-store-validation-");
    await fs.mkdir(path.join(root, "not-a-file"));
    const store = fileStoreSync({ rootDir: root, private: true });

    expect(() => store.readTextIfExists("not-a-file")).toThrow(
      expect.objectContaining({ code: "path-mismatch" }),
    );
  });

  it.runIf(process.platform !== "win32")("surfaces hardlinks as filesystem safety errors", async () => {
    const root = await tempRoot("fs-safe-sync-store-hardlink-");
    const filePath = path.join(root, "value.txt");
    await fs.writeFile(filePath, "secret");
    fsSync.linkSync(filePath, path.join(root, "alias.txt"));
    const store = fileStoreSync({ rootDir: root, private: true });

    expect(() => store.readTextIfExists("value.txt")).toThrow(
      expect.objectContaining({ code: "path-mismatch" }),
    );
  });
});
