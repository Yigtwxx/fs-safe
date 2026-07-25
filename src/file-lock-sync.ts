import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { Root } from "./root-impl.js";
import {
  readSidecarLockSnapshotSync,
  relativeSidecarLockPath,
  removeSidecarLockIfUnchangedSync,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
  type SidecarLockSnapshot,
  type SidecarLockStaleSnapshot,
} from "./sidecar-lock-reclaim.js";
import {
  computeSidecarLockDelayMs,
  sidecarLockPayloadIsStale,
} from "./sidecar-lock-policy.js";
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
  relativeSidecarLockPath(lockRoot, resolved);
  const parent = path.dirname(resolved);
  const parentReal = fs.realpathSync(parent);
  const parentRelative = path.relative(lockRoot.rootReal, parentReal);
  if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new FsSafeError("outside-workspace", "sidecar lock parent is outside lockRoot");
  }
  return path.join(parentReal, path.basename(resolved));
}

function defaultShouldReclaim(payload: unknown, lockPath: string, staleMs: number, nowMs: number): boolean {
  if (sidecarLockPayloadIsStale(payload, staleMs, nowMs)) return true;
  try {
    return nowMs - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
        const current = readSidecarLockSnapshotSync(lockPath, options.parsePayload);
        return !!current && sidecarLockSnapshotMatches(current, snapshot);
      };
      const release = () => {
        if (released) return;
        released = true;
        if (timer) clearInterval(timer);
        fs.closeSync(heldFd);
        fd = undefined;
        removeSidecarLockIfUnchangedSync(lockPath, snapshot);
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
        removeSidecarLockIfUnchangedSync(lockPath, failed);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const snapshot = readSidecarLockSnapshotSync(lockPath, options.parsePayload);
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
            if (removeSidecarLockIfUnchangedSync(lockPath, snapshot)) continue;
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
      sleep(computeSidecarLockDelayMs(retry, attempt));
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
