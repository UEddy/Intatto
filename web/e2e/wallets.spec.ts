import { expect, test, type Page } from "@playwright/test";

// Real wallets, real CSP (the production build's boot.js), live chains: Meteor and Intear on
// testnet, HOT and MyNearWallet on mainnet (they declare mainnet only). Runs in one project only:
// it loads third-party executors and opens their windows, and once is enough.
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "1440-light", "runs once");
});

/**
 * Blocked loads that are cosmetic (the wallets' own fonts, Meteor's loader image) and stay
 * blocked. HOT's images are allowed (src/wallet/csp.ts: without them its executor shuts down).
 */
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
    await page.goto("./?network=testnet#/");
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

// MyNearWallet logs in and signs in its own window; the executor needs no backend of its own.
test("MyNearWallet connects under the CSP (mainnet)", async ({ page, context }) => {
  test.setTimeout(90_000);
  const messages = cspMessages(page);
  await page.goto("./?network=mainnet#/");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  const popup = context.waitForEvent("page", { timeout: 30_000 });
  await page.getByText("MyNearWallet", { exact: true }).click();
  const win = await popup;
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  expect(new URL(win.url()).host).toBe("app.mynearwallet.com");
  await win.close();
  const functional = messages.filter((m) => !COSMETIC.some((c) => c.test(m)));
  expect(functional, "CSP violations that would break the wallet").toEqual([]);
});

// HOT shows a QR code in its executor and passes the request and the answer through its relay
// (h4n.app), dating requests by its clock (api0.herewallet.app). Both must get through the CSP.
test("HOT Wallet connects under the CSP (mainnet)", async ({ page }, info) => {
  test.setTimeout(90_000);
  const messages = cspMessages(page);
  const relay: { url: string; method: string; status: number }[] = [];
  page.on("response", (r) => {
    if (/^https:\/\/(h4n\.app|api0\.herewallet\.app)\//.test(r.url())) relay.push({ url: r.url(), method: r.request().method(), status: r.status() });
  });
  await page.goto("./?network=mainnet#/");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByText("HOT Wallet", { exact: true }).click();

  let scan = null;
  for (let i = 0; i < 40 && !scan; i++) {
    for (const f of page.frames()) {
      const el = f.getByText("Scan in", { exact: false }).first();
      if (await el.isVisible().catch(() => false)) scan = el;
    }
    if (!scan) await page.waitForTimeout(500);
  }
  expect(scan, "HOT showed its QR code").not.toBeNull();
  // A blocked load that HOT cannot do without makes it remove its own executor within a second.
  await page.waitForTimeout(3_000);
  await expect(scan!, "HOT's QR code is still up").toBeVisible();
  // The request was posted to the relay, which is then polled for the wallet's answer.
  await expect.poll(() => relay.filter((r) => /\/request$/.test(r.url) && r.method === "POST" && r.status < 300).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => relay.filter((r) => /\/response$/.test(r.url)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(relay.some((r) => r.url.startsWith("https://api0.herewallet.app/") && r.status === 200), JSON.stringify(relay)).toBe(true);
  await page.screenshot({ path: `screenshots/wallet-hot-${info.project.name}.png` });

  const functional = messages.filter((m) => !COSMETIC.some((c) => c.test(m)));
  expect(functional, "CSP violations that would break the wallet").toEqual([]);
  test.info().annotations.push({ type: "cosmetic CSP blocks", description: messages.filter((m) => !functional.includes(m)).map((m) => m.slice(0, 160)).join(" | ") || "none" });
});
