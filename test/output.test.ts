import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeExternalFileWithinRoot } from "../src/output.js";

const tempDirs = new Set<string>();

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { force: true, recursive: true });
  }
  tempDirs.clear();
});

describe("writeExternalFileWithinRoot", () => {
  it("stages an external writer in private temp storage and finalizes under the root", async () => {
    const rootDir = await tempRoot("fs-safe-output-root-");
    const targetPath = path.join(rootDir, "downloads", "report.txt");
    let tempPath = "";

    const result = await writeExternalFileWithinRoot({
      rootDir,
      path: targetPath,
      write: async (candidate) => {
        tempPath = candidate;
        await fs.writeFile(candidate, "downloaded", "utf8");
        return { bytes: 10 };
      },
    });

    expect(result.path).toBe(path.join(await fs.realpath(rootDir), "downloads", "report.txt"));
    expect(result.result).toEqual({ bytes: 10 });
    expect(path.dirname(tempPath)).not.toBe(path.dirname(targetPath));
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("downloaded");
    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves caller-provided destination filename spacing", async () => {
    const rootDir = await tempRoot("fs-safe-output-spaces-");
    const fileName = " report .txt ";

    const result = await writeExternalFileWithinRoot({
      rootDir,
      path: fileName,
      write: async (candidate) => {
        await fs.writeFile(candidate, "spaced", "utf8");
      },
    });

    const finalPath = path.join(rootDir, fileName);
    expect(result.path).toBe(path.join(await fs.realpath(rootDir), fileName));
    await expect(fs.readFile(finalPath, "utf8")).resolves.toBe("spaced");
    await expect(fs.stat(path.join(rootDir, fileName.trim()))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts absolute target paths that resolve inside the root", async () => {
    const rootDir = await tempRoot("fs-safe-output-absolute-");
    const targetPath = path.join(rootDir, "nested", "report.txt");

    const result = await writeExternalFileWithinRoot({
      rootDir,
      path: targetPath,
      write: async (candidate) => {
        await fs.writeFile(candidate, "absolute", "utf8");
      },
    });

    expect(result.path).toBe(path.join(await fs.realpath(rootDir), "nested", "report.txt"));
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("absolute");
  });

  it("enforces byte limits while leaving the final target absent", async () => {
    const rootDir = await tempRoot("fs-safe-output-max-bytes-");
    const targetPath = path.join(rootDir, "too-large.bin");

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "too-large.bin",
        maxBytes: 3,
        write: async (candidate) => {
          await fs.writeFile(candidate, "larger", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "too-large" });

    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("applies the requested final file mode", async () => {
    const rootDir = await tempRoot("fs-safe-output-mode-");
    const targetPath = path.join(rootDir, "private.txt");

    await writeExternalFileWithinRoot({
      rootDir,
      path: "private.txt",
      mode: 0o600,
      write: async (candidate) => {
        await fs.writeFile(candidate, "private", { encoding: "utf8", mode: 0o644 });
      },
    });

    const stat = await fs.stat(targetPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rejects empty target paths before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-default-");
    let called = false;

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "",
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "named", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });

    expect(called).toBe(false);
  });

  it("rejects targets outside the root before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-reject-root-");
    const outsideDir = await tempRoot("fs-safe-output-reject-outside-");
    const outsidePath = path.join(outsideDir, "pwned.txt");
    let called = false;

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: outsidePath,
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "pwned", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "outside-workspace" });

    expect(called).toBe(false);
    await expect(fs.stat(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal targets before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-traversal-root-");
    let called = false;

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "../../../pwned.txt",
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "pwned", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "outside-workspace" });

    expect(called).toBe(false);
  });

  it("rejects root directory targets before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-root-target-");
    let called = false;

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: rootDir,
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "not a file target", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });

    expect(called).toBe(false);
  });

  it("rejects trailing-separator targets before invoking the external writer", async () => {
    const rootDir = await tempRoot("fs-safe-output-dir-target-");
    let called = false;

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "nested/",
        write: async (candidate) => {
          called = true;
          await fs.writeFile(candidate, "not a file target", "utf8");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });

    expect(called).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "does not let symlinked target parents redirect the external temp write",
    async () => {
      const rootDir = await tempRoot("fs-safe-output-link-root-");
      const outsideDir = await tempRoot("fs-safe-output-link-outside-");
      await fs.symlink(outsideDir, path.join(rootDir, "link"), "dir");
      let tempPath = "";

      await expect(
        writeExternalFileWithinRoot({
          rootDir,
          path: "link/out.txt",
          write: async (candidate) => {
            tempPath = candidate;
            await fs.writeFile(candidate, "pwned", "utf8");
          },
        }),
      ).rejects.toBeTruthy();

      await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects hardlinked final targets and preserves the existing file",
    async () => {
      const rootDir = await tempRoot("fs-safe-output-hardlink-");
      const sourcePath = path.join(rootDir, "source.txt");
      const hardlinkPath = path.join(rootDir, "hardlink.txt");
      await fs.writeFile(sourcePath, "original", "utf8");
      await fs.link(sourcePath, hardlinkPath);

      await expect(
        writeExternalFileWithinRoot({
          rootDir,
          path: "hardlink.txt",
          write: async (candidate) => {
            await fs.writeFile(candidate, "replacement", "utf8");
          },
        }),
      ).rejects.toBeTruthy();

      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("original");
      await expect(fs.readFile(hardlinkPath, "utf8")).resolves.toBe("original");
    },
  );

  it("cleans private temp files when the external writer fails", async () => {
    const rootDir = await tempRoot("fs-safe-output-fail-root-");
    let tempPath = "";

    await expect(
      writeExternalFileWithinRoot({
        rootDir,
        path: "out.txt",
        write: async (candidate) => {
          tempPath = candidate;
          await fs.writeFile(candidate, "partial", "utf8");
          throw new Error("download failed");
        },
      }),
    ).rejects.toThrow("download failed");

    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(rootDir, "out.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
