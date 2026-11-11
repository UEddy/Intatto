import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The owner console against live testnet, with the E2E build's scripted wallet (see
// src/wallet/fakeAdapter.ts). Same widths and themes as the board.
export default defineConfig({
  ...base,
  testDir: "e2e/console",
  testIgnore: [],
  // One worker: the freeze flow looks up an old transaction on the archival node, which
  // rate-limits bursts.
  workers: 1,
  use: { ...base.use, baseURL: "http://localhost:4176/Intatto/" },
  webServer: {
    command: "VITE_E2E=1 VITE_DEFAULT_NETWORK=testnet npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port 4176 --strictPort",
    url: "http://localhost:4176/Intatto/",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
