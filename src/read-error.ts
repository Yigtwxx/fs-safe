import { FsSafeError } from "./errors.js";
import { isNodeError } from "./path.js";

export function throwFsSafeReadError(error: unknown, label: string): never {
  if (error instanceof FsSafeError) {
    throw error;
  }
  if (isNodeError(error)) {
    throw new FsSafeError("read-failed", `${label} target could not be read`, { cause: error });
  }
  throw error;
}
