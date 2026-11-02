import { defineConfig } from "vitest/config";

const ignored = ["**/node_modules/**", "contract/**", "web/.next/**", ".agents/**"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: [...ignored, "**/*.sandbox.test.ts"],
        },
      },
      {
        // Real local NEAR node (near-sandbox) with the real contract wasm. Slower; run on demand.
        test: {
          name: "sandbox",
          include: ["**/*.sandbox.test.ts"],
          exclude: ignored,
          testTimeout: 300_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
