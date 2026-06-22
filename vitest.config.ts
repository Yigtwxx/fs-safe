import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    expect: {
      requireAssertions: true,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/types.ts",
        "src/test-hooks.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 84.9,
        statements: 85,
        branches: 76,
      },
    },
  },
});
