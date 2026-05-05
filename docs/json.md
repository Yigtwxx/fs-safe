# JSON files

`@openclaw/fs-safe/json` is the standalone JSON surface. Strict and lenient read variants, atomic writes, and a small async lock for serializing in-process writers.

```ts
import {
  tryReadJson,
  readJson,
  readJsonIfExists,
  readJsonSync,
  tryReadJsonSync,
  writeJson,
  writeText,
  writeJsonSync,
  createAsyncLock,
  JsonFileReadError,
} from "@openclaw/fs-safe/json";
```

## Failure semantics in the name

Two read helpers, same input, different failure shape:

```ts
await tryReadJson<T>("./config.json"); // returns null on missing or invalid
await readJson<T>("./manifest.json");  // throws JsonFileReadError on missing or invalid
```

Use `tryReadJson` when "absent or unreadable" is a normal outcome (first run, optional caches). Use `readJson` when missing or malformed JSON is a programmer error you want to surface immediately.

`JsonFileReadError` carries `cause` so you can inspect whether it was an `ENOENT`, a `SyntaxError`, or something else.

## Reading

### `tryReadJson<T>(filePath)`

Async. Returns `Promise<T | null>`:

- file missing → `null`
- file present but invalid JSON → `null`
- file present and valid → parsed value cast to `T`

```ts
const cache = (await tryReadJson<Cache>("./cache.json")) ?? defaultCache();
```

### `readJson<T>(filePath)`

Async. Returns `Promise<T>`. Throws `JsonFileReadError` on missing-or-invalid. The cast is unchecked — validate the shape with your own schema (zod, valibot, …) if it came from an untrusted source.

### `readJsonSync(filePath)`

Synchronous strict-ish variant. Returns `unknown` for valid JSON and `null` for missing or invalid input.

### `tryReadJsonSync<T>(pathname)`

Synchronous lenient variant. Returns `T | null`; missing or invalid input returns `null`.

### `readJsonIfExists<T>(filePath)`

Async. Returns `Promise<T | null>`. Missing files return `null`; invalid JSON throws `JsonFileReadError`.

## Writing

### `writeJson(filePath, value, options?)`

Async. `JSON.stringify(value, null, 2)` + sibling-temp rename under the hood.

```ts
await writeJson("./state.json", state, { trailingNewline: true });
```

Options:

```ts
type WriteJsonOptions = {
  mode?: number;
  ensureDirMode?: number;
  trailingNewline?: boolean;
};
```

### `writeText(filePath, content, options?)`

Async. Atomic text write. Same options as `writeJson`, with `appendTrailingNewline` instead of `trailingNewline`.

```ts
await writeText("./README.md", rendered);
```

### `writeJsonSync(pathname, data)`

Synchronous convenience wrapper that writes formatted JSON with mode `0o600`. Existing symlink leaves are replaced, not followed.

```ts
writeJsonSync("./prefs.json", { theme: "dark" });
```

## Concurrency: `createAsyncLock()`

For in-process serialization of writers to the same file. Return value is a function that accepts an async task and runs it under the lock:

```ts
import { createAsyncLock } from "@openclaw/fs-safe/json";

const lock = createAsyncLock();

async function bumpCounter() {
  return lock(async () => {
    const state = (await tryReadJson<{ count: number }>("./counter.json")) ?? { count: 0 };
    state.count += 1;
    await writeJson("./counter.json", state);
    return state.count;
  });
}
```

The lock is *in-process only* — it does nothing for cross-process coordination. For multi-process locking, see [`createSidecarLockManager`](sidecar-lock.md).

## Common patterns

### Read-modify-write

```ts
const state = (await tryReadJson<State>("./state.json")) ?? initialState();
state.lastRun = Date.now();
await writeJson("./state.json", state, { mode: 0o600 });
```

### Atomic with secure mode

For credentials or other sensitive JSON, write at mode `0o600`:

```ts
await writeJson("./auth.json", token, { mode: 0o600, ensureDirMode: 0o700 });
```

For higher-assurance secrets, prefer the dedicated [secret-file helpers](secret-file.md) — they create the parent directory at `0o700` if missing.

### Strict load on boot

```ts
let manifest: Manifest;
try {
  manifest = await readJson<Manifest>("./manifest.json");
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
const state = await readJsonIfExists<State>("./state.json");
// missing returns null; malformed JSON still throws
```

## Error reference

| Throw / return | When |
|---|---|
| `null` (lenient reads) | File missing or contents are not valid JSON. |
| `JsonFileReadError` | `readJson` or `readJsonIfExists` saw unreadable or invalid input. Inspect `cause`. |
| Native `NodeJS.ErrnoException` | Lower-level fs errors not wrapped. |

## See also

- [Atomic writes](atomic.md) — lower-level sibling-temp replacement helpers.
- [Secret files](secret-file.md) — JSON-or-text writes with mode 0600 in mode 0700 dirs.
- [Private file store](private-file-store.md) — root-bounded JSON+text helpers.
- [Sidecar lock](sidecar-lock.md) — cross-process coordination.
