import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertNoNulPathInput, isPathInside } from "./path.js";

export type MutationPathPolicy = {
  denyExact?: readonly string[];
  denyPrefixes?: readonly string[];
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (path.dirname(cursor) !== cursor && !(await pathExists(cursor))) {
    missingSuffix.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }

  if (!(await pathExists(cursor))) {
    return normalized;
  }

  try {
    const resolvedAncestor = path.resolve(await fs.realpath(cursor));
    return missingSuffix.length === 0
      ? resolvedAncestor
      : path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

async function comparablePaths(rawPath: string): Promise<Set<string>> {
  assertNoNulPathInput(rawPath, "path contains a NUL byte");
  const resolved = path.resolve(rawPath);
  return new Set([resolved, await resolvePathViaExistingAncestor(resolved)]);
}

function isSamePath(left: string, right: string): boolean {
  return isPathInside(left, right) && isPathInside(right, left);
}

function hasPolicyEntries(policy: MutationPathPolicy | undefined): policy is MutationPathPolicy {
  return Boolean(policy?.denyExact?.length || policy?.denyPrefixes?.length);
}

function policyPathEntries(entries: readonly string[] | undefined): string[] {
  const paths: string[] = [];
  for (const entry of entries ?? []) {
    const candidate = entry.trim();
    if (!candidate) {
      continue;
    }
    assertNoNulPathInput(candidate, "mutation policy path contains a NUL byte");
    if (!path.isAbsolute(candidate)) {
      throw new FsSafeError("invalid-path", "mutation policy paths must be absolute");
    }
    paths.push(candidate);
  }
  return paths;
}

export async function assertMutationPathAllowed(
  filePath: string,
  policy: MutationPathPolicy | undefined,
): Promise<void> {
  if (!hasPolicyEntries(policy)) {
    return;
  }

  const targetPaths = await comparablePaths(filePath);
  for (const deniedPath of policyPathEntries(policy.denyExact)) {
    const deniedPaths = await comparablePaths(deniedPath);
    for (const target of targetPaths) {
      for (const denied of deniedPaths) {
        if (isSamePath(denied, target)) {
          throw new FsSafeError("denied-path", "path is denied by mutation policy");
        }
      }
    }
  }

  for (const deniedPrefix of policyPathEntries(policy.denyPrefixes)) {
    const deniedPaths = await comparablePaths(deniedPrefix);
    for (const target of targetPaths) {
      for (const denied of deniedPaths) {
        if (isPathInside(denied, target)) {
          throw new FsSafeError("denied-path", "path is denied by mutation policy");
        }
      }
    }
  }
}

export function mergeMutationPathPolicies(
  defaultPolicy: MutationPathPolicy | undefined,
  callPolicy: MutationPathPolicy | undefined,
): MutationPathPolicy | undefined {
  if (!defaultPolicy) {
    return callPolicy;
  }
  if (!callPolicy) {
    return defaultPolicy;
  }
  return {
    denyExact: [...(defaultPolicy.denyExact ?? []), ...(callPolicy.denyExact ?? [])],
    denyPrefixes: [...(defaultPolicy.denyPrefixes ?? []), ...(callPolicy.denyPrefixes ?? [])],
  };
}
