/** Every chain read the owner console needs, polled while the tab is visible. */
import { useQueries, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useServices } from "../app/services";
import { uintString } from "../contract/abi.gen";
import { ftBalanceOf, ftMetadata, getExchangeLedger, getVault, storageBalanceOf } from "../contract/views";
import { useFinalBlock } from "../board/useBoard";
import type { TokenInfo } from "./intents";

export const VAULT_POLL_MS = 4_000;

export interface TokenState {
  readonly info: TokenInfo | null;
  readonly role: "wnear" | "usdt";
  readonly id: string;
  /** In the owner's account (not the vault). */
  readonly held: bigint | null;
  readonly ownerRegistered: boolean | null;
  readonly vaultRegistered: boolean | null;
  readonly storageMin: bigint | null;
}

export function useConsole(ownerId: string | null) {
  const { chain, config } = useServices();
  const vaultId = config.vaultId;
  const net = config.networkId;
  const enabled = !!ownerId && !!vaultId;
  const block = useFinalBlock();

  const vault = useQuery({
    queryKey: [net, "vault", vaultId, ownerId],
    queryFn: () => getVault(chain, vaultId!, ownerId!),
    enabled,
    refetchInterval: VAULT_POLL_MS,
  });

  const account = useQuery({
    queryKey: [net, "owner-account", ownerId],
    queryFn: () => chain.account(ownerId!),
    enabled,
    refetchInterval: 15_000,
  });

  const per = (suffix: string) => config.tokens.map((t) => [net, suffix, t.contractId, ownerId] as const);
  const meta = useQueries({ queries: config.tokens.map((t) => ({ queryKey: [net, "ft_metadata", t.contractId], queryFn: () => ftMetadata(chain, t.contractId), staleTime: Infinity })) });
  const held = useQueries({ queries: per("ft_balance").map((k, i) => ({ queryKey: k, queryFn: () => ftBalanceOf(chain, config.tokens[i]!.contractId, ownerId!), enabled, refetchInterval: 15_000 })) });
  const ownerReg = useQueries({ queries: per("storage-owner").map((k, i) => ({ queryKey: k, queryFn: () => storageBalanceOf(chain, config.tokens[i]!.contractId, ownerId!), enabled, staleTime: 60_000 })) });
  const vaultReg = useQueries({
    queries: config.tokens.map((t) => ({ queryKey: [net, "storage-vault", t.contractId], queryFn: () => storageBalanceOf(chain, t.contractId, vaultId!), enabled: !!vaultId, staleTime: 5 * 60_000 })),
  });
  const bounds = useQueries({
    queries: config.tokens.map((t) => ({
      queryKey: [net, "storage-bounds", t.contractId],
      queryFn: () => chain.view(t.contractId, "storage_balance_bounds", {}, z.object({ min: uintString, max: uintString.nullable().optional() })),
      staleTime: Infinity,
    })),
  });

  const tokens: TokenState[] = config.tokens.map((t, i) => {
    const m = meta[i]?.data?.value;
    return {
      id: t.contractId,
      role: t.role,
      info: m ? { id: t.contractId, symbol: m.symbol, decimals: m.decimals } : null,
      held: held[i]?.data ? BigInt(held[i]!.data!.value) : null,
      ownerRegistered: ownerReg[i]?.data ? ownerReg[i]!.data!.value !== null : null,
      vaultRegistered: vaultReg[i]?.data ? vaultReg[i]!.data!.value !== null : null,
      storageMin: bounds[i]?.data ? BigInt(bounds[i]!.data!.value.min) : null,
    };
  });

  // The vault-wide exchange ledger, for tokens this owner has left on the exchange.
  const onExchange = (vault.data?.value?.tokens ?? []).filter((t) => BigInt(t.on_exchange) > 0n).map((t) => t.token_id);
  const ledgers = useQueries({
    queries: onExchange.map((id) => ({ queryKey: [net, "exchange-ledger", id], queryFn: () => getExchangeLedger(chain, vaultId!, id), enabled: !!vaultId, refetchInterval: 15_000 })),
  });
  const ledgerOf = (id: string) => ledgers[onExchange.indexOf(id)]?.data?.value ?? null;

  return { vaultId, block, vault, account, tokens, ledgerOf };
}
