import { defineConfig, devices } from "@playwright/test";

// Screenshots of the production build (with its CSP) at 360, 768 and 1440 px, light and dark,
// against live mainnet and testnet (and mocks of testnet).
const widths = [
  { name: "360", viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true },
  { name: "768", viewport: { width: 768, height: 1024 }, isMobile: false, hasTouch: true },
  { name: "1440", viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
] as const;

export default defineConfig({
  testDir: "e2e",
  // The console specs need the E2E build: playwright.console.config.ts. The prod specs need the
  // Cloudflare build with its headers: playwright.prod.config.ts.
  testIgnore: ["console/**", "prod/**"],
  outputDir: "test-results",
  timeout: 90_000,
  fullyParallel: false,
  workers: 2,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:4173/Intatto/", ...devices["Desktop Chrome"] },
  projects: widths.flatMap((w) =>
    (["light", "dark"] as const).map((scheme) => ({
      name: `${w.name}-${scheme}`,
      use: {
        viewport: w.viewport,
        isMobile: w.isMobile,
        hasTouch: w.hasTouch,
        deviceScaleFactor: w.isMobile ? 2 : 1,
        colorScheme: scheme,
      },
    })),
  ),
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173/Intatto/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
