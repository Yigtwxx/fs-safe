import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
console.log("native smoke: load binding");
const native = require("../native");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-native-smoke-"));
const rootFd = fs.openSync(root, fs.constants.O_RDONLY);
try {
  console.log("native smoke: mkdir");
  native.mkdirBeneath(rootFd, "nested", 0o700);
  console.log("native smoke: write fixture");
  fs.writeFileSync(path.join(root, "nested", "source"), "source");
  console.log("native smoke: open");
  const fd = native.openBeneath(rootFd, "nested/source", fs.constants.O_RDONLY);
  try {
    console.log("native smoke: fstat");
    const identity = native.fstatIdentity(fd);
    if (!identity.isFile || identity.size !== 6) throw new Error("unexpected native identity");
  } finally {
    fs.closeSync(fd);
  }

  console.log("native smoke: link");
  native.linkBeneath(rootFd, "nested/source", rootFd, "nested/linked");
  if (fs.readFileSync(path.join(root, "nested", "linked"), "utf8") !== "source") {
    throw new Error("native hardlink did not preserve content");
  }

  console.log("native smoke: rename success and collision");
  native.renameNoReplace(rootFd, "nested/source", rootFd, "nested/renamed");
  fs.writeFileSync(path.join(root, "nested", "collision"), "collision");
  try {
    native.renameNoReplace(rootFd, "nested/renamed", rootFd, "nested/collision");
    throw new Error("native collision unexpectedly succeeded");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  if (process.platform === "win32") {
    console.log("native smoke: reject reparse component");
    fs.symlinkSync(path.join(root, "nested"), path.join(root, "alias"), "junction");
    try {
      native.openBeneath(rootFd, "alias/linked", fs.constants.O_RDONLY);
      throw new Error("native reparse traversal unexpectedly succeeded");
    } catch (error) {
      if (error.message.includes("unexpectedly succeeded")) throw error;
    }
  }
  console.log("native smoke: PASS");
} finally {
  fs.closeSync(rootFd);
  fs.rmSync(root, { recursive: true, force: true });
}
