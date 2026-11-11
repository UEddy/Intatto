import { defineConfig, devices } from "@playwright/test";

// The Cloudflare Pages build (INTATTO_BASE=/), previewed with its real _headers (vite.config.ts),
// against live testnet: what https://intatto.pages.dev serves.
//
//   npm run test:prod
export default defineConfig({
  testDir: "e2e/prod",
  outputDir: "test-results/prod",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  // Live indexers; one retry for a blip, and the trace says what happened if both fail.
  retries: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:4175/", ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  webServer: {
    command: "INTATTO_BASE=/ npm run build && INTATTO_BASE=/ npx vite preview --port 4175 --strictPort",
    url: "http://localhost:4175/",
    // Always a fresh build: a server left running from another build would test the wrong thing.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
