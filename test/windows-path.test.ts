import { describe, expect, it } from "vitest";
import { isWindowsNetworkPath } from "../src/local-file-access.js";

describe("Windows path classification", () => {
  it("distinguishes extended local paths from UNC paths", () => {
    expect(isWindowsNetworkPath("\\\\server\\share\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\UNC\\server\\share\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\C:\\secrets\\token", "win32")).toBe(false);
    expect(
      isWindowsNetworkPath("\\\\?\\GLOBALROOT\\Device\\Mup\\server\\share\\token", "win32"),
    ).toBe(true);
    expect(isWindowsNetworkPath("\\\\?\\Volume{abc}\\secrets\\token", "win32")).toBe(true);
    expect(isWindowsNetworkPath("\\\\.\\pipe\\service", "win32")).toBe(true);
  });
});
