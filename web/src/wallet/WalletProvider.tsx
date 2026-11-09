import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useServices } from "../app/services";
import { NearConnectAdapter } from "./nearConnect";
import type { SignerAdapter } from "./types";

export interface WalletState {
  readonly adapter: SignerAdapter;
  /** "restoring" while a previous session is looked up on load. */
  readonly status: "restoring" | "disconnected" | "connecting" | "connected";
  readonly accountId: string | null;
  readonly error: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children, adapter: given }: { children: ReactNode; adapter?: SignerAdapter }) {
  const { config } = useServices();
  const adapter = useMemo(() => given ?? new NearConnectAdapter(config), [config, given]);
  const [status, setStatus] = useState<WalletState["status"]>("restoring");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    adapter.accountId().then((id) => {
      if (!live) return;
      setAccountId(id);
      setStatus(id ? "connected" : "disconnected");
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
    } catch (e) {
      setStatus(accountId ? "connected" : "disconnected");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [adapter, accountId]);

  const disconnect = useCallback(async () => {
    await adapter.disconnect();
    setAccountId(null);
    setStatus("disconnected");
  }, [adapter]);

  const value = useMemo(() => ({ adapter, status, accountId, error, connect, disconnect }), [adapter, status, accountId, error, connect, disconnect]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const w = useContext(WalletContext);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}
