import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import type { Root } from "./root-impl.js";

const MAX_LOCK_PAYLOAD_BYTES = 1024 * 1024;

const SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES = 16;
const SIDECAR_LOCK_OWNERSHIP_TOKEN_BITS = SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES * 8;
const SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX = "\t".repeat(8);
const SIDECAR_LOCK_OWNERSHIP_TOKEN_PATTERN = new RegExp(
  `\\n(${SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX}[ \\t]{${SIDECAR_LOCK_OWNERSHIP_TOKEN_BITS}})\\n$`,
);

export type SidecarLockStaleSnapshot = {
  lockPath: string;
  normalizedTargetPath: string;
  raw: string;
  payload: unknown;
};

export type SidecarLockSnapshot = {
  raw?: string;
  payload: unknown;
  stat?: Stats;
  ownershipToken?: string;
};

function createSidecarLockOwnershipToken(): string {
  let token = SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX;
  for (const byte of randomBytes(SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES)) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      token += byte & (1 << bit) ? "\t" : " ";
    }
  }
  return token;
}

export function readSidecarLockOwnershipToken(raw: string): string | undefined {
  return SIDECAR_LOCK_OWNERSHIP_TOKEN_PATTERN.exec(raw)?.[1];
}

export function serializeSidecarLockPayload(payload: Record<string, unknown>): {
  raw: string;
  ownershipToken: string;
} {
  const ownershipToken = createSidecarLockOwnershipToken();
  return {
    raw: `${JSON.stringify(payload, null, 2)}\n${ownershipToken}\n`,
    ownershipToken,
  };
}

export function relativeSidecarLockPath(lockRoot: Root, lockPath: string): string {
  const resolved = path.resolve(lockPath);
  const lexicalRelative = path.relative(lockRoot.rootDir, resolved);
  const relative =
    lexicalRelative !== ".." &&
    !lexicalRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(lexicalRelative)
      ? lexicalRelative
      : path.relative(lockRoot.rootReal, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FsSafeError("outside-workspace", "sidecar lock path is outside lockRoot");
  }
  return relative.split(path.sep).join(path.posix.sep);
}

function parseLockPayload(raw: string, parser?: (raw: string) => unknown): unknown {
  if (parser) {
    return parser(raw);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readSidecarLockSnapshot(
  lockPath: string,
  options: { lockRoot?: Root; parsePayload?: (raw: string) => unknown } = {},
): Promise<SidecarLockSnapshot | null> {
  try {
    if (options.lockRoot) {
      const opened = await options.lockRoot.open(relativeSidecarLockPath(options.lockRoot, lockPath));
      try {
        const raw = (await readFileHandleBounded(opened.handle, MAX_LOCK_PAYLOAD_BYTES)).toString("utf8");
        return { raw, payload: parseLockPayload(raw, options.parsePayload), stat: opened.stat };
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    }
    const stat = await fs.lstat(lockPath);
    const raw = await fs.readFile(lockPath, "utf8");
    return { raw, payload: parseLockPayload(raw, options.parsePayload), stat };
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code === "ENOENT" ||
      (err instanceof FsSafeError && err.code === "not-found")
    ) {
      return null;
    }
    throw err;
  }
}

export function sidecarLockSnapshotMatches(
  current: SidecarLockSnapshot,
  observed: SidecarLockSnapshot,
): boolean {
  if (observed.ownershipToken !== undefined) {
    return (
      current.stat?.isFile() === true &&
      current.raw !== undefined &&
      observed.raw !== undefined &&
      readSidecarLockOwnershipToken(current.raw) === observed.ownershipToken &&
      readSidecarLockOwnershipToken(observed.raw) === observed.ownershipToken &&
      current.raw === observed.raw
    );
  }
  if (observed.stat && current.stat && !sameFileIdentity(observed.stat, current.stat)) {
    return false;
  }
  if (observed.raw !== undefined) {
    return current.raw === observed.raw;
  }
  return observed.stat !== undefined && current.stat !== undefined;
}

export async function removeSidecarLockIfUnchanged(
  lockPath: string,
  observed: SidecarLockSnapshot | null,
  options: { lockRoot?: Root; parsePayload?: (raw: string) => unknown } = {},
): Promise<boolean> {
  const current = await readSidecarLockSnapshot(lockPath, options);
  if (!current || !observed || !sidecarLockSnapshotMatches(current, observed)) {
    return false;
  }
  if (options.lockRoot) {
    await options.lockRoot.remove(relativeSidecarLockPath(options.lockRoot, lockPath)).catch(() => undefined);
  } else {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
  return true;
}

export async function sidecarLockSnapshotStillPresent(
  lockPath: string,
  observed: SidecarLockSnapshot | null,
  options: { lockRoot?: Root; parsePayload?: (raw: string) => unknown } = {},
): Promise<boolean> {
  const current = await readSidecarLockSnapshot(lockPath, options);
  return !!current && !!observed && sidecarLockSnapshotMatches(current, observed);
}

export async function sidecarReclaimGuardExists(pathname: string): Promise<boolean> {
  try {
    await fs.lstat(pathname);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function tryAcquireSidecarReclaimGuard(
  reclaimGuards: Set<string>,
  reclaimGuardPath: string,
): Promise<boolean> {
  try {
    await fs.mkdir(reclaimGuardPath);
    reclaimGuards.add(reclaimGuardPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export async function releaseSidecarReclaimGuard(
  reclaimGuards: Set<string>,
  reclaimGuardPath: string,
): Promise<void> {
  await fs.rmdir(reclaimGuardPath);
  reclaimGuards.delete(reclaimGuardPath);
}

export async function removeStaleSidecarLockIfAllowed(params: {
  lockPath: string;
  normalizedTargetPath: string;
  snapshot: SidecarLockSnapshot;
  shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean | Promise<boolean>;
  lockRoot?: Root;
  parsePayload?: (raw: string) => unknown;
}): Promise<"removed" | "changed" | "not-approved"> {
  if (!params.shouldRemoveStaleLock || params.snapshot.raw === undefined) {
    return "not-approved";
  }
  const ioOptions = { lockRoot: params.lockRoot, parsePayload: params.parsePayload };
  if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot, ioOptions))) {
    return "changed";
  }
  if (
    !(await params.shouldRemoveStaleLock({
      lockPath: params.lockPath,
      normalizedTargetPath: params.normalizedTargetPath,
      raw: params.snapshot.raw,
      payload: params.snapshot.payload,
    }))
  ) {
    return "not-approved";
  }
  if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot, ioOptions))) {
    return "changed";
  }
  try {
    if (params.lockRoot) {
      await params.lockRoot.remove(relativeSidecarLockPath(params.lockRoot, params.lockPath));
    } else {
      await fs.rm(params.lockPath);
    }
    return "removed";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "changed";
    }
    throw err;
  }
}
