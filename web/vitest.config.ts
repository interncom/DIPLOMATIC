import { defineConfig } from "vitest/config";

export default defineConfig({
  // Enclave.dumpToTty is CLI paper backup; only runs if DIP_CLI_DUMP is true.
  // Tests pin false (same as the web bundle) so a TTY test run cannot print the seed.
  define: {
    DIP_CLI_DUMP: "false",
  },
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
