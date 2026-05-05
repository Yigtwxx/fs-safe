export type FastPathMode = "auto" | "never" | "require";

export type SafeEncoding = BufferEncoding | null;

export type SafePathStat = {
  dev: number;
  gid: number;
  ino: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
  uid: number;
};

export type SafeDirEntry = SafePathStat & {
  name: string;
};

export type BasePathOptions = {
  rootDir: string;
  relativePath: string;
};
