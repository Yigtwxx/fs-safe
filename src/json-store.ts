import path from "node:path";
import { createSidecarLockManager, type SidecarLockRetryOptions } from "./sidecar-lock.js";
import { readJson, readJsonIfExists, writeJson } from "./json.js";

export type JsonStoreLockOptions = {
  staleMs?: number;
  timeoutMs?: number;
  retry?: SidecarLockRetryOptions;
  managerKey?: string;
};

export type JsonStoreOptions<T> = {
  filePath: string;
  dirMode?: number;
  mode?: number;
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

function cloneFallback<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function resolveLockOptions<T>(options: JsonStoreOptions<T>): Required<JsonStoreLockOptions> | null {
  if (!options.lock) {
    return null;
  }
  const lockOptions = options.lock === true ? {} : options.lock;
  return {
    managerKey: lockOptions.managerKey ?? `fs-safe.json-store:${path.resolve(options.filePath)}`,
    retry: lockOptions.retry ?? {},
    staleMs: lockOptions.staleMs ?? 30_000,
    timeoutMs: lockOptions.timeoutMs ?? 30_000,
  };
}

export function jsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const filePath = path.resolve(options.filePath);
  const lockOptions = resolveLockOptions({ ...options, filePath });
  const locks = lockOptions ? createSidecarLockManager(lockOptions.managerKey) : null;

  async function read(): Promise<T | undefined> {
    const value = await readJsonIfExists<T>(filePath);
    return value === null ? undefined : value;
  }

  async function readOr(fallback: T): Promise<T> {
    return (await read()) ?? cloneFallback(fallback);
  }

  async function requireValue(): Promise<T> {
    return await readJson<T>(filePath);
  }

  async function write(value: T): Promise<void> {
    await writeJson(filePath, value, {
      mode: options.mode ?? 0o600,
      dirMode: options.dirMode ?? 0o700,
      trailingNewline: options.trailingNewline ?? true,
    });
  }

  async function withOptionalLock<R>(run: () => Promise<R>): Promise<R> {
    if (!locks || !lockOptions) {
      return await run();
    }
    return await locks.withLock(
      {
        targetPath: filePath,
        staleMs: lockOptions.staleMs,
        timeoutMs: lockOptions.timeoutMs,
        retry: lockOptions.retry,
        allowReentrant: true,
        payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
      },
      run,
    );
  }

  return {
    filePath,
    read,
    readOr,
    readRequired: requireValue,
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
