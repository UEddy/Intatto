import { expect, test, type Page } from "@playwright/test";

// Real wallets, real CSP (the production build's boot.js), live testnet. Runs in one project
// only: it loads third-party executors and opens their windows, and once is enough.
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "1440-light", "runs once");
});

/** Blocked loads that are cosmetic (the wallet's own fonts and loader image) and stay blocked. */
const COSMETIC = [/img-src/, /style-src/, /font-src/];

function cspMessages(page: Page): string[] {
  const found: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) found.push(m.text());
  });
  return found;
}

test("the CSP is enforced, with this page load's nonce", async ({ page }) => {
  const messages = cspMessages(page);
  await page.goto("./#/");
  const policy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "");
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}'/);
  expect(policy).not.toContain("{NONCE}");
  // Inline script without the nonce does not run; a host outside connect-src is refused.
  const ran = await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__inlineRan = true";
    document.body.append(s);
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true;
  });
  expect(ran).toBe(false);
  const fetched = await page.evaluate(() => fetch("https://example.com/").then(() => "fetched", () => "refused"));
  expect(fetched).toBe("refused");
  expect(messages.some((m) => /script-src/.test(m))).toBe(true);
  expect(messages.some((m) => /connect-src/.test(m))).toBe(true);
  // A second load gets a different nonce.
  await page.reload();
  const again = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "");
  expect(again.match(/nonce-[^']+/)?.[0]).not.toBe(policy.match(/nonce-[^']+/)?.[0]);
});

const WALLETS = [
  { name: "Meteor Wallet", choose: "Meteor Web", window: "wallet.meteorwallet.app" },
  { name: "Intear Wallet", choose: "Web", window: "wallet.intear.tech" },
];

for (const w of WALLETS) {
  test(`${w.name} connects under the CSP`, async ({ page, context }) => {
    test.setTimeout(90_000);
    const messages = cspMessages(page);
    await page.goto("./#/");
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByText(w.name, { exact: true }).click();

    // The executor runs in near-connect's sandboxed iframe and shows the wallet's own choices.
    let chooser = null;
    for (let i = 0; i < 40 && !chooser; i++) {
      for (const f of page.frames()) {
        const el = f.getByText(w.choose, { exact: true }).first();
        if (await el.isVisible().catch(() => false)) chooser = el;
      }
      if (!chooser) await page.waitForTimeout(500);
    }
    expect(chooser, `${w.name} showed "${w.choose}"`).not.toBeNull();
    const popup = context.waitForEvent("page", { timeout: 20_000 });
    await chooser!.click();
    const win = await popup;
    await win.waitForLoadState("domcontentloaded").catch(() => {});
    expect(new URL(win.url()).host).toBe(w.window);
    await win.close();

    const functional = messages.filter((m) => !COSMETIC.some((c) => c.test(m)));
    expect(functional, "CSP violations that would break the wallet").toEqual([]);
    test.info().annotations.push({ type: "cosmetic CSP blocks", description: messages.filter((m) => !functional.includes(m)).map((m) => m.slice(0, 160)).join(" | ") || "none" });
  });
}
