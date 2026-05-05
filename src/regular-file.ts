import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { isNotFoundPathError } from "./path.js";

export type RegularFileStatResult = { missing: true } | { missing: false; stat: Stats };

export async function statRegularFile(filePath: string): Promise<RegularFileStatResult> {
  let stat: Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return { missing: true };
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("path must be a regular file");
  }
  return { missing: false, stat };
}

export async function readRegularFile(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; stat: Stats }> {
  const result = await statRegularFile(params.filePath);
  if (result.missing) {
    throw Object.assign(new Error(`File not found: ${params.filePath}`), { code: "ENOENT" });
  }
  if (params.maxBytes !== undefined && result.stat.size > params.maxBytes) {
    throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
  }
  const buffer = await fs.readFile(params.filePath);
  if (params.maxBytes !== undefined && buffer.byteLength > params.maxBytes) {
    throw new Error(`File exceeds ${params.maxBytes} bytes: ${params.filePath}`);
  }
  return { buffer, stat: result.stat };
}
