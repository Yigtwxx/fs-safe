---
title: Config
description: "Process-global configuration for the optional Python helper used by fs-safe on POSIX."
---

# `@openclaw/fs-safe/config`

Process-global configuration knobs for the optional persistent Python helper that backs POSIX fd-relative operations in `root()`. The whole helper policy is described in the [Python helper policy](python-helper.md); this page is the API reference.

```ts
import {
  configureFsSafePython,
  getFsSafePythonConfig,
  type FsSafePythonConfig,
  type FsSafePythonMode,
} from "@openclaw/fs-safe/config";
```

`configureFsSafePython` is also re-exported from the main entry point, so `import { configureFsSafePython } from "@openclaw/fs-safe"` works too. Prefer the subpath when you only need helper configuration and want the smallest import surface.

## `configureFsSafePython(config)`

```ts
function configureFsSafePython(config: Partial<FsSafePythonConfig>): void;

type FsSafePythonConfig = {
  mode: FsSafePythonMode;
  pythonPath?: string;
};

type FsSafePythonMode = "auto" | "off" | "require";
```

Set the process-global policy. Calls merge into the existing override config, so passing `{ pythonPath: "/usr/bin/python3" }` keeps any previously set `mode`. Configure once at startup, before the first `root()` call — switching modes mid-process is supported but the helper may already be running.

| Mode | Behavior |
|---|---|
| `auto` | Default. Use the helper when it starts; fall back to Node-only behavior if Python is missing or fails to start. |
| `off` | Never spawn the helper. Read/write/move use Node fallbacks plus pre/post identity checks. |
| `require` | Fail closed if the helper cannot start. Operations that need the helper raise `FsSafeError("helper-unavailable")`. |

## `getFsSafePythonConfig()`

```ts
function getFsSafePythonConfig(): FsSafePythonConfig;
```

Return the effective configuration: programmatic overrides win, then env vars, then the package default (`auto`).

## Environment variables

The same policy can be set without code:

```bash
FS_SAFE_PYTHON_MODE=auto      # auto | off | require | true | false | on | off | 1 | 0 | never | required
FS_SAFE_PYTHON=/usr/bin/python3
```

OpenClaw compatibility aliases are accepted: `OPENCLAW_FS_SAFE_PYTHON_MODE`, `OPENCLAW_FS_SAFE_PYTHON`, `OPENCLAW_PINNED_PYTHON`, and `OPENCLAW_PINNED_WRITE_PYTHON`. Programmatic overrides via `configureFsSafePython` always win.

## Related pages

- [Python helper policy](python-helper.md) — when to pick `auto`, `off`, or `require`, and what each mode protects.
- [Root API](root.md) — the API whose POSIX hardening the helper backs.
- [Errors](errors.md) — `helper-unavailable` and `helper-failed`.
