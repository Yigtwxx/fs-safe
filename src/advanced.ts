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
export { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
export { sanitizeUntrustedFileName } from "./filename.js";
export { pathExists, pathExistsSync } from "./fs.js";
export {
  resolveLocalPathFromRootsSync,
  readLocalFileFromRoots,
  type LocalRootsInputOptions,
  type LocalRootsPathResult,
  type LocalRootsReadResult,
  type ReadLocalFileFromRootsOptions,
  type ResolveLocalPathFromRootsSyncOptions,
} from "./local-roots.js";
export {
  assertNoWindowsNetworkPath,
  basenameFromMediaSource,
  hasEncodedFileUrlSeparator,
  isWindowsNetworkPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "./local-file-access.js";
export { formatPosixMode } from "./mode.js";
export {
  assertNoHardlinkedFinalPath,
  assertNoPathAliasEscape,
  PATH_ALIAS_POLICIES,
  type PathAliasPolicy,
} from "./path-policy.js";
export {
  openPinnedFileSync,
  type PinnedOpenSyncAllowedType,
  type PinnedOpenSyncFailureReason,
  type PinnedOpenSyncFs,
  type PinnedOpenSyncResult,
} from "./pinned-open.js";
export {
  openRootFile,
  openRootFileSync,
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
  type RootFileOpenFailure,
  type RootFileOpenFailureReason,
  type RootFileOpenResult,
} from "./root-file.js";
export {
  ROOT_PATH_ALIAS_POLICIES,
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
} from "./root-path.js";
export {
  ensureDirectoryWithinRoot,
  pathScope,
  resolveExistingPathsWithinRoot,
  resolvePathWithinRoot,
  resolvePathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
  type PathScope,
  type PathScopeOptions,
  type PathScopeResolveOptions,
} from "./root-paths.js";
export {
  safeDirName,
  safePathSegmentHashed,
  resolveSafeInstallDir,
  assertCanonicalPathWithinBase,
} from "./install-path.js";
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  type AssertNoSymlinkParentsOptions,
} from "./symlink-parents.js";
export { createSidecarLockManager, withSidecarLock } from "./sidecar-lock.js";
export { movePathToTrash, type MovePathToTrashOptions } from "./trash.js";
export { withTimeout } from "./timing.js";
export { resolveHomeRelativePath } from "./home-dir.js";
