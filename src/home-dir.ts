import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "./string-coerce.js";

function normalize(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

function resolveRawHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (explicitHome) {
    if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      const fallbackHome = resolveRawOsHomeDir(env, homedir);
      if (fallbackHome) {
        return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
      }
      return undefined;
    }
    return explicitHome;
  }

  return resolveRawOsHomeDir(env, homedir);
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const envHome = normalize(env.HOME);
  if (envHome) {
    return envHome;
  }
  const userProfile = normalize(env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }
  return normalizeSafe(homedir);
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}

export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}

export function resolveRequiredOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveOsHomeDir(env, homedir) ?? path.resolve(process.cwd());
}

export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  // Normalize and split into path segments. path.normalize converts "/"
  // to the native separator on Windows and leaves "\" as a literal name
  // character on POSIX, so the segment check is platform-correct.
  const segments = path.normalize(input).split(path.sep);
  if (segments[0] !== "~") {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  return path.join(home, ...segments.slice(1));
}

export function resolveHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input) {
    return input;
  }
  const segments = path.normalize(input).split(path.sep)
  if (segments[0] !== "~") {
    return path.resolve(input);
  }
  const expanded = expandHomePrefix(input, {
    home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
    env: opts?.env,
    homedir: opts?.homedir,
  });
  return path.resolve(expanded);
}

export function resolveUserPath(
  input: string,
  optsOrEnv?:
    | {
        env?: NodeJS.ProcessEnv;
        homedir?: () => string;
      }
    | NodeJS.ProcessEnv,
  homedir?: () => string,
): string {
  const opts =
    optsOrEnv && ("env" in optsOrEnv || "homedir" in optsOrEnv)
      ? optsOrEnv
      : { env: optsOrEnv as NodeJS.ProcessEnv | undefined, homedir };
  return resolveHomeRelativePath(input, opts);
}

export function resolveOsHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input) {
    return input;
  }
  const segments = path.normalize(input).split(path.sep);
  if (segments[0] !== "~") {
    return path.resolve(input);
  }
  const expanded = expandHomePrefix(input, {
    home: resolveRequiredOsHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
    env: opts?.env,
    homedir: opts?.homedir,
  });
  return path.resolve(expanded);
}
