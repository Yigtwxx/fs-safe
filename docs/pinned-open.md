# Pinned open

`openPinnedFileSync()` is a low-level synchronous file open that re-pins identity after the open: it `open`s with `O_NOFOLLOW`, then `fstat`s and verifies the result matches what the path resolves to. It is the building block under `Root.open()` and a few of the other primitives — exposed for callers that want the same defense without going through `root()`.

```ts
import { openPinnedFileSync } from "@openclaw/fs-safe/pinned-open";
```

## Why a separate primitive

`fs.openSync` plus `fs.statSync` plus `fs.realpathSync` is three syscalls and a swap window. `openPinnedFileSync` performs them in one helper that:

1. Opens with `O_NOFOLLOW` (where the platform supports it).
2. `fstat`s the open fd.
3. Compares the fd's identity to the resolved path's identity.
4. Returns a typed result: `ok` plus the `fd`, or `not-ok` with a `reason`.

If you're already using `root().open()`, you don't need this — but if you're building a new helper that needs a synchronous pinned open, this is the foundation.

## Signature

```ts
type PinnedOpenSyncFailureReason = "path" | "validation" | "io";
type PinnedOpenSyncAllowedType = "file" | "directory";

type PinnedOpenSyncResult =
  | { ok: true; fd: number; stat: Stats }
  | { ok: false; reason: PinnedOpenSyncFailureReason; cause?: unknown };

function openPinnedFileSync(params: {
  rootDir: string;                              // canonical root absolute path
  filePath: string;                             // absolute target path
  fs?: PinnedOpenSyncFs;                        // injectable for tests
  allowedType?: PinnedOpenSyncAllowedType;      // default "file"
  flags?: number;                               // default O_RDONLY | O_NOFOLLOW
}): PinnedOpenSyncResult;
```

`PinnedOpenSyncFs` is a small subset of `node:fs`:

```ts
type PinnedOpenSyncFs = Pick<
  typeof fs,
  "openSync" | "fstatSync" | "closeSync" | "realpathSync" | "lstatSync"
>;
```

## Reasons for failure

- `"path"` — the resolved path does not stay inside `rootDir`, contains a symlink, or otherwise fails the lexical/canonical check.
- `"validation"` — the open succeeded but `fstat` does not match the path's identity (TOCTOU race), the file is not the allowed type, or it has unexpected `nlink`.
- `"io"` — the underlying `openSync` threw. Inspect `cause` for the original `NodeJS.ErrnoException`.

The caller is responsible for closing the `fd` on success:

```ts
import fs from "node:fs";
import { openPinnedFileSync } from "@openclaw/fs-safe/pinned-open";

const r = openPinnedFileSync({
  rootDir: "/srv/workspace",
  filePath: "/srv/workspace/state.json",
});

if (!r.ok) {
  if (r.reason === "io") throw new Error("io error", { cause: r.cause });
  throw new Error(`pinned open refused: ${r.reason}`);
}

try {
  const buf = Buffer.alloc(r.stat.size);
  fs.readSync(r.fd, buf, 0, buf.length, 0);
  // ...
} finally {
  fs.closeSync(r.fd);
}
```

## Allowed type

By default the helper requires the result to be a regular file. Pass `allowedType: "directory"` when you want to pin-open a directory (for `fdopendir`-style use). Any other type triggers `"validation"`.

## Test injection

The optional `fs` field accepts a partial `node:fs` interface. Use it in unit tests to simulate a TOCTOU swap or a denied open:

```ts
import { openPinnedFileSync } from "@openclaw/fs-safe/pinned-open";

const fakeFs = {
  ...fs,
  openSync: () => fakeFd,
  fstatSync: () => ({ ...realStat, ino: differentIno } as Stats),
  closeSync: () => {},
  realpathSync: () => filePath,
  lstatSync: () => realStat,
};
const r = openPinnedFileSync({ rootDir, filePath, fs: fakeFs });
expect(r.ok).toBe(false);
expect(r.reason).toBe("validation");
```

## Companions

The same module exports a higher-level helper used by the rest of the library:

```ts
import {
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  openRootFile,
  openRootFileSync,
} from "@openclaw/fs-safe/root-file";
```

- `openRootFileSync(params)` — `openPinnedFileSync` plus a richer result that distinguishes `"validation"` failures by sub-reason.
- `openRootFile(params)` — async variant, accepts a `signal: AbortSignal` for cancellation.
- `canUseRootFileOpen(io)` — checks whether the platform supports `O_NOFOLLOW`. Useful for falling back when the real defense is unavailable.
- `matchRootFileOpenFailure(failure, handlers)` — exhaustive switch helper for branching on the failure reason.

## See also

- [`root()`](root.md) — the high-level wrapper most callers want.
- [Reading](reading.md) — read pipeline that uses `openPinnedFileSync` internally.
- [Path helpers](path.md) — the lexical building blocks (`isPathInside`, `safeRealpathSync`).
