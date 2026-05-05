import fs from "node:fs/promises";

export type MovePathWithCopyFallbackOptions = {
  from: string;
  to: string;
};

export async function movePathWithCopyFallback(
  options: MovePathWithCopyFallbackOptions,
): Promise<void> {
  try {
    await fs.rename(options.from, options.to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EXDEV") {
      throw error;
    }
  }
  await fs.cp(options.from, options.to, {
    recursive: true,
    force: true,
    dereference: false,
  });
  await fs.rm(options.from, { recursive: true, force: true });
}
