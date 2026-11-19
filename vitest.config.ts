import { defineConfig } from "vitest/config";

export default defineConfig({
  // Web components use the automatic JSX runtime, like the Vite build.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    // Some suites do real work: replaying whole sessions, or booting PGlite
    // (Postgres in WebAssembly). Under coverage instrumentation on a shared CI
    // runner they take several seconds, close to the 5 s default.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      // TypeScript modules; React components are covered end to end by Playwright.
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "apps/api/src/test/**"],
      reporter: ["text-summary", "json-summary", "html", "lcov"],
    },
  },
});
