import { describe, expect, it } from "vitest";
import { sanitizeUntrustedFileName } from "../src/filename.js";

describe("sanitizeUntrustedFileName", () => {
  it("keeps only the basename and strips control characters", () => {
    expect(sanitizeUntrustedFileName("../nested/rep\u0000ort.pdf", "fallback.bin")).toBe(
      "report.pdf",
    );
  });

  it("uses fallback for empty or path-alias names", () => {
    expect(sanitizeUntrustedFileName(" ", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeUntrustedFileName("..", "fallback.bin")).toBe("fallback.bin");
  });
});
