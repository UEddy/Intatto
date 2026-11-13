import type { Page, TestInfo } from "@playwright/test";

/**
 * FastNEAR's mainnet Transactions API (tx.main.fastnear.com) answers bursts from one IP with 429
 * and no CORS header (measured 2026-11-11: 26 of 30 parallel requests), so the browser logs a CORS
 * error and a bare `net::ERR_FAILED`. Its POSTs need `Content-Type: application/json` (text/plain
 * gets a 400), so each one costs a preflight too. The page retries with backoff; the specs check
 * that the log still loads. This drops exactly those console lines, at most one ERR_FAILED per
 * CORS line, and records how many it dropped. Everything else still fails the test.
 *
 * FastNEAR's RPC hosts (rpc. and archival-rpc.mainnet.fastnear.com) rate-limit the same way but
 * answer 429 with CORS headers, so the browser logs a bare "status of 429 ()" with no URL in the
 * text (measured 2026-11-13: 18 to 45 per run of the intents spec, after the canary panel's and the
 * intents panel's first reads arrive together). Pass `rpc429s`, the number of such responses seen
 * from those two hosts (watchFastnearRpc429), and at most that many of those lines are dropped: a
 * 429 from any other host, NearBlocks included, still fails the test.
 */
export function withoutFastnearRateLimit(problems: readonly string[], info: TestInfo, rpc429s = 0): string[] {
  const cors = problems.filter((p) => /^Access to fetch at 'https:\/\/tx\.main\.fastnear\.com\/v0\/[a-z]+' from origin '[^']+' has been blocked by CORS policy/.test(p));
  let failedAllowed = cors.length;
  let rpc429Allowed = rpc429s;
  const rest = problems.filter((p) => {
    if (cors.includes(p)) return false;
    if (p === "Failed to load resource: the server responded with a status of 429 ()" && rpc429Allowed > 0) {
      rpc429Allowed--;
      return false;
    }
    if (p === "Failed to load resource: net::ERR_FAILED" && failedAllowed > 0) {
      failedAllowed--;
      return false;
    }
    return true;
  });
  if (cors.length > 0) info.annotations.push({ type: "FastNEAR mainnet rate limit", description: `${cors.length} request(s) refused with 429; the page retried` });
  const rpcDropped = rpc429s - rpc429Allowed;
  if (rpcDropped > 0) info.annotations.push({ type: "FastNEAR RPC rate limit", description: `${rpcDropped} RPC request(s) refused with 429; the page retried` });
  return rest;
}

const FASTNEAR_RPC = /^https:\/\/(archival-)?rpc\.mainnet\.fastnear\.com\//;

/** Counts the 429s FastNEAR's RPC hosts answer with CORS headers (the ones the console logs bare). */
export function watchFastnearRpc429(page: Page): () => number {
  let n = 0;
  page.on("response", (res) => {
    if (res.status() === 429 && FASTNEAR_RPC.test(res.url()) && res.headers()["access-control-allow-origin"]) n++;
  });
  return () => n;
}
