# Testing

`@openclaw/fs-safe/test-hooks` exposes a small set of test-only injection points. They are inert in production: the hooks only activate when `process.env.NODE_ENV === "test"`. Outside test mode, calls to set hooks are no-ops, so leaking a test setup line into production is safe but ineffective.

```ts
import {
  __setFsSafeTestHooksForTest,
  type FsSafeTestHooks,
} from "@openclaw/fs-safe/test-hooks";
```

The double-underscore prefix is a deliberate "hands off" signal: production code should never import this module. ESLint or your equivalent linter should flag it.

## When to reach for hooks

- Reproduce a TOCTOU race deterministically: simulate a symlink swap between resolve and open, or between write and rename.
- Make a "helper unavailable" branch reachable in CI without uninstalling Python from your runners.
- Inject latency to test cancellation/timeout paths.

If you don't need to inject a race, you don't need hooks — most tests should drive the library through normal calls and assert on observable behavior.

## Hooks API

```ts
type FsSafeTestHooks = {
  beforeOpen?: (info: { absPath: string }) => void | Promise<void>;
  beforeRename?: (info: { tempPath: string; destPath: string }) => void | Promise<void>;
  afterFstat?: (info: { absPath: string; stat: import("node:fs").Stats }) => void | Promise<void>;
  helperUnavailableReason?: () => string | undefined;
};

function __setFsSafeTestHooksForTest(hooks?: FsSafeTestHooks): void;
function getFsSafeTestHooks(): FsSafeTestHooks | undefined;
```

Hooks are called at well-defined points in the library's hot paths:

- **`beforeOpen`** — runs before `fs.open` or the pinned-open helper opens the file. A common use is to swap the path's target via `fs.symlink`/`fs.unlink` to drive a TOCTOU race.
- **`beforeRename`** — runs after the temp file is fully written and before the rename. Use to mutate the destination dir, simulate a parallel writer, or unlink the temp file.
- **`afterFstat`** — runs after the post-open `fstat`. Useful to validate the library called `fstat` (and not bypassed it).
- **`helperUnavailableReason`** — when defined, the library treats the POSIX helper as unavailable and surfaces the returned string as the failure reason. Use this to drive the Node-only fallback path on systems where the helper *would* spawn.

`__setFsSafeTestHooksForTest(undefined)` clears all hooks. Always clean up between tests.

## Example: simulate a TOCTOU swap

```ts
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root, FsSafeError } from "@openclaw/fs-safe";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fs-safe-toctou-"));
  await writeFile(path.join(dir, "real.txt"), "secret");
  await writeFile(path.join(dir, "decoy.txt"), "decoy");
});
afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await rm(dir, { recursive: true, force: true });
});

it("rejects a swap between resolve and open", async () => {
  const fs = await root(dir, { symlinks: "reject" });

  __setFsSafeTestHooksForTest({
    beforeOpen: async ({ absPath }) => {
      // swap real.txt for a symlink to decoy.txt right before the open
      await unlink(absPath);
      await symlink(path.join(dir, "decoy.txt"), absPath);
    },
  });

  await expect(fs.read("real.txt")).rejects.toMatchObject({
    name: "FsSafeError",
    code: expect.stringMatching(/symlink|path-mismatch/),
  });
});
```

The `code` may be `symlink` (caught at open by `O_NOFOLLOW`) or `path-mismatch` (caught by the post-open identity check) depending on platform — both are correct refusals.

## Example: force the helper-unavailable branch

```ts
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

beforeEach(() => {
  __setFsSafeTestHooksForTest({
    helperUnavailableReason: () => "test: pretend Python is missing",
  });
});

it("falls back to the Node-only path", async () => {
  // exercise an operation that would normally use the helper
  // and assert the Node fallback succeeded with the same observable result
});
```

## Cleanup is mandatory

Hooks set by `__setFsSafeTestHooksForTest` persist across tests until explicitly cleared. Always clear in `afterEach` (or your test framework's equivalent) — leaked hooks will silently change behavior in unrelated tests and cause maddening intermittent failures.

```ts
import { afterEach } from "vitest";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});
```

A global hook clear in your test setup file is a good safety net.

## Patterns for testing fs-safe-using code

You usually don't need hooks. Most tests follow this shape:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "@openclaw/fs-safe";

let dir: string;
let fs: Awaited<ReturnType<typeof root>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "my-feature-"));
  fs = await root(dir, { symlinks: "reject", hardlinks: "reject", mkdir: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("writes and reads through the boundary", async () => {
  await fs.write("notes/today.txt", "hello");
  expect(await fs.readText("notes/today.txt")).toBe("hello");
});
```

For tests that need a private temp workspace, [`withTempWorkspace`](temp.md) makes the setup-and-teardown story trivial.

## See also

- [Security model](security-model.md) — what the boundary is supposed to defend; design tests around the same threats.
- [`root()`](root.md) — the surface most tests will exercise.
- [Temp workspaces](temp.md) — `withTempWorkspace` for cleanup-on-exit test directories.
