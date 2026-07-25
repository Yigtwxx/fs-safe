import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";

export type CreatePrivateDirectoryOptions = {
  platform?: NodeJS.Platform;
};

export async function createPrivateDirectory(
  targetPath: string,
  options?: CreatePrivateDirectoryOptions,
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  if (platform !== "win32") {
    await fs.mkdir(targetPath, { mode: 0o700 });
    await fs.chmod(targetPath, 0o700);
    return;
  }

  const native = getNativeBinding();
  if (!native) {
    throw new FsSafeError(
      "helper-unavailable",
      "private Windows directory creation requires the optional native binding",
    );
  }
  native.createPrivateDirectory(targetPath);
}
