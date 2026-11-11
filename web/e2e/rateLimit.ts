import type { TestInfo } from "@playwright/test";

/**
 * FastNEAR's mainnet Transactions API (tx.main.fastnear.com) answers bursts from one IP with 429
 * and no CORS header (measured 2026-11-11: 26 of 30 parallel requests), so the browser logs a CORS
 * error and a bare `net::ERR_FAILED`. Its POSTs need `Content-Type: application/json` (text/plain
 * gets a 400), so each one costs a preflight too. The page retries with backoff; the specs check
 * that the log still loads. This drops exactly those console lines, at most one ERR_FAILED per
 * CORS line, and records how many it dropped. Everything else still fails the test.
 */
export function withoutFastnearRateLimit(problems: readonly string[], info: TestInfo): string[] {
  const cors = problems.filter((p) => /^Access to fetch at 'https:\/\/tx\.main\.fastnear\.com\/v0\/[a-z]+' from origin '[^']+' has been blocked by CORS policy/.test(p));
  let failedAllowed = cors.length;
  const rest = problems.filter((p) => {
    if (cors.includes(p)) return false;
    if (p === "Failed to load resource: net::ERR_FAILED" && failedAllowed > 0) {
      failedAllowed--;
      return false;
    }
    return true;
  });
  if (cors.length > 0) info.annotations.push({ type: "FastNEAR mainnet rate limit", description: `${cors.length} request(s) refused with 429; the page retried` });
  return rest;
}
