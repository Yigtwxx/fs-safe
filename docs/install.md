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
| `@openclaw/fs-safe` | The full surface. Re-exports everything below. |
| `@openclaw/fs-safe/root` | `root()`, `Root`, `RootDefaults`, related types. |
| `@openclaw/fs-safe/path` | `isPathInside`, `safeRealpathSync`, `isWithinDir`, error helpers. |
| `@openclaw/fs-safe/json` | `tryReadJson`, `readJson`, `readJsonIfExists`, `writeJson`, `writeText`. |
| `@openclaw/fs-safe/regular-file` | `readRegularFile`, `appendRegularFile`, regular-file stat helpers. |
| `@openclaw/fs-safe/atomic` | `replaceFileAtomic`, `replaceDirectoryAtomic`, `movePathWithCopyFallback`. |
| `@openclaw/fs-safe/temp` | `tempWorkspace`, `withTempWorkspace`, `tempFile`, `writeSiblingTempFile`. |
| `@openclaw/fs-safe/archive` | `extractArchive`, `resolveArchiveKind`, limits, preflight helpers. |
| `@openclaw/fs-safe/fs` | `pathExists`, `pathExistsSync`. |
| `@openclaw/fs-safe/timing` | `withTimeout`. |
| `@openclaw/fs-safe/errors` | `FsSafeError`, `FsSafeErrorCode`. |
| `@openclaw/fs-safe/types` | Shared types: `DirEntry`, `PathStat`, `BasePathOptions`, … |
| `@openclaw/fs-safe/test-hooks` | Test-only hooks for injecting races. Active under `NODE_ENV=test`. |
| `@openclaw/fs-safe/home` | `expandHomePrefix`, `homeDir`. |

## Runtime dependencies

`@openclaw/fs-safe` depends on `jszip` and `tar` for [archive extraction](archive.md). Both are loaded lazily — if your code never touches the archive subpath, the runtime cost is negligible.

There are no peer dependencies and no native build step.

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
