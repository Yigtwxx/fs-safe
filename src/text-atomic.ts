import { replaceFileAtomic } from "./replace-file.js";

export type WriteTextAtomicOptions = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  /**
   * When false, skip the temp-file and parent-directory fsync calls while
   * preserving the temp-file replace/rename behavior.
   *
   * Defaults to true.
   */
  durable?: boolean;
};

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: WriteTextAtomicOptions,
): Promise<void> {
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const durable = options?.durable ?? true;
  await replaceFileAtomic({
    filePath,
    content: payload,
    mode: options?.mode ?? 0o600,
    dirMode: options?.dirMode ?? (0o777 & ~process.umask()),
    copyFallbackOnPermissionError: true,
    syncTempFile: durable,
    syncParentDir: durable,
  });
}
