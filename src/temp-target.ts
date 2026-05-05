import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export type TempFileTarget = {
  dir: string;
  path: string;
  cleanup: () => Promise<void>;
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
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const normalized = base.replace(/^-+|-+$/g, "");
  return normalized || "download.bin";
}

export function buildRandomTempFilePath(params: {
  rootDir: string;
  prefix: string;
  extension?: string;
  now?: number;
  uuid?: string;
}): string {
  const prefix = sanitizePrefix(params.prefix);
  const extension = sanitizeExtension(params.extension);
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  return path.join(params.rootDir, `${prefix}-${now}-${uuid}${extension}`);
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

export async function createTempFileTarget(params: {
  rootDir: string;
  prefix: string;
  fileName?: string;
  onCleanupError?: (error: unknown) => void;
}): Promise<TempFileTarget> {
  const prefix = `${sanitizePrefix(params.prefix)}-`;
  const dir = await mkdtemp(path.join(params.rootDir, prefix));
  return {
    dir,
    path: path.join(dir, sanitizeTempFileName(params.fileName ?? "download.bin")),
    cleanup: async () => {
      await cleanupTempDir(dir, params.onCleanupError);
    },
  };
}

export async function withTempFileTarget<T>(
  params: {
    rootDir: string;
    prefix: string;
    fileName?: string;
    onCleanupError?: (error: unknown) => void;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const target = await createTempFileTarget(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}
