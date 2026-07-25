import fs from "node:fs/promises";
import type { SidecarLockRetryOptions } from "./sidecar-lock-types.js";

export function computeSidecarLockDelayMs(retry: SidecarLockRetryOptions, attempt: number): number {
  const minTimeout = retry.minTimeout ?? 50;
  const maxTimeout = retry.maxTimeout ?? 1000;
  const factor = retry.factor ?? 1;
  const base = Math.min(maxTimeout, Math.max(minTimeout, minTimeout * factor ** attempt));
  const jitter = retry.randomize ? 1 + Math.random() : 1;
  return Math.min(maxTimeout, Math.round(base * jitter));
}

export function sidecarLockPayloadIsStale(
  payload: unknown,
  staleMs: number,
  nowMs: number,
): boolean {
  const createdAt =
    payload &&
    typeof payload === "object" &&
    "createdAt" in payload &&
    typeof payload.createdAt === "string"
      ? payload.createdAt
      : "";
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs > staleMs;
}

export async function defaultSidecarLockShouldReclaim(params: {
  lockPath: string;
  payload: unknown;
  staleMs: number;
  nowMs: number;
}): Promise<boolean> {
  if (sidecarLockPayloadIsStale(params.payload, params.staleMs, params.nowMs)) return true;
  try {
    return params.nowMs - (await fs.stat(params.lockPath)).mtimeMs > params.staleMs;
  } catch {
    return true;
  }
}
