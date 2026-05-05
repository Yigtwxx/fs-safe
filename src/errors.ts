export type FsSafeErrorCode =
  | "already-exists"
  | "hardlink"
  | "helper-failed"
  | "helper-unavailable"
  | "invalid-path"
  | "not-empty"
  | "not-file"
  | "not-found"
  | "not-removable"
  | "outside-workspace"
  | "path-alias"
  | "path-mismatch"
  | "symlink"
  | "too-large"
  | "unsupported-platform";

export class FsSafeError extends Error {
  readonly code: FsSafeErrorCode;
  readonly cause?: unknown;

  constructor(code: FsSafeErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "FsSafeError";
    this.code = code;
    this.cause = options.cause;
  }
}
