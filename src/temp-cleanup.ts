import fsSync from "node:fs";

type TempCleanupEntry = {
  path: string;
  recursive: boolean;
};

const tempCleanupEntries = new Map<string, TempCleanupEntry>();
let cleanupRegistered = false;

function cleanupRegisteredTempPathsSync(): void {
  for (const entry of tempCleanupEntries.values()) {
    try {
      fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
    } catch {
      // Process-exit cleanup is best-effort.
    }
  }
  tempCleanupEntries.clear();
}

export function registerTempPathForExit(
  tempPath: string,
  options?: { recursive?: boolean },
): () => void {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", cleanupRegisteredTempPathsSync);
  }
  tempCleanupEntries.set(tempPath, {
    path: tempPath,
    recursive: options?.recursive === true,
  });
  return () => {
    tempCleanupEntries.delete(tempPath);
  };
}

export function __cleanupRegisteredTempPathsForTest(): void {
  cleanupRegisteredTempPathsSync();
}

export function __cleanupRegisteredTempPathForTest(tempPath: string): void {
  const entry = tempCleanupEntries.get(tempPath);
  if (!entry) {
    return;
  }
  try {
    fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
  } finally {
    tempCleanupEntries.delete(tempPath);
  }
}
