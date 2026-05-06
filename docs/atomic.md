# Atomic writes

`@openclaw/fs-safe/atomic` re-exports the lower-level helpers that `root()`'s write methods are built on. Reach for them when you have an absolute path you trust and want sibling-temp + rename without setting up a `Root`, or when you need finer control over `fsync`, mode preservation, or pre-rename hooks.

```ts
import {
  replaceFileAtomic,
  replaceFileAtomicSync,
  writeTextAtomic,
  replaceDirectoryAtomic,
  movePathWithCopyFallback,
} from "@openclaw/fs-safe/atomic";
```

## `replaceFileAtomic` / `replaceFileAtomicSync`

Write `content` to a sibling temp file in the destination directory, optionally `fsync` the temp file, optionally `fsync` the parent directory after rename, then atomically rename over the destination.

Async replacements to the same destination are serialized inside the current process, so two overlapping `replaceFileAtomic()` calls do not interleave their temp-write/rename phases. Use a sidecar lock when multiple processes may write the same target.

```ts
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";

await replaceFileAtomic({
  filePath: "/srv/workspace/state.json",
  content: JSON.stringify(state, null, 2),
  mode: 0o600,
  syncTempFile: true,
  syncParentDir: true,
});
```

### Options

```ts
type ReplaceFileAtomicOptions = {
  filePath: string;                 // destination
  content: string | Uint8Array;
  dirMode?: number;                 // mode for parent dirs created by the helper
  mode?: number;                    // explicit mode for the new file (e.g. 0o600)
  preserveExistingMode?: boolean;   // copy mode from existing destination, when present
  tempPrefix?: string;
  renameMaxRetries?: number;
  renameRetryBaseDelayMs?: number;
  copyFallbackOnPermissionError?: boolean;
  syncTempFile?: boolean;           // fsync(temp) before rename
  syncParentDir?: boolean;          // fsync(parent) after rename (POSIX only)
  beforeRename?: (params: { filePath: string; tempPath: string }) => Promise<void>;
  fileSystem?: ReplaceFileAtomicFileSystem; // injectable fs for tests
};
```

### `beforeRename`

Runs after the temp file is fully written and before the rename. Use it to take a backup snapshot, capture the about-to-be-replaced contents, or notify an observer:

```ts
await replaceFileAtomic({
  filePath: "/srv/workspace/config.toml",
  content: rendered,
  beforeRename: async ({ filePath }) => {
    await fs.copyFile(filePath, `${filePath}.bak`); // snapshot existing
  },
});
```

If `beforeRename` throws, the rename is skipped and the temp file is removed — the destination is unchanged.

### `EPERM` and copy fallback

On systems where `rename` fails with `EPERM`/`EEXIST`, pass
`copyFallbackOnPermissionError: true` to fall back to a non-atomic copy
replacement. The fallback removes the old destination, opens the replacement
with exclusive/no-follow flags where the platform supports them, and refuses
known symlink destinations so it does not write through a replaced destination
link.

### Sync variant

`replaceFileAtomicSync` accepts the same options shape, with the obvious removal of the async-only hooks. Use it inside synchronous boot paths or test setup code.

## `replaceDirectoryAtomic`

Atomically swap one directory's contents with another, using a temporary backup during the swap.

```ts
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await replaceDirectoryAtomic({
  stagedDir: "/srv/workspace/staging/snapshot-2026-05-05",
  targetDir: "/srv/workspace/snapshot",
});
```

The helper renames `targetDir` to a generated backup path, renames `stagedDir → targetDir`, then removes the backup. If the second rename fails, it tries to restore the original target before rethrowing.

Use it when callers must see a whole staged tree at the target path. For single-file replacement, `replaceFileAtomic` is the right tool.

## `writeTextAtomic`

Atomic UTF-8 text write with the same secure defaults as `writeJson`: sibling
temp file, temp fsync, rename, parent fsync, and final chmod best-effort.
It delegates to `replaceFileAtomic()` with a smaller call shape. Use it when
you do not need replacement hooks such as `beforeRename`, `preserveExistingMode`,
or custom copy-fallback policy.

```ts
import { writeTextAtomic } from "@openclaw/fs-safe/atomic";

await writeTextAtomic("/srv/workspace/rendered.md", rendered, {
  mode: 0o600,
  dirMode: 0o700,
  trailingNewline: true,
});
```

Options:

```ts
type WriteTextAtomicOptions = {
  mode?: number;             // file mode (default 0o600)
  dirMode?: number;          // mode for parent dirs created on demand
  trailingNewline?: boolean; // append "\n" if missing
  durable?: boolean;         // default true; false skips temp/parent fsync
};
```

`durable: false` keeps the sibling-temp replace/rename behavior but skips the
temp-file and parent-directory `fsync` calls. Use it only for reconstructible
metadata where lower latency matters more than crash-durability.

## `movePathWithCopyFallback`

Rename a path. If the rename fails with `EXDEV` (cross-device), fall back to
copying into a staged sibling path, renaming that staged path into place, and
then removing only the source entries that were copied. The fallback avoids
buffering regular files into memory and does not tighten the destination parent
directory mode.

```ts
import { movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";

await movePathWithCopyFallback({
  from: "/srv/cache/blob.bin",
  sourceHardlinks: "reject",
  to: "/srv/persistent/blob.bin",
});
```

Use it when source and destination might live on different filesystems (containers, tmpfs, separate volumes).
If another writer changes source entries during the fallback, the staged copy
throws `ESTALE` before commit when possible. If the destination has already
been committed, cleanup still preserves the changed source entries and throws
`ESTALE`.

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
    promises: {
      ...realFs,
      writeFile: async (...args) => { ops.push("write"); return realFs.writeFile(...args); },
      rename: async (...args) => { ops.push("rename"); return realFs.rename(...args); },
    },
  },
});
```

## See also

- [`root()`](root.md) — when you want method-style writes with the boundary baked in.
- [JSON files](json.md) — JSON/text helpers built on sibling-temp replacement.
- [Temp workspaces](temp.md) — for staging-then-swap directory builds.
- [Errors](errors.md) — code union for failures.
