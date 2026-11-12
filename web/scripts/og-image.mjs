// node scripts/og-image.mjs: renders public/og.png, the 1200x630 link-preview image, in the site's
// own style (paper and ink, Bodoni Moda / Instrument Sans / JetBrains Mono from the Fontsource
// packages the site uses, the wax seal). Run it again after changing the wording; commit the PNG.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const font = (pkg, file) => readFileSync(fileURLToPath(new URL(`../node_modules/@fontsource-variable/${pkg}/files/${file}`, import.meta.url))).toString("base64");
const faces = [
  ["Bodoni", "bodoni-moda", "bodoni-moda-latin-opsz-normal.woff2", "normal"],
  ["Bodoni", "bodoni-moda", "bodoni-moda-latin-opsz-italic.woff2", "italic"],
  ["Instrument", "instrument-sans", "instrument-sans-latin-wght-normal.woff2", "normal"],
  ["Mono", "jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2", "normal"],
]
  .map(([family, pkg, file, style]) => `@font-face{font-family:${family};font-style:${style};font-weight:100 900;src:url(data:font/woff2;base64,${font(pkg, file)}) format("woff2")}`)
  .join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${faces}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px}
body{
  background-color:#f4efe6;
  background-image:
    radial-gradient(circle,rgba(70,50,25,.07) .55px,transparent .8px),
    radial-gradient(circle,rgba(70,50,25,.07) .5px,transparent .75px),
    repeating-linear-gradient(90deg,transparent 0 31px,rgba(60,45,20,.035) 31px 32px);
  background-size:5px 5px,7px 7px,auto;background-position:0 0,3px 2px,0 0;
  color:#1c1a17;font-family:Instrument,sans-serif;
  display:grid;grid-template-columns:1fr 330px;align-items:center;padding:64px 80px;position:relative;
}
.rule{position:absolute;left:80px;right:80px;bottom:96px;border-top:3px double #1c1a17}
.mark{display:flex;align-items:baseline;gap:18px}
.word{font-family:Bodoni;font-size:46px;letter-spacing:-.01em}
.tag{font-family:Bodoni;font-style:italic;font-size:24px;color:#4a453d}
h1{margin-top:70px;font-family:Bodoni;font-weight:400;font-size:78px;line-height:1.02;letter-spacing:-.015em}
h1 em{display:block;color:#6b645a}
.foot{position:absolute;left:80px;right:80px;bottom:46px;display:flex;justify-content:space-between;font-family:Mono;font-size:19px;color:#4a453d}
.seal{width:270px;height:270px;border-radius:50%;justify-self:end;margin-top:-40px;
  background:radial-gradient(circle at 38% 32%,#b8382c 0%,#8e1b1b 48%,#6e1212 100%);
  box-shadow:0 18px 40px -14px rgba(110,18,18,.55),inset 0 -8px 18px rgba(0,0,0,.25),inset 0 6px 14px rgba(255,220,200,.25);
  display:grid;place-items:center;position:relative}
.seal::before{content:"";position:absolute;inset:34px;border-radius:50%;border:3px solid rgba(251,243,234,.35);background:radial-gradient(circle at 45% 40%,#9c2420,#741515)}
.seal span{position:relative;font-family:Bodoni;font-size:120px;line-height:1;color:#fbf3ea;opacity:.92}
</style></head><body>
<div>
  <div class="mark"><span class="word">Intatto</span><span class="tag">Your money stays intact.</span></div>
  <h1>The agent can trade.<em>It can't withdraw.</em></h1>
</div>
<div class="seal"><span>I</span></div>
<div class="rule"></div>
<div class="foot"><span>intatto.pages.dev</span><span>Live on NEAR mainnet</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log(`wrote ${out}`);
