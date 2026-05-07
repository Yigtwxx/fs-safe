import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/move-path.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("movePathWithCopyFallback regressions", () => {
  it.runIf(process.platform !== "win32")(
    "does not delete source entries replaced after an EXDEV copy",
    async () => {
      const base = await tempRoot("fs-safe-move-exdev-replaced-source-");
      const source = path.join(base, "source-dir");
      const dest = path.join(base, "dest-dir");
      await fsp.mkdir(source);
      await fsp.writeFile(path.join(source, "copied.txt"), "copied");
      const realRename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === source && to === dest) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        await realRename(from, to);
        if (to === dest && String(from).includes(".fs-safe-move-")) {
          await fsp.rm(path.join(source, "copied.txt"));
          await fsp.writeFile(path.join(source, "copied.txt"), "replacement");
          await fsp.writeFile(path.join(source, "late.txt"), "late");
        }
      });

      await expect(movePathWithCopyFallback({ from: source, to: dest })).rejects.toMatchObject({
        code: "ENOTEMPTY",
      });

      await expect(fsp.readFile(path.join(dest, "copied.txt"), "utf8")).resolves.toBe("copied");
      await expect(fsp.readFile(path.join(source, "copied.txt"), "utf8")).resolves.toBe(
        "replacement",
      );
      await expect(fsp.readFile(path.join(source, "late.txt"), "utf8")).resolves.toBe("late");
    },
  );

  it.runIf(process.platform !== "win32")(
    "can reject hardlinked files during EXDEV move fallback",
    async () => {
      const base = await tempRoot("fs-safe-move-exdev-hardlink-");
      const source = path.join(base, "source.txt");
      const hardlink = path.join(base, "hardlink.txt");
      const dest = path.join(base, "dest.txt");
      await fsp.writeFile(source, "source");
      await fsp.link(source, hardlink);
      const realRename = fsp.rename;
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === source && to === dest) {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        return await realRename(from, to);
      });

      await expect(
        movePathWithCopyFallback({ from: source, sourceHardlinks: "reject", to: dest }),
      ).rejects.toThrow("Refusing to move hardlinked file");

      await expect(fsp.readFile(source, "utf8")).resolves.toBe("source");
      await expect(fsp.stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
