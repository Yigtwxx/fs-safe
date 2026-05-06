# Archive extraction

`@openclaw/fs-safe/archive` extracts ZIP and TAR archives behind one API, with traversal checks, blocked-link-type rejection, and entry-count and byte budgets. Extraction stages into a private directory and merges through the same safe-open boundary used by direct writes — a symlinked entry can't trick the merge into following an out-of-tree path.

Archive extraction uses optional runtime dependencies: `jszip` for ZIP and `tar`
for TAR. Installs that omit optional dependencies can still import this subpath,
inspect archive kinds, and use pure path/limit helpers, but extraction or ZIP
loading fails with a clear message until the matching optional dependency is
installed.

Some package managers and CI installs skip optional dependencies
(`--no-optional`, `--omit=optional`, or equivalent). If an archive helper throws
that an optional archive dependency is not installed, install `jszip` and/or
`tar` explicitly in the consuming package.

```ts
import { extractArchive, resolveArchiveKind } from "@openclaw/fs-safe/archive";
```

## `extractArchive`

```ts
await extractArchive({
  archivePath: "/srv/uploads/plugin.zip",
  destDir: "/srv/workspace/plugins/plugin",
  kind: "zip",                        // optional; resolveArchiveKind() can infer
  timeoutMs: 15_000,                  // hard ceiling for the whole extraction
  stripComponents: 0,                 // tar-style strip-leading-dirs
  limits: {
    maxArchiveBytes: 256 * 1024 * 1024,
    maxEntries: 50_000,
    maxExtractedBytes: 512 * 1024 * 1024,
    maxEntryBytes: 256 * 1024 * 1024,
  },
});
```

### Parameters

```ts
type ExtractArchiveParams = {
  archivePath: string;          // absolute path to the archive
  destDir: string;              // absolute destination directory; must already exist
  timeoutMs: number;            // wall-clock cap; throws on overrun
  kind?: ArchiveKind;           // "zip" | "tar"; inferred from filename when omitted
  stripComponents?: number;     // strip N leading dirs from entry paths
  tarGzip?: boolean;            // when archive is .tar.gz/.tgz
  limits?: ArchiveExtractLimits;
  logger?: ArchiveLogger;       // { info?, warn? }
};
```

If `kind` is omitted, the helper calls `resolveArchiveKind(archivePath)` and throws if the extension is not recognized. Pass `kind` explicitly when the archive name doesn't carry the type (e.g. content-addressed names).

### Limits

```ts
type ArchiveExtractLimits = {
  maxArchiveBytes?: number;     // refuse if archivePath stat'd size exceeds this
  maxEntries?: number;          // refuse before extracting if entry count > this
  maxExtractedBytes?: number;   // refuse mid-stream if total extracted bytes > this
  maxEntryBytes?: number;       // refuse a single entry larger than this
};
```

Defaults exist for each (`DEFAULT_MAX_ARCHIVE_BYTES_ZIP`, `DEFAULT_MAX_ENTRIES`, `DEFAULT_MAX_EXTRACTED_BYTES`, `DEFAULT_MAX_ENTRY_BYTES`). They are conservative — pass explicit values when you know your domain's actual ceiling.

A limit violation throws `ArchiveLimitError`. The error's code is one of:

```ts
ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_BYTES_EXCEEDS_LIMIT
ARCHIVE_LIMIT_ERROR_CODE.ENTRY_BYTES_EXCEEDS_LIMIT
```

Catch and branch on the code to surface a meaningful response to the caller.

## What it defends against

- **Path traversal:** entries with `..`, absolute paths, or Windows drive prefixes are rejected (`ArchiveSecurityError`).
- **Symlink/hardlink entries:** rejected by default. Some archives ship symlink/hardlink entries that point outside the destination once resolved; `extractArchive` does not follow them.
- **TOCTOU during merge:** extraction first writes to a private temp dir, then merges into `destDir` using the same boundary checks as `root().write()`. A symlink swap in the destination tree mid-merge is caught.
- **Zip bombs:** `maxExtractedBytes` and `maxEntryBytes` apply to *post-decompression* bytes, so highly-compressed payloads hit the cap before they exhaust disk.
- **Slow-loris archives:** `timeoutMs` is a hard wall-clock budget. Extraction is aborted on overrun.

## `resolveArchiveKind`

```ts
import { resolveArchiveKind, type ArchiveKind } from "@openclaw/fs-safe/archive";

const kind = resolveArchiveKind("upload.zip"); // "zip"
const tar = resolveArchiveKind("upload.tar.gz"); // "tar"
const unknown = resolveArchiveKind("upload.bin"); // undefined
```

Recognizes:

- `*.zip` → `"zip"`
- `*.tar`, `*.tar.gz`, `*.tgz`, `*.tar.bz2`, `*.tbz`, `*.tbz2` → `"tar"`

Returns `undefined` for unknown extensions; check the result before calling `extractArchive` if the filename is caller-controlled.

## Lower-level building blocks

The archive subpath also exports the helpers `extractArchive` is built on. Most callers will not need them, but they are stable and documented:

| Function | Purpose |
|---|---|
| `withStagedArchiveDestination(opts)` | Creates a private staging dir outside the destination, calls your `run(stagingDir)`, then cleans it up. |
| `mergeExtractedTreeIntoDestination(opts)` | The merge step alone — staged tree → destination through boundary checks. |
| `prepareArchiveDestinationDir(destDir)` | Canonicalizes and asserts the destination directory. |
| `prepareArchiveOutputPath(opts)` | Resolves a single entry's output path against the staging dir. |
| `loadZipArchiveWithPreflight(opts)` | Loads a JSZip with size/entry-count preflight before unzipping. |
| `readZipCentralDirectoryEntryCount(path)` | Returns the entry count from a ZIP's central directory without reading any payloads. |
| `createTarEntryPreflightChecker(opts)` | Returns a per-entry checker for use as a `tar.x` `onReadEntry` hook. |

These let you build custom extractors that share the same safety machinery — for example, a streaming uploader that wants to refuse archives with too many entries before reading any payloads.

## Path helpers

`archive-entry` exports a handful of low-level helpers for entry-path normalization:

```ts
import {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "@openclaw/fs-safe/archive";
```

- `validateArchiveEntryPath(raw, opts)` — throws `ArchiveSecurityError` for `..`, absolute, drive-prefixed, or otherwise unsafe entry paths.
- `normalizeArchiveEntryPath(raw)` — POSIX-normalizes the entry path (forward slashes, no `.` segments).
- `stripArchivePath(entryPath, n)` — strip the leading N path components, returning `null` if not enough remain.
- `resolveArchiveOutputPath({ destDir, entryPath })` — combines the entry path with the destination, after validation.
- `isWindowsDrivePath(value)` — detects `C:\…` style entries that should be rejected.

## Common patterns

### Extract an upload, surface budget violations

```ts
import { extractArchive, ArchiveLimitError, ARCHIVE_LIMIT_ERROR_CODE } from "@openclaw/fs-safe/archive";

try {
  await extractArchive({
    archivePath: upload.path,
    destDir: targetDir,
    kind: "zip",
    timeoutMs: 30_000,
    limits: {
      maxArchiveBytes: 100 * 1024 * 1024,
      maxEntries: 10_000,
      maxExtractedBytes: 200 * 1024 * 1024,
      maxEntryBytes: 50 * 1024 * 1024,
    },
  });
} catch (err) {
  if (err instanceof ArchiveLimitError) {
    return reply(413, { code: err.code, message: err.message });
  }
  throw err;
}
```

### Decide kind from MIME, not filename

```ts
const kind: ArchiveKind = mime === "application/zip" ? "zip" : "tar";
await extractArchive({ archivePath, destDir, kind, timeoutMs: 10_000 });
```

### Stage to private dir, then commit as a directory

```ts
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { replaceDirectoryAtomic } from "@openclaw/fs-safe/atomic";

await withTempWorkspace({ rootDir: "/srv/site/tmp", prefix: "extract-" }, async (ws) => {
  await extractArchive({
    archivePath: upload.path,
    destDir: ws.dir,
    timeoutMs: 30_000,
  });
  await replaceDirectoryAtomic({
    stagedDir: ws.dir,
    targetDir: "/srv/site/plugin",
  });
});
```

## See also

- [Atomic writes](atomic.md) — `replaceDirectoryAtomic` for staged directory replacement.
- [Temp workspaces](temp.md) — extract into a private workspace and commit as one step.
- [Errors](errors.md) — `FsSafeError` codes the underlying writes can raise.
- [`extractArchive` source](https://github.com/openclaw/fs-safe/blob/main/src/archive.ts).
