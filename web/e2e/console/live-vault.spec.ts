import { expect, test } from "@playwright/test";

// "See a live vault": anyone may open demo.intatto.near's console on mainnet, read-only. Live
// mainnet reads, E2E build (the scripted wallet counts every signing request in __e2eSubmits).
// It must sign nothing, send nothing and open no signing sheet, whatever is clicked.

const SENDS = /"method":"(broadcast_tx_commit|broadcast_tx_async|send_tx)"/;

// Live mainnet reads: a desktop and a phone width are enough, and spare the rate-limited indexer.
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "1440-light" && info.project.name !== "360-dark", "runs at two widths");
});

test("a live vault is read-only: it shows the owner's console and signs nothing", async ({ page }) => {
  test.setTimeout(120_000);
  const sends: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && SENDS.test(r.postData() ?? "")) sends.push(r.url());
  });

  await page.goto("./?network=mainnet#/vault");
  await expect(page.getByRole("heading", { name: "Your vault, your rules." })).toBeVisible();
  await expect(page.locator("main").getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await page.getByRole("link", { name: "See a live vault" }).click();

  await expect(page).toHaveURL(/#\/vault\?view=live$/);
  await expect(page.getByRole("heading", { name: "A live vault, read-only" })).toBeVisible();
  await expect(page.locator(".console-owner")).toHaveText("demo.intatto.near");
  await expect(page.locator("#readonly-note")).toContainText("Connect the owner's wallet to change this.");
  await expect(page.locator("#readonly-note")).toContainText("signs nothing");

  // Its balances and policy, read from mainnet.
  await expect(page.locator(".lfig--lead .lfig-value .skeleton")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator(".console-main")).toContainText("demo-agent.intatto.near", { timeout: 45_000 });

  // Every owner control is disabled, natively, and says why.
  const owner = page.locator("fieldset.console-fieldset");
  await expect(owner).toHaveAttribute("disabled", "");
  const controls = owner.locator("button, input, select, textarea");
  const n = await controls.count();
  expect(n, "owner controls shown").toBeGreaterThan(3);
  for (let i = 0; i < n; i++) await expect(controls.nth(i)).toBeDisabled();
  const note = await owner.locator(".panel").first().evaluate((el) => getComputedStyle(el, "::after").content);
  expect(note).toContain("Connect the owner's wallet to change this.");

  // Clicking anyway opens no signing sheet and reaches no wallet.
  for (const name of [/Freeze/i, /Deposit/i, /Withdraw/i]) {
    const b = owner.getByRole("button", { name }).first();
    if (await b.count()) await b.click({ force: true });
  }
  await page.waitForTimeout(800);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __e2eSubmits?: number }).__e2eSubmits ?? 0), "signing requests").toBe(0);

  // Its agent's activity, allowed and refused (the mainnet smoke test refused five calls).
  await page.getByRole("tab", { name: "Activity" }).click();
  const feed = page.locator(".console-feed");
  await expect(feed.locator(".entry--skeleton")).toHaveCount(0, { timeout: 60_000 });
  if ((await feed.locator(".indexer-down").count()) === 0) {
    await expect(feed.locator(".stamp--blocked").first()).toBeVisible({ timeout: 30_000 });
  }

  expect(sends, "transactions sent").toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __e2eSubmits?: number }).__e2eSubmits ?? 0), "signing requests").toBe(0);
});
