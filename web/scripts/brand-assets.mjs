// node scripts/brand-assets.mjs: writes the brand files made from the seal mark, all from the
// same wax outline as the site's seal (src/ui/sealPath.ts) and its reds (tokens.css, light):
//   public/favicon.svg            the mark; its "I" is a shape, since a tab cannot load web fonts
//   public/apple-touch-icon.png   180x180, the mark on paper
//   public/og.png                 1200x630 link preview: mark, wordmark, tagline, the claim
// Fonts are the Fontsource packages the site uses. Run it again after changing any of them, and
// commit the files.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WAX } from "../src/ui/sealPath.ts";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const font = (pkg, file) => readFileSync(at(`../node_modules/@fontsource-variable/${pkg}/files/${file}`)).toString("base64");

// tokens.css, light theme: --wax-glow, --wax, --wax-deep; the seal's letter colour.
const LIGHT = "#b8382c";
const MID = "#8e1b1b";
const DARK = "#6e1212";
const LETTER = "rgba(255, 238, 226, 0.9)";
// A Bodoni-like "I" as a shape: a heavy stem with hairline slab serifs, centred on the seal.
const I_SHAPE = "M74,56h52v6h-17v76h17v6h-52v-6h17v-76h-17z";

/** The mark as standalone SVG. `letter`: "shape" (no fonts) or "text" (Bodoni, when embedded). */
function markSvg(size, letter = "shape") {
  const glyph =
    letter === "shape"
      ? `<path d="${I_SHAPE}" fill="${LETTER}"/>`
      : `<text x="100" y="150" text-anchor="middle" font-family="Bodoni" font-weight="600" font-size="150" fill="${LETTER}">I</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 216 216" width="${size}" height="${size}">
<defs>
<radialGradient id="b" cx="38%" cy="32%" r="78%"><stop offset="0" stop-color="${LIGHT}"/><stop offset="0.55" stop-color="${MID}"/><stop offset="1" stop-color="${DARK}"/></radialGradient>
<radialGradient id="s" cx="30%" cy="24%" r="40%"><stop offset="0" stop-color="#fff" stop-opacity="0.24"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<path d="${WAX}" fill="url(#b)"/><path d="${WAX}" fill="url(#s)"/>${glyph}
</svg>`;
}

writeFileSync(at("../public/favicon.svg"), markSvg(64, "shape") + "\n");

const faces = [
  ["Bodoni", "bodoni-moda", "bodoni-moda-latin-opsz-normal.woff2", "normal"],
  ["Bodoni", "bodoni-moda", "bodoni-moda-latin-opsz-italic.woff2", "italic"],
  ["Mono", "jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2", "normal"],
]
  .map(([family, pkg, file, style]) => `@font-face{font-family:${family};font-style:${style};font-weight:100 900;src:url(data:font/woff2;base64,${font(pkg, file)}) format("woff2")}`)
  .join("\n");
const PAPER = `background-color:#f4efe6;background-image:radial-gradient(circle,rgba(70,50,25,.07) .55px,transparent .8px),radial-gradient(circle,rgba(70,50,25,.07) .5px,transparent .75px),repeating-linear-gradient(90deg,transparent 0 31px,rgba(60,45,20,.035) 31px 32px);background-size:5px 5px,7px 7px,auto;background-position:0 0,3px 2px,0 0;`;

const touch = `<!doctype html><html><head><meta charset="utf-8"><style>${faces}
*{margin:0}html,body{width:180px;height:180px}body{${PAPER}display:grid;place-items:center}
svg{filter:drop-shadow(0 6px 8px rgba(70,12,8,.25))}</style></head><body>${markSvg(146, "text")}</body></html>`;

const og = `<!doctype html><html><head><meta charset="utf-8"><style>${faces}
*{box-sizing:border-box;margin:0}html,body{width:1200px;height:630px}
body{${PAPER}color:#1c1a17;display:grid;grid-template-columns:1fr 330px;align-items:center;padding:64px 80px;position:relative}
.mark{display:flex;align-items:center;gap:14px}.mark svg{flex:none}
.word{font-family:Bodoni;font-size:46px;letter-spacing:-.01em;line-height:1}
.tag{font-family:Bodoni;font-style:italic;font-size:24px;color:#4a453d;margin-left:6px}
h1{margin-top:70px;font-family:Bodoni;font-weight:400;font-size:78px;line-height:1.02;letter-spacing:-.015em}
h1 em{display:block;color:#6b645a}
.seal{justify-self:end;margin-top:-40px;filter:drop-shadow(0 18px 22px rgba(70,12,8,.3))}
.rule{position:absolute;left:80px;right:80px;bottom:96px;border-top:3px double #1c1a17}
.foot{position:absolute;left:80px;right:80px;bottom:46px;display:flex;justify-content:space-between;font-family:Mono;font-size:19px;color:#4a453d}
</style></head><body>
<div>
  <div class="mark">${markSvg(44, "text")}<span class="word">Intatto</span><span class="tag">Your money stays intact.</span></div>
  <h1>The agent can trade.<em>It can't withdraw.</em></h1>
</div>
<div class="seal">${markSvg(280, "text")}</div>
<div class="rule"></div>
<div class="foot"><span>intatto.pages.dev</span><span>Live on NEAR mainnet</span></div>
</body></html>`;

const browser = await chromium.launch();
for (const [html, w, h, file] of [
  [touch, 180, 180, "../public/apple-touch-icon.png"],
  [og, 1200, 630, "../public/og.png"],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: at(file), type: "png" });
  await page.close();
}
await browser.close();
console.log("wrote public/favicon.svg, public/apple-touch-icon.png, public/og.png");
