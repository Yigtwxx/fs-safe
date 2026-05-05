import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

async function replaceFileWithWindowsFallback(tempPath: string, filePath: string, mode: number) {
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    const code = getErrorCode(err);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw err;
    }
  }

  const existing = await fs.lstat(filePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
    return;
  }

  await fs.copyFile(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; dirMode?: number; trailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.dirMode === "number") {
    mkdirOptions.mode = options.dirMode;
  }
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const parentDir = path.dirname(filePath);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await replaceFileWithWindowsFallback(tmp, filePath, mode);
    try {
      const dirHandle = await fs.open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    } catch {
      // best-effort; some platforms/filesystems do not support syncing directories.
    }
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
