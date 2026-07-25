import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import type { Root } from "./root-impl.js";
import {
  readSidecarLockOwnershipToken,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
  type SidecarLockStaleSnapshot,
} from "./sidecar-lock-reclaim.js";
import type {
  SidecarLockCompromisedInfo,
  SidecarLockRetryOptions,
  SidecarLockStaleRecovery,
} from "./sidecar-lock-types.js";

export type FileLockSyncAcquireOptions<TPayload extends Record<string, unknown>> = {
  lockPath?: string;
  staleMs?: number;
  timeoutMs?: number;
  retry?: SidecarLockRetryOptions;
  staleRecovery?: SidecarLockStaleRecovery;
  payload: () => TPayload;
  shouldReclaim?: (params: {
    lockPath: string;
    normalizedTargetPath: string;
    payload: unknown;
    staleMs: number;
    nowMs: number;
    heldByThisProcess: false;
  }) => boolean;
  shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean;
  parsePayload?: (raw: string) => unknown;
  lockRoot?: Root;
  onCompromised?: (info: SidecarLockCompromisedInfo) => void;
  compromiseCheckIntervalMs?: number;
};

export type FileLockSyncHandle = {
  lockPath: string;
  normalizedTargetPath: string;
  verifyStillHeld(): boolean;
  release(): void;
  [Symbol.dispose](): void;
};

function normalizeTargetPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function boundedLockPath(lockPath: string, lockRoot?: Root): string {
  const resolved = path.resolve(lockPath);
  if (!lockRoot) return resolved;
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
  const parent = path.dirname(resolved);
  const parentReal = fs.realpathSync(parent);
  const parentRelative = path.relative(lockRoot.rootReal, parentReal);
  if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new FsSafeError("outside-workspace", "sidecar lock parent is outside lockRoot");
  }
  return path.join(parentReal, path.basename(resolved));
}

function readSnapshot(
  lockPath: string,
  parsePayload?: (raw: string) => unknown,
): SidecarLockSnapshot | null {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(lockPath);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const noFollow =
      process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
        ? fs.constants.O_NOFOLLOW
        : 0;
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.lstatSync(lockPath);
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) return null;
    let payload: unknown = null;
    try {
      payload = parsePayload ? parsePayload(raw) : (JSON.parse(raw) as unknown);
    } catch {
      payload = null;
    }
    return { raw, payload, stat: after, ownershipToken: readSidecarLockOwnershipToken(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function defaultShouldReclaim(payload: unknown, lockPath: string, staleMs: number, nowMs: number): boolean {
  if (payload && typeof payload === "object" && "createdAt" in payload) {
    const createdAt = typeof payload.createdAt === "string" ? Date.parse(payload.createdAt) : NaN;
    if (Number.isFinite(createdAt) && nowMs - createdAt > staleMs) return true;
  }
  try {
    return nowMs - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryDelay(retry: SidecarLockRetryOptions, attempt: number): number {
  const min = retry.minTimeout ?? 50;
  const max = retry.maxTimeout ?? 1000;
  const factor = retry.factor ?? 1;
  const base = Math.min(max, Math.max(min, min * factor ** attempt));
  return Math.min(max, Math.round(base * (retry.randomize ? 1 + Math.random() : 1)));
}

function removeIfUnchanged(lockPath: string, snapshot: SidecarLockSnapshot): boolean {
  const current = readSnapshot(lockPath);
  if (!current || !sidecarLockSnapshotMatches(current, snapshot)) return false;
  fs.rmSync(lockPath);
  return true;
}

export function acquireFileLockSync<TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockSyncAcquireOptions<TPayload>,
): FileLockSyncHandle {
  const normalizedTargetPath = normalizeTargetPath(targetPath);
  const lockPath = boundedLockPath(options.lockPath ?? `${normalizedTargetPath}.lock`, options.lockRoot);
  const staleMs = options.staleMs ?? 30_000;
  const retry = options.retry ?? {};
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    let fd: number | undefined;
    try {
      const payload = options.payload();
      const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
      const noFollow =
        process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0;
      fd = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      fs.writeFileSync(fd, raw, "utf8");
      fs.fsyncSync(fd);
      const snapshot: SidecarLockSnapshot = {
        raw,
        payload,
        stat: fs.fstatSync(fd),
        ownershipToken,
      };
      const heldFd = fd;
      let released = false;
      let timer: NodeJS.Timeout | undefined;
      const verifyStillHeld = () => {
        const current = readSnapshot(lockPath, options.parsePayload);
        return !!current && sidecarLockSnapshotMatches(current, snapshot);
      };
      const release = () => {
        if (released) return;
        released = true;
        if (timer) clearInterval(timer);
        fs.closeSync(heldFd);
        fd = undefined;
        removeIfUnchanged(lockPath, snapshot);
      };
      if (options.onCompromised && (options.compromiseCheckIntervalMs ?? 0) > 0) {
        timer = setInterval(() => {
          if (!verifyStillHeld()) {
            if (timer) clearInterval(timer);
            timer = undefined;
            options.onCompromised?.({ lockPath, normalizedTargetPath });
          }
        }, options.compromiseCheckIntervalMs);
        timer.unref();
      }
      return {
        lockPath,
        normalizedTargetPath,
        verifyStillHeld,
        release,
        [Symbol.dispose]: release,
      };
    } catch (error) {
      if (fd !== undefined) {
        const failed = { payload: null, stat: fs.fstatSync(fd) } satisfies SidecarLockSnapshot;
        fs.closeSync(fd);
        fd = undefined;
        removeIfUnchanged(lockPath, failed);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const snapshot = readSnapshot(lockPath, options.parsePayload);
      if (!snapshot) continue;
      const nowMs = Date.now();
      const reclaim = options.shouldReclaim
        ? options.shouldReclaim({
            lockPath,
            normalizedTargetPath,
            payload: snapshot.payload,
            staleMs,
            nowMs,
            heldByThisProcess: false,
          })
        : defaultShouldReclaim(snapshot.payload, lockPath, staleMs, nowMs);
      if (reclaim) {
        if (
          options.staleRecovery === "remove-if-unchanged" &&
          snapshot.raw !== undefined &&
          options.shouldRemoveStaleLock?.({
            lockPath,
            normalizedTargetPath,
            raw: snapshot.raw,
            payload: snapshot.payload,
          })
        ) {
          const reclaimGuard = `${lockPath}.reclaim`;
          try {
            fs.mkdirSync(reclaimGuard);
            if (removeIfUnchanged(lockPath, snapshot)) continue;
          } finally {
            try {
              fs.rmdirSync(reclaimGuard);
            } catch {
              // A surviving reclaim guard fails closed.
            }
          }
        }
        throw Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
          code: "file_lock_stale",
          lockPath,
          normalizedTargetPath,
        });
      }
      const elapsed = Date.now() - startedAt;
      const timedOut = options.timeoutMs !== undefined && elapsed >= options.timeoutMs;
      if (timedOut || (retry.retries !== undefined && attempt >= retry.retries)) {
        throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
          code: "file_lock_timeout",
          lockPath,
          normalizedTargetPath,
        });
      }
      sleep(retryDelay(retry, attempt));
      attempt += 1;
    }
  }
}

export function withFileLockSync<T, TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: FileLockSyncAcquireOptions<TPayload>,
  fn: () => T,
): T {
  const lock = acquireFileLockSync(targetPath, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
}
