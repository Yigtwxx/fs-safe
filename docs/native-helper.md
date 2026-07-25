---
title: Native helper policy
description: "How fs-safe loads its optional native filesystem primitives and how auto, require, and off affect guarded fallbacks."
---

# Native helper policy

`@openclaw/fs-safe` installs `@openclaw/fs-safe-native` as an optional dependency. Its loader selects one of seven prebuilt packages for Linux x64/arm64 (glibc or musl), macOS x64/arm64, or Windows x64. Consumers do not compile Rust during installation.

```ts
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

configureFsSafeNative({ mode: "auto" });    // default
configureFsSafeNative({ mode: "off" });     // guarded JavaScript only
configureFsSafeNative({ mode: "require" }); // fail closed when the binding is unavailable
```

The equivalent environment variables are `FS_SAFE_NATIVE_MODE` and `OPENCLAW_FS_SAFE_NATIVE_MODE`. Accepted values are `auto`, `off`, `require`, `true`, `false`, `on`, `never`, `required`, `1`, and `0`.

## Modes

| Mode | Behavior |
|---|---|
| `auto` | Prefer native primitives when the current platform package loads; otherwise use the guarded JavaScript path. |
| `off` | Do not load a platform package. Use the guarded JavaScript path deterministically. |
| `require` | Throw `FsSafeError("helper-unavailable")` instead of falling back when an operation needs the native binding and it cannot load. |

Configure the mode once during startup. Loading is lazy and cached; changing from `auto` to `require` after a failed load changes failure policy but does not repeatedly probe the package.

## Native boundary

The native package exposes policy-free synchronous primitives: `openBeneath`, `mkdirBeneath`, `linkBeneath`, `renameNoReplace`, and `fstatIdentity`. The TypeScript layer owns policy, retries, cleanup, error normalization, and the decision to fall back.

- Linux uses `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS` and `renameat2(RENAME_NOREPLACE)`.
- macOS resolves components with `O_NOFOLLOW`, restarts in-root symlinks from the pinned root descriptor, and uses `renameatx_np(RENAME_EXCL)`.
- Windows uses handle-relative `NtCreateFile`, rejects reparse points, and uses `FileRenameInfoEx` with replacement disabled.

Native primitives currently back create-only pinned writes, async sidecar creation, guarded hardlink publication, and the explicit `rename-noreplace` publication strategy. Other operations retain their existing guarded JavaScript implementations.

## Migration from the Python helper

Version 0.5 removes the Python worker, interpreter-path selection, and Python environment aliases. Map the old mode directly: `configureFsSafePython({ mode })` becomes `configureFsSafeNative({ mode })`; `FS_SAFE_PYTHON_MODE` becomes `FS_SAFE_NATIVE_MODE`. Delete `pythonPath` and interpreter provisioning.

## Related pages

- [Config](config.md)
- [Security model](security-model.md)
- [Writing](writing.md)
- [File locks](sidecar-lock.md)
- [Durability](durability.md)
