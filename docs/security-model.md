# Security model

`fs-safe` is a library-level guardrail. It assumes the calling process already has whatever filesystem permissions it needs and aims to stop trivial path tricks from broadening that authority. It is not a sandbox and does not replace operating-system isolation.

## Threat model

You hand a `root()` boundary to a piece of code that takes caller-controlled relative paths. The library defends against a caller that:

- supplies `..` traversal segments to escape the boundary
- supplies an absolute path where a relative one is expected
- replaces a path component with a symlink between check and use (TOCTOU)
- replaces the destination directory with a symlink right before a write
- creates a hardlink that aliases an out-of-tree inode and asks you to read or replace it
- triggers a partial write that leaves a half-written file at the destination
- ships an archive with `..` paths, absolute paths, or symlinks pointing outside the destination

It does **not** defend against:

- a process running with permissions to write anywhere on the filesystem and choosing to ignore the library
- another process with the same UID racing to mutate the same directory between two separate `fs-safe` calls — the boundary is per-call, not per-session
- container escape, TOCTOU between fork and exec of helpers, or kernel-level vulnerabilities
- semantic content checks: file types, archive payload schemas, signature verification

If you need full sandboxing, run the worker under reduced privileges (uid, container, seccomp, chroot, jail) and use `fs-safe` inside the sandbox to keep the worker honest about its own workspace.

## Defenses, by failure mode

### Path traversal and absolute paths

Every relative path is resolved against the canonicalized real path of the root, then checked with `isPathInside`. Inputs containing `..`, leading `/` (without `pathScope` opt-in), or that resolve outside the root throw `outside-workspace`.

### Symlinks (read side)

`open()` and `read()` use `fs.open` with `O_NOFOLLOW` on POSIX where available. The library then `fstat`s the open fd and `realpath`s the original input, asserting the two refer to the same inode (`sameFileIdentity`). A symlink swap that happens between resolve and open will fail at the identity check rather than silently following the new target.

Per-call `symlinks: "follow-within-root"` allows symlinks whose final target is still inside the root. The default is `"reject"`.

### Symlinks (write side)

Writes use a sibling-temp + rename helper that opens the parent directory by fd, then performs the rename `at` the parent fd. Replacing the parent directory with a symlink between the parent-fd open and the rename does not divert the write.

### Hardlink aliasing

When `hardlinks: "reject"` is set, reads stat the target and refuse if `nlink > 1`, on the conservative assumption that a hardlinked file might alias an out-of-tree inode. This is defense-in-depth: the link count check is best-effort and platform-dependent. Treat it as a tripwire, not authorization.

### TOCTOU between resolve and use

`resolve()`, `exists()`, `stat()`, and `list()` are explicitly **not** race-resistant — they answer a question and return. To act on a path with race resistance, use `read()`, `open()`, `write()`, `create()`, `copyIn()`, `move()`, or `remove()`. They re-pin the path identity at the point of use.

### Atomic writes

`replaceFileAtomic` writes to a sibling temp file in the destination directory, optionally `fsync`s it, optionally `fsync`s the parent directory after rename, and atomically renames over the destination. On failure mid-write, the destination is either the old contents (rename never happened) or the new contents (rename succeeded). There is no half-written intermediate state visible at the destination path.

### Archive extraction

`extractArchive` first stages into a private temp directory (mode 0700) outside the destination, validates each entry path against `..` and absolute prefixes, refuses link-type entries by default, enforces entry count and byte budgets, and only then merges the staged tree into the destination through the same boundary checks used by direct writes.

## What "library-level" means

A library cannot revoke its own caller's authority. If your code chooses to bypass `fs-safe` and call `fs.writeFile` directly with the same path, you bypass the defenses too. The contract `fs-safe` enforces is: *every filesystem operation that touches caller-controlled input goes through the boundary*. That contract is yours to keep.

The library does not modify or constrain the global Node.js `fs` namespace, and it does not patch the runtime. Other code in the same process retains its normal filesystem authority.

## Platform notes

- **POSIX (Linux, macOS):** Best-defended path. Uses `O_NOFOLLOW`, `openat`-style helpers via a small Python helper for fd-relative `unlinkat` / `mkdirat` / `renameat`, with a Node fallback when the helper cannot spawn. fd identity checks are reliable.
- **Windows:** Falls back to the safest Node-level behavior available. `O_NOFOLLOW` is not honored. Some fd-relative POSIX hardening is unavailable. The library does the path canonicalization, identity, and atomic-rename checks it can.

The library does not advertise different security guarantees per platform — it advertises the same surface and relies on the strongest mechanism the platform offers.

## Limitations to keep in mind

- **Hardlink rejection** depends on platform-supplied link counts and is best-effort; do not use it as an authorization mechanism for capability decisions.
- **`fs.fchown` / mode bits** are not enforced beyond what `replaceFileAtomic` and the secret-file helpers do — if you need stronger mode enforcement, set umask and inspect mode after writes.
- **Archive extraction** rejects unsafe entries by default but does not interpret payload semantics. A "malicious safe" archive (valid paths, dangerous content) is your application layer's problem.
- **Helper spawn failures** are reported via `helper-failed` / `helper-unavailable` codes. The library falls back to Node-only paths when the Python helper is unavailable; that fallback retains atomicity guarantees but loses some fd-relative race resistance.

## Recommended deployment shape

- Run worker code under a dedicated UID with the smallest filesystem privileges that still allow the worker to do its job.
- Mount the workspace directory writable; mount everything else read-only or not at all.
- Use `fs-safe`'s `root()` for that workspace.
- For credentials, use [secret files](secret-file.md) (mode 0600 in mode-0700 dirs) rather than the workspace.
- For scratch space, use a [private temp workspace](temp.md) — don't reuse the workspace root.

## Reporting issues

Suspected security issues belong in private disclosure first. See [`SECURITY.md`](https://github.com/openclaw/fs-safe/blob/main/SECURITY.md) in the repo for the current contact path.
