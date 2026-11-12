/**
 * The wax seal's outline, shared by the hero seal (Seal.tsx), the header mark (SealMark) and the
 * brand files made from it (scripts/brand-assets.mjs: favicon, touch icon, link preview). Plain
 * TypeScript with no imports, so a Node script can load it too.
 */

/** A fixed, irregular wax outline: radius wobble per angle, smoothed with Catmull-Rom curves. */
const WOBBLE = [0, 3.2, -1.4, 4.1, 1.2, -2.6, 2.8, 5.0, -0.8, 1.9, -3.1, 2.2, 4.4, -1.7, 0.9, 3.6, -2.2, 1.4, 4.8, -0.6, 2.5, -2.9, 1.1, 3.9];
export function waxPath(cx: number, cy: number, r: number): string {
  const pts = WOBBLE.map((w, i) => {
    const a = (i / WOBBLE.length) * Math.PI * 2;
    return [cx + Math.cos(a) * (r + w), cy + Math.sin(a) * (r + w)] as const;
  });
  const n = pts.length;
  let d = `M${pts[0]![0].toFixed(2)},${pts[0]![1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]!.toFixed(2)},${c1[1]!.toFixed(2)} ${c2[0]!.toFixed(2)},${c2[1]!.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return `${d} Z`;
}
/** The outline every seal uses: centre (100, 100), radius 86, in a -8 -8 216 216 view box. */
export const WAX = waxPath(100, 100, 86);
