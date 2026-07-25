export type TarModule = {
  x(options: {
    file: string;
    cwd: string;
    strip: number;
    gzip?: boolean;
    signal?: AbortSignal;
    preservePaths: false;
    noChmod: true;
    preserveOwner: false;
    strict: true;
    filter?(entryPath: string, entry: unknown): boolean;
    onReadEntry(this: unknown, entry: unknown): void;
  }): Promise<unknown>;
};

export async function importOptionalTar(): Promise<TarModule> {
  try {
    return await import("tar");
  } catch (cause) {
    throw new Error(
      'Optional archive dependency "tar" is not installed. Install it to use TAR archive helpers from @openclaw/fs-safe/archive.',
      { cause },
    );
  }
}
