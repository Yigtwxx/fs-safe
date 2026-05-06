# Install

`fs-safe` is published to npm as `@openclaw/fs-safe`. It targets Node 20.11 or newer, ships ESM only, and works on macOS, Linux, and Windows.

## Package managers

```bash
pnpm add @openclaw/fs-safe
```

```bash
npm install @openclaw/fs-safe
```

```bash
yarn add @openclaw/fs-safe
```

```bash
bun add @openclaw/fs-safe
```

## Node version

Minimum **Node 20.11**. The package uses `fs.promises`, `fs.constants.O_NOFOLLOW` where available, and `node:stream/promises`. Earlier Node releases will fail at import time.

Verify the runtime:

```bash
node --version
# v20.11.0 or newer
```

## TypeScript

Types ship with the package — no `@types/openclaw__fs-safe` needed. The `exports` map in `package.json` provides typed entries for every subpath:

```ts
import { root, FsSafeError } from "@openclaw/fs-safe";
import { writeJson } from "@openclaw/fs-safe/json";
import { extractArchive } from "@openclaw/fs-safe/archive";
```

A working `tsconfig.json` for consumers:

```jsonc
{
  "compilerOptions": {
    "target": "es2022",
    "module": "node18",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## Subpath exports

Use the main entry for the common surface, or the focused subpaths when you want a leaner import or to depend on a narrower contract:

| Subpath | Contents |
|---|---|
| `@openclaw/fs-safe` | Small common surface: `root`, root types, and errors. |
| `@openclaw/fs-safe/root` | `root()`, `Root`, `RootDefaults`, related types. |
| `@openclaw/fs-safe/config` | Process-global Python helper configuration. |
| `@openclaw/fs-safe/path` | `isPathInside`, `safeRealpathSync`, `isWithinDir`, error helpers. |
| `@openclaw/fs-safe/json` | `tryReadJson`, `readJson`, `readJsonIfExists`, `writeJson`, sync variants. |
| `@openclaw/fs-safe/store` | `fileStore()`, `fileStoreSync()`, and `jsonStore<T>()`. |
| `@openclaw/fs-safe/secret` | Secret file read/write helpers. |
| `@openclaw/fs-safe/atomic` | `replaceFileAtomic`, `writeTextAtomic`, `replaceDirectoryAtomic`, `movePathWithCopyFallback`. |
| `@openclaw/fs-safe/temp` | `tempWorkspace`, `withTempWorkspace`, sync variants, `resolveSecureTempRoot`. |
| `@openclaw/fs-safe/secure-file` | `readSecureFile` for pinned absolute file reads with permissions checks. |
| `@openclaw/fs-safe/file-lock` | `acquireFileLock`, `withFileLock`, `createFileLockManager`, and related lock types. |
| `@openclaw/fs-safe/permissions` | POSIX mode and Windows ACL inspection/remediation helpers. |
| `@openclaw/fs-safe/walk` | `walkDirectory`, `walkDirectorySync`, related types. Budget-bounded, not root-bounded. |
| `@openclaw/fs-safe/archive` | `extractArchive`, `resolveArchiveKind`, limits, preflight helpers. |
| `@openclaw/fs-safe/advanced` | Lower-level composition helpers: path scopes, root-file open, install paths, local-root readers, temp-file targets, sibling-temp writes, regular-file helpers, `pathExists`, `withTimeout`, and related advanced types. This surface is less stable than the focused public subpaths. |
| `@openclaw/fs-safe/errors` | `FsSafeError`, `FsSafeErrorCode`. |
| `@openclaw/fs-safe/types` | Shared types: `DirEntry`, `PathStat`, `BasePathOptions`, … |
| `@openclaw/fs-safe/test-hooks` | Test-only hooks for injecting races. Active under `NODE_ENV=test`. |

## Runtime dependencies

`@openclaw/fs-safe` lists `jszip` and `tar` as optional dependencies for [archive extraction](archive.md). They are loaded lazily and only required when ZIP/TAR helpers run. Installs that omit optional dependencies can still import and use every non-archive subpath; archive calls fail with a clear missing-optional-dependency message.

There are no peer dependencies and no native build step.

## Python helper policy

On POSIX, `root()` uses one persistent Python helper process for the
fd-relative operations Node does not expose cleanly. The default is `auto`: use
the helper when it starts, fall back to Node-only behavior when it is disabled
or unavailable.

```ts
import { configureFsSafePython } from "@openclaw/fs-safe/config";

configureFsSafePython({ mode: "auto" });    // default
configureFsSafePython({ mode: "off" });     // never spawn Python
configureFsSafePython({ mode: "require" }); // fail closed if unavailable
```

Environment variables are read at runtime:

```bash
FS_SAFE_PYTHON_MODE=off      # auto | off | require
FS_SAFE_PYTHON=/usr/bin/python3
```

OpenClaw compatibility aliases are also accepted:
`OPENCLAW_FS_SAFE_PYTHON_MODE`, `OPENCLAW_FS_SAFE_PYTHON`,
`OPENCLAW_PINNED_PYTHON`, and `OPENCLAW_PINNED_WRITE_PYTHON`.

Disabling Python keeps the public API working, but downgrades POSIX mutation
hardening from fd-relative syscalls to Node path operations guarded by lexical
and canonical checks plus identity verification. Use `require` for
security-sensitive deployments where that downgrade should be a startup/runtime
failure instead of a fallback. The full tradeoff is documented in
[Python helper policy](python-helper.md).

## Verify the install

```ts
import { root, FsSafeError } from "@openclaw/fs-safe";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.tmpdir(), "fs-safe-smoke");
await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));

const fs = await root(dir);
await fs.write("hello.txt", "ok\n");
console.log(await fs.readText("hello.txt"));

try {
  await fs.write("../escape.txt", "x");
} catch (err) {
  if (err instanceof FsSafeError) console.log("blocked:", err.code);
}
```

If the script prints `ok` followed by `blocked: outside-workspace`, your install is healthy.

## Next

- [Quickstart](quickstart.md) — write, read, atomic, temp.
- [Security model](security-model.md) — what the boundary defends against.
- [Errors](errors.md) — the closed code union you'll be catching.
