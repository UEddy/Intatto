/**
 * The chain reads behind the "Agent trades through NEAR Intents" panel: four checks, each a query
 * that never throws (check.ts `verify`), so a read that fails shows as "unverified", not as a
 * pass and not as an endless load.
 *
 * Nothing is read until the panel comes near the viewport. Identical requests are made once:
 * concurrent ones share one request (RpcClient), and reads that cannot change are kept for the
 * page load (Memo), so a retry or a re-poll asks only for what is still missing.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type RefObject } from "react";
import { useServices } from "../app/services";
import { ATTEMPTS_POLL_MS, BOARD_POLL_MS } from "../board/useBoard";
import { Memo, checkBuild, checkCaveat, checkKey, checkSwapAll, type Reads } from "./check";

/** One per network config for the page load (switching network reloads the page). */
const memos = new WeakMap<object, Memo>();

/** How far below the fold the panel starts reading, so it has answers by the time it is seen. */
const NEAR_MARGIN = "600px";

/** True once the element has come within NEAR_MARGIN of the viewport; it stays true. */
export function useNearViewport(ref: RefObject<Element | null>, active: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!active || near) return;
    const el = ref.current;
    // No IntersectionObserver (old browsers, jsdom): read right away rather than never.
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: `${NEAR_MARGIN} 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, active, near]);
  return near;
}

export function useIntents(ref: RefObject<Element | null>) {
  const { chain, archive, txFallback, config } = useServices();
  const cfg = config.intents;
  const near = useNearViewport(ref, cfg !== null);
  const enabled = cfg !== null && near;
  const net = config.networkId;

  let memo = memos.get(config);
  if (!memo) {
    memo = new Memo();
    memos.set(config, memo);
  }
  const reads: Reads = { chain, archive, txFallback, memo };
  // The check functions catch every error themselves; React Query never needs to retry.
  const common = { enabled, retry: false } as const;

  const build = useQuery({ ...common, queryKey: [net, "intents-check", "build", cfg?.vaultId], queryFn: () => checkBuild(reads, cfg!), refetchInterval: BOARD_POLL_MS });
  const key = useQuery({ ...common, queryKey: [net, "intents-check", "key", cfg?.vaultId], queryFn: () => checkKey(reads, cfg!), refetchInterval: ATTEMPTS_POLL_MS });
  // The transactions and metadata come from the memo after the first answer; only the floor is re-read.
  const swap = useQuery({ ...common, queryKey: [net, "intents-check", "swap", cfg?.swap.signTxHash], queryFn: () => checkSwapAll(reads, cfg!), refetchInterval: ATTEMPTS_POLL_MS });
  const caveat = useQuery({ ...common, queryKey: [net, "intents-check", "caveat", cfg?.vaultId], queryFn: () => checkCaveat(reads, cfg!), refetchInterval: ATTEMPTS_POLL_MS });

  return { cfg, near, build, key, swap, caveat };
}
