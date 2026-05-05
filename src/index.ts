export { FsSafeError, type FsSafeErrorCode } from "./errors.js";
export {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  PRIVATE_SECRET_DIR_MODE,
  PRIVATE_SECRET_FILE_MODE,
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
  writePrivateSecretFileAtomic,
  type SecretFileReadOptions,
  type SecretFileReadResult,
} from "./secret-file.js";
export {
  ROOT_PATH_ALIAS_POLICIES,
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
} from "./root-path.js";
export * from "./root-paths.js";
export {
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  openRootFile,
  openRootFileSync,
  type RootFileOpenFailure,
  type RootFileOpenFailureReason,
  type RootFileOpenResult,
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
} from "./root-file.js";
export { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
export {
  openPinnedFileSync,
  type PinnedOpenSyncAllowedType,
  type PinnedOpenSyncFailureReason,
  type PinnedOpenSyncFs,
  type PinnedOpenSyncResult,
} from "./pinned-open.js";
export {
  assertNoWindowsNetworkPath,
  basenameFromMediaSource,
  hasEncodedFileUrlSeparator,
  isWindowsNetworkPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "./local-file-access.js";
export {
  isPathInside,
  isPathInsideWithRealpath,
  isWithinDir,
  resolveSafeBaseDir,
  safeRealpathSync,
  safeStatSync,
} from "./path.js";
export {
  assertNoHardlinkedFinalPath,
  assertNoPathAliasEscape,
  PATH_ALIAS_POLICIES,
  type PathAliasPolicy,
} from "./path-policy.js";
export {
  pathScope,
  type PathScope,
  type PathScopeOptions,
  type PathScopeResolveOptions,
} from "./path-scope.js";
export { formatPosixMode } from "./mode.js";
export {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
} from "./install-path.js";
export { sanitizeUntrustedFileName } from "./filename.js";
export {
  JsonFileReadError,
  createAsyncLock,
  loadJsonFile,
  readDurableJsonFile,
  readJsonFile,
  readJsonFileSync,
  readJsonFileStrict,
  saveJsonFile,
  writeJsonAtomic,
  writeTextAtomic,
} from "./json.js";
export {
  privateFileStore,
  writePrivateJsonAtomic,
  writePrivateJsonAtomicSync,
  writePrivateTextAtomic,
  writePrivateTextAtomicSync,
  type PrivateFileStore,
} from "./private-file-store.js";
export { readRegularFile, statRegularFile, type RegularFileStatResult } from "./regular-file.js";
export * from "./atomic.js";
export * from "./temp.js";
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  type AssertNoSymlinkParentsOptions,
} from "./symlink-parents.js";
export {
  assertAbsolutePathInput,
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
  type AbsolutePathSymlinkPolicy,
  type ResolvedAbsolutePath,
  type ResolvedWritableAbsolutePath,
} from "./absolute-path.js";
export {
  createSidecarLockManager,
  type SidecarLockAcquireOptions,
  type SidecarLockHandle,
  type SidecarLockHeldEntry,
  type SidecarLockRetryOptions,
} from "./sidecar-lock.js";
export { movePathToTrash, type MovePathToTrashOptions } from "./trash.js";
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  ArchiveSecurityError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  createArchiveSymlinkTraversalError,
  createTarEntryPreflightChecker,
  extractArchive,
  fileExists,
  loadZipArchiveWithPreflight,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  readZipCentralDirectoryEntryCount,
  resolveArchiveKind,
  resolvePackedRootDir,
  withStagedArchiveDestination,
  withTimeout,
  type ArchiveExtractLimits,
  type ArchiveKind,
  type ArchiveLimitErrorCode,
  type ArchiveLogger,
  type ArchiveSecurityErrorCode,
  type TarEntryInfo,
} from "./archive.js";
export type {
  BasePathOptions,
  FastPathMode,
  SafeDirEntry,
  SafeEncoding,
  SafePathStat,
} from "./types.js";

export * from "./root.js";
