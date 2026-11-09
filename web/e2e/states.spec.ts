import { expect, test, type Page } from "@playwright/test";
import { attemptSet, mockChain, scenarios } from "./mockChain";

// Chain time for the mocks: three days after the canary's lock was set.
const NOW_NS = 1793985194506864730n + 3n * 86_400n * 1_000_000_000n + 4_380_000_000_000n;

async function settle(page: Page) {
  await expect(page.locator(".hero-status .badge")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".hash-row").first().locator(".skeleton")).toHaveCount(0);
  await expect(page.locator(".ledger .entry").first()).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500); // seal press, cooling and crack
}

function watchErrors(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

for (const [name, scenario] of Object.entries(scenarios(NOW_NS))) {
  test(`state: ${name}`, async ({ page }, info) => {
    const problems = watchErrors(page);
    await mockChain(page, scenario, NOW_NS);
    await page.goto("./#/");
    await settle(page);

    const seal = page.locator(".seal--hero");
    if (name === "broken") {
      await expect(page.locator("#board-title")).toContainText("The seal is broken.");
      await expect(seal).toHaveAttribute("aria-label", "Seal broken");
      await expect(page.locator(".hfig--alert .hfig-value")).toContainText("0.5");
      await expect(page.locator(".stamp--through")).toHaveCount(1);
      await expect(page.locator(".integrity-title")).toContainText("CODE CHANGED");
    } else {
      await expect(page.locator(".integrity-title")).toContainText("Matches the published build");
      await expect(seal).toHaveAttribute("aria-label", name === "frozen" ? "Seal frozen" : "Seal intact");
      await expect(page.locator(".stamp--rejected")).toHaveCount(3);
      await expect(page.locator(".stamp").first()).toContainText("Rejected · receiver not allowed");
    }
    // Attempts exist, so the rules panel has given its space back to the log.
    await expect(page.locator(".rules")).toHaveCount(0);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `screenshots/state-${name}-${info.project.name}.png`, fullPage: true });
    // Readable-scale views of the parts that change per state.
    await page.screenshot({ path: `screenshots/state-${name}-${info.project.name}-top.png` });
    await page.locator(".attempt-log").screenshot({ path: `screenshots/state-${name}-${info.project.name}-log.png` });
    expect(problems).toEqual([]);
  });
}

test("a new attempt during polling is stamped in", async ({ page }) => {
  const problems = watchErrors(page);
  const all = attemptSet(NOW_NS); // newest first
  await mockChain(page, { ...scenarios(NOW_NS)["attempts-matches"]!, attempts: (poll) => (poll === 0 ? all.slice(1) : all) }, NOW_NS);
  await page.goto("./#/");
  await settle(page);
  await expect(page.locator(".ledger .entry")).toHaveCount(2);
  await expect(page.locator(".entry.is-new")).toHaveCount(0);

  // React Query refetches stale queries when the page becomes visible again.
  await page.waitForTimeout(5_500);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect(page.locator(".ledger .entry")).toHaveCount(3, { timeout: 15_000 });
  const fresh = page.locator(".entry.is-new");
  await expect(fresh).toHaveCount(1);
  await expect(fresh.locator(".entry-no-value")).toHaveText("0003");
  await expect(fresh.locator(".stamp")).toHaveCSS("animation-name", "stamp-down");
  expect(problems).toEqual([]);
});

test("with reduced motion the seal is static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockChain(page, scenarios(NOW_NS)["broken"]!, NOW_NS);
  await page.goto("./#/");
  await expect(page.locator(".seal--hero")).toHaveAttribute("aria-label", "Seal broken", { timeout: 20_000 });
  await page.waitForTimeout(100);
  // Every seal animation (press, crack, halves parting) has already reached its end state.
  const states = await page.locator(".seal--hero").evaluate((el) => el.getAnimations({ subtree: true }).map((a) => a.playState));
  expect(states.every((s) => s === "finished")).toBe(true);
});
