import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
  writeSecretFileAtomic,
} from "../src/secret-file.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("secret file helpers", () => {
  it("reads trimmed secrets and exposes nullable try-read semantics", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const filePath = path.join(root, "token.txt");
    await fs.writeFile(filePath, " secret \n", "utf8");

    expect(readSecretFileSync(filePath, "API token")).toBe("secret");
    expect(tryReadSecretFileSync(filePath, "API token")).toBe("secret");
    expect(tryReadSecretFileSync(undefined, "API token")).toBeUndefined();
    expect(loadSecretFileSync(filePath, "API token")).toMatchObject({
      ok: true,
      resolvedPath: filePath,
      secret: "secret",
    });
  });

  it("can reject symlinked secret paths", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(target, "secret", "utf8");
    await fs.symlink(target, link);

    expect(loadSecretFileSync(link, "API token", { rejectSymlink: true })).toMatchObject({
      ok: false,
      message: `API token file at ${link} must not be a symlink.`,
    });
  });

  it("writes private secret files under a non-symlink root", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const filePath = path.join(root, "nested", "token.txt");

    await writeSecretFileAtomic({
      rootDir: root,
      filePath,
      content: "secret\n",
    });

    expect(readSecretFileSync(filePath, "API token")).toBe("secret");
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(filePath));
      const fileStat = await fs.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(PRIVATE_SECRET_DIR_MODE);
      expect(fileStat.mode & 0o777).toBe(PRIVATE_SECRET_FILE_MODE);
    }
  });

  it("accepts stricter private secret file and directory modes", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const filePath = path.join(root, "nested", "token.txt");

    await writeSecretFileAtomic({
      rootDir: root,
      filePath,
      content: "secret\n",
      mode: 0o400,
      dirMode: 0o700,
    });

    expect(readSecretFileSync(filePath, "API token")).toBe("secret");
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(filePath));
      const fileStat = await fs.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o400);
    }
  });

  it("rejects writes outside the private secret root", async () => {
    const root = await tempRoot("fs-safe-secret-");
    const outside = await tempRoot("fs-safe-secret-outside-");

    await expect(
      writeSecretFileAtomic({
        rootDir: root,
        filePath: path.join(outside, "token.txt"),
        content: "secret\n",
      }),
    ).rejects.toThrow(`Private secret path must stay under ${root}.`);
  });
});
