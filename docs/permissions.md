# Permissions

`@openclaw/fs-safe/permissions` contains the curated mode and permission inspection helpers used by secure file reads and by applications that want to report actionable permission problems.

```ts
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
} from "@openclaw/fs-safe/permissions";

const perms = await inspectPathPermissions("/var/lib/app/auth.token");
console.log(formatPermissionDetail("/var/lib/app/auth.token", perms));
if (perms.ok && (perms.groupReadable || perms.worldReadable)) {
  console.log(
    formatPermissionRemediation({
      targetPath: "/var/lib/app/auth.token",
      perms,
      isDir: false,
      posixMode: 0o600,
    }),
  );
}
```

## POSIX helpers

```ts
safeStat(path);
inspectPathPermissions(path, options?);
formatPermissionDetail(path, check);
formatPermissionRemediation({ targetPath, perms, isDir, posixMode });
modeBits(mode);
formatOctal(bits);
isWorldWritable(bits);
isGroupWritable(bits);
isWorldReadable(bits);
isGroupReadable(bits);
```

`inspectPathPermissions()` follows symlink targets for the effective mode but tells you whether the original path was a symlink. On POSIX it reports owner/group/world bits. On Windows it delegates to the ACL helpers below.

## Advanced Windows ACL helpers

The low-level Windows ACL parser and `icacls` command builders live in `@openclaw/fs-safe/advanced`:

```ts
import {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  summarizeWindowsAcl,
} from "@openclaw/fs-safe/advanced";

inspectWindowsAcl(path, { env, exec });
parseIcaclsOutput(output, targetPath);
summarizeWindowsAcl(entries, env);
formatWindowsAclSummary(summary);
formatIcaclsResetCommand(targetPath, { isDir, env });
createIcaclsResetCommand(targetPath, { isDir, env });
resolveWindowsUserPrincipal(env);
```

The default Windows inspector calls `icacls.exe /sid` and classifies principals as trusted, world, or group. Trusted defaults include the current user, SYSTEM, and Administrators. The parser is on the advanced surface so tests and CLIs can process captured `icacls` output without spawning a process.

Use `createIcaclsResetCommand()` when you need a structured command and argv pair. Use `formatIcaclsResetCommand()` when you only need a remediation string for a user-facing message.

## Types

```ts
type PermissionCheck = {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  bits: number | null;
  source: "posix" | "windows-acl" | "unknown";
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  aclSummary?: string;
  error?: string;
};
```

`ok: false` means the path itself could not be inspected. `ok: true` with `source: "unknown"` means basic stat information was available, but the platform-specific permission source could not be verified.

## See also

- [Secure file reads](secure-file.md) — fd-pinned reads that enforce these checks.
- [Errors](errors.md) — permission-related `FsSafeError` codes.
