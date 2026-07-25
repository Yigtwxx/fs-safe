---
title: Directory durability
description: "Pin directory identities, fsync publication metadata, and durably create nested directory paths."
---

# Directory durability

`@openclaw/fs-safe/durability` provides the directory side of crash-safe file
publication. Flushing a file does not guarantee that its containing directory
entry reached storage; callers that promise durable create, link, rename, or
unlink operations must also synchronize the affected directory.

```ts
import {
  ensureDurableDirectory,
  pinDirectory,
} from "@openclaw/fs-safe/durability";

const repository = await ensureDurableDirectory({
  directoryPath: "/srv/backups/sqlite",
  mode: 0o700,
});

const pinned = await pinDirectory(repository, { label: "backup repository" });
try {
  await publishSnapshot();
  const outcome = await pinned.sync();
  if (outcome.status === "unsupported") {
    // Decide at the product boundary whether this platform can weaken the promise.
  }
} finally {
  await pinned.close();
}
```

## Outcomes and failure semantics

`syncDirectory()` and `PinnedDirectory.sync()` return:

```ts
type DirectorySyncOutcome =
  | { status: "synced" }
  | { status: "unsupported"; code?: string };
```

POSIX synchronization failures propagate. Windows directory handles do not
portably support `FlushFileBuffers`; the known unsupported error family is
reported as `unsupported` after the pathname and pinned identity are checked
again. Directory-open access failures and other Windows I/O failures still
propagate.

`syncDirectoryBestEffort()` and `syncDirectoryBestEffortSync()` intentionally
discard both unsupported outcomes and failures. Use them only when the primary
write remains useful without a crash-durability promise.

## Pinned directories

`pinDirectory()` rejects final symlinks and non-directories. On POSIX it opens
with `O_DIRECTORY`, `O_NOFOLLOW`, and `O_NONBLOCK`, then compares the open
descriptor, pathname identity, and canonical path. `assertCurrent()` repeats
those checks. This prevents a pathname replacement from turning a later sync
into proof for a different directory.

Call `close()` in `finally`. Closing is idempotent; using a closed pin fails.

## Durable directory creation

`ensureDurableDirectory()` finds and pins the nearest existing ancestor,
creates the requested path, opens every new directory segment, and synchronizes
each new parent-to-child edge from the leaf upward. It returns the final
directory receipt plus the aggregate parent-sync outcome.

By default it uses fs-safe's guarded one-segment-at-a-time absolute-directory
creator. Advanced callers can pass `create` when directory creation needs
platform-specific ACLs or another product-owned policy. The callback owns the
safety of its mutations and must create exactly `directoryPath`; fs-safe
validates and pins every resulting segment before any synchronization is
accepted.

`expectedExistingIdentity` binds an existing target to an identity observed by
the caller before a separate permission or policy check. A missing or replaced
target fails with `FsSafeError("path-mismatch")`.

## Exclusive file publication

`publishFileExclusive()` materializes one file without clobbering an existing
target. It pins the source with `O_NOFOLLOW`, optionally verifies
`expectedSourceIdentity`, tries a hardlink first, then synchronizes the target
parent directory.

```ts
const result = await publishFileExclusive({
  sourcePath: stagedPath,
  targetPath: finalPath,
  strategy: "link-or-copy",
  parentReceipt,
});
// result.method: "hardlink" | "exclusive-copy"
// result.identity: the verified target Stats
// result.directorySync: strict directory-sync outcome
```

`"link-required"` propagates an unsupported hardlink failure.
`"link-or-copy"` falls back only for `EPERM`, `EXDEV`, `ENOTSUP`,
`EOPNOTSUPP`, or `ENOSYS`; `isHardlinkFallbackError()` exposes that exact
classifier. The fallback copies from the pinned source into a `wx` target,
fsyncs it, and fences source and target identity and content before reporting
success. `parentReceipt`, when supplied, must name the target's direct parent.

With a native binding, the copy fallback first attempts a copy-on-write clone
(`fclonefileat` on macOS, `FICLONE` on Linux), then Linux
`copy_file_range`, and finally the existing JavaScript byte loop. Every route
creates the target exclusively, normalizes its mode to `0o600`, and goes
through the same post-copy identity and SHA-256 fencing. Hashing uses an async
native task when available, so large verification reads do not occupy the
JavaScript event loop.

On a clone-capable filesystem, publication of a large file becomes mostly a
metadata operation: data blocks are shared copy-on-write until either file is
modified. Clone support is filesystem- and mount-dependent, so callers must
not infer durability or physical independence from timing; an unsupported
clone or `copy_file_range` transparently continues down the fallback chain.

If publication fails after this call created the target, it throws an
`FsSafeError` with a `details` receipt:

```ts
type PublishFileExclusiveFailureDetails = {
  phase:
    | "hardlink-create" | "hardlink-verify"
    | "copy-create" | "copy-verify"
    | "rename-create" | "rename-verify"
    | "directory-sync";
  targetCreated: boolean;
  targetIdentity?: { dev: number | bigint; ino: number | bigint };
  cleanup: "removed" | "preserved" | "unknown";
};
```

`"removed"` means the path still matched the identity created by this call and
was unlinked (or was already absent). `"preserved"` means it was deliberately
retained—for example after a successful no-replace rename—or the pathname had
been replaced and therefore was not safe to remove. `"unknown"` means cleanup
could not verify or remove the created identity. Callers that run a second
application-level guard, such as SQLite snapshot validation, should branch on
this receipt instead of inferring ownership from path existence. The original
failure remains available as `cause`. Failures before target creation retain
their existing error shape and do not claim a cleanup result.

`"rename-noreplace"` requires the native helper and atomically moves the
source to the target without replacement. A collision is reported as
`EEXIST`, both files remain unchanged, and a successful call returns
`method: "rename-noreplace"` after synchronizing the source and target parent
directories. Unlike the link/copy strategies, success consumes `sourcePath`.

## Scope

These primitives establish path identity and filesystem synchronization. One
`publishFileExclusive()` call is one no-clobber file materialization, not a
retention policy, multi-file transaction, or application commit protocol. They
do not decide application commit protocols, marker formats, permission policy,
or whether an unsupported platform is acceptable. Keep those decisions at the
owning product boundary.
