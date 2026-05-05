# @openclaw/fs-safe

Race-resistant root-bounded filesystem primitives for Node.js.

The package is for code that must operate on caller-controlled paths without letting symlinks,
`..` traversal, hardlinks, path aliases, or rename races escape a configured root.

## Motivation

Most Node filesystem helpers make path handling convenient, but they do not give you a reusable
security boundary. A check like `path.resolve(root, input).startsWith(root)` only validates a string
snapshot. It does not pin the opened file, defend against symlink swaps between check and use, reject
hardlinked aliases, or verify that a write still landed on the intended file after a rename.

OpenClaw has many places where an agent, plugin, archive, upload, or config file can supply a path.
Each call site used to carry its own mix of "within root" checks, temp-file conventions, JSON helpers,
archive extraction limits, and symlink policy. That made the product harder to audit: small differences
in helper behavior mattered, and fixing one surface did not automatically improve the others.

`@openclaw/fs-safe` packages those patterns as one small set of primitives:

- define a trusted root once with `root()`, then use relative paths for reads, writes, moves, copies,
  directory creation, and removal
- choose explicit policies for hardlinks and symlinks instead of threading boolean flags through every
  call site
- use pinned/opened file identity checks where Node exposes enough platform support
- use sibling-temp and atomic-replace helpers for writes that should not leave partially written files
- extract archives with entry-count and byte limits, traversal checks, and symlink-safe staging

This is not a full sandbox and it does not replace OS permissions, containers, or process isolation.
It is a library-level guardrail for the common case where trusted application code must safely touch
untrusted paths inside a directory it owns.

## Install

```sh
pnpm add @openclaw/fs-safe
```

## API

```ts
import { openRootFile, openPinnedFileSync, safeFileURLToPath, root } from "@openclaw/fs-safe";

const fs = await root("/safe/workspace", {
  hardlinks: "reject",
  nonBlockingRead: true,
  mkdir: true,
});

await fs.write("notes/today.txt", "hello\n");
await fs.create("notes/README.md", "seed\n");
const text = await fs.readText("notes/today.txt");
const config = await fs.readJson("config.json");
await fs.copyFrom("/tmp/upload.png", "uploads/upload.png");
await fs.move("notes/today.txt", "notes/archive/today.txt");
```

Use `read()` and `open()` when you need metadata or a `FileHandle`:

```ts
const { buffer, realPath, stat } = await fs.read("notes/today.txt");
const opened = await fs.open("notes/today.txt");
```

Lower-level primitives are available from named subpaths:

```ts
import { root } from "@openclaw/fs-safe/root";
import { isPathInside } from "@openclaw/fs-safe/path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { pathExists } from "@openclaw/fs-safe/fs";
import { readJsonFile, readJsonFileStrict, writeJsonAtomic } from "@openclaw/fs-safe/json";
import { replaceFileAtomic, movePathWithCopyFallback } from "@openclaw/fs-safe/atomic";
import { createPrivateTempWorkspace, createTempFileTarget } from "@openclaw/fs-safe/temp";
import { extractArchive } from "@openclaw/fs-safe/archive";
```

`readJsonFile()` returns `null` when the file cannot be read or parsed.
`readJsonFileStrict()` throws read and parse errors.

Archive extraction keeps ZIP/TAR handling behind one API and exposes lower-level preflight helpers for
callers that need to enforce the same limits before doing custom work:

```ts
import { extractArchive, resolveArchiveKind } from "@openclaw/fs-safe/archive";

const kind = resolveArchiveKind(uploadPath);
if (!kind) {
  throw new Error(`unsupported archive: ${uploadPath}`);
}
await extractArchive({
  archivePath: uploadPath,
  destDir: "/safe/workspace/plugin",
  kind,
  timeoutMs: 15_000,
  limits: {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxEntries: 50_000,
  },
});
```

`replaceFileAtomic()` and `replaceFileAtomicSync()` write a sibling temp file and
then replace the destination. They support rename retry/fallback behavior,
existing-mode preservation, optional temp-file and parent-directory fsync,
injected filesystem ops for tests, and a `beforeRename` hook for backup/observer
workflows. `writeSiblingTempFile()` covers stream/download producers that need
to decide the final sibling path after writing a temp file.

```ts
import { pathScope } from "@openclaw/fs-safe";

const uploads = pathScope("/safe/uploads", { label: "uploads directory" });
const files = await uploads.files(["photo.jpg"]);
const target = await uploads.writable("report.pdf");
```

## Safety Model

- root-bounded APIs resolve paths against a configured root and reject canonical escapes
- reads open with `O_NOFOLLOW` where available and verify fd/path identity before returning
- writes use pinned parent-directory helpers and atomic replacement on POSIX, with verified post-write identity
- remove and mkdir use fd-relative Python syscalls on POSIX, with legacy fallback when the helper cannot spawn
- archive extraction rejects traversal paths and blocked link types, enforces entry and byte budgets,
  and merges through the same safe-open boundary checks used by direct writes
- optional internal subpath exports expose pinned helper modules used by OpenClaw tests

## Design Notes

The public surface is intentionally organized by job, not by implementation detail:

- `root()` and `SafeRoot` are the preferred API for application code
- `/path` exposes canonical path checks and scoped path helpers
- `/json`, `/atomic`, `/temp`, and `/archive` expose focused building blocks for code that already has
  a trusted absolute path
- `/fs` exposes small generic filesystem predicates such as `pathExists()`
- `/errors` provides the canonical `FsSafeError` type for downstream `instanceof` checks
- `/internal/*` is exported only for OpenClaw helper-process shims and tests; treat it as a reserved,
  unsupported surface

When two helpers have different failure semantics, the name says so. For example, `readJsonFile()`
returns `null` on missing or invalid JSON for legacy state files, while `readJsonFileStrict()` throws
for install manifests and other inputs where parse failure should stop the operation.
`pathExists()` follows `fs.stat()` semantics, so broken symlinks return false.

## Limitations

- Windows support uses the safest Node-level behavior available, but some fd-relative POSIX hardening is
  unavailable there.
- Hardlink rejection depends on platform metadata and should be treated as a defense-in-depth policy,
  not an authorization model.
- The package does not sanitize file contents or validate archive payload semantics beyond filesystem
  safety constraints.
