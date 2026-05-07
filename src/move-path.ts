import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { guardedRename } from "./guarded-mutation.js";

export type MovePathWithCopyFallbackOptions = {
  from: string;
  sourceHardlinks?: "allow" | "reject";
  to: string;
};

type EntryIdentity = {
  dev: number;
  ino: number;
};

type CopiedEntryManifest =
  | (EntryIdentity & {
      children: Array<{ name: string; manifest: CopiedEntryManifest }>;
      kind: "directory";
    })
  | (EntryIdentity & { kind: "leaf" });

function entryIdentity(stat: { dev: number; ino: number }): EntryIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

async function copyEntryWithManifest(
  from: string,
  to: string,
  options: { sourceHardlinks: "allow" | "reject" },
): Promise<CopiedEntryManifest> {
  const sourceStat = await fs.lstat(from);
  const identity = entryIdentity(sourceStat);

  if (sourceStat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(from), to);
    return { ...identity, kind: "leaf" };
  }

  if (sourceStat.isDirectory()) {
    await fs.mkdir(to, { mode: modeBits(sourceStat.mode) || 0o755 });
    const children: Array<{ name: string; manifest: CopiedEntryManifest }> = [];
    for (const child of await fs.readdir(from)) {
      children.push({
        name: child,
        manifest: await copyEntryWithManifest(path.join(from, child), path.join(to, child), options),
      });
    }
    return { ...identity, children, kind: "directory" };
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Refusing to move non-file path with copy fallback: ${from}`);
  }
  if (options.sourceHardlinks === "reject" && sourceStat.nlink > 1) {
    throw new Error(`Refusing to move hardlinked file with copy fallback: ${from}`);
  }

  await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
  await fs.chmod(to, modeBits(sourceStat.mode)).catch(() => undefined);
  return { ...identity, kind: "leaf" };
}

async function removeCopiedEntry(sourcePath: string, manifest: CopiedEntryManifest): Promise<void> {
  let currentStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    currentStat = await fs.lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!sameIdentity(manifest, entryIdentity(currentStat))) {
    return;
  }

  if (manifest.kind === "directory") {
    for (const child of manifest.children) {
      await removeCopiedEntry(path.join(sourcePath, child.name), child.manifest);
    }
    await fs.rmdir(sourcePath);
    return;
  }

  await fs.unlink(sourcePath);
}

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
  const targetDir = path.dirname(path.resolve(options.to));
  const staged = path.join(targetDir, `.fs-safe-move-${process.pid}-${randomUUID()}.tmp`);
  try {
    const manifest = await copyEntryWithManifest(options.from, staged, {
      sourceHardlinks: options.sourceHardlinks ?? "allow",
    });
    await guardedRename({ from: staged, to: options.to });
    await removeCopiedEntry(options.from, manifest);
  } finally {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined);
  }
}
