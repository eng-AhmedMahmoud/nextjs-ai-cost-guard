import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
    // The tests share one Redis database; keep files sequential.
    fileParallelism: false,
  },
});
