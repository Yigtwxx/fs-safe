# JSON store

`@openclaw/fs-safe/json-store` is a small read-modify-write wrapper around a single JSON file. It bakes in atomic writes, a typed fallback when the file is missing, and optional cross-process locking via [`createSidecarLockManager`](sidecar-lock.md).

```ts
import { jsonStore } from "@openclaw/fs-safe/json-store";

const settings = jsonStore<{ theme: "light" | "dark"; volume: number }>({
  filePath: "/var/lib/app/settings.json",
  fallback: { theme: "dark", volume: 0.7 },
});

const current = await settings.read();         // returns fallback if file missing
await settings.write({ ...current, volume: 1 });
await settings.update((prev) => ({ ...prev, theme: "light" }));
```

## When to reach for it

- You have a single JSON state file and want `read / write / update` semantics with fallback baked in.
- You want every write atomic at file mode `0o600` and parents at `0o700` by default.
- You want optional cross-process locking with one boolean.

For ad-hoc read/write of multiple JSON files, use the standalone helpers in [`json`](json.md). For object-style storage of many files at known modes, use [`fileStore`](file-store.md).

## Factory: `jsonStore<T>(options)`

```ts
type JsonStoreOptions<T> = {
  filePath: string;
  fallback: T;                                     // returned when file is missing
  dirMode?: number;                                // default 0o700
  mode?: number;                                   // default 0o600
  trailingNewline?: boolean;                       // default true
  lock?: boolean | JsonStoreLockOptions;           // false / undefined = no lock
};

type JsonStoreLockOptions = {
  staleMs?: number;     // default 30_000
  timeoutMs?: number;   // default 30_000
  retry?: SidecarLockRetryOptions;
  managerKey?: string;  // default `fs-safe.json-store:<filePath>`
};

type JsonStore<T> = {
  readonly filePath: string;
  read(): Promise<T>;
  write(value: T): Promise<void>;
  update(run: (current: T) => T | Promise<T>): Promise<T>;
};
```

`fallback` is **deep-cloned** on every read so the caller can safely mutate the returned object without poisoning the next call.

The store does **not** validate the parsed value against `T` at runtime — the cast is unchecked. Wrap with a schema (zod/valibot) if the file might be hand-edited or written by another process you don't control.

## `read()`

Returns the parsed contents, or `fallback` (cloned) if the file does not exist. Invalid JSON throws (via [`readJsonIfExists`](json.md)).

```ts
const state = await store.read();
```

## `write(value)`

Atomic JSON write at `mode` (default `0o600`), creating parent dirs at `dirMode` (default `0o700`) if needed. When `lock: true` is set, takes the sidecar lock for the duration of the write.

```ts
await store.write({ ...state, lastSeen: Date.now() });
```

## `update(run)`

Read, transform, write — under the lock if locking is enabled. Returns the new value:

```ts
const next = await store.update((prev) => ({ ...prev, count: prev.count + 1 }));
```

`run` is async-friendly. The whole `read → run → write` sequence runs inside one `withLock` call, so concurrent updaters from different processes serialize cleanly.

## Locking

Set `lock: true` for default behavior, or pass an options object to tune:

```ts
const counter = jsonStore<{ count: number }>({
  filePath: "/var/lib/app/counter.json",
  fallback: { count: 0 },
  lock: {
    staleMs: 60_000,
    timeoutMs: 10_000,
    retry: { retries: 30, minTimeout: 100, maxTimeout: 5_000, randomize: true },
  },
});
```

When `lock` is falsy, `read` / `write` / `update` are unlocked. The `update` shape is still useful — it gives you a single function for the read-modify-write pattern — but it offers no concurrency guarantees if other processes also write to the file.

The default `managerKey` namespaces the in-process `SidecarLockManager` per absolute file path, so two `jsonStore` calls on the same file share lock state automatically.

## Common patterns

### Per-feature settings file

```ts
type Settings = { theme: "light" | "dark"; muted: boolean };

const settings = jsonStore<Settings>({
  filePath: path.join(homedir(), ".myapp/settings.json"),
  fallback: { theme: "dark", muted: false },
});

// Read on boot
applySettings(await settings.read());

// Toggle on UI action
await settings.update((prev) => ({ ...prev, muted: !prev.muted }));
```

### Cross-process counter

```ts
const counter = jsonStore<{ count: number }>({
  filePath: "/var/lib/app/counter.json",
  fallback: { count: 0 },
  lock: true,
});

const { count } = await counter.update((prev) => ({ count: prev.count + 1 }));
console.log("now at", count);
```

### Migration on boot

```ts
const config = jsonStore<Config>({ filePath, fallback: defaultConfig });
const current = await config.read();
if (current.version !== CURRENT_VERSION) {
  await config.write(migrate(current));
}
```

## Difference from raw `writeJson` / `readJsonIfExists`

| `jsonStore` | Raw helpers |
|---|---|
| Read-modify-write in one call (`update`). | Compose `readJsonIfExists` + `writeJson` yourself. |
| Optional cross-process lock with one flag. | Manage `withSidecarLock` yourself. |
| Fallback baked in, deep-cloned per read. | Caller handles `null` and clones. |
| Mode/dirMode locked per store. | Per-call. |

`jsonStore` is the right shape when one file owns one piece of state and many call sites read or update it. For one-off writes, the raw helpers are leaner.

## See also

- [JSON files](json.md) — the standalone helpers `jsonStore` is built on.
- [Sidecar lock](sidecar-lock.md) — the cross-process lock used when `lock: true`.
- [File store](file-store.md) — the multi-file equivalent of this surface.
