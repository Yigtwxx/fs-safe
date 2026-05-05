# Sidecar lock

`createSidecarLockManager(key)` provides a cross-process file lock with retry, stale-lock reclaim, and process-exit cleanup. The lock is implemented as a sidecar file (e.g. `state.json` ↔ `state.json.lock`) — only one acquirer can create the sidecar with `O_CREAT | O_EXCL` at a time.

```ts
import { createSidecarLockManager } from "@openclaw/fs-safe";

const locks = createSidecarLockManager("snapshot");

const handle = await locks.acquire({
  targetPath: "/var/lib/app/state.json",
  staleMs: 5 * 60_000,
  payload: async () => ({ pid: process.pid, host: os.hostname() }),
});
try {
  // ...exclusive work on /var/lib/app/state.json...
} finally {
  await handle.release();
}
```

## Why sidecar?

The lock file sits next to the protected resource. If a process crashes mid-lock, the next acquirer notices the held entry, inspects its payload (PID, host, acquired-at timestamp), and decides — via `shouldReclaim` (defaulting to "is the lock older than `staleMs`?") — whether to take it over.

The library installs a `process.on("exit")` handler that releases all currently-held locks synchronously, so well-behaved exits leave no stale sidecars. Crashes still need the reclaim path.

## Manager API

```ts
function createSidecarLockManager(key: string): {
  acquire<TPayload>(options: SidecarLockAcquireOptions<TPayload>): Promise<SidecarLockHandle>;
  withLock<T, TPayload>(options: SidecarLockAcquireOptions<TPayload>, fn: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
  reset(): void;
  heldEntries(): SidecarLockHeldEntry[];
};
```

The `key` is a per-manager identifier used to keep state isolated across multiple managers in the same process. Use distinct keys for distinct lock domains (`"snapshot"`, `"compact"`, `"build"`).

## Acquire options

```ts
type SidecarLockAcquireOptions<TPayload extends Record<string, unknown>> = {
  targetPath: string;                    // the resource you want to protect
  lockPath?: string;                     // override; defaults to `${targetPath}.lock`
  staleMs: number;                       // how long until a held lock is considered stale
  timeoutMs?: number;                    // overall acquire deadline; default unbounded
  retry?: SidecarLockRetryOptions;
  allowReentrant?: boolean;              // if this process already holds it, increment a count instead of failing
  payload: () => TPayload | Promise<TPayload>;
  shouldReclaim?: (params: {
    lockPath: string;
    normalizedTargetPath: string;
    payload: Record<string, unknown> | null;
    staleMs: number;
    nowMs: number;
    heldByThisProcess: boolean;
  }) => boolean | Promise<boolean>;
  metadata?: Record<string, unknown>;    // attached to heldEntries() output for diagnostics
};

type SidecarLockRetryOptions = {
  retries?: number;       // number of retry attempts after the first failure
  factor?: number;        // exponential backoff factor (default 2)
  minTimeout?: number;    // initial delay (ms)
  maxTimeout?: number;    // delay cap (ms)
  randomize?: boolean;    // jitter
};
```

`payload` is a function so you can re-evaluate it on each retry (e.g. timestamp, PID).

## Release handle

```ts
type SidecarLockHandle = {
  lockPath: string;
  normalizedTargetPath: string;
  release: () => Promise<void>;
};
```

Always release in a `finally`:

```ts
const handle = await locks.acquire({ targetPath, staleMs: 60_000, payload: () => ({ pid: process.pid }) });
try {
  await doExclusiveWork();
} finally {
  await handle.release();
}
```

If your process dies before `release()` runs and skips the exit handler, the next acquirer reclaims the lock once `staleMs` elapses (or your `shouldReclaim` returns true).

## `withLock` — common shape made one-liner

```ts
const result = await locks.withLock(
  { targetPath: "/var/lib/app/state.json", staleMs: 30_000, payload: () => ({ pid: process.pid }) },
  async () => {
    return await runCompaction();
  },
);
```

Acquires, runs `fn`, releases regardless of success/failure. Returns the result of `fn`.

## Reclaim policy: `shouldReclaim`

The default policy reclaims locks whose `acquiredAt` is older than `staleMs`. Pass a custom callback when you want a richer notion of "is the holder still alive":

```ts
import { kill } from "node:process";

const handle = await locks.acquire({
  targetPath,
  staleMs: 60_000,
  payload: () => ({ pid: process.pid }),
  shouldReclaim: ({ payload, nowMs, staleMs }) => {
    if (!payload) return true;
    const pid = Number(payload.pid);
    if (!Number.isFinite(pid)) return true;
    try {
      kill(pid, 0);
      return false;                     // process still alive — don't reclaim
    } catch {
      return true;                      // process gone — reclaim
    }
  },
});
```

`heldByThisProcess` is true when this manager already holds the lock (relevant for the reentrant case).

## Diagnostics: `heldEntries`

```ts
for (const entry of locks.heldEntries()) {
  console.log(entry.normalizedTargetPath, "held since", new Date(entry.acquiredAt).toISOString());
  console.log("  metadata:", entry.metadata);
}
```

Each held entry exposes `forceRelease()` for admin tooling — use only when you're sure no real holder is still doing work.

## `drain` and `reset`

```ts
await locks.drain();      // async: release every currently-held lock with force
locks.reset();             // sync: same, but synchronous (use in tests / shutdown)
```

`drain()` is the right call during graceful shutdown when you want to clean up locks held by long-running tasks. `reset()` is the same operation in synchronous form, used by the built-in exit cleanup and useful in tests.

## What sidecar locks defend against

- **Two processes writing the same file at once.** `acquire` serializes the critical section.
- **A crashed holder leaving a stale lock.** `staleMs` plus optional `shouldReclaim` recovers it.
- **Race between simultaneous acquire attempts.** `O_CREAT | O_EXCL` ensures one wins.

## What they do **not** defend against

- **Misbehaving holders that ignore the lock.** Locks are advisory — only callers that go through `acquire` are bound.
- **Holders that never call `release` and have no liveness check.** Without a real `shouldReclaim`, the lock relies on `staleMs` alone — pick a deadline that is comfortably longer than your real work but short enough to recover from crashes.
- **Multi-host coordination over network filesystems.** Behavior depends on the underlying filesystem's `O_EXCL` semantics; treat as best-effort.

## Common patterns

### Compact under lock

```ts
await locks.withLock(
  {
    targetPath: "/var/lib/app/db.sqlite",
    staleMs: 30_000,
    payload: () => ({ pid: process.pid, what: "compact" }),
  },
  async () => {
    await runCompaction();
  },
);
```

### Try once, give up if held

```ts
try {
  await locks.withLock(
    { targetPath, staleMs: 30_000, retry: { retries: 0 }, payload: () => ({ pid: process.pid }) },
    async () => await work(),
  );
} catch (err) {
  console.log("another process is doing this; skipping");
}
```

### Wait politely with backoff

```ts
await locks.withLock(
  {
    targetPath,
    staleMs: 60_000,
    timeoutMs: 30_000,
    retry: { retries: 30, minTimeout: 100, maxTimeout: 5_000, factor: 1.7, randomize: true },
    payload: () => ({ pid: process.pid }),
  },
  async () => await work(),
);
```

## See also

- [Atomic writes](atomic.md) — single-writer atomicity that often replaces the need for a lock entirely.
- [Async lock](json.md#concurrency-createasynclock) — in-process serialization for a single Node process.
- [`createSidecarLockManager` source](https://github.com/openclaw/fs-safe/blob/main/src/sidecar-lock.ts).
