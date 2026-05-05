# Private state store

`privateStateStore({ rootDir })` returns a private-mode `fileStore` handle for **JSON or text state** inside a trusted root directory. Every write atomically creates the parent directory tree at mode `0o700` and the file at mode `0o600`.

```ts
import { privateStateStore } from "@openclaw/fs-safe/store";

const store = privateStateStore({ rootDir: "/var/lib/app" });

await store.writeJson("state.json", state);
const loaded = await store.readJson<State>("state.json");
```

## When to reach for it

- You have a single trusted directory holding small JSON or text state.
- You want every write to land at mode `0o600` in dirs at `0o700` without thinking about it.
- You want lenient missing-file reads for text/JSON state, while keeping `remove`, `exists`, `open`, `copyIn`, stream writes, and pruning available from the same handle.

For non-private modes or cache/media-style stores, use [`fileStore`](file-store.md). For general root operations, use [`root()`](root.md). For one-off credential reads, use the [secret-file helpers](secret-file.md).

## API

```ts
type PrivateStateStoreOptions = {
  rootDir: string;
};

type PrivateStateStore = Omit<FileStore, "readText" | "readJson" | "writeText" | "writeJson"> & {
  readText(relativePath: string, options?: { maxBytes?: number }): Promise<string | null>;
  readJson<T = unknown>(relativePath: string, options?: { maxBytes?: number }): Promise<T | null>;

  writeText(relativePath: string, content: string | Uint8Array): Promise<string>;
  writeJson(relativePath: string, value: unknown, options?: { trailingNewline?: boolean }): Promise<string>;
};

function privateStateStore(options: PrivateStateStoreOptions): PrivateStateStore;
```

`store.path(rel)` returns the absolute path the store would use, useful for logging or for handing to other libraries that take absolute paths.

`readText` and `readJson` return `null` when the file is missing — lenient by design. Other inherited store methods keep the stricter `fileStore` behavior. Callers that want strict failure on missing should check the result and throw.

## Advanced standalone helpers

The standalone function form lives in `@openclaw/fs-safe/advanced`. Use it when you don't want to pin a single root:

```ts
import {
  writePrivateTextAtomic,        // async
  writePrivateTextAtomicSync,    // sync
  writePrivateJsonAtomic,        // async
  writePrivateJsonAtomicSync,    // sync
  readPrivateText,               // async
  readPrivateTextSync,           // sync
  readPrivateJson,               // async
  readPrivateJsonSync,           // sync
} from "@openclaw/fs-safe/advanced";
```

Each standalone takes `{ rootDir, filePath, ... }` directly:

```ts
await writePrivateJsonAtomic({
  rootDir: "/var/lib/app",
  filePath: "/var/lib/app/state.json",
  value: state,
  trailingNewline: true,
});
```

`filePath` is an absolute path. The helper asserts it stays inside `rootDir` and refuses anything that would escape.

## Examples

### Read-modify-write

```ts
const store = privateStateStore({ rootDir: "/var/lib/app" });

const state = (await store.readJson<State>("state.json")) ?? initialState();
state.count += 1;
await store.writeJson("state.json", state, { trailingNewline: true });
```

### Sync at boot

```ts
import { readPrivateJsonSync } from "@openclaw/fs-safe/advanced";

const config =
  readPrivateJsonSync({ rootDir: "/etc/app", filePath: "/etc/app/config.json" }) ??
  defaultConfig();
applyConfig(config);
```

### Bounded reads

```ts
const config = await store.readJson<Config>("config.json", { maxBytes: 64 * 1024 });
if (!config) throw new Error("config missing");
```

`maxBytes` is forwarded into the read; oversized files throw `too-large` from the underlying [`Root`](root.md).

## Behavior notes

- **Mode bits.** Writes always end at file mode `0o600` and create parent directories at `0o700`. The store does not narrow modes on existing wider parents — it sets the mode at creation only. Audit existing trees yourself.
- **Hardlinks.** Reads refuse files with `nlink > 1` (defense-in-depth, since the file might alias an out-of-tree inode).
- **Symlinks.** Refused everywhere along the resolved path.
- **Sync writes.** The standalone `*Sync` writers are appropriate for boot paths or test fixtures. They use the same atomic-rename mechanism as the async variant.

## Difference from `Root`

| `privateStateStore` | `Root` |
|---|---|
| Reads return `null` on miss. | Reads throw with code `not-found`. |
| Four verbs (text in/out, JSON in/out). | Full surface (move, remove, list, …). |
| Writes always set 0600 on the file and 0700 on the parents. | Writes use the umask unless you override. |
| No streaming. | `open()` returns a `FileHandle`. |

If you find yourself asking for a root-level operation the store does not expose, call `store.root()` or use `root()` directly.

## See also

- [`root()`](root.md) — full method-style boundary.
- [Secret files](secret-file.md) — standalone read/write of mode-0600 credential files.
- [JSON files](json.md) — strict/lenient JSON helpers without per-store fanout.
- [Atomic writes](atomic.md) — what these writes use under the hood.
