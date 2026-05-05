export {
  FsSafeError,
  categorizeFsSafeError,
  type FsSafeErrorCategory,
  type FsSafeErrorCode,
} from "./errors.js";
export {
  DEFAULT_ROOT_MAX_BYTES,
  root,
  type HardlinkPolicy,
  type OpenResult,
  type ReadResult,
  type Root,
  type RootAppendOptions,
  type RootCopyOptions,
  type RootCreateJsonOptions,
  type RootCreateOptions,
  type RootDefaults,
  type RootOpenOptions,
  type RootOpenWritableOptions,
  type RootOptions,
  type RootReadOptions,
  type RootWriteJsonOptions,
  type RootWriteOptions,
  type SymlinkPolicy,
  type WritableOpenMode,
  type WritableOpenResult,
} from "./root.js";
export {
  pathScope,
  type PathScope,
  type PathScopeOptions,
  type PathScopeResolveOptions,
} from "./path-scope.js";
export {
  fileStore,
  type FileStore,
  type FileStoreOptions,
  type FileStorePruneOptions,
  type FileStoreWriteOptions,
} from "./file-store.js";
export {
  jsonStore,
  type JsonStore,
  type JsonStoreLockOptions,
  type JsonStoreOptions,
} from "./json-store.js";
export {
  tempFile,
  tempWorkspace,
  withTempFile,
  withTempWorkspace,
  type TempFile,
  type TempWorkspace,
  type TempWorkspaceOptions,
} from "./temp.js";
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  ArchiveSecurityError,
  extractArchive,
  resolveArchiveKind,
  type ArchiveExtractLimits,
  type ArchiveKind,
  type ArchiveLimitErrorCode,
  type ArchiveLogger,
  type ArchiveSecurityErrorCode,
} from "./archive.js";
export type {
  BasePathOptions,
  DirEntry,
  FastPathMode,
  PathStat,
  SafeEncoding,
} from "./types.js";
