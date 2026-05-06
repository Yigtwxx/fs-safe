import type { DirEntry, PathStat } from "./types.js";
import {
  isPinnedHelperUnavailable,
  runPinnedPythonOperation,
  validatePinnedOperationPayload,
} from "./pinned-python.js";

type HelperOperation = "stat" | "readdir" | "mkdirp" | "remove" | "rename";

export { isPinnedHelperUnavailable };

export async function runPinnedHelper<T>(
  operation: HelperOperation,
  rootDir: string,
  payload: Record<string, unknown>,
): Promise<T> {
  validatePinnedOperationPayload(payload);
  return await runPinnedPythonOperation<T>({
    operation,
    rootPath: rootDir,
    payload,
  });
}

export async function helperStat(rootDir: string, relativePath: string): Promise<PathStat> {
  return await runPinnedHelper<PathStat>("stat", rootDir, { relativePath });
}

export async function helperReaddir(
  rootDir: string,
  relativePath: string,
  withFileTypes: false,
): Promise<string[]>;
export async function helperReaddir(
  rootDir: string,
  relativePath: string,
  withFileTypes: true,
): Promise<DirEntry[]>;
export async function helperReaddir(
  rootDir: string,
  relativePath: string,
  withFileTypes: boolean,
): Promise<string[] | DirEntry[]> {
  return await runPinnedHelper<string[] | DirEntry[]>("readdir", rootDir, {
    relativePath,
    withFileTypes,
  });
}
