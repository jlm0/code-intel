import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["dist/**", "node_modules/**", "tests/fixtures/**"],
    pool: "forks",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
