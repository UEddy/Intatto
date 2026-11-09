#!/usr/bin/env node
// Writes src/wallet/manifest.pinned.json: the four wallets the site offers, copied from the
// near-connect manifest, with icons embedded as data: URIs (so the CSP needs no image hosts).
// Executor URLs are kept as published: near-connect fetches each executor's code from there at
// connect time. See THREAT_MODEL.md, "Frontend".
//
//   node scripts/pin-wallets.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const SOURCE = "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json";
const KEEP = ["meteor-wallet", "intear-wallet", "hot-wallet", "mynearwallet"];

const raw = await (await fetch(SOURCE)).text();
const manifest = JSON.parse(raw);
const wallets = [];
for (const id of KEEP) {
  const w = manifest.wallets.find((x) => x.id === id);
  if (!w) throw new Error(`${id} is not in the manifest`);
  if (w.type !== "sandbox") throw new Error(`${id} is not a sandboxed wallet`);
  let icon = w.icon;
  if (/^https:\/\//.test(icon)) {
    const res = await fetch(icon);
    if (!res.ok) throw new Error(`icon of ${id}: HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!/^image\/(png|svg\+xml|jpeg|webp)$/.test(type)) throw new Error(`icon of ${id}: unexpected type ${type}`);
    icon = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } else if (!icon.startsWith("data:image/")) {
    throw new Error(`icon of ${id}: not https or data:image`);
  }
  wallets.push({ ...w, icon });
}
const out = {
  _pinned: {
    from: SOURCE,
    sourceVersion: manifest.version,
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    at: new Date().toISOString().slice(0, 10),
    wallets: KEEP,
  },
  version: manifest.version,
  wallets,
};
writeFileSync(new URL("../src/wallet/manifest.pinned.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`pinned ${wallets.length} wallets from manifest ${manifest.version}`);
for (const w of wallets) console.log(`  ${w.id.padEnd(14)} ${w.version}  executor ${w.executor}  testnet=${w.features.testnet === true}`);
