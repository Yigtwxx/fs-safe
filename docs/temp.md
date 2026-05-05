# Temp workspaces

`@openclaw/fs-safe/temp` covers four overlapping needs: a private temp **directory** with auto-cleanup, a private temp **file path** for sibling writes, the secure per-user temp root the helpers default to, and ad-hoc sibling-temp file creation.

```ts
import {
  tempWorkspace,
  createPrivateTempWorkspace,
  withPrivateTempWorkspace,
  createPrivateTempWorkspaceSync,
  withPrivateTempWorkspaceSync,
  createTempFileTarget,
  withTempFileTarget,
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

### `withPrivateTempWorkspace`

The recommended shape. Auto-cleanup on every exit path:

```ts
import { withPrivateTempWorkspace } from "@openclaw/fs-safe/temp";

const result = await withPrivateTempWorkspace({ rootDir: "/tmp/my-app", prefix: "build-" }, async (workspace) => {
  await workspace.writePrivate("input.txt", "data");
  return await runBuild(workspace.dir);
});
```

The callback receives the same workspace shape as `tempWorkspace()`. Cleanup is wired to run after the callback resolves or rejects.

### `createPrivateTempWorkspace`

Lower-level. You manage the lifetime:

```ts
const workspace = await createPrivateTempWorkspace({ rootDir: "/tmp/my-app", prefix: "scan-" });
try {
  // …work in workspace.dir…
} finally {
  await workspace.cleanup();
}
```

### Sync variants

`createPrivateTempWorkspaceSync` and `withPrivateTempWorkspaceSync` are the synchronous siblings. Useful for setup code in tests or boot paths that have not entered async land yet.

### Options

```ts
type PrivateTempWorkspaceOptions = {
  rootDir: string;          // parent directory for workspaces
  prefix: string;           // dir prefix (sanitized)
  dirMode?: number;         // dir mode; default 0o700
  fileMode?: number;        // writePrivate file mode; default 0o600
};
```

## Temp file targets

When you don't need a whole directory — just one temp file path under your control — use the file-target helpers. They produce a path inside a private workspace and clean up either the file (`createTempFileTarget`) or the entire enclosing directory (`withTempFileTarget`).

### `createTempFileTarget`

```ts
import { createTempFileTarget } from "@openclaw/fs-safe/temp";

const target = await createTempFileTarget({ fileName: "report.pdf", prefix: "render-" });
try {
  await render(target.filePath);
  await fs.copyFile(target.filePath, "/srv/workspace/reports/today.pdf");
} finally {
  await target.dispose();
}
```

Returns:

```ts
type TempFileTarget = {
  filePath: string;     // absolute path; safe to write to
  dirPath: string;      // the enclosing private workspace dir
  dispose(): Promise<void>; // removes filePath if present, then dirPath
};
```

### `withTempFileTarget`

Same shape with auto-cleanup:

```ts
import { withTempFileTarget } from "@openclaw/fs-safe/temp";

await withTempFileTarget({ fileName: "out.zip", prefix: "pack-" }, async (t) => {
  await pack(t.filePath);
  await uploadAndForget(t.filePath);
});
```

## Sibling temp writes

When you want to write to a temp file in **the same directory** as a future destination — useful when you need atomic placement but don't want to use `replaceFileAtomic`'s full machinery.

### `writeSiblingTempFile`

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/temp";

const result = await writeSiblingTempFile<string>({
  destinationFilePath: "/srv/workspace/state.json",
  fileMode: 0o600,
  write: async (tempPath) => {
    await fs.writeFile(tempPath, JSON.stringify(state));
    return tempPath;
  },
});
// result.tempPath, result.value (returned by write()), result.dispose
```

`writeSiblingTempFile` chooses a random sibling name in the destination's parent directory, calls your `write()` callback, and lets you decide what to do with it next. The result includes a `dispose()` to remove the temp file if you didn't rename it into place.

### `writeViaSiblingTempPath`

A higher-level convenience — write content + rename in one call:

```ts
import { writeViaSiblingTempPath } from "@openclaw/fs-safe/temp";

await writeViaSiblingTempPath({
  destinationFilePath: "/srv/workspace/state.json",
  content: JSON.stringify(state),
  fileMode: 0o600,
});
```

If `replaceFileAtomic` does what you need, prefer that — `writeViaSiblingTempPath` is the lower-level building block.

## Secure temp root

The `resolveSecureTempRoot()` helper picks a per-user directory under the system temp dir, creates it at mode `0o700` if missing, and returns the absolute path. The other helpers in this module call it by default; you can call it directly if you need to materialize the root yourself.

```ts
import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";

const tempRoot = resolveSecureTempRoot({ namespace: "my-app" });
// e.g. /tmp/fs-safe-501-my-app-9af7
```

### Options

```ts
type ResolveSecureTempRootOptions = {
  namespace?: string;       // appended to the default name
  parentDir?: string;       // override os.tmpdir()
  mode?: number;            // default 0o700
};
```

The directory name embeds the user's UID (POSIX) or username so multi-user systems don't collide. On unsupported platforms, falls back to `os.tmpdir()` directly with a `helper-unavailable` error code surfaced to callers that explicitly required the secure root.

## Common patterns

### Build something, atomically place it

```ts
await withPrivateTempWorkspace({ prefix: "build-" }, async (ws) => {
  await runCompiler({ outDir: ws.dir });
  await replaceDirectoryStaged({
    sourceDir: ws.dir,
    targetDir: "/srv/site/public",
    backupDir: "/srv/site/public.prev",
  });
});
```

### Stream a download to a sibling temp, then commit

```ts
import { writeSiblingTempFile } from "@openclaw/fs-safe/temp";
import fs from "node:fs/promises";

const r = await writeSiblingTempFile({
  destinationFilePath: "/srv/cache/blob.bin",
  write: async (tempPath) => {
    const handle = await fs.open(tempPath, "w");
    try {
      await pipeline(downloadStream, handle.createWriteStream());
    } finally {
      await handle.close();
    }
    return tempPath;
  },
});

await fs.rename(r.tempPath, "/srv/cache/blob.bin");
```

### Per-call private scratch in a test

```ts
import { withPrivateTempWorkspace } from "@openclaw/fs-safe/temp";

it("processes a fixture", async () => {
  await withPrivateTempWorkspace({ prefix: "test-" }, async (ws) => {
    await fs.writeFile(path.join(ws.dir, "input.txt"), fixture);
    const out = await processFile(path.join(ws.dir, "input.txt"));
    expect(out).toEqual(expected);
  });
});
```

## See also

- [Atomic writes](atomic.md) — `replaceDirectoryStaged` for whole-directory swaps.
- [`root()`](root.md) — `fs.copyIn(rel, sourceAbs)` for moving files from a temp into a `Root`.
- [Sidecar lock](sidecar-lock.md) — when many processes share a temp tree.
