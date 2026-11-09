import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { NetworkConfig } from "../config/networks";
import { IdbTxCache } from "../indexer/cache";
import { FastNearSource } from "../indexer/fastnear";
import { NearBlocksSource } from "../indexer/nearblocks";
import { ResilientIndexer } from "../indexer/resilient";
import { Chain } from "../near/chain";
import { RpcClient } from "../near/rpc";

export interface Services {
  readonly config: NetworkConfig;
  readonly chain: Chain;
  /** Archival node, for old transactions only. */
  readonly archive: Chain;
  readonly indexer: ResilientIndexer;
}

const ServicesContext = createContext<Services | null>(null);

export function makeServices(config: NetworkConfig): Services {
  return {
    config,
    chain: new Chain(new RpcClient(config.rpcUrl)),
    archive: new Chain(new RpcClient(config.archivalRpcUrl)),
    indexer: new ResilientIndexer(
      [new FastNearSource(config.indexers.fastnear), new NearBlocksSource(config.indexers.nearblocks)],
      new IdbTxCache(),
      config.networkId,
    ),
  };
}

export function ServicesProvider({ config, children, services }: { config: NetworkConfig; children: ReactNode; services?: Services }) {
  const value = useMemo(() => services ?? makeServices(config), [config, services]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("useServices outside ServicesProvider");
  return s;
}
