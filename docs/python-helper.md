---
title: Python helper policy
description: "How fs-safe uses its optional persistent Python helper, how to configure it, and what Node-only mode changes."
---

# Python helper policy

`fs-safe` is a Node library. On POSIX systems, it can optionally keep one persistent Python helper process for filesystem operations that Node does not expose ergonomically as fd-relative APIs.

The helper is not a sandbox and does not add new authority. It uses the same process user and the same filesystem permissions as your Node process. Its job is narrower: reduce race windows around parent-directory mutations after a root boundary has already been chosen.

## Default

The package default is:

```ts
configureFsSafePython({ mode: "auto" });
```

`auto` means:

- use the helper for supported POSIX operations when it starts successfully;
- fall back to Node-only behavior when Python is missing, disabled by the host, or unavailable;
- keep the public API working in ordinary desktop, CI, Docker, and bundled-app environments.

Applications can choose a stricter or simpler policy before the first filesystem operation:

```ts
import { configureFsSafePython } from "@openclaw/fs-safe/config";

configureFsSafePython({ mode: "off" });     // never spawn Python
configureFsSafePython({ mode: "require" }); // fail closed if helper cannot start
```

Environment variables provide the same policy:

```bash
FS_SAFE_PYTHON_MODE=auto      # auto | off | require
FS_SAFE_PYTHON=/usr/bin/python3
```

OpenClaw compatibility aliases are accepted too: `OPENCLAW_FS_SAFE_PYTHON_MODE`, `OPENCLAW_FS_SAFE_PYTHON`, `OPENCLAW_PINNED_PYTHON`, and `OPENCLAW_PINNED_WRITE_PYTHON`.

## What the helper does

Node's `fs` API is path-string oriented. It exposes `O_NOFOLLOW`, file handles, and some identity checks, but not a complete ergonomic `openat` / `renameat` / `unlinkat` / `mkdirat` surface for every operation `root()` needs.

The helper fills that gap for supported POSIX operations:

- stat/list paths relative to an already-open root directory;
- create directories while walking from a pinned parent;
- remove entries relative to a pinned parent;
- move entries with fd-relative rename semantics;
- run parent-fd write paths used by atomic replacement helpers.

`fs-safe` sends requests to the helper over a JSON-lines protocol. It is one persistent process per Node process, not one Python spawn per filesystem call.

## What you lose with `mode: "off"`

Node-only mode still keeps the important application-level guardrails:

- root-relative path validation;
- canonical root checks;
- no-follow opens where Node/platform support exists;
- file identity checks around reads and writes;
- atomic sibling-temp replacement;
- hardlink/symlink policy checks where the API requests them;
- byte limits and structured `FsSafeError` failures.

What gets weaker is the POSIX defense against another same-UID process swapping a parent directory between validation and mutation. Without fd-relative mutation, `root().move()`, `root().remove()`, `root().mkdir()`, and some write paths rely on Node path operations plus pre/post checks instead of parent-fd syscalls.

That is usually acceptable when the root directory is only writable by the trusted application user. It is not the right posture if untrusted local processes can race writes in the same tree and you are relying on `fs-safe` as part of the security boundary.

## Choosing a mode

| Mode | Use when |
|---|---|
| `auto` | You want the strongest available POSIX path when Python exists, but installs should still work without it. This is the package default. |
| `off` | You want deterministic Node-only behavior, no Python process, or a runtime that forbids spawning Python. |
| `require` | The fd-relative helper is part of your security posture and startup/runtime should fail closed if it is unavailable. |

If you deploy with `require`, set `FS_SAFE_PYTHON` to an absolute interpreter path and test it in the same container, bundle, service manager, or sandbox that runs your app.

## Application defaults

Libraries should normally leave the package default alone. Applications can set a process-global policy once at startup:

```ts
import { configureFsSafePython } from "@openclaw/fs-safe/config";

if (!process.env.FS_SAFE_PYTHON_MODE) {
  configureFsSafePython({ mode: "off" });
}
```

This is the right shape for apps that want to make Python an explicit operator choice while still letting deployment env vars opt back into `auto` or `require`.

## Related pages

- [Security model](security-model.md) — what `root()` does and does not promise.
- [Root API](root.md) — root-bounded read/write/move/remove methods.
- [Errors](errors.md) — `helper-unavailable` and `helper-failed` handling.
- [Testing](testing.md) — forcing helper modes in tests.
