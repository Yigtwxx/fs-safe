import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { canFallbackFromPythonError, getFsSafePythonConfig } from "./pinned-python-config.js";
import {
  assertPinnedPythonOperationAvailable,
  runPinnedPythonOperation,
  validatePinnedOperationPayload,
} from "./pinned-python.js";

type PinnedWriteInput =
  | { kind: "buffer"; data: string | Buffer; encoding?: BufferEncoding }
  | { kind: "stream"; stream: Readable };

function byteLength(input: string | Buffer, encoding: BufferEncoding | undefined): number {
  return typeof input === "string"
    ? Buffer.byteLength(input, encoding ?? "utf8")
    : input.byteLength;
}

function assertSafeBasename(basename: string): void {
  if (
    !basename ||
    basename === "." ||
    basename === ".." ||
    basename.includes("/") ||
    basename.includes("\0")
  ) {
    throw new FsSafeError("invalid-path", "invalid target path");
  }
}

function assertWithinMaxBytes(bytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`,
    );
  }
}

function createMaxBytesTransform(maxBytes: number | undefined): Transform | undefined {
  if (maxBytes === undefined) {
    return undefined;
  }
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        callback(
          new FsSafeError(
            "too-large",
            `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

async function pipelineWithMaxBytes(
  stream: Readable,
  destination: NodeJS.WritableStream,
  maxBytes: number | undefined,
): Promise<void> {
  const limiter = createMaxBytesTransform(maxBytes);
  if (limiter) {
    await pipeline(stream, limiter, destination);
    return;
  }
  await pipeline(stream, destination);
}

async function inputToBase64(
  input: PinnedWriteInput,
  maxBytes: number | undefined,
): Promise<string> {
  if (input.kind === "buffer") {
    assertWithinMaxBytes(byteLength(input.data, input.encoding), maxBytes);
    return (
      typeof input.data === "string"
        ? Buffer.from(input.data, input.encoding ?? "utf8")
        : input.data
    ).toString("base64");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input.stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    assertWithinMaxBytes(bytes, maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("base64");
}

export async function runPinnedWriteHelper(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  overwrite?: boolean;
  maxBytes?: number;
  input: PinnedWriteInput;
}): Promise<FileIdentityStat> {
  if (getFsSafePythonConfig().mode === "off") {
    return await runPinnedWriteFallback(params);
  }
  assertSafeBasename(params.basename);
  validatePinnedOperationPayload({
    relativeParentPath: params.relativeParentPath,
  });
  if (params.input.kind === "stream") {
    try {
      assertPinnedPythonOperationAvailable();
    } catch (error) {
      if (canFallbackFromPythonError(error)) {
        return await runPinnedWriteFallback(params);
      }
      throw error;
    }
  }
  const payload = {
    base64: await inputToBase64(params.input, params.maxBytes),
    basename: params.basename,
    maxBytes: params.maxBytes ?? -1,
    mkdir: params.mkdir,
    mode: params.mode || 0o600,
    overwrite: params.overwrite !== false,
    relativeParentPath: params.relativeParentPath,
  };
  try {
    return await runPinnedPythonOperation<FileIdentityStat>({
      operation: "write",
      rootPath: params.rootPath,
      payload,
    });
  } catch (error) {
    if (canFallbackFromPythonError(error)) {
      return await runPinnedWriteFallback(params);
    }
    throw error;
  }
}

export async function runPinnedCopyHelper(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  overwrite?: boolean;
  maxBytes?: number;
  sourcePath: string;
  sourceIdentity: FileIdentityStat;
}): Promise<FileIdentityStat> {
  assertSafeBasename(params.basename);
  validatePinnedOperationPayload({
    relativeParentPath: params.relativeParentPath,
  });
  return await runPinnedPythonOperation<FileIdentityStat>({
    operation: "copy",
    rootPath: params.rootPath,
    payload: {
      basename: params.basename,
      maxBytes: params.maxBytes ?? -1,
      mkdir: params.mkdir,
      mode: params.mode || 0o600,
      overwrite: params.overwrite !== false,
      relativeParentPath: params.relativeParentPath,
      sourceDev: params.sourceIdentity.dev,
      sourceIno: params.sourceIdentity.ino,
      sourcePath: params.sourcePath,
    },
  });
}

async function runPinnedWriteFallback(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  overwrite?: boolean;
  maxBytes?: number;
  input: PinnedWriteInput;
}): Promise<FileIdentityStat> {
  const parentPath = params.relativeParentPath
    ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
    : params.rootPath;
  if (params.mkdir) {
    await fs.mkdir(parentPath, { recursive: true });
  }
  const targetPath = path.join(parentPath, params.basename);
  if (params.overwrite === false) {
    const handle = await fs.open(
      targetPath,
      fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
      params.mode,
    );
    let created = true;
    try {
      if (params.input.kind === "buffer") {
        assertWithinMaxBytes(
          byteLength(params.input.data, params.input.encoding),
          params.maxBytes,
        );
        if (typeof params.input.data === "string") {
          await handle.writeFile(params.input.data, params.input.encoding ?? "utf8");
        } else {
          await handle.writeFile(params.input.data);
        }
      } else {
        await pipelineWithMaxBytes(
          params.input.stream,
          handle.createWriteStream(),
          params.maxBytes,
        );
      }
      const stat = await handle.stat();
      created = false;
      return { dev: stat.dev, ino: stat.ino };
    } finally {
      await handle.close().catch(() => undefined);
      if (created) {
        await fs.rm(targetPath, { force: true }).catch(() => undefined);
      }
    }
  }

  const tempPath = path.join(parentPath, `.${params.basename}.fallback.tmp`);
  try {
    if (params.input.kind === "buffer") {
      assertWithinMaxBytes(
        byteLength(params.input.data, params.input.encoding),
        params.maxBytes,
      );
      if (typeof params.input.data === "string") {
        await fs.writeFile(tempPath, params.input.data, {
          encoding: params.input.encoding ?? "utf8",
          mode: params.mode,
        });
      } else {
        await fs.writeFile(tempPath, params.input.data, { mode: params.mode });
      }
    } else {
      const handle = await fs.open(tempPath, "w", params.mode);
      try {
        await pipelineWithMaxBytes(
          params.input.stream,
          handle.createWriteStream(),
          params.maxBytes,
        );
      } finally {
        await handle.close().catch(() => {});
      }
    }
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const stat = await fs.stat(targetPath);
  return { dev: stat.dev, ino: stat.ino };
}
