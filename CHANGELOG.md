# Changelog

## 0.1.2 - 2026-05-06

### Fixes

- Reject `fileStore()` and `fileStoreSync()` writes through symlinked parent directories so store commits cannot escape the configured root.

### Tests

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
