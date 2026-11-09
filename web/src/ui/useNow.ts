import { useEffect, useState } from "react";

/** Date.now(), refreshed every `intervalMs` while the tab is visible. Display only. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        setNow(Date.now());
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Chain time now, estimated: the last final block's timestamp plus the local time elapsed since
 * it was read. Used only to tick displayed durations between polls; every decision uses the
 * block timestamp itself.
 */
export function useChainNow(blockTimestampNs: bigint | undefined, readAtMs: number): bigint | null {
  const now = useNow(1000);
  if (blockTimestampNs === undefined) return null;
  return blockTimestampNs + BigInt(Math.max(0, now - readAtMs)) * 1_000_000n;
}
