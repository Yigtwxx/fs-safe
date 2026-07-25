import { createRequire } from "node:module";
import { FsSafeError } from "./errors.js";
import { getFsSafeNativeConfig } from "./native-config.js";

export type NativeBinding = typeof import("@openclaw/fs-safe-native");

const require = createRequire(import.meta.url);
let binding: NativeBinding | undefined;
let loadError: unknown;
let attempted = false;
let loadBinding = (): NativeBinding => require("@openclaw/fs-safe-native") as NativeBinding;

export function getNativeBinding(): NativeBinding | undefined {
  const { mode } = getFsSafeNativeConfig();
  if (mode === "off") {
    return undefined;
  }
  if (!attempted) {
    attempted = true;
    try {
      binding = loadBinding();
    } catch (error) {
      loadError = error;
    }
  }
  if (binding) {
    return binding;
  }
  if (mode === "require") {
    throw new FsSafeError("helper-unavailable", "native fs-safe helper is unavailable", {
      cause: loadError,
    });
  }
  return undefined;
}

export function requireNativeBinding(): NativeBinding {
  const native = getNativeBinding();
  if (!native) {
    throw new FsSafeError("helper-unavailable", "native fs-safe helper is unavailable", {
      cause: loadError,
    });
  }
  return native;
}

export function __setNativeLoaderForTest(loader: () => NativeBinding): void {
  binding = undefined;
  loadError = undefined;
  attempted = false;
  loadBinding = loader;
}

export function __resetNativeLoaderForTest(): void {
  binding = undefined;
  loadError = undefined;
  attempted = false;
  loadBinding = () => require("@openclaw/fs-safe-native") as NativeBinding;
}
