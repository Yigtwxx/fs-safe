import type { SidecarLockRetryOptions, SidecarLockStaleRecovery } from "./sidecar-lock.js";

export type FsSafeLockConfig = {
  staleRecovery: SidecarLockStaleRecovery;
  staleMs?: number;
  timeoutMs?: number;
  retry?: SidecarLockRetryOptions;
};

const DEFAULT_LOCK_CONFIG: FsSafeLockConfig = {
  staleRecovery: "fail-closed",
};

let lockConfig: FsSafeLockConfig = { ...DEFAULT_LOCK_CONFIG };

export function configureFsSafeLocks(config: Partial<FsSafeLockConfig>): void {
  // Process defaults only fill lock options after a caller explicitly enables
  // locking for a resource; this must never turn sidecar locks on globally.
  lockConfig = { ...lockConfig, ...config };
}

export function getFsSafeLockConfig(): FsSafeLockConfig {
  return { ...lockConfig, retry: lockConfig.retry ? { ...lockConfig.retry } : undefined };
}

