---
title: Test hooks
description: "Internal-only injection hooks used by the fs-safe test suite. Active only when NODE_ENV=test or VITEST=true."
---

# `@openclaw/fs-safe/test-hooks`

Internal injection points the `fs-safe` test suite uses to deterministically reproduce open/lstat races. They are exposed as a public subpath so downstream test suites can reuse the same harness, but they are **not** part of the supported runtime API.

```ts
import {
  getFsSafeTestHooks,
  __setFsSafeTestHooksForTest,
  type FsSafeTestHooks,
} from "@openclaw/fs-safe/test-hooks";
```

## When the hooks are active

Hooks are only honored when one of the following is true:

- `process.env.NODE_ENV === "test"`
- `process.env.VITEST === "true"`

Calling `__setFsSafeTestHooksForTest(hooks)` outside of those environments throws. `getFsSafeTestHooks()` returns `undefined` when no hooks are registered, regardless of the environment.

## Shape

```ts
type FsSafeTestHooks = {
  afterPreOpenLstat?: (filePath: string) => Promise<void> | void;
  beforeOpen?: (filePath: string, flags: number) => Promise<void> | void;
  afterOpen?: (filePath: string, handle: FileHandle) => Promise<void> | void;
};
```

| Hook | Fires when |
|---|---|
| `afterPreOpenLstat` | A pre-open `lstat` has just resolved. Use this to swap a path between validation and open. |
| `beforeOpen` | The library is about to call `open(path, flags)`. Use this to inject a TOCTOU window. |
| `afterOpen` | An open just succeeded. Use this to mutate state before the post-open identity check runs. |

Each hook may be sync or async; async hooks are awaited.

## Usage

```ts
import { afterEach, beforeEach } from "vitest";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";

beforeEach(() => {
  __setFsSafeTestHooksForTest({
    beforeOpen: async (filePath) => {
      // swap a victim file with a symlink right before fs-safe opens it
      await replaceWithSymlink(filePath);
    },
  });
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
});
```

Always clear the hooks in `afterEach` so a stuck hook does not leak across tests.

## Stability

The shape can grow new optional fields between minor versions. Treat the surface as test-only and do not rely on it from production code.

## Related pages

- [Testing](testing.md) — broader notes on testing against `fs-safe`.
- [Security model](security-model.md) — the races these hooks help reproduce.
