import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { assertSafePathSegment, sanitizeSafePathSegment } from "./safe-path-segment.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { registerTempPathForExit } from "./temp-cleanup.js";

export type TempFile = {
  dir: string;
  path: string;
  file(fileName?: string): string;
  cleanup: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

function sanitizePrefix(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "tmp";
}

function sanitizeExtension(extension?: string): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = normalized.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "";
  const token = suffix.replace(/^[._-]+/, "");
  return token ? `.${token}` : "";
}

export function sanitizeTempFileName(fileName: string): string {
  return sanitizeSafePathSegment(path.basename(fileName), "download.bin", {
    allowDotPrefix: true,
  });
}

export function buildRandomTempFilePath(params: {
  rootDir?: string;
  prefix: string;
  extension?: string;
  now?: number;
  uuid?: string;
}): string {
  const rootDir = resolveTempRoot(params.rootDir);
  const prefix = sanitizePrefix(params.prefix);
  const extension = sanitizeExtension(params.extension);
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid
    ? assertSafePathSegment(params.uuid.trim(), { label: "temp uuid" })
    : crypto.randomUUID();
  return path.join(rootDir, `${prefix}-${now}-${uuid}${extension}`);
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}

async function cleanupTempDir(dir: string, onCleanupError?: (error: unknown) => void) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (!isNodeErrorWithCode(err, "ENOENT")) {
      onCleanupError?.(err);
    }
  }
}

function resolveTempRoot(rootDir?: string): string {
  return rootDir ?? resolveSecureTempRoot({ fallbackPrefix: "fs-safe" });
}

export async function tempFile(params: {
  rootDir?: string;
  prefix: string;
  fileName?: string;
  onCleanupError?: (error: unknown) => void;
}): Promise<TempFile> {
  const rootDir = resolveTempRoot(params.rootDir);
  const prefix = `${sanitizePrefix(params.prefix)}-`;
  const dir = await mkdtemp(path.join(rootDir, prefix));
  const unregisterTempDir = registerTempPathForExit(dir, { recursive: true });
  const file = (fileName?: string) =>
    path.join(dir, sanitizeTempFileName(fileName ?? params.fileName ?? "download.bin"));
  const cleanup = async () => {
    try {
      await cleanupTempDir(dir, params.onCleanupError);
    } finally {
      unregisterTempDir();
    }
  };
  return {
    dir,
    path: file(),
    file,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

export async function withTempFile<T>(
  params: {
    rootDir?: string;
    prefix: string;
    fileName?: string;
    onCleanupError?: (error: unknown) => void;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const target = await tempFile(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}
