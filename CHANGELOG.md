# Changelog

## Unreleased

### Changes

- Add a `durable: false` option to async atomic text and JSON writes so callers can preserve replace semantics while skipping temp-file and parent-directory fsync.
- Add `ensureAbsoluteDirectory()` for creating trusted absolute directory paths one segment at a time while rejecting symlink and non-directory components. (#12; thanks @jesse-merhi)

### Fixes

- Harden temp filename prefixes, local-root reads, private store imports, durable queue reads, and regular-file byte caps against Deepsec-reported path traversal, symlink, and oversized-read races.
- Harden sidecar lock cleanup and stale-lock handling so stale third-party locks fail closed instead of being deleted by path.
- Make cross-device move fallbacks reject source changes during staged copies and clean up only the source entries copied into the staged destination, preserving concurrent source additions or replacements instead of recursively deleting them.

### Tests

- Added Deepsec regression coverage for unsafe temp tokens, dangling symlinks, default read caps, private `copyIn()` races, symlinked queue entries, oversized queue entries, and fresh sidecar lock preservation.

## 0.1.2 - 2026-05-06

### Fixes

- Add `writeExternalFileWithinRoot()` for libraries that require an output path while preserving caller-provided destination names. (#7; thanks @jesse-merhi)
- Reject `fileStore()` and `fileStoreSync()` writes through symlinked parent directories so store commits cannot escape the configured root.
- Harden Root fallback mutators, archive merges, private store reads/writes, durable queue ids, JSON fallback writes, sibling temp writes, temp filename sanitization, and trash moves against symlink-swap and path traversal edge cases.
- Centralize safe path segment validation, directory identity guards, and guarded mutation wrappers so future filesystem helpers reuse the same race-resistant checks.
- Route archive ZIP staging, temp workspace sync reads, secret-file commits, and atomic move/replace fallbacks through shared pinned-read or guarded-write primitives without applying private-directory modes to public paths.
- Close guarded fallback write handles without following path names if post-write directory verification fails, avoiding descriptor leaks and unsafe cleanup in symlink-swap races.
- Preserve empty-directory pruning and broken-symlink trash moves across guarded fallback paths.
- Preserve sync file-store read policy errors for directory and hardlink validation failures.
- Guard fallback mkdir component creation and skip archive destination cleanup after pre-commit races.

### Tests

- Added regression coverage for the filesystem race and traversal findings fixed in this release.
- Added a static filesystem-boundary primitive check that blocks reintroducing known raw copy/read/guard patterns.
- Increased filesystem edge coverage around secure temp fallback handling, sibling-temp cleanup, local-root resolution, file locks, and file identity checks.
- Prevented POSIX test runs from leaving Windows-style secure-temp fallback paths in the repository root.

### Docs

- Added missing docs pages for `@openclaw/fs-safe/config`, `@openclaw/fs-safe/store`, `@openclaw/fs-safe/advanced`, and `@openclaw/fs-safe/test-hooks`.
- Corrected path-helper docs for the synchronous `isPathInsideWithRealpath` and `safeRealpathSync` behavior.
- Included the Markdown docs in the npm package so README links resolve after install.

## 0.1.1 - 2026-05-06

### Fixes

- Preserve the caller's destination path spelling during staged archive merges so symlink-rebind checks catch alias races on macOS.
- Reject archive writes that gain a hardlink alias during post-write verification and clean up the destination file.

## 0.1.0 - 2026-05-06

### Features

- Added `root()` capability-style filesystem handles for root-bounded reads, writes, appends, moves, copies, directory listing, stat, mkdir, remove, JSON, streams, and existence checks.
- Added traversal, symlink, hardlink, alias, and post-open/post-write identity checks for untrusted relative paths.
- Added process-global Python helper configuration for stronger POSIX fd-relative mutation paths, with `auto`, `off`, and `require` modes.
- Added atomic file and directory replacement helpers with mode control, fsync options, retry handling, and copy-fallback behavior.
- Added JSON helpers, `fileStore()`, `jsonStore()`, private store mode, and file-backed temporary workspaces.
- Added secure absolute file reads, secret-file helpers, permissions inspection, Windows ACL helpers, and local-root readers.
- Added archive extraction and preflight helpers for ZIP/TAR with optional `jszip` and `tar` dependencies, size/count/path/link limits, and staged destination writes.
- Added file locks, async locks, bounded directory walking, install-path sanitizers, filename sanitization, regular-file helpers, trash moves, and advanced composition helpers.
- Added OpenClaw bypass-parity coverage, API coverage, a benchmark workflow, docs site generation, security docs, and coverage CI.
