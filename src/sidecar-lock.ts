import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";

export type SidecarLockRetryOptions = {
  retries?: number;
  factor?: number;
  minTimeout?: number;
  maxTimeout?: number;
  randomize?: boolean;
};

export type SidecarLockAcquireOptions<TPayload extends Record<string, unknown>> = {
  targetPath: string;
  lockPath?: string;
  staleMs: number;
  timeoutMs?: number;
  retry?: SidecarLockRetryOptions;
  allowReentrant?: boolean;
  payload: () => TPayload | Promise<TPayload>;
  shouldReclaim?: (params: {
    lockPath: string;
    normalizedTargetPath: string;
    payload: Record<string, unknown> | null;
    staleMs: number;
    nowMs: number;
    heldByThisProcess: boolean;
  }) => boolean | Promise<boolean>;
  metadata?: Record<string, unknown>;
};

export type SidecarLockHandle = {
  lockPath: string;
  normalizedTargetPath: string;
  release: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type SidecarLockHeldEntry = {
  normalizedTargetPath: string;
  lockPath: string;
  acquiredAt: number;
  metadata: Record<string, unknown>;
  forceRelease: () => Promise<boolean>;
};

export type WithSidecarLockOptions<TPayload extends Record<string, unknown>> = Omit<
  SidecarLockAcquireOptions<TPayload>,
  "targetPath"
> & {
  managerKey?: string;
};

type HeldLock = {
  count: number;
  handle: FileHandle;
  lockPath: string;
  acquiredAt: number;
  metadata: Record<string, unknown>;
  releasePromise?: Promise<void>;
};

type SidecarLockManagerState = {
  cleanupRegistered: boolean;
  held: Map<string, HeldLock>;
};

const GLOBAL_STATE_KEY = Symbol.for("fsSafe.sidecarLockManagers");

function getGlobalManagers(): Map<string, SidecarLockManagerState> {
  const globalWithState = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: Map<string, SidecarLockManagerState>;
  };
  if (!globalWithState[GLOBAL_STATE_KEY]) {
    globalWithState[GLOBAL_STATE_KEY] = new Map();
  }
  return globalWithState[GLOBAL_STATE_KEY];
}

function resolveManagerState(key: string): SidecarLockManagerState {
  const managers = getGlobalManagers();
  let state = managers.get(key);
  if (!state) {
    state = { cleanupRegistered: false, held: new Map() };
    managers.set(key, state);
  }
  return state;
}

async function readJsonPayload(lockPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function resolveNormalizedTargetPath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    return path.join(await fs.realpath(dir), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function computeDelayMs(retry: SidecarLockRetryOptions, attempt: number): number {
  const minTimeout = retry.minTimeout ?? 50;
  const maxTimeout = retry.maxTimeout ?? 1000;
  const factor = retry.factor ?? 1;
  const base = Math.min(maxTimeout, Math.max(minTimeout, minTimeout * factor ** attempt));
  const jitter = retry.randomize ? 1 + Math.random() : 1;
  return Math.min(maxTimeout, Math.round(base * jitter));
}

async function defaultShouldReclaim(params: {
  lockPath: string;
  payload: Record<string, unknown> | null;
  staleMs: number;
  nowMs: number;
}): Promise<boolean> {
  const createdAt = typeof params.payload?.createdAt === "string" ? params.payload.createdAt : "";
  const createdAtMs = Date.parse(createdAt);
  if (Number.isFinite(createdAtMs) && params.nowMs - createdAtMs > params.staleMs) {
    return true;
  }
  try {
    const stat = await fs.stat(params.lockPath);
    return params.nowMs - stat.mtimeMs > params.staleMs;
  } catch {
    return true;
  }
}

function releaseAllLocksSync(state: SidecarLockManagerState): void {
  for (const [normalizedTargetPath, held] of state.held) {
    void held.handle.close().catch(() => undefined);
    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {
      // Best-effort process-exit cleanup.
    }
    state.held.delete(normalizedTargetPath);
  }
}

async function releaseHeldLock(
  state: SidecarLockManagerState,
  normalizedTargetPath: string,
  held: HeldLock,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const current = state.held.get(normalizedTargetPath);
  if (current !== held) {
    return false;
  }
  if (opts.force) {
    held.count = 0;
  } else {
    held.count -= 1;
    if (held.count > 0) {
      return false;
    }
  }
  if (held.releasePromise) {
    await held.releasePromise.catch(() => undefined);
    return true;
  }
  state.held.delete(normalizedTargetPath);
  held.releasePromise = (async () => {
    await held.handle.close().catch(() => undefined);
    await fs.rm(held.lockPath, { force: true }).catch(() => undefined);
  })();
  try {
    await held.releasePromise;
    return true;
  } finally {
    held.releasePromise = undefined;
  }
}

export function createSidecarLockManager(key: string) {
  const state = resolveManagerState(key);

  function ensureExitCleanupRegistered(): void {
    if (state.cleanupRegistered) {
      return;
    }
    state.cleanupRegistered = true;
    process.on("exit", () => releaseAllLocksSync(state));
  }

  async function acquire<TPayload extends Record<string, unknown>>(
    options: SidecarLockAcquireOptions<TPayload>,
  ): Promise<SidecarLockHandle> {
    ensureExitCleanupRegistered();
    const normalizedTargetPath = await resolveNormalizedTargetPath(options.targetPath);
    const lockPath = options.lockPath ?? `${normalizedTargetPath}.lock`;
    const held = state.held.get(normalizedTargetPath);
    if (held && options.allowReentrant) {
      held.count += 1;
      const release = () => releaseHeldLock(state, normalizedTargetPath, held).then(() => undefined);
      return {
        lockPath,
        normalizedTargetPath,
        release,
        [Symbol.asyncDispose]: release,
      };
    }

    const startedAt = Date.now();
    const retry = options.retry ?? {};
    const maxRetries = options.timeoutMs === Number.POSITIVE_INFINITY ? undefined : retry.retries;
    let attempt = 0;
    while (true) {
      let handle: FileHandle | null = null;
      try {
        handle = await fs.open(lockPath, "wx");
        const createdHeld: HeldLock = {
          count: 1,
          handle,
          lockPath,
          acquiredAt: Date.now(),
          metadata: options.metadata ?? {},
        };
        state.held.set(normalizedTargetPath, createdHeld);
        await handle.writeFile(`${JSON.stringify(await options.payload(), null, 2)}\n`, "utf8");
        const release = () =>
          releaseHeldLock(state, normalizedTargetPath, createdHeld).then(() => undefined);
        return {
          lockPath,
          normalizedTargetPath,
          release,
          [Symbol.asyncDispose]: release,
        };
      } catch (err) {
        if (handle) {
          const current = state.held.get(normalizedTargetPath);
          if (current?.handle === handle) {
            state.held.delete(normalizedTargetPath);
          }
          await handle.close().catch(() => undefined);
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
        }
        if ((err as { code?: unknown }).code !== "EEXIST") {
          throw err;
        }
        const nowMs = Date.now();
        const payload = await readJsonPayload(lockPath);
        const shouldReclaim = options.shouldReclaim ?? defaultShouldReclaim;
        if (
          await shouldReclaim({
            lockPath,
            normalizedTargetPath,
            payload,
            staleMs: options.staleMs,
            nowMs,
            heldByThisProcess: state.held.has(normalizedTargetPath),
          })
        ) {
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
        const elapsed = Date.now() - startedAt;
        if (
          (options.timeoutMs !== undefined &&
            options.timeoutMs !== Number.POSITIVE_INFINITY &&
            elapsed >= options.timeoutMs) ||
          (maxRetries !== undefined && attempt >= maxRetries)
        ) {
          throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
            code: "file_lock_timeout",
            lockPath,
            normalizedTargetPath,
          });
        }
        const remaining =
          options.timeoutMs === undefined || options.timeoutMs === Number.POSITIVE_INFINITY
            ? Number.POSITIVE_INFINITY
            : Math.max(0, options.timeoutMs - elapsed);
        const delay = Math.min(computeDelayMs(retry, attempt), remaining);
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async function withLock<T, TPayload extends Record<string, unknown>>(
    options: SidecarLockAcquireOptions<TPayload>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lock = await acquire(options);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  async function drain(): Promise<void> {
    for (const [normalizedTargetPath, held] of Array.from(state.held.entries())) {
      await releaseHeldLock(state, normalizedTargetPath, held, { force: true }).catch(
        () => undefined,
      );
    }
  }

  function reset(): void {
    releaseAllLocksSync(state);
  }

  function heldEntries(): SidecarLockHeldEntry[] {
    return Array.from(state.held.entries()).map(([normalizedTargetPath, held]) => ({
      normalizedTargetPath,
      lockPath: held.lockPath,
      acquiredAt: held.acquiredAt,
      metadata: held.metadata,
      forceRelease: () => releaseHeldLock(state, normalizedTargetPath, held, { force: true }),
    }));
  }

  return { acquire, withLock, drain, reset, heldEntries };
}

export async function withSidecarLock<T, TPayload extends Record<string, unknown>>(
  targetPath: string,
  options: WithSidecarLockOptions<TPayload>,
  fn: () => Promise<T>,
): Promise<T> {
  const manager = createSidecarLockManager(
    options.managerKey ?? `fs-safe.sidecar-lock:${targetPath}`,
  );
  const { managerKey: _managerKey, ...acquireOptions } = options;
  return await manager.withLock({ ...acquireOptions, targetPath }, fn);
}
