# Atomic writes

`@openclaw/fs-safe/atomic` re-exports the lower-level helpers that `root()`'s write methods are built on. Reach for them when you have an absolute path you trust and want sibling-temp + rename without setting up a `Root`, or when you need finer control over `fsync`, mode preservation, or pre-rename hooks.

```ts
import {
  replaceFileAtomic,
  replaceFileAtomicSync,
  replaceDirectoryStaged,
  movePathWithCopyFallback,
} from "@openclaw/fs-safe/atomic";
```

## `replaceFileAtomic` / `replaceFileAtomicSync`

Write `content` to a sibling temp file in the destination directory, optionally `fsync` the temp file, optionally `fsync` the parent directory after rename, then atomically rename over the destination.

```ts
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";

await replaceFileAtomic({
  filePath: "/srv/workspace/state.json",
  content: JSON.stringify(state, null, 2),
  fileMode: 0o600,
  syncTempFile: true,
  syncParentDir: true,
});
```

### Options

```ts
type ReplaceFileAtomicOptions = {
  filePath: string;                 // destination
  content: string | Buffer;
  encoding?: BufferEncoding;        // applied when content is a string; default utf8
  fileMode?: number;                // explicit mode for the new file (e.g. 0o600)
  preserveMode?: boolean;           // copy mode from existing destination, when present
  syncTempFile?: boolean;           // fsync(temp) before rename
  syncParentDir?: boolean;          // fsync(parent) after rename (POSIX only)
  beforeRename?: (tempPath: string) => Promise<void> | void;
  fileSystem?: ReplaceFileAtomicFileSystem; // injectable fs for tests
};
```

### `beforeRename`

Runs after the temp file is fully written and before the rename. Use it to take a backup snapshot, capture the about-to-be-replaced contents, or notify an observer:

```ts
await replaceFileAtomic({
  filePath: "/srv/workspace/config.toml",
  content: rendered,
  beforeRename: async (tempPath) => {
    await fs.copyFile(filePath, `${filePath}.bak`); // snapshot existing
  },
});
```

If `beforeRename` throws, the rename is skipped and the temp file is removed — the destination is unchanged.

### `EPERM` and copy fallback

On systems where `rename` across mount boundaries (or under restrictive permissions) fails with `EPERM`, the helper falls back to a copy + unlink + close sequence that preserves atomicity at the destination. You don't have to do anything to opt in.

### Sync variant

`replaceFileAtomicSync` accepts the same options shape, with the obvious removal of the async-only hooks. Use it inside synchronous boot paths or test setup code.

## `replaceDirectoryStaged`

Atomically swap one directory's *contents* with another, with the previous contents preserved at a backup path on success.

```ts
import { replaceDirectoryStaged } from "@openclaw/fs-safe/atomic";

await replaceDirectoryStaged({
  sourceDir: "/srv/workspace/staging/snapshot-2026-05-05",
  targetDir: "/srv/workspace/snapshot",
  backupDir: "/srv/workspace/snapshot.prev",
});
```

The helper renames `targetDir → backupDir`, then `sourceDir → targetDir`. On failure mid-swap it tries to restore the backup. The end state is one of:

- `targetDir` holds the new tree, `backupDir` holds the old tree (success).
- `targetDir` holds the old tree, `backupDir` is gone (rename failed before the second step).
- Either both exist (after a failed restore) or `targetDir` is missing (rare, hard-failure case) — both are surfaced as `FsSafeError`.

Use it when callers must see *the whole new tree or none of it*. For single-file replacement, `replaceFileAtomic` is the right tool.

## `movePathWithCopyFallback`

Rename a path. If the rename fails with `EXDEV` (cross-device) or `EPERM`, fall back to copy + remove. Preserves atomicity at the destination by writing the copy through `replaceFileAtomic` (for files) or staged-rename (for directories).

```ts
import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";

await movePathWithCopyFallback({
  source: "/srv/cache/blob.bin",
  destination: "/srv/persistent/blob.bin",
  overwrite: true,
});
```

Use it when source and destination might live on different filesystems (containers, tmpfs, separate volumes).

## Difference from `root()`

| `Root` methods | `atomic` helpers |
|---|---|
| Take relative paths, bound to a `rootDir`. | Take absolute paths, no boundary. |
| Throw `FsSafeError` with `code`. | Throw `FsSafeError` *or* the underlying `NodeJS.ErrnoException`, depending on failure point. |
| Atomicity, mode, hooks, fsync are sane defaults. | Caller controls all of the above. |
| `mkdir`, identity check, hardlink reject built in. | No identity check, no hardlink reject — pair with [path helpers](path.md) if you need them. |

Use `Root` when the path is caller-controlled. Use `atomic` when the path is fully under your control and you want explicit knobs.

## Test injection

Both `replaceFileAtomic` and `replaceFileAtomicSync` accept a `fileSystem` option that overrides the small set of `fs` calls they make. Pass a stub in unit tests to assert order, simulate `EPERM`, or capture the temp filename:

```ts
const ops: string[] = [];
await replaceFileAtomic({
  filePath: "/tmp/x",
  content: "hi",
  fileSystem: {
    ...realFs,
    writeFile: async (...args) => { ops.push("write"); return realFs.writeFile(...args); },
    rename: async (...args) => { ops.push("rename"); return realFs.rename(...args); },
  },
});
```

## See also

- [`root()`](root.md) — when you want method-style writes with the boundary baked in.
- [JSON files](json.md) — `writeJsonAtomic` is `replaceFileAtomic` with `JSON.stringify`.
- [Temp workspaces](temp.md) — for staging-then-swap directory builds.
- [Errors](errors.md) — code union for failures.
