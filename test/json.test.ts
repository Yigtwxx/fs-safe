import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JsonFileReadError,
  createAsyncLock,
  readDurableJsonFile,
  readJsonFile,
  readJsonFileStrict,
  writeJsonAtomic,
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

    await writeJsonAtomic(filePath, { ok: true }, { mode: 0o600, trailingNewline: true });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("{\n  \"ok\": true\n}\n");
    await expect(readJsonFile(filePath)).resolves.toEqual({ ok: true });
    await expect(readJsonFileStrict(filePath)).resolves.toEqual({ ok: true });
  });

  it("separates nullable and durable read failure semantics", async () => {
    const root = await tempRoot("fs-safe-json-");
    const missing = path.join(root, "missing.json");
    const invalid = path.join(root, "invalid.json");
    await fs.writeFile(invalid, "{", "utf8");

    await expect(readJsonFile(missing)).resolves.toBeNull();
    await expect(readJsonFile(invalid)).resolves.toBeNull();
    await expect(readDurableJsonFile(missing)).resolves.toBeNull();
    await expect(readDurableJsonFile(invalid)).rejects.toMatchObject({
      name: "JsonFileReadError",
      reason: "parse",
    } satisfies Partial<JsonFileReadError>);
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
