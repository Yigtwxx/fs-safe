# JSON files

`@openclaw/fs-safe/json` is the standalone JSON surface. Strict and lenient read variants, atomic writes, and a small async lock for serializing in-process writers.

```ts
import {
  readJsonFile,
  readJsonFileStrict,
  writeJsonAtomic,
  writeTextAtomic,
  loadJsonFile,
  saveJsonFile,
  readDurableJsonFile,
  createAsyncLock,
  JsonFileReadError,
} from "@openclaw/fs-safe/json";
```

## Failure semantics in the name

Two read helpers, same input, different failure shape:

```ts
await readJsonFile<T>("./config.json");        // returns null on missing or invalid
await readJsonFileStrict<T>("./manifest.json"); // throws JsonFileReadError on missing or invalid
```

Use `readJsonFile` when "absent or unreadable" is a normal outcome (first run, optional caches). Use `readJsonFileStrict` when missing or malformed JSON is a programmer error you want to surface immediately.

`JsonFileReadError` carries `cause` so you can inspect whether it was an `ENOENT`, a `SyntaxError`, or something else.

## Reading

### `readJsonFile<T>(filePath)`

Async. Returns `Promise<T | null>`:

- file missing → `null`
- file present but invalid JSON → `null`
- file present and valid → parsed value cast to `T`

```ts
const cache = (await readJsonFile<Cache>("./cache.json")) ?? defaultCache();
```

### `readJsonFileStrict<T>(filePath)`

Async. Returns `Promise<T>`. Throws `JsonFileReadError` on missing-or-invalid. The cast is unchecked — validate the shape with your own schema (zod, valibot, …) if it came from an untrusted source.

### `readJsonFileSync(filePath)`

Synchronous variant. Returns `unknown` (parse with caution).

### `readDurableJsonFile<T>(filePath)`

Async. Returns `Promise<T | null>`. Behaves like `readJsonFile` but tolerates a brief window where the file is being atomically replaced — if the read returns `null` because the file is momentarily missing during a `rename`, it retries once before giving up.

Use this when many readers concurrently read a file that one writer atomically rewrites.

### `loadJsonFile<T>(pathname)`

Synchronous. Returns `T | undefined`. The "load with no fuss" sibling of `readJsonFile`. Same lenient semantics; missing or invalid → `undefined`.

## Writing

### `writeJsonAtomic(filePath, value, options?)`

Async. `JSON.stringify(value, replacer, space)` + [`replaceFileAtomic`](atomic.md#replacefileatomic-replacefileatomicsync) under the hood.

```ts
await writeJsonAtomic("./state.json", state, { space: 2 });
```

Options pass through to `replaceFileAtomic`:

```ts
type WriteJsonAtomicOptions = {
  fileMode?: number;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
  replacer?: Parameters<typeof JSON.stringify>[1];
  space?: Parameters<typeof JSON.stringify>[2];
  trailingNewline?: boolean; // default true
};
```

### `writeTextAtomic(filePath, content, options?)`

Async. Atomic text write. Same options as `writeJsonAtomic` (minus `replacer`/`space`/`trailingNewline`).

```ts
await writeTextAtomic("./README.md", rendered);
```

### `saveJsonFile(pathname, data)`

Synchronous, lenient. Convenience wrapper that calls the sync atomic write with sensible defaults.

```ts
saveJsonFile("./prefs.json", { theme: "dark" });
```

## Concurrency: `createAsyncLock()`

For in-process serialization of writers to the same file. Return value is a function that accepts an async task and runs it under the lock:

```ts
import { createAsyncLock } from "@openclaw/fs-safe/json";

const lock = createAsyncLock();

async function bumpCounter() {
  return lock(async () => {
    const state = (await readJsonFile<{ count: number }>("./counter.json")) ?? { count: 0 };
    state.count += 1;
    await writeJsonAtomic("./counter.json", state);
    return state.count;
  });
}
```

The lock is *in-process only* — it does nothing for cross-process coordination. For multi-process locking, see [`createSidecarLockManager`](sidecar-lock.md).

## Common patterns

### Read-modify-write

```ts
const state = (await readJsonFile<State>("./state.json")) ?? initialState();
state.lastRun = Date.now();
await writeJsonAtomic("./state.json", state, { space: 2, fileMode: 0o600 });
```

### Atomic with secure mode

For credentials or other sensitive JSON, write at mode `0o600`:

```ts
await writeJsonAtomic("./auth.json", token, {
  fileMode: 0o600,
  syncTempFile: true,
  syncParentDir: true,
});
```

For higher-assurance secrets, prefer the dedicated [secret-file helpers](secret-file.md) — they create the parent directory at `0o700` if missing.

### Strict load on boot

```ts
let manifest: Manifest;
try {
  manifest = await readJsonFileStrict<Manifest>("./manifest.json");
} catch (err) {
  if (err instanceof JsonFileReadError) {
    console.error("manifest unreadable:", err.cause);
    process.exit(1);
  }
  throw err;
}
```

### Concurrent readers, single writer

```ts
const state = await readDurableJsonFile<State>("./state.json");
// during a writer's atomic rename, the unlucky read returns null -> retried once
```

## Error reference

| Throw / return | When |
|---|---|
| `null` (lenient reads) | File missing or contents are not valid JSON. |
| `JsonFileReadError` | `readJsonFileStrict` saw missing or invalid input. Inspect `cause`. |
| `FsSafeError` | Atomic-write helpers can throw the standard codes via `replaceFileAtomic`. |
| Native `NodeJS.ErrnoException` | Lower-level fs errors not wrapped. |

## See also

- [Atomic writes](atomic.md) — `writeJsonAtomic` builds on `replaceFileAtomic`.
- [Secret files](secret-file.md) — JSON-or-text writes with mode 0600 in mode 0700 dirs.
- [Private file store](private-file-store.md) — root-bounded JSON+text helpers.
- [Sidecar lock](sidecar-lock.md) — cross-process coordination.
