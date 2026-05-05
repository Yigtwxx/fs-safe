# @openclaw/fs-safe

Race-resistant root-bounded filesystem primitives for Node.js.

Use this when trusted application code has to touch caller-controlled paths inside a directory it owns. The package gives you one `root()` boundary that survives symlink swaps, `..` traversal, hardlink aliases, and TOCTOU rename races between check and use.

## Why

`path.resolve(root, input).startsWith(root)` validates a string. It does not pin the file you opened, defend against a symlink retarget between check and use, reject hardlinked aliases, or verify that a write landed where you intended after a rename. `fs-safe` does those things, packaged so every call site picks up the same defense without re-implementing it.

This is a library-level guardrail, not OS-level isolation. It does not replace containers, seccomp, or filesystem permissions — it is for code that already runs with the privileges of its workspace and wants to stop trivial path tricks from escaping it.

## Install

```sh
pnpm add @openclaw/fs-safe
```

Node 20.11 or newer. No runtime npm dependencies.

## Quick start

```ts
import { root } from "@openclaw/fs-safe";

const fs = await root("/safe/workspace", {
  hardlinks: "reject",
  symlinks: "reject",
  mkdir: true,
});

await fs.write("notes/today.txt", "hello\n");
const text = await fs.readText("notes/today.txt");
const config = await fs.readJson("config.json");
await fs.copyIn("uploads/upload.png", "/tmp/upload.png");
await fs.move("notes/today.txt", "notes/archive/today.txt", { overwrite: true });
await fs.remove("notes/archive/today.txt");
```

`root()` takes the trusted directory; relative paths in subsequent calls are resolved against it. Defaults you pass to `root()` apply to every call below; per-call options override them.

When you need metadata or a `FileHandle`:

```ts
const { buffer, realPath, stat } = await fs.read("notes/today.txt");
const opened = await fs.open("notes/today.txt");
```

`create()` is the don't-clobber variant of `write()` and throws `already-exists` when the target already exists:

```ts
await fs.create("notes/README.md", "seed\n"); // throws if it already exists
```

`move()` also defaults to no clobber. Pass `{ overwrite: true }` when replacing the target is intended.

## Reading

Pick the narrowest read shape that gives you what you need:

```ts
await fs.readJson("config.json"); // parsed value; validate it at your boundary
await fs.readText("notes/today.txt");
await fs.readBytes("image.png");
await fs.read("notes/today.txt"); // { buffer, realPath, stat }
const opened = await fs.open("large.log"); // FileHandle for streaming
```

For streams, use `open()` and the returned `FileHandle`:

```ts
const opened = await fs.open("large.log");
try {
  const stream = opened.handle.createReadStream();
  // consume stream
} finally {
  await opened.handle.close();
}
```

`reader()` returns a callback that reads absolute or relative paths through the same root boundary. It is useful for APIs that accept a `(path) => Promise<Buffer>` loader. `readPath()` has the same absolute-path behavior directly: an absolute path outside the root is rejected with `outside-workspace`.

`stat()`, `exists()`, and `list()` are boundary-checked, but they cannot pin a later operation to the same filesystem object. Use `read()`, `open()`, `write()`, `create()`, `copyIn()`, `move()`, or `remove()` for operations that must be race-resistant at the point of use.

## Subpaths

The main entry point re-exports the common surface (`root`, `pathScope`, `FsSafeError`, `pathExists`, `extractArchive`, …). Focused subpaths are useful when you want a leaner import or to depend on a narrower contract.

| Subpath | Contents |
|---|---|
| `@openclaw/fs-safe/root` | `root()`, `Root`, `RootDefaults`, related types |
| `@openclaw/fs-safe/path` | canonical path checks: `isPathInside`, `safeRealpathSync`, `isNotFoundPathError`, `isSymlinkOpenError` |
| `@openclaw/fs-safe/json` | `readJsonFile`, `readJsonFileStrict`, `writeJsonAtomic`, `writeTextAtomic` |
| `@openclaw/fs-safe/regular-file` | `readRegularFile`, `appendRegularFile`, `appendRegularFileSync`, regular-file stat helpers |
| `@openclaw/fs-safe/atomic` | `replaceFileAtomic`, `replaceDirectoryStaged`, `movePathWithCopyFallback` |
| `@openclaw/fs-safe/temp` | `createPrivateTempWorkspace`, `createTempFileTarget`, `writeSiblingTempFile`, `resolveSecureTempRoot` |
| `@openclaw/fs-safe/archive` | `extractArchive`, `resolveArchiveKind`, `ArchiveLimitError`, preflight helpers |
| `@openclaw/fs-safe/fs` | `pathExists`, `pathExistsSync` |
| `@openclaw/fs-safe/timing` | `withTimeout` |
| `@openclaw/fs-safe/errors` | `FsSafeError`, `FsSafeErrorCode` |
| `@openclaw/fs-safe/types` | shared types: `DirEntry`, `PathStat`, … |
| `@openclaw/fs-safe/test-hooks` | hooks the test suite uses to inject races; only active under `NODE_ENV=test` |

## Failure semantics in the name

When two helpers behave differently on the same input, the difference is in the name, not the docs.

```ts
import { readJsonFile, readJsonFileStrict } from "@openclaw/fs-safe/json";

await readJsonFile("./config.json");        // returns null on missing or invalid
await readJsonFileStrict("./manifest.json"); // throws on missing or invalid
```

```ts
import { pathExists } from "@openclaw/fs-safe/fs";

await pathExists("/safe/workspace/link"); // follows fs.stat() — broken symlinks return false
```

## Atomic writes

`replaceFileAtomic()` writes a sibling temp file, optionally fsyncs it, and renames it over the destination. Mode preservation, rename retry / copy fallback on `EPERM`, parent-directory fsync, and a `beforeRename` hook for backup or observer flows are all opt-in.

```ts
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";

await replaceFileAtomic({
  filePath: "/safe/workspace/state.json",
  content: JSON.stringify(state, null, 2),
  fileMode: 0o600,
  syncTempFile: true,
  syncParentDir: true,
});
```

`replaceFileAtomicSync()` covers the synchronous case with the same options shape. Both accept an injectable `fileSystem` for tests.

## Archive extraction

`extractArchive()` handles ZIP and TAR behind one API, with traversal checks, blocked-link-type rejection, and entry-count and byte budgets.

```ts
import { extractArchive, resolveArchiveKind } from "@openclaw/fs-safe/archive";

const kind = resolveArchiveKind(uploadPath);
if (!kind) throw new Error(`unsupported archive: ${uploadPath}`);

await extractArchive({
  archivePath: uploadPath,
  destDir: "/safe/workspace/plugin",
  kind,
  timeoutMs: 15_000,
  limits: {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxEntries: 50_000,
    maxExtractedBytes: 512 * 1024 * 1024,
    maxEntryBytes: 256 * 1024 * 1024,
  },
});
```

Extraction stages into a private directory and merges through the same safe-open boundary used by direct writes, so a symlinked entry can't trick the merge into following an out-of-tree path.

## Path scopes

For code that already has a trusted absolute path and wants the same boundary semantics without going through `root()`:

```ts
import { pathScope } from "@openclaw/fs-safe";

const uploads = pathScope("/safe/uploads", { label: "uploads directory" });
const files = await uploads.files(["photo.jpg"]);
const target = await uploads.writable("report.pdf");
```

## Errors

Every failure surfaces as an `FsSafeError` with a closed `code` union you can branch on:

```ts
import { FsSafeError } from "@openclaw/fs-safe/errors";

try {
  await fs.write("../escape.txt", "x");
} catch (err) {
  if (err instanceof FsSafeError && err.code === "outside-workspace") {
    // handle
  }
  throw err;
}
```

Codes include `outside-workspace`, `path-mismatch`, `path-alias`, `hardlink`, `symlink`, `not-file`, `not-found`, `not-empty`, `not-removable`, `too-large`, `helper-failed`, `helper-unavailable`, `unsupported-platform`, `already-exists`, and `invalid-path`.

## Safety model

- root-bounded APIs resolve paths against a configured root and reject canonical escapes
- reads open with `O_NOFOLLOW` where available, then verify fd identity matches the path identity before returning the buffer or handle
- writes use pinned parent-directory helpers and atomic replacement on POSIX, with verified post-write identity
- `remove` and `mkdir` use fd-relative syscalls on POSIX through a small Python helper, with a Node fallback when the helper cannot spawn
- archive extraction stages into a private directory and merges through the same boundary checks used by direct writes

## Limitations

- Windows uses the safest Node-level behavior available; some fd-relative POSIX hardening is unavailable there.
- Hardlink rejection depends on platform metadata. Treat it as defense-in-depth, not authorization.
- `fs-safe` does not validate file contents or archive payload semantics beyond filesystem safety constraints. Schemas, signatures, and authorization belong in the layer above.

## License

MIT.
