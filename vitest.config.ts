import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/atomic.ts",
        "src/temp.ts",
        "src/types.ts",
        "src/file-url.ts",
        "src/test-hooks.ts",
      ],
      thresholds: {
        lines: 84,
        functions: 95,
        statements: 84,
        branches: 78,
      },
    },
  },
});
