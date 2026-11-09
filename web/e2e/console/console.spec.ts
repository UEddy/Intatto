import { expect, test, type Page } from "@playwright/test";

// Live testnet, E2E build: the wallet is scripted (src/wallet/fakeAdapter.ts) and connects as
// intatto-dev.testnet, whose real vault has a policy, tokens and history.

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow").toBeLessThanOrEqual(0);
}

async function connect(page: Page) {
  await page.goto("./#/vault");
  await expect(page.getByRole("heading", { name: "Your vault, your rules." })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `screenshots/console-intro-${test.info().project.name}.png`, fullPage: true });
  await page.locator("main").getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.locator(".console-owner")).toHaveText("intatto-dev.testnet");
  await expect(page.locator(".lfig--lead .lfig-value .skeleton")).toHaveCount(0, { timeout: 30_000 });
}

test("the console shows the owner's live vault and activity", async ({ page }, info) => {
  const problems = watch(page);
  await connect(page);
  await expect(page.locator(".status-rows")).toContainText("agent.intatto-dev.testnet");
  await expect(page.locator("#policy")).toBeVisible();
  // The 24-hour window counts on chain time: the spend from 2026-11-06 no longer counts.
  await expect(page.locator(".status-rows")).toContainText("0 of 5 agent actions");
  await expect(page.locator(".status-rows")).toContainText("older entries no longer count");
  const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  if (!mobile) {
    await expect(page.locator(".feed-item").first()).toBeVisible({ timeout: 45_000 });
    await expect(page.locator(".feed")).toContainText("your per-trade cap is 0.1 wNEAR");
  }
  await page.waitForTimeout(800);
  await noOverflow(page);
  await page.screenshot({ path: `screenshots/console-${info.project.name}.png`, fullPage: true });
  if (mobile) {
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.locator(".feed-item").first()).toBeVisible({ timeout: 45_000 });
    await expect(page.locator(".feed")).toContainText("your per-trade cap is 0.1 wNEAR");
    await noOverflow(page);
    await page.screenshot({ path: `screenshots/console-activity-${info.project.name}.png`, fullPage: true });
  }
  expect(problems).toEqual([]);
});

test("freeze: reviewed before signing, then confirmed from the chain", async ({ page }, info) => {
  const problems = watch(page);
  await connect(page);
  const kill = page.getByRole("region", { name: "Kill switch" });
  await expect(kill).toBeVisible();
  await kill.getByRole("button", { name: /freeze vault/i }).click();
  const sheet = page.locator("dialog.sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".plan-method")).toHaveText(["freeze"]);
  await expect(sheet.locator(".plan-tx-head")).toContainText("vault-v1.intatto-dev.testnet");
  await expect(sheet.locator(".plan-meta")).toContainText("none");
  await expect(sheet.locator(".plan-meta")).toContainText("30 Tgas");
  await page.screenshot({ path: `screenshots/console-review-${info.project.name}.png` });
  await sheet.getByRole("button", { name: "Sign with wallet" }).click();
  await expect(sheet.locator(".result-headline")).toContainText(/Frozen on chain \d+\.\d s after the transaction was included \(block [\d,]+\)\./, { timeout: 45_000 });
  await page.screenshot({ path: `screenshots/console-frozen-${info.project.name}.png` });
  expect(problems).toEqual([]);
});

test("policy edit: plain words and the exact on-chain arguments", async ({ page }, info) => {
  test.skip(info.project.name !== "1440-light" && info.project.name !== "360-dark", "two sizes suffice");
  const problems = watch(page);
  await connect(page);
  const policy = page.locator("#policy");
  const perTrade = policy.locator(".token-row").first().locator("input").nth(1);
  await expect(perTrade).toHaveValue("0.1");
  await perTrade.fill("0.2");
  await expect(policy.locator(".changes")).toContainText("wNEAR per trade");
  await expect(policy.locator(".changes")).toContainText("0.2 wNEAR");
  await policy.getByRole("button", { name: "Review policy" }).click();
  const sheet = page.locator("dialog.sheet");
  await expect(sheet.locator(".plan-method")).toHaveText(["set_agent"]);
  await expect(sheet.locator(".plan-args")).toContainText('"per_tx_cap": "200000000000000000000000"');
  await expect(sheet.locator(".plan-meta")).toContainText("1 yoctoNEAR");
  await page.screenshot({ path: `screenshots/console-policy-review-${info.project.name}.png` });
  expect(problems).toEqual([]);
});
