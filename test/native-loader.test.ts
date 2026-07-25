import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
  getFsSafeNativeConfig,
} from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  getNativeBinding,
  type NativeBinding,
} from "../src/native.js";

const envKeys = ["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("native helper configuration", () => {
  it("reads the environment and lets programmatic configuration win", () => {
    process.env.FS_SAFE_NATIVE_MODE = "off";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "off" });
    configureFsSafeNative({ mode: "require" });
    expect(getFsSafeNativeConfig()).toEqual({ mode: "require" });
  });

  it("accepts documented boolean and compatibility mode spellings", () => {
    process.env.FS_SAFE_NATIVE_MODE = "required";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "require" });
    process.env.FS_SAFE_NATIVE_MODE = "never";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "off" });
    process.env.FS_SAFE_NATIVE_MODE = "true";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "auto" });
  });

  it("falls back in auto mode and fails closed in require mode", () => {
    const unavailable = vi.fn(() => {
      throw Object.assign(new Error("missing binding"), { code: "MODULE_NOT_FOUND" });
    });
    __setNativeLoaderForTest(unavailable);
    configureFsSafeNative({ mode: "auto" });
    expect(getNativeBinding()).toBeUndefined();
    expect(unavailable).toHaveBeenCalledTimes(1);

    configureFsSafeNative({ mode: "require" });
    expect(() => getNativeBinding()).toThrowError(
      expect.objectContaining({ code: "helper-unavailable" }),
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to load the binding in off mode", () => {
    const loader = vi.fn(() => ({}) as NativeBinding);
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode: "off" });
    expect(getNativeBinding()).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });
});
