# Temp workspaces

`@openclaw/fs-safe/temp` covers four overlapping needs: a private temp **directory** with auto-cleanup, a private temp **file path** for sibling writes, the secure per-user temp root the helpers default to, and ad-hoc sibling-temp file creation.

```ts
import {
  tempWorkspace,
  withTempWorkspace,
  tempWorkspaceSync,
  withTempWorkspaceSync,
  tempFile,
  withTempFile,
  writeSiblingTempFile,
  writeViaSiblingTempPath,
  resolveSecureTempRoot,
} from "@openclaw/fs-safe/temp";
```

## Private temp workspaces

A private workspace is a directory created at mode `0o700` under a caller-provided temp root. It is unique per call (random suffix) and cleaned up when you call `cleanup()` or leave an `await using` scope.

### `tempWorkspace`

The compact factory. It returns `{ dir, file(name), path(name), writePrivate(), read(), cleanup(), [Symbol.asyncDispose] }`.

```ts
import { tempWorkspace } from "@openclaw/fs-safe/temp";

await using workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" });
const inputPath = await workspace.writePrivate("input.txt", "data");
await runBuild(workspace.dir, inputPath);
```

### `withTempWorkspace`

The recommended shape. Auto-cleanup on every exit path:

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";

const result = await withTempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" }, async (workspace) => {
  await workspace.writePrivate("input.txt", "data");
  return await runBuild(workspace.dir);
});
```

The callback receives the same workspace shape as `tempWorkspace()`. Cleanup is wired to run after the callback resolves or rejects.

### Manual lifetime

Lower-level. You manage the lifetime:

```ts
const workspace = await tempWorkspace({ rootDir: "/tmp/my-app", prefix: "scan-" });
try {
  // …work in workspace.dir…
} finally {
  await workspace.cleanup();
}
```

### Sync variants

`tempWorkspaceSync` and `withTempWorkspaceSync` are the synchronous siblings. Useful for setup code in tests or boot paths that have not entered async land yet.

### Options

```ts
type TempWorkspaceOptions = {
  rootDir: string;          // parent directory for workspaces
  prefix: string;           // dir prefix (sanitized)
  dirMode?: number;         // dir mode; default 0o700
  mode?: number;            // writePrivate file mode; default 0o600
};
```

## Temp file targets

When you don't need a whole directory — just one temp file path under your control — use the file-target helpers. They produce a path inside a private workspace and clean up the enclosing directory.

### `tempFile`

```ts
import { tempFile } from "@openclaw/fs-safe/temp";

const target = await tempFile({ fileName: "report.pdf", prefix: "render-" });
try {
  await render(target.path);
  await fs.copyFile(target.path, "/srv/workspace/reports/today.pdf");
} finally {
  await target.cleanup();
}
```

Returns:

```ts
type TempFile = {
  path: string;                            // absolute path; safe to write to
  dir: string;                             // the enclosing private workspace dir
  file(fileName?: string): string;          // resolve another file in the same dir
  cleanup(): Promise<void>;                 // removes the private workspace dir
  [Symbol.asyncDispose](): Promise<void>;   // alias of cleanup()
};
```

### `withTempFile`

Same shape with auto-cleanup:

```ts
import { withTempFile } from "@openclaw/fs-safe/temp";

await withTempFile({ fileName: "out.zip", prefix: "pack-" }, async (filePath) => {
  await pack(filePath);
  await uploadAndForget(filePath);
});
```

## Sibling temp writes

When you want to write to a temp file in **the same directory** as a future destination — useful when you need atomic placement but don't want to use `replaceFileAtomic`'s full machinery.

### `writeSiblingTempFile`

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/temp";

const result = await writeSiblingTempFile<string>({
  dir: "/srv/workspace",
  mode: 0o600,
  writeTemp: async (tempPath) => {
    await fs.writeFile(tempPath, JSON.stringify(state));
    return "state.json";
  },
  resolveFinalPath: (fileName) => path.join("/srv/workspace", fileName),
});
// result.filePath, result.result (returned by writeTemp)
```

`writeSiblingTempFile` chooses a random sibling name in `dir`, calls your `writeTemp()` callback, validates that `resolveFinalPath(result)` is still inside that same directory, and renames the temp file there.

### `writeViaSiblingTempPath`

A higher-level convenience — write content + rename in one call:

```ts
import { writeViaSiblingTempPath } from "@openclaw/fs-safe/temp";

await writeViaSiblingTempPath({
  rootDir: "/srv/workspace",
  targetPath: "/srv/workspace/state.json",
  writeTemp: async (tempPath) => {
    await fs.writeFile(tempPath, JSON.stringify(state));
  },
});
```

If `replaceFileAtomic` does what you need, prefer that — `writeViaSiblingTempPath` is the lower-level building block.

## Secure temp root

The `resolveSecureTempRoot()` helper picks a per-user directory under the system temp dir, creates it at mode `0o700` if missing, and returns the absolute path. The other helpers in this module call it by default; you can call it directly if you need to materialize the root yourself.

```ts
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";

const tempRoot = resolveSecureTempRoot({ fallbackPrefix: "my-app" });
// e.g. /tmp/my-app-501
```

### Options

```ts
type ResolveSecureTempRootOptions = {
  fallbackPrefix: string;   // base name for the per-user fallback dir
  preferredDir?: string;    // optional preferred secure temp root
  tmpdir?: () => string;    // override os.tmpdir()
};
```

The directory name embeds the user's UID (POSIX) or username so multi-user systems don't collide. On unsupported platforms, falls back to `os.tmpdir()` directly with a `helper-unavailable` error code surfaced to callers that explicitly required the secure root.

## Common patterns

### Build something, atomically place it

```ts
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await withTempWorkspace({ rootDir: "/srv/site/tmp", prefix: "build-" }, async (ws) => {
  await runCompiler({ outDir: ws.dir });
  await replaceDirectoryAtomic({
    stagedDir: ws.dir,
    targetDir: "/srv/site/public",
  });
});
```

### Stream a download to a sibling temp, then commit

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/temp";
import fs from "node:fs/promises";

const r = await writeSiblingTempFile({
  dir: "/srv/cache",
  writeTemp: async (tempPath) => {
    const handle = await fs.open(tempPath, "w");
    try {
      await pipeline(downloadStream, handle.createWriteStream());
    } finally {
      await handle.close();
    }
    return "blob.bin";
  },
  resolveFinalPath: (fileName) => path.join("/srv/cache", fileName),
});

console.log(`downloaded ${r.filePath}`);
```

### Per-call private scratch in a test

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";

it("processes a fixture", async () => {
  await withTempWorkspace({ rootDir: "/tmp/my-tests", prefix: "test-" }, async (ws) => {
    await fs.writeFile(path.join(ws.dir, "input.txt"), fixture);
    const out = await processFile(path.join(ws.dir, "input.txt"));
    expect(out).toEqual(expected);
  });
});
```

## See also

- [Atomic writes](atomic.md) — `replaceDirectoryAtomic` for whole-directory swaps.
- [`root()`](root.md) — `fs.copyIn(rel, sourceAbs)` for moving files from a temp into a `Root`.
- [Sidecar lock](sidecar-lock.md) — when many processes share a temp tree.
