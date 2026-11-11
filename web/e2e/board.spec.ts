import { expect, test } from "@playwright/test";

test("break-price board renders live testnet data", async ({ page }, info) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto("./#/");
  // Live data: seal state, bounty, integrity hash and the attempt log have loaded.
  await expect(page.locator(".hero-status .badge")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".hfig").first().locator(".hfig-value .skeleton")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".hash-row").first().locator(".skeleton")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".attempt-log .entry--skeleton")).toHaveCount(0, { timeout: 60_000 });
  // No skeletons is also true of the "indexers are not answering" state; that must fail the test.
  await expect(page.locator(".attempt-log .indexer-down")).toHaveCount(0);
  // Since the 2026-11-08 upgrade, vault-v1 runs the published build, and the run's start
  // transaction verifies: the integrity check must say so (live testnet, not a mock).
  await expect(page.locator(".integrity-title")).toContainText("Matches the published build");
  await expect(page.locator(".hfig").nth(1)).toContainText("Since this run started with the upgrade to the published build");
  await page.evaluate(() => document.fonts.ready);
  // Let the seal's press-in animation finish.
  await page.waitForTimeout(1500);

  // No horizontal page scroll at any width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);

  await page.screenshot({ path: `screenshots/board-${info.project.name}.png`, fullPage: true });
  expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p)), "CSP violations").toEqual([]);
  expect(problems, "console errors").toEqual([]);
});
