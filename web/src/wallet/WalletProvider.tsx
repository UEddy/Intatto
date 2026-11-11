import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useServices } from "../app/services";
import type { Chain } from "../near/chain";
import { NearConnectAdapter } from "./nearConnect";
import { PLAIN_SESSION, type SignerAdapter, type WalletSession } from "./types";

export interface WalletState {
  readonly adapter: SignerAdapter;
  /** "restoring" while a previous session is looked up on load. */
  readonly status: "restoring" | "disconnected" | "connecting" | "connected";
  readonly accountId: string | null;
  readonly error: string | null;
  /** The connected wallet's notice and whether its gas is sponsored (the passkey wallet). */
  readonly session: WalletSession;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children, adapter: given }: { children: ReactNode; adapter?: SignerAdapter }) {
  const { config, chain } = useServices();
  const adapter = useMemo(() => given ?? new NearConnectAdapter(config, (hash, sender) => waitUntilFinal(chain, hash, sender), import.meta.env.BASE_URL), [config, chain, given]);
  const [status, setStatus] = useState<WalletState["status"]>("restoring");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<WalletSession>(PLAIN_SESSION);
  const readSession = useCallback(async () => setSession((await adapter.session?.()) ?? PLAIN_SESSION), [adapter]);

  useEffect(() => {
    let live = true;
    adapter.accountId().then((id) => {
      if (!live) return;
      setAccountId(id);
      setStatus(id ? "connected" : "disconnected");
      if (id) void readSession();
    });
    return () => {
      live = false;
    };
  }, [adapter]);

  const connect = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    try {
      const id = await adapter.connect();
      setAccountId(id);
      setStatus("connected");
      await readSession();
    } catch (e) {
      setStatus(accountId ? "connected" : "disconnected");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [adapter, accountId, readSession]);

  const disconnect = useCallback(async () => {
    await adapter.disconnect();
    setAccountId(null);
    setSession(PLAIN_SESSION);
    setStatus("disconnected");
  }, [adapter]);

  const value = useMemo(() => ({ adapter, status, accountId, error, session, connect, disconnect }), [adapter, status, accountId, error, session, connect, disconnect]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}

/**
 * Resolves once `hash` (sent by `senderId`) is final on our RPC; the passkey adapter waits for it
 * before signing the next transaction of a plan. Gives up after about a minute.
 */
export async function waitUntilFinal(chain: Chain, hash: string, senderId: string, attempts = 12): Promise<void> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const outcome = await chain.tx(hash, senderId, "FINAL");
      if (outcome) return;
    } catch (e) {
      last = e; // TIMEOUT_ERROR while the node waits for finality: ask again
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Transaction ${hash} did not become final${last ? `: ${String(last)}` : ""}`);
}
