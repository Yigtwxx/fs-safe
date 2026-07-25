import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";

const require = createRequire(import.meta.url);
let native: NativeBinding | undefined;
try {
  native = require("../native") as NativeBinding;
} catch {
  // JS-only jobs intentionally exercise the fallback without a built binding.
}
const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-publish-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  await Promise.all(tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.runIf(Boolean(native))("native publication primitives", () => {
  it("hashes the same bytes as Node without changing the descriptor position", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source");
    const payload = Buffer.from("native hash equivalence".repeat(4096));
    await fs.writeFile(sourcePath, payload);
    const source = await fs.open(sourcePath, "r");
    try {
      const before = await source.read(Buffer.alloc(1), 0, 1, null);
      const digest = await native!.sha256File(source.fd);
      const after = await source.read(Buffer.alloc(1), 0, 1, null);
      expect(digest).toEqual({
        bytes: payload.length,
        digest: createHash("sha256").update(payload).digest("hex"),
      });
      expect(before.buffer[0]).toBe(payload[0]);
      expect(after.buffer[0]).toBe(payload[1]);
    } finally {
      await source.close();
    }
  });

  it("clones exclusively and preserves an existing target", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source");
    const targetPath = path.join(root, "target");
    await fs.writeFile(sourcePath, "clone-payload");
    const source = await fs.open(sourcePath, "r");
    const directory = await fs.open(root, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
    try {
      let clonedFd: number;
      try {
        clonedFd = native!.cloneFileExclusive(source.fd, directory.fd, "target");
      } catch (error) {
        expect(error).toMatchObject({ code: "ENOTSUP" });
        return;
      }
      fsSync.closeSync(clonedFd);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("clone-payload");
      await expect(() => native!.cloneFileExclusive(source.fd, directory.fd, "target")).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("clone-payload");
    } finally {
      await source.close();
      await directory.close();
    }
  });

  it.runIf(process.platform === "linux")("copies exclusively with copy_file_range", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source");
    await fs.writeFile(sourcePath, "range-payload");
    const source = await fs.open(sourcePath, "r");
    const directory = await fs.open(root, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
    try {
      const copied = await native!.copyFileRangeExclusive(source.fd, directory.fd, "target");
      expect(copied.bytes).toBe(13);
      fsSync.closeSync(copied.fd);
      await expect(fs.readFile(path.join(root, "target"), "utf8")).resolves.toBe("range-payload");
    } finally {
      await source.close();
      await directory.close();
    }
  });

  it.runIf(process.platform === "darwin")(
    "falls back for ACL-bearing sources without inheriting the ACL",
    async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source-acl");
    const targetPath = path.join(root, "target-acl");
    await fs.writeFile(sourcePath, "private", { mode: 0o600 });
    execFileSync("chmod", ["+a", "everyone allow read", sourcePath]);
    __setNativeLoaderForTest(() => ({
      ...native!,
      linkBeneath() {
        throw Object.assign(new Error("force copy"), { code: "EXDEV" });
      },
    }));
    configureFsSafeNative({ mode: "require" });
    await publishFileExclusive({ sourcePath, targetPath, strategy: "link-or-copy" });
    expect(execFileSync("ls", ["-lde", targetPath], { encoding: "utf8" })).not.toContain(
      "everyone:allow read",
    );
    },
  );
});

const publishBackends = native
  ? (["native", "javascript"] as const)
  : (["javascript"] as const);

describe.each(publishBackends)("%s publication fallback", (backend) => {
  it("publishes identical bytes with an exclusive 0600 target", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source");
    const targetPath = path.join(root, "target");
    const payload = Buffer.alloc(256 * 1024, 0x5a);
    await fs.writeFile(sourcePath, payload, { mode: 0o644 });

    if (backend === "native") {
      __setNativeLoaderForTest(() => ({
        ...native!,
        linkBeneath() {
          throw Object.assign(new Error("force copy"), { code: "EXDEV" });
        },
      }));
      configureFsSafeNative({ mode: "require" });
    } else {
      configureFsSafeNative({ mode: "off" });
      vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("force copy"), { code: "EXDEV" }));
    }

    const result = await publishFileExclusive({
      sourcePath,
      targetPath,
      strategy: "link-or-copy",
    });
    expect(result.method).toBe("exclusive-copy");
    await expect(fs.readFile(targetPath)).resolves.toEqual(payload);
    if (process.platform !== "win32") {
      expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o600);
    }
  });
});
