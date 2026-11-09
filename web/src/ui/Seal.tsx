/**
 * The wax seal: Intatto's promise that the contents are as they were. Intact (oxblood), frozen
 * (cold grey), broken (cracked and split), or unknown (an empty impression, while loading).
 */
import { useId } from "react";

export type SealVariant = "intact" | "frozen" | "broken" | "unknown";

/** A fixed, irregular wax outline: radius wobble per angle, smoothed with Catmull-Rom curves. */
const WOBBLE = [0, 3.2, -1.4, 4.1, 1.2, -2.6, 2.8, 5.0, -0.8, 1.9, -3.1, 2.2, 4.4, -1.7, 0.9, 3.6, -2.2, 1.4, 4.8, -0.6, 2.5, -2.9, 1.1, 3.9];
function waxPath(cx: number, cy: number, r: number): string {
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
const WAX = waxPath(100, 100, 86);
/** The crack: a jagged line across the seal, and the two halves it leaves. */
const CRACK = "M58,8 L76,46 L66,62 L92,88 L84,104 L112,128 L104,146 L128,192";
const LEFT_HALF = `${CRACK} L0,200 L0,0 Z`;
const RIGHT_HALF = `${CRACK} L200,200 L200,0 Z`;

const RING: Record<SealVariant, string> = {
  intact: "INTATTO · INTACT · INTATTO · INTACT · ",
  frozen: "INTATTO · FROZEN · INTATTO · FROZEN · ",
  broken: "INTATTO · BROKEN · INTATTO · BROKEN · ",
  unknown: "INTATTO · · · INTATTO · · · ",
};

const LABEL: Record<SealVariant, string> = {
  intact: "Seal intact",
  frozen: "Seal frozen",
  broken: "Seal broken",
  unknown: "Seal state loading",
};

export function Seal({ variant, size = 200, className }: { variant: SealVariant; size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const tone = variant === "frozen" ? "frost" : variant === "unknown" ? "blank" : "wax";
  const face = (
    <g>
      {tone === "blank" ? (
        <>
          <path d={WAX} className="seal-blank" strokeDasharray="3 5" strokeWidth="1.5" />
          <circle cx="100" cy="100" r="62" className="seal-blank" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <path d={WAX} fill={`url(#${id}-body)`} />
          <path d={WAX} fill={`url(#${id}-sheen)`} />
          <circle cx="100" cy="100" r="62" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="3" />
          <circle cx="100" cy="100" r="56" fill={`url(#${id}-pool)`} />
        </>
      )}
      <text className="seal-ring seal-letter">
        <textPath href={`#${id}-ring`} startOffset="0" textLength="440" lengthAdjust="spacing">
          {RING[variant]}
        </textPath>
      </text>
      <text x="100" y="128" textAnchor="middle" className="seal-monogram seal-letter">
        I
      </text>
    </g>
  );
  return (
    <svg
      viewBox="-8 -8 216 216"
      width={size}
      height={size}
      role="img"
      aria-label={LABEL[variant]}
      className={`seal seal--${variant}${className ? ` ${className}` : ""}`}
      data-tone={tone}
    >
      <defs>
        <path id={`${id}-ring`} d="M100,100 m-71,0 a71,71 0 1,1 142,0 a71,71 0 1,1 -142,0" />
        <radialGradient id={`${id}-body`} cx="38%" cy="32%" r="78%">
          <stop offset="0" className="s-light" />
          <stop offset="0.55" className="s-mid" />
          <stop offset="1" className="s-dark" />
        </radialGradient>
        <radialGradient id={`${id}-sheen`} cx="30%" cy="24%" r="40%">
          <stop offset="0" className="s-sheen" />
          <stop offset="1" className="s-sheen-end" />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="s-dark" />
          <stop offset="1" className="s-light" />
        </linearGradient>
        <radialGradient id={`${id}-pool`} cx="60%" cy="66%" r="70%">
          <stop offset="0" className="s-mid" />
          <stop offset="1" className="s-dark" />
        </radialGradient>
        <clipPath id={`${id}-left`}>
          <path d={LEFT_HALF} />
        </clipPath>
        <clipPath id={`${id}-right`}>
          <path d={RIGHT_HALF} />
        </clipPath>
      </defs>
      {variant === "broken" ? (
        <>
          {/* The fissure shows through as the halves part (offsets and timing live in CSS). */}
          <path d={CRACK} className="seal-fissure" />
          <g className="seal-half seal-half--left">
            <g clipPath={`url(#${id}-left)`}>{face}</g>
          </g>
          <g className="seal-half seal-half--right">
            <g clipPath={`url(#${id}-right)`}>{face}</g>
          </g>
          <path d={CRACK} className="seal-crack" pathLength={1} />
        </>
      ) : (
        face
      )}
    </svg>
  );
}
