import { defineConfig } from "vitest/config";

/**
 * Suites that spawn the built server as real processes against PostgreSQL and
 * assert on wall-clock bounds (exit within seconds, takeover within one poll).
 * Run in parallel with everything else, they compete for the CPU and miss
 * those bounds on a loaded machine, so they run on their own, one file at a
 * time, after the in-process tests.
 */
const PROCESS_SUITES = [
  "apps/api/src/shutdown.test.ts",
  "apps/api/src/deploy.test.ts",
  "apps/api/src/startup.test.ts",
  "apps/api/src/rollover.test.ts",
  "apps/api/src/persistence.test.ts",
];

export default defineConfig({
  // Web components use the automatic JSX runtime, like the Vite build.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Some suites do real work: replaying whole sessions, or booting PGlite
    // (Postgres in WebAssembly). Under coverage instrumentation on a shared CI
    // runner they take several seconds, close to the 5 s default.
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", ...PROCESS_SUITES],
        },
      },
      {
        extends: true,
        test: {
          name: "process",
          include: PROCESS_SUITES,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: "v8",
      // TypeScript modules; React components are covered end to end by Playwright.
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "apps/api/src/test/**"],
      reporter: ["text-summary", "json-summary", "html", "lcov"],
    },
  },
});
