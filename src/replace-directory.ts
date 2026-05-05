import fs from "node:fs/promises";
import path from "node:path";

export type ReplaceDirectoryAtomicOptions = {
  stagedDir: string;
  targetDir: string;
  backupPrefix?: string;
};

export async function replaceDirectoryAtomic(
  options: ReplaceDirectoryAtomicOptions,
): Promise<void> {
  const targetDir = path.resolve(options.targetDir);
  const stagedDir = path.resolve(options.stagedDir);
  const parentDir = path.dirname(targetDir);
  const backupDir = path.join(
    parentDir,
    `${options.backupPrefix ?? ".fs-safe-dir-backup-"}${process.pid}-${Date.now()}`,
  );
  let backupCreated = false;

  await fs.mkdir(parentDir, { recursive: true });
  try {
    await fs.rename(targetDir, backupDir);
    backupCreated = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  try {
    await fs.rename(stagedDir, targetDir);
  } catch (err) {
    if (backupCreated) {
      await fs.rename(backupDir, targetDir).catch(() => undefined);
      backupCreated = false;
    }
    throw err;
  }

  if (backupCreated) {
    await fs.rm(backupDir, { recursive: true, force: true });
  }
}
