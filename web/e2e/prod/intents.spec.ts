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
  // The panel's own reads: anything about the intents vault or the swap's transactions, by RPC
  // (a JSON body) or from NearBlocks, the fallback for the transactions (a GET of the hash).
  const isPanelRead = (url: string, body: string) =>
    /intents\.intatto\.near|GbHfV9nq|EJY7oiU1|73aJTu55|"(ft_metadata|derived_public_key|get_intent_policy|public_keys_of)"/.test(body) || NB_TX.test(url);
  const panelReads: string[] = [];
  // The same reads, only those the page got a usable answer to: HTTP 200 with the CORS header and
  // a JSON-RPC result (or NearBlocks' tree). A retry after a failed attempt is expected.
  const answered: Promise<Read | null>[] = [];
  page.on("request", (r) => {
    origins.add(new URL(r.url()).origin);
    const body = r.postData() ?? "";
    if (isPanelRead(r.url(), body)) panelReads.push(body || r.url());
  });
  page.on("response", (res) => {
    const req = res.request();
    const body = req.postData() ?? "";
    if (!isPanelRead(req.url(), body)) return;
    answered.push(
      (async () => {
        if (res.status() !== 200 || !res.headers()["access-control-allow-origin"]) return null;
        const json = (await res.json().catch(() => null)) as { result?: unknown; data?: unknown } | null;
        const nb = NB_TX.exec(req.url());
        if (nb) return json?.data ? { key: JSON.stringify(["tx", nb[1]]), from: "nearblocks" } : null;
        if (!json || !("result" in json)) return null;
        const { method, params } = JSON.parse(body) as { method: string; params: { method_name?: string; tx_hash?: string } };
        if (method === "tx") return { key: JSON.stringify(["tx", params.tx_hash]), from: "rpc" };
        return { key: JSON.stringify([method, params]), from: "rpc" };
      })(),
    );
  });
  /** Successful reads of what cannot change, counted per read; a transaction counts once whichever source answered it. */
  const immutableReads = async () => {
    const seen = new Map<string, number>();
    for (const r of await Promise.all(answered)) {
      if (!r) continue;
      const k = JSON.parse(r.key) as [string, { method_name?: string }];
      if (!(k[0] === "tx" || k[1].method_name === "ft_metadata" || k[1].method_name === "derived_public_key")) continue;
      seen.set(r.key, (seen.get(r.key) ?? 0) + 1);
    }
    return seen;
  };
  return { problems, origins, panelReads, immutableReads };
}

/** NearBlocks' receipt tree for one of the swap's transactions. */
const NB_TX = new RegExp(`^https://api\\.nearblocks\\.io/v3/txns/(${[SIGN_TX, EXECUTE_TX, SETTLE_TX].join("|")})/receipts$`);
type Read = { key: string; from: "rpc" | "nearblocks" };

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
    const { problems, origins, panelReads, immutableReads } = watch(page);
    const res = await page.goto("./#/");
    const csp = res!.headers()["content-security-policy"] ?? "";

    const panel = page.locator("section.intents");
    await expect(panel.getByRole("heading", { level: 2 })).toContainText("The agent traded.");
    // Nothing is read until the panel comes near the viewport.
    await page.waitForTimeout(1500);
    await expect(panel.locator(".icheck-title .badge").first()).toHaveText("Checking");
    // The 360 px board is long, the 1440 one too: the panel starts well below the fold.
    expect(panelReads, "the panel read before it was near the viewport").toEqual([]);
    await panel.scrollIntoViewIfNeeded();
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
    await expect(key).toContainText(
      "No single party holds its private key: it exists only as shares across v1.signer's MPC nodes, and signing needs a threshold of them.",
    );

    // 3. The swap: three transactions verified from the archival node, and the floor as a floor.
    await expect(swap.locator(".badge").first()).toHaveText("Settled", { timeout: 60_000 });
    await expect(swap.locator(".swap-figure")).toHaveAttribute("aria-label", "0.3 wNEAR for 1.130742 USDt");
    await expect(swap.locator(".swap-step .badge", { hasText: "Verified" })).toHaveCount(3);
    for (const hash of [SIGN_TX, EXECUTE_TX, SETTLE_TX]) await expect(swap.locator(`a.txlink[href$="${hash}"]`)).toHaveCount(1);
    await expect(swap.locator(".swap-step").nth(1)).toContainText("Intent 5aGuMW…wmUi executed");
    // That swap was made before the agent asked NEAR AI: no receipt in its arguments, so no link
    // (and no broken one, and no refusal).
    await expect(swap.getByRole("link", { name: /Verify AI decision/ })).toHaveCount(0);
    await expect(swap.locator(".ai-refused")).toHaveCount(0);
    await expect(swap.locator(".floor-note")).toContainText("3.769 USDt per wNEAR against the owner's floor of 3.3 USDt per wNEAR");
    await expect(swap.locator(".floor-note")).toContainText("not a target");

    // 4. The caveat, from view_access_key_list, linking the threat model.
    const caveat = panel.locator(".intents-caveat");
    await expect(caveat).toContainText("the vault account still holds a full-access upgrade key", { timeout: 45_000 });
    await expect(caveat.locator('a[href$="THREAT_MODEL.md#trust-assumptions-intents-path"]')).toBeVisible();

    // Reads that cannot change were answered exactly once for the page load: the 3 transactions,
    // the 2 tokens' metadata, the derived key. Only answered requests count: a retry after a
    // failure (a 429, an overloaded node's answer without CORS headers) is expected. (Live state
    // re-polls on its interval, by design.)
    const seen = await immutableReads();
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    expect(seen.size, "immutable reads").toBe(6);
    expect(dupes, "identical reads answered twice").toEqual([]);

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

// The RPC hosts unreachable: every check must end "unverified" with a retry, never a pass tick,
// never a red fail, and never an endless load. Once the hosts answer again, Retry verifies.
const RPC_HOSTS = /^https:\/\/(archival-)?rpc\.mainnet\.fastnear\.com\//;
for (const mode of ["network error", "429"] as const) {
  test(`mainnet: with the RPC hosts blocked (${mode}), the panel shows "couldn't verify" and a retry`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route(RPC_HOSTS, (route) =>
      mode === "429"
        ? route.fulfill({ status: 429, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }, body: "Too Many Requests" })
        : route.abort("connectionrefused"),
    );
    await page.goto("./#/");
    const panel = page.locator("section.intents");
    await panel.scrollIntoViewIfNeeded();

    // The client's backoff (about 20 s for a suspected rate limit), then the neutral state.
    const retry = panel.getByRole("button", { name: "Retry" });
    await expect(retry).toHaveCount(4, { timeout: 75_000 });
    await expect(retry.first()).toBeVisible();
    await expect(panel.locator(".icheck-title .badge")).toHaveText(["Unverified", "Unverified", "Unverified"]);
    const retryLine = panel.locator(".icheck").first().locator(".intents-retry");
    await expect(retryLine.locator("span")).toHaveText("Couldn't verify right now.");
    await expect(retryLine.getByRole("button")).toHaveText("Retry");
    await expect(panel.locator(".intents-caveat")).toContainText("could not be read");
    // No pass tick, no "Verified", no red fail, no skeleton left spinning.
    await expect(panel.locator(".badge--ok")).toHaveCount(0);
    await expect(panel.locator(".badge--alert")).toHaveCount(0);
    await expect(panel.getByText("Verified", { exact: true })).toHaveCount(0);
    await expect(panel.locator(".skeleton")).toHaveCount(0);
    await page.screenshot({ path: `screenshots/prod-intents-unverified-${mode.replace(" ", "-")}.png`, fullPage: false });

    // The hosts answer again: Retry turns that check into a real verification.
    await page.unroute(RPC_HOSTS);
    await retry.first().click();
    await expect(panel.locator(".icheck").first().locator(".badge")).toHaveText("Matches", { timeout: 45_000 });
    await expect(panel.getByRole("button", { name: "Retry" })).toHaveCount(3);
  });
}

// The archival node overloaded, as on 2026-11-12 at 16:20: answers without CORS headers, which
// the browser cannot read. After its retries the swap's transactions come from NearBlocks, go
// through the same checks, and are verified, with NearBlocks named and credited.
test("mainnet: with the archival node answering without CORS headers, the swap is verified from NearBlocks", async ({ page }, info) => {
  // Three transactions, each through the archival client's full backoff first.
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { problems, origins, immutableReads } = watch(page);
  await page.route(/^https:\/\/archival-rpc\.mainnet\.fastnear\.com\//, (route) => route.fulfill({ status: 503, body: "upstream overloaded" }));
  const res = await page.goto("./#/");
  const csp = res!.headers()["content-security-policy"] ?? "";
  const panel = page.locator("section.intents");
  await panel.scrollIntoViewIfNeeded();
  const swap = panel.locator(".icheck").nth(2);

  await expect(swap.locator(".badge").first()).toHaveText("Settled", { timeout: 200_000 });
  await expect(swap.locator(".swap-step .badge", { hasText: "Verified" })).toHaveCount(3);
  await expect(swap.locator(".swap-step-via")).toHaveText(["read from NearBlocks", "read from NearBlocks", "read from NearBlocks"]);
  await expect(swap.locator(".swap-fallback")).toContainText("The archival node did not answer, so these transactions were read from NearBlocks and checked the same way.");
  await expect(swap.locator('.swap-fallback a.attribution[href="https://nearblocks.io"]')).toHaveText("Powered by Nearblocks.io APIs");

  const seen = await immutableReads();
  for (const h of [SIGN_TX, EXECUTE_TX, SETTLE_TX]) expect(seen.get(JSON.stringify(["tx", h])), `${h} answered once`).toBe(1);
  expect(origins.has("https://api.nearblocks.io"), "NearBlocks was read").toBe(true);
  expect(csp, "header CSP").toContain("https://api.nearblocks.io");
  await page.evaluate(() => document.fonts.ready);
  await swap.screenshot({ path: "screenshots/prod-intents-swap-from-nearblocks.png" });

  expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p)), "CSP violations").toEqual([]);
  // The blocked archival node's own failures are expected here; nothing else.
  expect(withoutFastnearRateLimit(problems, info).filter((p) => !/^Access to fetch at 'https:\/\/archival-rpc\.mainnet\.fastnear\.com\/' from origin '[^']+' has been blocked by CORS policy/.test(p) && !/^Failed to load resource: (net::ERR_FAILED|the server responded with a status of 503)/.test(p)), "console errors").toEqual([]);
});

test("testnet: no NEAR Intents panel", async ({ page }) => {
  await page.goto("./?network=testnet#/");
  await expect(page.locator(".hero-status .badge")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator("section.intents")).toHaveCount(0);
});
