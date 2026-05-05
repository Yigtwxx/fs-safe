# Private file store

`privateFileStore(rootDir)` returns a small handle for reading and writing **JSON or text** files inside a trusted root directory. Every write atomically creates the parent directory tree at mode `0o700` and the file at mode `0o600` — the no-frills sibling of [`secret-file`](secret-file.md) when you want a per-root handle.

```ts
import { privateFileStore } from "@openclaw/fs-safe";

const store = privateFileStore("/var/lib/app");

await store.writeJson("state.json", state);
const loaded = await store.readJson<State>("state.json");
```

## When to reach for it

- You have a single trusted directory holding small JSON or text state.
- You want every write to land at mode `0o600` in dirs at `0o700` without thinking about it.
- You don't need `move`, `remove`, `list`, `copyIn`, or streaming — only read/write.

For richer needs (move, list, atomic directory swap, archives), use [`root()`](root.md). For one-off credential reads, use the standalone [secret-file helpers](secret-file.md).

## API

```ts
type PrivateFileStore = {
  rootDir: string;
  path(relativePath: string): string;

  readText(relativePath: string, options?: { maxBytes?: number }): Promise<string | null>;
  readJson<T = unknown>(relativePath: string, options?: { maxBytes?: number }): Promise<T | null>;

  writeText(relativePath: string, content: string | Uint8Array): Promise<void>;
  writeJson(relativePath: string, value: unknown, options?: { trailingNewline?: boolean }): Promise<void>;
};

function privateFileStore(rootDir: string): PrivateFileStore;
```

`store.path(rel)` returns the absolute path the store would use, useful for logging or for handing to other libraries that take absolute paths.

`readText` and `readJson` return `null` when the file is missing — lenient by design. Callers that want strict failure on missing should check the result and throw.

## Standalone helpers

Every operation is also exposed as a standalone function. Useful when you don't want to pin a single root:

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
} from "@openclaw/fs-safe";
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
const store = privateFileStore("/var/lib/app");

const state = (await store.readJson<State>("state.json")) ?? initialState();
state.count += 1;
await store.writeJson("state.json", state, { trailingNewline: true });
```

### Sync at boot

```ts
import { readPrivateJsonSync } from "@openclaw/fs-safe";

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

| `privateFileStore` | `Root` |
|---|---|
| Reads return `null` on miss. | Reads throw with code `not-found`. |
| Four verbs (text in/out, JSON in/out). | Full surface (move, remove, list, …). |
| Writes always set 0600 on the file and 0700 on the parents. | Writes use the umask unless you override. |
| No streaming. | `open()` returns a `FileHandle`. |

If you find yourself asking "does the store have an X?" — reach for `root()`.

## See also

- [`root()`](root.md) — full method-style boundary.
- [Secret files](secret-file.md) — standalone read/write of mode-0600 credential files.
- [JSON files](json.md) — strict/lenient JSON helpers without per-store fanout.
- [Atomic writes](atomic.md) — what these writes use under the hood.
