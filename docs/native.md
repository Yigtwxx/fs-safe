---
title: Native architecture
description: "The optional native binding, fd-relative beneath model, platform mechanisms, loader security, and JavaScript fallback contract."
---

# Native architecture

The optional `@openclaw/fs-safe-native` package supplies mechanisms that Node
does not expose directly. It is deliberately not a second policy engine.
TypeScript owns trusted-root selection, path validation, archive filtering,
budgets, modes, identity fencing, cleanup decisions, and error normalization.
Rust receives already-decided relative operations and performs the smallest
platform syscall sequence that can preserve the boundary.

Every native acceleration keeps a guarded JavaScript implementation. Native
loading is lazy and optional; installs do not compile Rust.

## The beneath model

A trusted directory descriptor is the capability. Native operations accept
that descriptor plus a validated relative path and never reconstruct authority
from a process working directory. Newly created files use exclusive creation,
and TypeScript compares descriptor, pathname, and expected identities before
accepting results.

- Linux uses `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`, fd-relative
  `mkdirat`/`linkat`/`renameat2`, `FICLONE`, and `copy_file_range`.
- macOS walks components with `openat(O_NOFOLLOW)`, restarts in-root symlinks
  from the pinned root, uses `renameatx_np(RENAME_EXCL)`, and permits
  `fclonefileat` only for simple metadata in an owned, non-shared parent. The
  clone is normalized inside a private staging directory before publication.
- Windows uses handle-relative `NtCreateFile` with `OBJ_DONT_REPARSE` and
  `FILE_OPEN_REPARSE_POINT`, then explicitly rejects reparse points. Rename and
  hardlink operations stay rooted in already-open handles. Owner/DACL reads
  use `GetSecurityInfo`; private directories receive their protected DACL in
  the `CreateDirectoryW` call itself.

## Archives

Rust streams ZIP and TAR payloads, including gzip, zstd, and bzip2. It first
returns a bounded manifest. TypeScript applies the shared path, filter, strip,
mode, and byte policies and returns an index-bound extraction plan. Rust then
creates only those planned entries beneath a private staging descriptor.

A fixed-512-byte pass-through meter sits between decompression and the TAR
crate. It reads only header type and octal/base-256 size fields. It never parses
metadata content. Oversized GNU long-name/link metadata is rejected before
buffering; PAX size overrides and GNU sparse entries are rejected as
unmeterable rather than guessed. The JavaScript node-tar path receives the same
`maxMetaEntryBytes` value and a matching fixed-header preflight.

## Publication and hashing

Exclusive publication tries a hardlink, then a copy-on-write clone, Linux
`copy_file_range`, and finally the existing asynchronous JavaScript byte loop.
All routes preserve `wx` semantics and the same source/target identity and
SHA-256 fencing. Native hashing and Linux whole-file copying run on N-API async
workers rather than the JavaScript event loop.

## Mode semantics

| Mode | Native loading | Fallback |
|---|---|---|
| `auto` | Try once, cache the result | Use guarded JavaScript when unavailable |
| `require` | Try once, cache the result | Throw `FsSafeError("helper-unavailable")` |
| `off` | Never attempt a binding load | Always use guarded JavaScript |

The one exception is functionality with no safe JavaScript implementation:
zstd/bzip2 TAR and Windows private-directory creation fail with
`helper-unavailable` when native support is absent or off.

## Loader security

Importing fs-safe never executes a platform detector. Linux libc selection uses
the Node process report, conventional musl library filenames, and the ELF
`PT_INTERP` field of `process.execPath`. If all probes are inconclusive, the
loader conservatively attempts the glibc package and lets normal module loading
fail into `auto` fallback. The checked-in hardening script reapplies this prefix
after napi-rs generation, and tests reject `child_process`, `exec`, or `spawn`
usage in the loader.

## Related pages

- [Native helper policy](native-helper.md)
- [Security model](security-model.md)
- [Archive extraction](archive.md)
- [Durability](durability.md)
- [Permissions](permissions.md)
