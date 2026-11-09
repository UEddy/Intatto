// node e2e/harness/measure-clicked.mjs <dev server url> <out.json> <screenshot dir>, with CSP bypassed.
// Clicked flows: what each wallet contacts and which windows it opens, up to the point where a
// person would have to log in.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const [base, out, shots] = process.argv.slice(2);
const browser = await chromium.launch();
const result = {};
for (const walletId of ["meteor-wallet", "intear-wallet"]) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1000, height: 800 } });
  const page = await ctx.newPage();
  const seen = [];
  const add = (kind, url, where) => {
    try {
      const u = new URL(url);
      if (!/^(https|wss):$/.test(u.protocol)) return;
      seen.push(`${where} ${kind} ${u.protocol}//${u.host}${u.pathname.slice(0, 60)}`);
    } catch {}
  };
  page.on("request", (r) => add(r.resourceType(), r.url(), r.frame() === page.mainFrame() ? "page" : `frame(${r.frame().url().slice(0, 40)})`));
  page.on("websocket", (ws) => add("websocket", ws.url(), "page/frames"));
  const popups = [];
  ctx.on("page", (p) => {
    if (p === page) return;
    popups.push(p.url());
    p.on("framenavigated", (f) => f === p.mainFrame() && popups.push(f.url()));
  });
  await page.goto(`${base}/Intatto/e2e/harness/wallet.html`);
  await page.waitForFunction(() => window.harness);
  await page.click(`#connect-${walletId}`);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${shots}/clicked-${walletId}-1.png` });
  // Intear asks how to connect, inside its own iframe: choose its web wallet.
  for (const f of page.frames()) {
    if (f.url().includes("hot-wallet-connector-iframe")) {
      await f.getByText("Web", { exact: true }).first().click().catch((e) => console.log("click failed", String(e).slice(0, 100)));
    }
  }
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${shots}/clicked-${walletId}-2.png` });
  result[walletId] = { requests: [...new Set(seen)], popups: [...new Set(popups)].map((u) => u.slice(0, 140)) };
  await ctx.close();
}
await browser.close();
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
