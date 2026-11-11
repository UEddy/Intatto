import { expect, test } from "@playwright/test";
import { withoutFastnearRateLimit } from "./rateLimit";

// The board on each network, live. Mainnet is the default (no ?network=): its vault was deployed
// with the published build and the canary set up on it afterwards, so its run counts from the
// setup. On testnet, vault-v1 was upgraded to the published build under an existing canary.
const NETWORKS = [
  { id: "mainnet", path: "./#/", runNote: "Since the canary was set up on the published build" },
  { id: "testnet", path: "./?network=testnet#/", runNote: "Since this run started with the upgrade to the published build" },
];

for (const net of NETWORKS) test(`break-price board renders live ${net.id} data`, async ({ page }, info) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto(net.path);
  await expect(page.locator(".net-switch")).toContainText(net.id === "mainnet" ? "Mainnet" : "Testnet", { ignoreCase: true });
  // Live data: seal state, bounty, integrity hash and the attempt log have loaded.
  await expect(page.locator(".hero-status .badge")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".hfig").first().locator(".hfig-value .skeleton")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".hash-row").first().locator(".skeleton")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".attempt-log .entry--skeleton")).toHaveCount(0, { timeout: 60_000 });
  // No skeletons is also true of the "indexers are not answering" state; that must fail the test.
  await expect(page.locator(".attempt-log .indexer-down")).toHaveCount(0);
  // The vault runs the published build and the run's start transactions verify: the integrity
  // check must say so (live chain, not a mock).
  await expect(page.locator(".integrity-title")).toContainText("Matches the published build");
  await expect(page.locator(".hfig").nth(1)).toContainText(net.runNote, { timeout: 45_000 });
  await page.evaluate(() => document.fonts.ready);
  // Let the seal's press-in animation finish.
  await page.waitForTimeout(1500);

  // No horizontal page scroll at any width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);

  await page.screenshot({ path: `screenshots/board-${net.id}-${info.project.name}.png`, fullPage: true });
  expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p)), "CSP violations").toEqual([]);
  expect(withoutFastnearRateLimit(problems, info), "console errors").toEqual([]);
});
