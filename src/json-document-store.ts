import type { FileLockRetryOptions } from "./file-lock.js";
import { getFsSafeLockConfig } from "./lock-config.js";
import { createSidecarLockManager } from "./sidecar-lock.js";
import type { SidecarLockStaleRecovery } from "./sidecar-lock.js";

export type JsonStoreLockOptions = {
  staleMs?: number;
  timeoutMs?: number;
  retry?: FileLockRetryOptions;
  staleRecovery?: SidecarLockStaleRecovery;
  managerKey?: string;
};

export type JsonFileStoreOptions = {
  trailingNewline?: boolean;
  lock?: boolean | JsonStoreLockOptions;
};

export type JsonStore<T> = {
  readonly filePath: string;
  read(): Promise<T | undefined>;
  readOr(fallback: T): Promise<T>;
  readRequired(): Promise<T>;
  write(value: T): Promise<void>;
  update(run: (current: T | undefined) => T | Promise<T>): Promise<T>;
  updateOr(fallback: T, run: (current: T) => T | Promise<T>): Promise<T>;
};

export type JsonStoreAdapter<T> = {
  filePath: string;
  readIfExists(): Promise<T | null>;
  readRequired(): Promise<T>;
  write(value: T, options?: { trailingNewline?: boolean }): Promise<void>;
};

function cloneFallback<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function resolveLockOptions(
  filePath: string,
  options: JsonFileStoreOptions,
): Required<JsonStoreLockOptions> | null {
  if (!options.lock) {
    return null;
  }
  const lockOptions = options.lock === true ? {} : options.lock;
  const defaults = getFsSafeLockConfig();
  return {
    managerKey: lockOptions.managerKey ?? `fs-safe.json-store:${filePath}`,
    retry: lockOptions.retry ?? defaults.retry ?? {},
    staleMs: lockOptions.staleMs ?? defaults.staleMs ?? 30_000,
    staleRecovery: lockOptions.staleRecovery ?? defaults.staleRecovery,
    timeoutMs: lockOptions.timeoutMs ?? defaults.timeoutMs ?? 30_000,
  };
}

export function createJsonStore<T>(
  adapter: JsonStoreAdapter<T>,
  options: JsonFileStoreOptions = {},
): JsonStore<T> {
  const lockOptions = resolveLockOptions(adapter.filePath, options);
  const locks = lockOptions ? createSidecarLockManager(lockOptions.managerKey) : null;

  async function read(): Promise<T | undefined> {
    return (await adapter.readIfExists()) ?? undefined;
  }

  async function readOr(fallback: T): Promise<T> {
    return (await read()) ?? cloneFallback(fallback);
  }

  async function write(value: T): Promise<void> {
    await adapter.write(value, {
      trailingNewline: options.trailingNewline ?? true,
    });
  }

  async function withOptionalLock<R>(run: () => Promise<R>): Promise<R> {
    if (!locks || !lockOptions) {
      return await run();
    }
    return await locks.withLock(
      {
        targetPath: adapter.filePath,
        staleMs: lockOptions.staleMs,
        timeoutMs: lockOptions.timeoutMs,
        retry: lockOptions.retry,
        staleRecovery: lockOptions.staleRecovery,
        allowReentrant: true,
        payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
      },
      run,
    );
  }

  return {
    filePath: adapter.filePath,
    read,
    readOr,
    readRequired: adapter.readRequired,
    write: async (value) => {
      await withOptionalLock(async () => {
        await write(value);
      });
    },
    update: async (run) =>
      await withOptionalLock(async () => {
        const next = await run(await read());
        await write(next);
        return next;
      }),
    updateOr: async (fallback, run) =>
      await withOptionalLock(async () => {
        const next = await run((await read()) ?? cloneFallback(fallback));
        await write(next);
        return next;
      }),
  };
}
