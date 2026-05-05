import type { FileHandle } from "node:fs/promises";

export type FsSafeTestHooks = {
  afterPreOpenLstat?: (filePath: string) => Promise<void> | void;
  beforeOpen?: (filePath: string, flags: number) => Promise<void> | void;
  afterOpen?: (filePath: string, handle: FileHandle) => Promise<void> | void;
};

let fsSafeTestHooks: FsSafeTestHooks | undefined;

function allowFsSafeTestHooks(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

export function getFsSafeTestHooks(): FsSafeTestHooks | undefined {
  return fsSafeTestHooks;
}

export function __setFsSafeTestHooksForTest(hooks?: FsSafeTestHooks): void {
  if (hooks && !allowFsSafeTestHooks()) {
    throw new Error("__setFsSafeTestHooksForTest is only available in tests");
  }
  fsSafeTestHooks = hooks;
}
