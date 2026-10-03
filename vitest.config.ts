import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/test-helpers.ts",
        "src/types.ts",
        "src/channel.setup.ts",
        "src/setup-surface.ts",
      ],
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 95,
        lines: 95,
      },
    },
  },
});
