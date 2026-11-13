import { expect, test } from "@playwright/test";

// Link previews: crawlers read the served HTML without running scripts, so the tags must be in
// it as served, with absolute URLs, and the image must be a 1200x630 PNG this site serves.
const SITE = "https://intatto.pages.dev/";
const IMAGE = `${SITE}og.png`;

test("link preview tags are in the served HTML, with absolute URLs and a 1200x630 image", async ({ request }) => {
  const res = await request.get("./");
  expect(res.status()).toBe(200);
  const html = await res.text();
  const tag = (attr: "property" | "name", key: string) => new RegExp(`<meta ${attr}="${key.replace(/[:.]/g, "\\$&")}" content="([^"]+)"`).exec(html)?.[1] ?? null;

  expect(tag("property", "og:title")).toBe("Intatto: the agent can trade. It can't withdraw.");
  const description = tag("property", "og:description");
  expect(description).toBe("Your AI agent's own trading account on NEAR: spending limits the contract enforces, no way to withdraw. Its key is public: take the money if you can.");
  expect(description!.length, "under 160 characters").toBeLessThan(160);
  expect(tag("name", "description")).toBe(description);
  expect(tag("name", "twitter:description")).toBe(description);
  expect(tag("property", "og:url")).toBe(SITE);
  expect(tag("property", "og:image")).toBe(IMAGE);
  expect(tag("property", "og:image:width")).toBe("1200");
  expect(tag("property", "og:image:height")).toBe("630");
  expect(tag("name", "twitter:card")).toBe("summary_large_image");
  expect(tag("name", "twitter:image")).toBe(IMAGE);
  for (const t of [tag("property", "og:title"), tag("property", "og:description"), tag("name", "twitter:title")]) expect(t).not.toMatch(/[–—]/);

  // The image as this build serves it (the same path on intatto.pages.dev).
  const img = await request.get(new URL(IMAGE).pathname.slice(1));
  expect(img.status()).toBe(200);
  expect(img.headers()["content-type"]).toBe("image/png");
  const png = await img.body();
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("the seal mark is the favicon and the touch icon, served from this site", async ({ request }) => {
  const html = await (await request.get("./")).text();
  expect(html).toContain('<link rel="icon" href="./favicon.svg" type="image/svg+xml" />');
  expect(html).toContain('<link rel="apple-touch-icon" href="./apple-touch-icon.png" />');
  const svg = await request.get("favicon.svg");
  expect(svg.status()).toBe(200);
  expect(await svg.text()).toMatch(/^<svg[^>]+viewBox="-8 -8 216 216"/);
  const touch = await request.get("apple-touch-icon.png");
  expect(touch.status()).toBe(200);
  expect(touch.headers()["content-type"]).toBe("image/png");
  const png = await touch.body();
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
});
