import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/index.js";
import { runPinnedWriteHelper } from "../src/pinned-write.js";

const tempDirs = new Set<string>();

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("pinned write fsync compatibility", () => {
  it.runIf(process.platform !== "win32")(
    "treats EPERM from fallback file sync as best effort",
    async () => {
      configureFsSafeNative({ mode: "off" });
      const root = await tempRoot("fs-safe-pinned-write-fsync-eperm-");
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
        );
        return handle;
      });

      await expect(
        runPinnedWriteHelper({
          rootPath: root,
          relativeParentPath: "",
          basename: "created.txt",
          mkdir: true,
          mode: 0o600,
          overwrite: true,
          input: { kind: "buffer", data: "created", encoding: "utf8" },
        }),
      ).resolves.toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
      await expect(fs.readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("created");
    },
  );
});
