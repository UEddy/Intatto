import { useEffect, useRef, useState } from "react";

/**
 * Keys that appeared after the first non-empty set was seen: entries that arrived while the page
 * was open (a poll brought them), as opposed to ones that were there on load.
 */
export function nextArrivals(seen: Set<string> | null, keys: readonly string[]): { seen: Set<string>; added: string[] } {
  if (seen === null) return { seen: new Set(keys), added: [] };
  const added = keys.filter((k) => !seen.has(k));
  if (added.length === 0) return { seen, added };
  const next = new Set(seen);
  for (const k of added) next.add(k);
  return { seen: next, added };
}

export function useArrivals(keys: readonly string[] | undefined): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys?.join("|");
  useEffect(() => {
    if (keys === undefined) return;
    const r = nextArrivals(seen.current, keys);
    seen.current = r.seen;
    if (r.added.length > 0) setFresh(new Set(r.added));
    // `signature` stands for `keys`' contents.
  }, [signature]);
  return fresh;
}
