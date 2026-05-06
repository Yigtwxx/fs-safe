---
title: Store
description: "Overview of @openclaw/fs-safe/store: fileStore, fileStoreSync, and jsonStore."
---

# `@openclaw/fs-safe/store`

The `store` subpath bundles two managed wrappers around the same safe-write primitives `root()` uses:

```ts
import {
  fileStore,
  fileStoreSync,
  jsonStore,
  type FileStore,
  type FileStoreOptions,
  type FileStoreSync,
  type JsonStore,
  type JsonStoreOptions,
} from "@openclaw/fs-safe/store";
```

| Helper | Use it for |
|---|---|
| [`fileStore()`](file-store.md) | Multi-file directories with safe relative paths, size limits, atomic replacement, stream writes, copy-in, and TTL-based pruning. |
| `fileStoreSync()` | Synchronous variant of `fileStore()` for places that genuinely cannot await. |
| [`jsonStore()`](json-store.md) | A single keyed JSON state file with explicit fallback, atomic writes, and optional sidecar locking around read-modify-write updates. |
| [Private file-store mode](private-file-store.md) | `fileStore({ private: true })` for credentials, tokens, and per-agent state at `0600` files under `0700` directories. |

`fileStore().json("rel.json")` and `jsonStore({ filePath })` are intentionally separate primitives. Use `fileStore().json(...)` when JSON state lives alongside other files in the same managed directory; use `jsonStore({ filePath })` when you have a single absolute path and want the keyed JSON shape directly.

## Picking a shape

- **Multi-file directory under one root** — reach for `fileStore()`. It exposes `write`, `writeJson`, `writeText`, `writeStream`, `read*`, `open`, `copyIn`, `remove`, and `pruneExpired` against safe relative paths.
- **One JSON state file** — reach for `jsonStore({ filePath })`. Its `update()` and `updateOr()` methods cover the merge-into-defaults and read-modify-write cases.
- **Credentials or tokens** — pass `private: true` to `fileStore()`. Same store shape; writes route through the secret-file atomic path with `0600`/`0700` permissions.

## Related pages

- [`fileStore`](file-store.md) — full API for the multi-file store.
- [`jsonStore`](json-store.md) — single-file JSON store with locking.
- [Private file-store mode](private-file-store.md) — credential-shaped variant.
- [JSON files](json.md) — lower-level `readJson` / `writeJson` helpers.
- [Atomic writes](atomic.md) — what `fileStore` and `jsonStore` use under the hood.
