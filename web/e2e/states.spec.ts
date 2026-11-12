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
    await page.goto("./?network=testnet#/");
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
    // The rules live in their own tab, closed until chosen.
    await expect(page.locator(".rules")).toBeHidden();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `screenshots/state-${name}-${info.project.name}.png`, fullPage: true });
    // Readable-scale views of the parts that change per state.
    await page.screenshot({ path: `screenshots/state-${name}-${info.project.name}-top.png` });
    // The canary's log (testnet also shows the demo agent's log below it).
    await page.locator(".attempt-log", { has: page.getByRole("heading", { name: "Attempts with the published key" }) }).screenshot({ path: `screenshots/state-${name}-${info.project.name}-log.png` });
    expect(problems).toEqual([]);
  });
}

test("a new attempt during polling is stamped in", async ({ page }) => {
  const problems = watchErrors(page);
  const all = attemptSet(NOW_NS); // newest first
  await mockChain(page, { ...scenarios(NOW_NS)["attempts-matches"]!, attempts: (poll) => (poll === 0 ? all.slice(1) : all) }, NOW_NS);
  await page.goto("./?network=testnet#/");
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
  await page.goto("./?network=testnet#/");
  await expect(page.locator(".seal--hero")).toHaveAttribute("aria-label", "Seal broken", { timeout: 20_000 });
  await page.waitForTimeout(100);
  // Every seal animation (press, crack, halves parting) has already reached its end state.
  const states = await page.locator(".seal--hero").evaluate((el) => el.getAnimations({ subtree: true }).map((a) => a.playState));
  expect(states.every((s) => s === "finished")).toBe(true);
});

test("Try to break it opens the Try it tab; the tabs follow the arrow keys", async ({ page }) => {
  const problems = watchErrors(page);
  await mockChain(page, scenarios(NOW_NS)["attempts-matches"]!, NOW_NS);
  await page.goto("./?network=testnet#/");
  await settle(page);
  const tabs = page.getByRole("tablist", { name: "Try it, the key, the rules" });
  await tabs.getByRole("tab", { name: "The rules" }).click();
  await expect(page.locator(".rules")).toBeVisible();

  // The hero's button brings back the command, in view, without leaving the board's route.
  await page.locator(".board-hero").getByRole("button", { name: /Try to break it/ }).click();
  await expect(tabs.getByRole("tab", { name: "Try it" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".try-it")).toBeInViewport();
  expect(new URL(page.url()).hash).toBe("#/");

  await tabs.getByRole("tab", { name: "Try it" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "The key" })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: "The key" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "The rules" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Try it" })).toHaveAttribute("aria-selected", "true");
  expect(problems).toEqual([]);
});

test("the ticker and the card stack: live values, controls, and still with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockChain(page, scenarios(NOW_NS)["attempts-matches"]!, NOW_NS);
  await page.goto("./?network=testnet#/");
  await settle(page);
  // Assistive technology reads the ticker once; the copy that makes the loop is hidden.
  const ticker = page.getByRole("region", { name: "Testnet canary, live" });
  await expect(ticker.locator('ul:not([aria-hidden="true"]) li').first()).toContainText("Testnet canary live");
  await expect(ticker.locator(".ticker-track")).toHaveCSS("animation-name", "none");

  const stack = page.getByRole("group", { name: "The canary at a glance" });
  await expect(stack.locator('[data-depth="0"]')).toHaveClass(/stack-card--seal/);
  await stack.getByRole("button", { name: "Show the bounty" }).click();
  await expect(stack.locator('[data-depth="0"]')).toHaveClass(/stack-card--bounty/);
  await expect(stack.getByRole("button", { name: "Show the bounty" })).toHaveAttribute("aria-pressed", "true");
  // Reduced motion: it never turns by itself.
  await page.waitForTimeout(6000);
  await expect(stack.locator('[data-depth="0"]')).toHaveClass(/stack-card--bounty/);
});

test("the header's seal mark: decorative, centred on the wordmark, its size reserved", async ({ page }, info) => {
  test.skip(info.project.name.startsWith("768"), "1440 and 360, light and dark");
  await mockChain(page, scenarios(NOW_NS)["attempts-matches"]!, NOW_NS);
  await page.goto("./?network=testnet#/");
  const home = page.getByRole("link", { name: "Intatto, home" });
  await expect(home).toHaveAttribute("href", "#/");
  const mark = home.locator("svg.wordmark-seal");
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  // Reserved before fonts or styles load: the element itself carries its size.
  await expect(mark).toHaveAttribute("width", "30");
  await expect(mark).toHaveAttribute("height", "30");
  await page.evaluate(() => document.fonts.ready);
  const box = (await mark.boundingBox())!;
  const word = (await home.locator(".wordmark-name").boundingBox())!;
  const px = info.project.name.startsWith("360") ? 24 : 30;
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([px, px]);
  expect(Math.abs(box.y + box.height / 2 - (word.y + word.height / 2)), "centred on the wordmark").toBeLessThanOrEqual(2);
  expect(word.x - (box.x + box.width), "gap to the wordmark").toBeCloseTo(10, 0);
  await page.locator(".masthead").screenshot({ path: `screenshots/header-${info.project.name}.png` });
});

