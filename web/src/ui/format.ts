/** Display helpers. Inputs are chain values (ns, yocto); nothing here feeds back into a decision. */

const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;

/** "27 d 04 h 12 m" (or with seconds). Negative durations show as 0. */
export function formatDuration(ns: bigint, options: { seconds?: boolean } = {}): string {
  let s = ns > 0n ? ns / NS_PER_S : 0n;
  const d = s / 86_400n;
  s %= 86_400n;
  const h = s / 3600n;
  s %= 3600n;
  const m = s / 60n;
  s %= 60n;
  const pad = (n: bigint) => n.toString().padStart(2, "0");
  const parts: string[] = [];
  if (d > 0n) parts.push(`${d} d`);
  if (d > 0n || h > 0n) parts.push(`${d > 0n ? pad(h) : h} h`);
  parts.push(`${d > 0n || h > 0n ? pad(m) : m} m`);
  if (options.seconds) parts.push(`${pad(s)} s`);
  return parts.join(" ");
}

/** The same, as [number, unit] pairs for typesetting. */
export function durationParts(ns: bigint): [string, string][] {
  return formatDuration(ns).split(" ").reduce<[string, string][]>((acc, tok, i, all) => {
    if (i % 2 === 0) acc.push([tok, all[i + 1] ?? ""]);
    return acc;
  }, []);
}

/** "6 Dec 2026", the date in UTC (so it always agrees with the UTC times shown next to it). */
export function formatShortDate(ns: bigint | string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(nsToDate(ns));
}

/** Coarse version for prose: "27 days", "4 hours", "12 minutes". */
export function formatDurationWords(ns: bigint): string {
  const s = ns > 0n ? Number(ns / NS_PER_S) : 0;
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (s >= 86_400) return unit(Math.floor(s / 86_400), "day");
  if (s >= 3600) return unit(Math.floor(s / 3600), "hour");
  if (s >= 60) return unit(Math.floor(s / 60), "minute");
  return unit(s, "second");
}

export function nsToDate(ns: bigint | string): Date {
  return new Date(Number(BigInt(ns) / NS_PER_MS));
}

/** "6 Dec 2026, 22:33 UTC": always UTC, and says so, whatever the viewer's zone. */
export function formatDateTime(ns: bigint | string): string {
  return `${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(nsToDate(ns))} UTC`;
}

export function formatDate(ns: bigint | string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(nsToDate(ns));
}

/** ISO-8601 UTC, for sources and tooltips. */
export function formatUtc(ns: bigint | string): string {
  return nsToDate(ns).toISOString().replace(".000Z", "Z");
}

export function formatInt(n: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** "ed25519:EHqQ…ZqrA"-style shortening for keys and hashes. */
export function shorten(text: string, head = 10, tail = 6): string {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** "4 s ago", "3 min ago". */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
