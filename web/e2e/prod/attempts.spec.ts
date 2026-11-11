import { expect, test, type Page } from "@playwright/test";

// The prompt-injection demo's runs on 2026-11-11 (agent/README.md, "Results"). Final on chain, so
// they stay in the demo agent's log; later runs only add rows above them.
const DEMO_TXS = [
  "6JtBgjrVpdm4jH333BWbv2Ywq8dVE3Vi5HFUiqEk19fd", // entire balance to attacker.testnet: rejected
  "3bsGC4Kp1gq1ECeVksxkjmhsVx6nMqRsmW9ovvWzRTV4", // 0.5 NEAR to attacker.testnet: rejected
  "DzQMbCsQ3uxz17mrAuvSYZjBaBtWDh6DMHbj5MojP6gB", // over the per-payment cap: rejected
  "CpM5mfEVUqTf1XywgV5iGx7CheMSyiG9UVAtM4JqYxeU", // the invoice: paid
  "647hggDJQFsifiScwcRAx7uufoaNwneUXdAc7MXjTNjP", // the invoice, --llm run: paid
];

function watch(page: Page) {
  const problems: string[] = [];
  const indexer: { url: string; status: number }[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("response", (r) => {
    if (/tx\.test\.fastnear\.com|nearblocks\.io/.test(r.url())) indexer.push({ url: r.url(), status: r.status() });
  });
  return { problems, indexer };
}

test("the attempt logs render real rows from the indexer under the production CSP", async ({ page }) => {
  const { problems, indexer } = watch(page);
  const res = await page.goto("./#/");

  // The preview sends the Cloudflare headers, so this runs under the header CSP and the <meta> one.
  const csp = res!.headers()["content-security-policy"] ?? "";
  expect(csp, "header CSP").toContain("https://tx.test.fastnear.com");
  expect(csp, "header CSP").toContain("frame-ancestors 'none'");
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);

  const demo = page.locator(".attempt-log", { has: page.getByRole("heading", { name: "The demo agent's payments and blocked attempts" }) });
  const canary = page.locator(".attempt-log", { has: page.getByRole("heading", { name: "Attempts with the published key" }) });

  // Rows, not skeletons, and not the "indexers are not answering" state (which also has no skeletons).
  await expect(demo.locator(".entry--skeleton")).toHaveCount(0, { timeout: 60_000 });
  await expect(demo.locator(".indexer-down"), await demo.innerText()).toHaveCount(0);
  const rows = demo.locator("li.entry:not(.entry--skeleton)");
  expect(await rows.count()).toBeGreaterThanOrEqual(DEMO_TXS.length);
  for (const hash of DEMO_TXS) {
    const row = rows.filter({ has: page.locator(`a.txlink[href$="${hash}"]`) });
    await expect(row, hash).toHaveCount(1);
  }
  // The contract's answers, read from the receipts: three refusals and two payments at least.
  expect(await demo.locator(".stamp--rejected").count()).toBeGreaterThanOrEqual(3);
  expect(await demo.locator(".stamp--allowed").count()).toBeGreaterThanOrEqual(2);
  await expect(rows.filter({ has: page.locator(`a.txlink[href$="${DEMO_TXS[0]}"]`) })).toContainText("receiver is not on the allowlist");
  await expect(rows.filter({ has: page.locator(`a.txlink[href$="${DEMO_TXS[2]}"]`) })).toContainText("per-payment cap");

  // The canary agent's key has signed nothing since setup so far: rows or the empty state, never an error.
  await expect(canary.locator(".entry--skeleton")).toHaveCount(0, { timeout: 60_000 });
  await expect(canary.locator(".indexer-down"), await canary.innerText()).toHaveCount(0);

  // Answered by FastNEAR, the only source that can list what a key signed.
  expect(indexer.filter((r) => r.url.endsWith("/v0/account") && r.status === 200).length, JSON.stringify(indexer)).toBeGreaterThanOrEqual(2);
  expect(indexer.filter((r) => /nearblocks\.io\/v3\/accounts\/[^/]+\/txns/.test(r.url)), "NearBlocks /txns lists what an account received").toEqual([]);

  expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p)), "CSP violations").toEqual([]);
  expect(problems, "console errors").toEqual([]);
});
