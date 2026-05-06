import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { guardedRename, guardedRm } from "./guarded-mutation.js";
import { replaceFileAtomic } from "./replace-file.js";

export type MovePathWithCopyFallbackOptions = {
  from: string;
  to: string;
};

export async function movePathWithCopyFallback(
  options: MovePathWithCopyFallbackOptions,
): Promise<void> {
  try {
    await guardedRename({ from: options.from, to: options.to });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EXDEV") {
      throw error;
    }
  }
  const sourceStat = await fs.lstat(options.from);
  if (sourceStat.isFile()) {
    await replaceFileAtomic({
      filePath: options.to,
      content: await fs.readFile(options.from),
      mode: sourceStat.mode & 0o777,
      syncTempFile: true,
      syncParentDir: true,
    });
    await guardedRm({ target: options.from, force: true, verifyAfter: false });
    return;
  }

  const targetDir = path.dirname(path.resolve(options.to));
  const staged = path.join(targetDir, `.fs-safe-move-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.cp(options.from, staged, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    await guardedRename({ from: staged, to: options.to });
    await guardedRm({ target: options.from, recursive: true, force: true, verifyAfter: false });
  } finally {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined);
  }
}
