import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

type NativeBinding = typeof import("../native/index.js");

const require = createRequire(import.meta.url);
let native: NativeBinding | undefined;
try {
  native = require("../native") as NativeBinding;
} catch {
  // Native artifacts are built by dedicated platform jobs. The ordinary JS
  // matrix deliberately proves that installation without them still works.
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.runIf(native)("native filesystem primitives", () => {
  it("opens beneath a directory descriptor and reports fd identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-open-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "value"), "ok");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      const fd = native!.openBeneath(rootFd, "nested/value", fsSync.constants.O_RDONLY);
      try {
        expect(native!.fstatIdentity(fd)).toMatchObject({ isFile: true, size: 2 });
      } finally {
        fsSync.closeSync(fd);
      }
      expect(() => native!.openBeneath(rootFd, "../outside", fsSync.constants.O_RDONLY)).toThrow();
    } finally {
      fsSync.closeSync(rootFd);
    }
  });

  it("maps no-replace collisions to EEXIST without changing either file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-rename-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "source"), "source");
    await fs.writeFile(path.join(root, "target"), "target");
    const rootFd = fsSync.openSync(root, fsSync.constants.O_RDONLY);
    try {
      expect(() => native!.renameNoReplace(rootFd, "source", rootFd, "target")).toThrowError(
        expect.objectContaining({ code: "EEXIST" }),
      );
    } finally {
      fsSync.closeSync(rootFd);
    }
    await expect(fs.readFile(path.join(root, "source"), "utf8")).resolves.toBe("source");
    await expect(fs.readFile(path.join(root, "target"), "utf8")).resolves.toBe("target");
  });
});
