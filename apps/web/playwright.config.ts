import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

/**
 * End-to-end tests run the production shape: the API serving the built web app
 * from one origin, with an in-memory command log and a short warm-up.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    trace: "retain-on-failure",
    ...(process.env.CI ? {} : { channel: "chrome" }),
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run build -w @marketlab/web && npx tsx apps/api/src/server.ts",
    cwd: "../..",
    url: `http://localhost:${String(PORT)}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      WEB_DIST: "apps/web/dist",
      TICK_MS: "300",
      WARMUP_MINUTES: "5",
      LOG_LEVEL: "warn",
      // Every test opens its own guest account from one address; production limits stay as they are.
      RATE_LIMIT_SCALE: "100",
    },
  },
});
