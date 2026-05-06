import { FsSafeError } from "./errors.js";

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export type SafePathSegmentOptions = {
  allowDotPrefix?: boolean;
  label?: string;
};

export function isSafePathSegment(
  segment: string,
  options: SafePathSegmentOptions = {},
): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0") &&
    (options.allowDotPrefix === true || !segment.startsWith(".")) &&
    (options.allowDotPrefix === true
      ? SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN.test(segment)
      : SAFE_PATH_SEGMENT_PATTERN.test(segment))
  );
}

export function assertSafePathSegment(
  segment: string,
  options: SafePathSegmentOptions = {},
): string {
  // Validate the exact value callers will later join into paths; trimming here
  // would let whitespace-padded ids pass and then be used verbatim.
  if (!isSafePathSegment(segment, options)) {
    throw new FsSafeError(
      "invalid-path",
      `${options.label ?? "path segment"} must be a safe path segment`,
    );
  }
  return segment;
}

export function sanitizeSafePathSegment(
  value: string,
  fallback: string,
  options: SafePathSegmentOptions = {},
): string {
  const sanitized = value
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\0/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (isSafePathSegment(sanitized, options)) {
    return sanitized;
  }
  return assertSafePathSegment(fallback, { ...options, label: "fallback path segment" });
}
