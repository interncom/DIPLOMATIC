import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json"],
      include: ["src/**/*.ts"],
      exclude: ["test/**/*.ts", "dist/**", "**/*.d.ts"],
    },
  },
  optimizeDeps: {
    exclude: ["@noble/hashes"],
  },
});
