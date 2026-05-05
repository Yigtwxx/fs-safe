# File store

`@openclaw/fs-safe/file-store` is a managed wrapper around `root()` for the common "store files under a directory at known modes, prune old ones, hand back absolute paths" pattern. Useful for caches, ingest staging, generated artifacts, anywhere the consumer wants object-style access plus stream and copy primitives.

```ts
import {
  fileStore,
  copyIntoRoot,
  type FileStore,
  type FileStoreOptions,
  type FileStoreWriteOptions,
  type FileStorePruneOptions,
} from "@openclaw/fs-safe/file-store";
```

## When to reach for it

- You want a single directory holding files written by your code, with consistent mode bits and atomic placement.
- You want a `FileStore.write(rel, data)` / `read(rel)` / `pruneExpired(...)` interface.
- You want to feed a stream into the store with a byte cap.
- You don't need the full `Root` surface (move, list, mkdir, …); the store can hand you a real `Root` via `.root()` when you do.

## Factory: `fileStore(options)`

```ts
const cache = fileStore({
  rootDir: "/var/cache/app",
  mode: 0o600,        // file mode for writes (default 0o600)
  dirMode: 0o700,     // mode for parent directories created on demand (default 0o700)
  maxBytes: 64 * 1024 * 1024, // optional: refuse writes/reads larger than this
});
```

Returns a `FileStore`:

```ts
type FileStore = {
  readonly rootDir: string;
  path(relativePath: string): string;
  root(): Promise<Root>;
  write(rel, data: string | Buffer, options?): Promise<string>;
  writeStream(rel, stream: Readable, options?): Promise<string>;
  copyIn(rel, sourcePath: string, options?): Promise<string>;
  open(rel, options?): Promise<OpenResult>;
  read(rel, options?): Promise<ReadResult>;
  readBytes(rel, options?): Promise<Buffer>;
  remove(rel): Promise<void>;
  exists(rel): Promise<boolean>;
  pruneExpired(options: FileStorePruneOptions): Promise<void>;
};
```

`path()` returns the absolute path the store would use, after asserting it stays inside `rootDir`. Useful for logging or for handing to other libraries.

`root()` returns a [`Root`](root.md) handle for the same directory when you need the full surface (move, list, mkdir). It's a fresh handle per call and is safe to call frequently.

## Writes

Every write goes through `writeSiblingTempFile` — temp + rename, mode applied to file and parent dir, both `fsync`'d.

### `write(rel, data, options?)`

```ts
const path = await cache.write("entries/2026/05/05.json", JSON.stringify(entry));
```

Buffer or string. Returns the final absolute path. Throws `too-large` if `data.byteLength` exceeds `maxBytes`.

### `writeStream(rel, stream, options?)`

```ts
import { Readable } from "node:stream";
const path = await cache.writeStream("downloads/blob.bin", Readable.from(remoteFetch));
```

Streams into a sibling temp with a running byte budget. Aborts the source stream with `too-large` if `maxBytes` is exceeded mid-stream — partial writes are cleaned up.

### `copyIn(rel, sourcePath, options?)`

```ts
const path = await cache.copyIn("ingest/upload.bin", "/tmp/upload.bin");
```

One-shot ingest from an absolute source path. Source is checked for symlink/non-regular before copy. Same mode rules as `write`.

### `FileStoreWriteOptions`

Per-call overrides for the store-level defaults:

```ts
type FileStoreWriteOptions = {
  dirMode?: number;
  mode?: number;
  maxBytes?: number;
  tempPrefix?: string;  // override the default "." + basename
};
```

## Reads

`open`, `read`, `readBytes` delegate to a fresh `Root` with `hardlinks: "reject"` and the store's `maxBytes`. Same return shapes as `Root`.

## `remove(rel)` / `exists(rel)`

Forward to the underlying `Root`. `remove` unlinks files and `rmdir`s empty directories; non-empty dirs throw `not-empty`.

## `pruneExpired(options)`

Walk the store and delete files older than `options.ttlMs`:

```ts
await cache.pruneExpired({
  ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  recursive: true,
  pruneEmptyDirs: true,
});
```

Options:

```ts
type FileStorePruneOptions = {
  ttlMs: number;
  recursive?: boolean;       // default false (top-level only)
  maxDepth?: number;         // bound recursion explicitly
  pruneEmptyDirs?: boolean;  // also remove dirs that became empty (only with recursive/maxDepth)
};
```

Symlinks are skipped. The walk is best-effort — failures on individual entries don't abort the whole prune. Compares against `mtimeMs`.

## Standalone: `copyIntoRoot`

The same one-shot copy primitive used by `FileStore.copyIn`, exported separately for callers that don't want to instantiate a store:

```ts
import { copyIntoRoot } from "@openclaw/fs-safe/file-store";

await copyIntoRoot({
  rootDir: "/var/cache/app",
  relativePath: "ingest/upload.bin",
  sourcePath: "/tmp/upload.bin",
  mode: 0o600,
  dirMode: 0o700,
  maxBytes: 32 * 1024 * 1024,
  tempPrefix: ".upload.bin", // optional
});
```

Returns the final absolute path. Throws `not-file` if the source is a symlink or non-regular file; throws `too-large` if it exceeds `maxBytes`.

## Difference from `Root`

| `FileStore` | `Root` |
|---|---|
| Object-style with mode+dirMode baked in. | Method-style boundary; mode is per-call or per-default. |
| `writeStream` with built-in byte budget. | Manual via `openWritable()`. |
| `copyIn` returns the final path. | `copyIn` returns void. |
| `pruneExpired` walks by `mtime`. | No prune helper. |
| Reads delegate via `Root` internally. | The boundary itself. |

If you need richer ops (move, list, append, JSON), call `store.root()` to get a `Root` and use that.

## Common patterns

### Cache with TTL prune

```ts
const cache = fileStore({ rootDir: "/var/cache/app", maxBytes: 16 * 1024 * 1024 });

await cache.writeStream(`${id}.bin`, fetchStream(id));

// Background prune every hour
setInterval(() => cache.pruneExpired({ ttlMs: 24 * 60 * 60 * 1000 }), 60 * 60 * 1000);
```

### Ingest pipeline

```ts
const ingest = fileStore({ rootDir: "/srv/ingest", mode: 0o644 });

for (const upload of uploads) {
  const dest = await ingest.copyIn(`raw/${upload.id}`, upload.tempPath, {
    maxBytes: 200 * 1024 * 1024,
  });
  await enqueueProcess(dest);
}
```

### Drop down to `Root` for moves

```ts
const root = await store.root();
await root.move(`pending/${id}`, `done/${id}`);
```

## See also

- [`root()`](root.md) — the boundary `FileStore` is built on; reach for it when you need move/list/append.
- [JSON store](json-store.md) — the JSON-state-file equivalent of this surface.
- [Atomic writes](atomic.md) — `writeSiblingTempFile` is what every write goes through.
- [Temp workspaces](temp.md) — `TempWorkspace.copyIn` uses `copyIntoRoot`.
