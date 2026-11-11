import { expect, test, type Page } from "@playwright/test";
import { withoutFastnearRateLimit } from "../rateLimit";

// The mainnet board's "Agent trades through NEAR Intents" panel, live, under the production CSP.
// Every figure is read from mainnet: intents.intatto.near's code hash, its keys on intents.near and
// v1.signer's derived key, the owner's floor, the account's access keys, and the swap's three
// final transactions (CHAIN_SIGNATURES.md, "Transactions").
const SIGN_TX = "GbHfV9nqv8C3xXWCFECWaruJFaQijMhq2GBrKxb1uJjT";
const EXECUTE_TX = "EJY7oiU1SE3w9kg94qhwdcsn2zxFWEZ3eykbVnvUCLUE";
const SETTLE_TX = "73aJTu55356n6QGvcLuj8h5vHy5cY1PGcvGzprM42uKE";
const CODE_HASH = "HRkrMN8ohf7CmYUs3o9orCKx7vY1MApuPQ9yrGoTYtdC";
const INTENTS_KEY = "ed25519:5kYTxFESA4ciqDeFz5j5YqsY2sSC9WN2YN5hBNRpCgWi";

function watch(page: Page) {
  const problems: string[] = [];
  const origins = new Set<string>();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("request", (r) => origins.add(new URL(r.url()).origin));
  return { problems, origins };
}

const VIEWS = [
  { name: "1440-light", viewport: { width: 1440, height: 900 }, scheme: "light" },
  { name: "360-light", viewport: { width: 360, height: 780 }, scheme: "light" },
  { name: "360-dark", viewport: { width: 360, height: 780 }, scheme: "dark" },
  { name: "1440-dark", viewport: { width: 1440, height: 900 }, scheme: "dark" },
] as const;

for (const v of VIEWS) {
  test(`mainnet: the NEAR Intents panel reads its checks from chain (${v.name})`, async ({ page }, info) => {
    await page.setViewportSize(v.viewport);
    await page.emulateMedia({ colorScheme: v.scheme, reducedMotion: "reduce" });
    const { problems, origins } = watch(page);
    const res = await page.goto("./#/");
    const csp = res!.headers()["content-security-policy"] ?? "";

    const panel = page.locator("section.intents");
    await expect(panel.getByRole("heading", { level: 2 })).toContainText("The agent traded.");
    const [build, key, swap] = [0, 1, 2].map((i) => panel.locator(".icheck").nth(i));

    // 1. Build: the code hash, live, equals the published build of tag intents-build.
    await expect(build.locator(".badge").first()).toHaveText("Matches", { timeout: 45_000 });
    await expect(build.locator(".hash").first()).toHaveText(CODE_HASH);
    await expect(build.locator('a[href$="/tree/intents-build"]')).toBeVisible();
    await expect(build.locator('a[href$="/actions/runs/43063218549"]')).toBeVisible();

    // 2. Key: exactly one key on intents.near, equal to v1.signer's derived key; both shown.
    await expect(key.locator(".badge").first()).toHaveText("One key", { timeout: 45_000 });
    await expect(key.locator(".key-list li")).toHaveCount(1);
    await expect(key.locator(".key-list li")).toHaveText(INTENTS_KEY);
    await expect(key.locator(".hash-row").nth(1).locator(".hash").first()).toHaveText(INTENTS_KEY);
    await expect(key).toContainText("No private key exists for it.");

    // 3. The swap: three transactions verified from the archival node, and the floor as a floor.
    await expect(swap.locator(".badge").first()).toHaveText("Settled", { timeout: 60_000 });
    await expect(swap.locator(".swap-figure")).toHaveAttribute("aria-label", "0.3 wNEAR for 1.130742 USDt");
    await expect(swap.locator(".swap-step .badge", { hasText: "Verified" })).toHaveCount(3);
    for (const hash of [SIGN_TX, EXECUTE_TX, SETTLE_TX]) await expect(swap.locator(`a.txlink[href$="${hash}"]`)).toHaveCount(1);
    await expect(swap.locator(".swap-step").nth(1)).toContainText("Intent 5aGuMW…wmUi executed");
    await expect(swap.locator(".floor-note")).toContainText("3.769 USDt per wNEAR against the owner's floor of 3.3 USDt per wNEAR");
    await expect(swap.locator(".floor-note")).toContainText("not a target");

    // 4. The caveat, from view_access_key_list, linking the threat model.
    const caveat = panel.locator(".intents-caveat");
    await expect(caveat).toContainText("the vault account still holds a full-access upgrade key", { timeout: 45_000 });
    await expect(caveat.locator('a[href$="THREAT_MODEL.md#trust-assumptions-intents-path"]')).toBeVisible();

    // Everything it read came from origins the CSP already allowed.
    for (const origin of ["https://rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.fastnear.com"]) {
      expect(origins.has(origin), `${origin} was read`).toBe(true);
      expect(csp, "header CSP").toContain(origin);
    }

    // Reduced motion: nothing in the panel animates or transitions.
    const moving = await panel.evaluate((el) =>
      [el, ...el.querySelectorAll("*")].filter((n) => {
        const s = getComputedStyle(n);
        return (s.animationName !== "none" && parseFloat(s.animationDuration) > 0.001) || parseFloat(s.transitionDuration) > 0.001;
      }).length,
    );
    expect(moving, "animated elements under reduced motion").toBe(0);

    // No horizontal page scroll, and nothing in the panel wider than it.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
    const wide = await panel.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().right > right + 0.5).map((n) => n.className);
    });
    expect(wide, "elements past the panel's right edge").toEqual([]);

    await page.evaluate(() => document.fonts.ready);
    await panel.screenshot({ path: `screenshots/prod-intents-${v.name}.png` });

    expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p)), "CSP violations").toEqual([]);
    expect(withoutFastnearRateLimit(problems, info), "console errors").toEqual([]);
  });
}

test("testnet: no NEAR Intents panel", async ({ page }) => {
  await page.goto("./?network=testnet#/");
  await expect(page.locator(".hero-status .badge")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("section.intents")).toHaveCount(0);
});
