import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonFileReadError,
  createAsyncLock,
  readJson,
  readJsonIfExists,
  readJsonSync,
  tryReadJson,
  writeJson,
  writeText,
  writeJsonSync,
} from "../src/json.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("json file helpers", () => {
  it("writes formatted JSON atomically with an optional trailing newline", async () => {
    const root = await tempRoot("fs-safe-json-");
    const filePath = path.join(root, "nested", "state.json");

    await writeJson(filePath, { ok: true }, { mode: 0o600, trailingNewline: true });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{\n  \"ok\": true\n}\n");
    await expect(tryReadJson(filePath)).resolves.toEqual({ ok: true });
    await expect(readJson(filePath)).resolves.toEqual({ ok: true });
  });

  it("uses dirMode and trailingNewline consistently for text writes", async () => {
    const root = await tempRoot("fs-safe-json-");
    const filePath = path.join(root, "nested", "note.txt");

    await writeText(filePath, "hello", {
      dirMode: 0o700,
      mode: 0o600,
      trailingNewline: true,
    });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("hello\n");
    if (process.platform !== "win32") {
      const dirStat = await fs.stat(path.dirname(filePath));
      const fileStat = await fs.stat(filePath);
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  it("separates nullable and durable read failure semantics", async () => {
    const root = await tempRoot("fs-safe-json-");
    const missing = path.join(root, "missing.json");
    const invalid = path.join(root, "invalid.json");
    await fs.writeFile(invalid, "{", "utf8");

    await expect(tryReadJson(missing)).resolves.toBeNull();
    await expect(tryReadJson(invalid)).resolves.toBeNull();
    await expect(readJsonIfExists(missing)).resolves.toBeNull();
    await expect(readJsonIfExists(invalid)).rejects.toMatchObject({
      name: "JsonFileReadError",
      reason: "parse",
    } satisfies Partial<JsonFileReadError>);
    expect(() => readJsonSync(invalid)).toThrow(JsonFileReadError);
  });

  it("does not follow symlink swaps while reading", async () => {
    const root = await tempRoot("fs-safe-json-swap-");
    const filePath = path.join(root, "state.json");
    const secretPath = path.join(root, "secret.json");
    await fs.writeFile(filePath, "{\"ok\":true}", "utf8");
    await fs.writeFile(secretPath, "{\"secret\":true}", "utf8");

    const originalLstat = fs.lstat.bind(fs);
    let swapped = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (!swapped && args[0] === filePath) {
        swapped = true;
        await fs.rm(filePath, { force: true });
        await fs.symlink(secretPath, filePath);
      }
      return stat;
    });

    try {
      await expect(readJson(filePath)).rejects.toMatchObject({
        name: "JsonFileReadError",
        reason: "read",
      } satisfies Partial<JsonFileReadError>);
      await expect(tryReadJson(filePath)).resolves.toBeNull();
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")("replaces symlink leaves on sync writes", async () => {
    const root = await tempRoot("fs-safe-json-link-");
    const outsidePath = path.join(root, "outside.json");
    const linkPath = path.join(root, "state.json");
    await fs.writeFile(outsidePath, "{\"secret\":true}\n", "utf8");
    await fs.symlink(outsidePath, linkPath);

    writeJsonSync(linkPath, { ok: true });

    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("{\"secret\":true}\n");
    await expect(fs.readFile(linkPath, "utf8")).resolves.toBe("{\n  \"ok\": true\n}\n");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(false);
  });

  it("serializes work through createAsyncLock", async () => {
    const lock = createAsyncLock();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = lock(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
      return 1;
    });
    const second = lock(async () => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});
