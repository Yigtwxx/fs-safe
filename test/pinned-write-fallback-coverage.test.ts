import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
  return {
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        kill(signal?: NodeJS.Signals): void;
        stdout: EventEmitter & { setEncoding: () => void };
        stderr: EventEmitter & { setEncoding: () => void };
      };
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      child.kill = () => undefined;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  };
});

const tempDirs = new Set<string>();

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("pinned write fallback coverage", () => {
  it("writes buffers, creates only when missing, streams, and enforces limits", async () => {
    const { runPinnedWriteHelper } = await import("../src/pinned-write.js");
    const root = await tempRoot("fs-safe-pinned-write-fallback-");

    const created = await runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "nested",
      basename: "created.txt",
      mkdir: true,
      mode: 0o600,
      overwrite: false,
      input: { kind: "buffer", data: "created", encoding: "utf8" },
    });
    expect(created.ino).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(root, "nested", "created.txt"), "utf8")).resolves.toBe(
      "created",
    );
    await expect(
      runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "nested",
        basename: "created.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: false,
        input: { kind: "buffer", data: "again" },
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    const streamed = await runPinnedWriteHelper({
      rootPath: root,
      relativeParentPath: "nested",
      basename: "streamed.txt",
      mkdir: true,
      mode: 0o600,
      overwrite: true,
      maxBytes: 16,
      input: { kind: "stream", stream: Readable.from(["stream", "ed"]) },
    });
    expect(streamed.dev).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(root, "nested", "streamed.txt"), "utf8")).resolves.toBe(
      "streamed",
    );

    await expect(
      runPinnedWriteHelper({
        rootPath: root,
        relativeParentPath: "nested",
        basename: "too-large.txt",
        mkdir: true,
        mode: 0o600,
        overwrite: true,
        maxBytes: 2,
        input: { kind: "buffer", data: Buffer.from("large") },
      }),
    ).rejects.toMatchObject({ code: "too-large" });
    await expect(fs.stat(path.join(root, "nested", "too-large.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
