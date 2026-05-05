import {
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import {
  assertArchiveEntryCountWithinLimit,
  createByteBudgetTracker,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";

export type TarEntryInfo = { path: string; type: string; size: number };

const BLOCKED_TAR_ENTRY_TYPES = new Set([
  "SymbolicLink",
  "Link",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
]);

export function readTarEntryInfo(entry: unknown): TarEntryInfo {
  const p =
    typeof entry === "object" && entry !== null && "path" in entry
      ? String((entry as { path: unknown }).path)
      : "";
  const t =
    typeof entry === "object" && entry !== null && "type" in entry
      ? String((entry as { type: unknown }).type)
      : "";
  const s =
    typeof entry === "object" &&
    entry !== null &&
    "size" in entry &&
    typeof (entry as { size?: unknown }).size === "number" &&
    Number.isFinite((entry as { size: number }).size)
      ? Math.max(0, Math.floor((entry as { size: number }).size))
      : 0;
  return { path: p, type: t, size: s };
}

export function createTarEntryPreflightChecker(params: {
  rootDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
  escapeLabel?: string;
}): (entry: TarEntryInfo) => void {
  const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
  const limits = resolveExtractLimits(params.limits);
  let entryCount = 0;
  const budget = createByteBudgetTracker(limits);

  return (entry: TarEntryInfo) => {
    validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });

    const relPath = stripArchivePath(entry.path, strip);
    if (!relPath) {
      return;
    }
    validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
    resolveArchiveOutputPath({
      rootDir: params.rootDir,
      relPath,
      originalPath: entry.path,
      escapeLabel: params.escapeLabel,
    });

    if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) {
      throw new Error(`tar entry is a link: ${entry.path}`);
    }

    entryCount += 1;
    assertArchiveEntryCountWithinLimit(entryCount, limits);
    budget.addEntrySize(entry.size);
  };
}
