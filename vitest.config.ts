import { defineConfig } from "vitest/config";

export default defineConfig({
  // Web components use the automatic JSX runtime, like the Vite build.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // TypeScript modules; React components are covered end to end by Playwright.
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "apps/api/src/test/**"],
      reporter: ["text-summary", "json-summary", "html", "lcov"],
    },
  },
});
