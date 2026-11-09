// node e2e/harness/measure-scripted.mjs <dev server url> <out.json>: every host each wallet contacts
// when its connect and sign calls are made from script (no click), with CSP bypassed.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const [base, out] = process.argv.slice(2);
const browser = await chromium.launch();
const result = {};
for (const walletId of ["meteor-wallet", "intear-wallet"]) {
  for (const flow of ["connect", "sign"]) {
    const ctx = await browser.newContext({ bypassCSP: true });
    const page = await ctx.newPage();
    const seen = [];
    const add = (kind, url, frame) => {
      try {
        const u = new URL(url);
        if (u.protocol === "data:" || u.protocol === "blob:" || u.hostname === "localhost") return;
        seen.push({ kind, origin: `${u.protocol}//${u.host}`, path: u.pathname.slice(0, 80), frame });
      } catch {}
    };
    page.on("request", (r) => add(`${r.resourceType()}`, r.url(), r.frame() === page.mainFrame() ? "page" : "iframe"));
    page.on("websocket", (ws) => add("websocket", ws.url(), "?"));
    const popups = [];
    ctx.on("page", (p) => {
      if (p !== page) {
        popups.push(p.url());
        p.on("framenavigated", (f) => f === p.mainFrame() && popups.push(f.url()));
      }
    });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
    await page.goto(`${base}/Intatto/e2e/harness/wallet.html`);
    await page.waitForFunction(() => window.harness);
    await page.evaluate(() => window.harness.ready);
    const available = await page.evaluate(() => window.harness.wallets());
    const outcome = page.evaluate(([f, id]) => window.harness[f](id), [flow, walletId]);
    const settled = await Promise.race([outcome, new Promise((r) => setTimeout(() => r("still waiting after 20 s (prompt open)"), 20000))]);
    await page.waitForTimeout(2000);
    const origins = {};
    for (const s of seen) (origins[s.origin] ??= new Set()).add(`${s.frame} ${s.kind} ${s.path}`);
    result[`${walletId} ${flow}`] = {
      available,
      settled,
      origins: Object.fromEntries(Object.entries(origins).map(([k, v]) => [k, [...v].slice(0, 6)])),
      popups: [...new Set(popups)].map((u) => u.slice(0, 120)),
      errors: errors.slice(0, 5),
    };
    await ctx.close();
  }
}
await browser.close();
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
