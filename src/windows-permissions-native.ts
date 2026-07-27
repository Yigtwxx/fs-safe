import { getNativeBinding } from "./native.js";
import type { PermissionCheck, SafeStatResult } from "./permissions.js";

export function inspectWindowsPermissionsNative(params: {
  targetPath: string;
  stat: SafeStatResult;
  effectiveIsDir: boolean;
  effectiveMode: number | null;
  bits: number | null;
}): PermissionCheck | undefined {
  const native = getNativeBinding();
  if (!native) return undefined;
  try {
    const facts = native.readOwnerAndDacl(params.targetPath);
    if (facts.fallbackRequired) return undefined;
    return {
      ok: true,
      isSymlink: params.stat.isSymlink,
      isDir: params.effectiveIsDir,
      mode: params.effectiveMode,
      bits: params.bits,
      source: "windows-acl",
      worldWritable: facts.worldWritable,
      groupWritable: facts.groupWritable,
      worldReadable: facts.worldReadable,
      groupReadable: facts.groupReadable,
      ownerSid: facts.ownerSid,
      ownerTrusted: facts.ownerClass !== "foreign",
      aclSummary:
        `native owner=${facts.ownerClass} world=` +
        `${facts.worldReadable ? "r" : "-"}${facts.worldWritable ? "w" : "-"} ` +
        `group=${facts.groupReadable ? "r" : "-"}${facts.groupWritable ? "w" : "-"}`,
    };
  } catch {
    return undefined;
  }
}
