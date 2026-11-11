/**
 * The chain reads behind the "Agent trades through NEAR Intents" panel. Live state (code, keys,
 * policy) polls like the rest of the board; the swap's transactions are final, so they are read
 * once, from the archival node, one after another.
 */
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useServices } from "../app/services";
import { ftMetadata } from "../contract/views";
import { ATTEMPTS_POLL_MS, BOARD_POLL_MS } from "../board/useBoard";
import { IntentPolicySchema, checkSwap } from "./check";

export function useIntents() {
  const { chain, archive, config } = useServices();
  const cfg = config.intents;
  const enabled = cfg !== null;
  const net = config.networkId;

  const code = useQuery({
    queryKey: [net, "account", cfg?.vaultId],
    queryFn: () => chain.account(cfg!.vaultId),
    enabled,
    refetchInterval: BOARD_POLL_MS,
  });

  // What the Verifier would accept a signature from, for the vault's account there.
  const keysOnVerifier = useQuery({
    queryKey: [net, "public-keys-of", cfg?.verifierId, cfg?.vaultId],
    queryFn: () => chain.view(cfg!.verifierId, "public_keys_of", { account_id: cfg!.vaultId }, z.array(z.string())),
    enabled,
    refetchInterval: ATTEMPTS_POLL_MS,
  });

  // A function of (signer's root key, predecessor, path, domain): it changes only if the MPC
  // network's key does.
  const derived = useQuery({
    queryKey: [net, "derived-public-key", cfg?.signerId, cfg?.vaultId, cfg?.keyPath, cfg?.keyDomain],
    queryFn: () => chain.view(cfg!.signerId, "derived_public_key", { path: cfg!.keyPath, predecessor: cfg!.vaultId, domain_id: cfg!.keyDomain }, z.string()),
    enabled,
    staleTime: 5 * 60_000,
  });

  const policy = useQuery({
    queryKey: [net, "intent-policy", cfg?.vaultId, cfg?.ownerId],
    queryFn: () => chain.view(cfg!.vaultId, "get_intent_policy", { owner_id: cfg!.ownerId }, IntentPolicySchema),
    enabled,
    refetchInterval: ATTEMPTS_POLL_MS,
  });

  const accountKeys = useQuery({
    queryKey: [net, "access-key-list", cfg?.vaultId],
    queryFn: () => chain.accessKeyList(cfg!.vaultId),
    enabled,
    refetchInterval: ATTEMPTS_POLL_MS,
  });

  // Symbols and decimals are always the token's own (NetworkConfig.tokens).
  const tokenIn = useQuery({
    queryKey: [net, "ft-metadata", cfg?.swap.tokenIn],
    queryFn: () => ftMetadata(chain, cfg!.swap.tokenIn),
    enabled,
    staleTime: Infinity,
  });
  const tokenOut = useQuery({
    queryKey: [net, "ft-metadata", cfg?.swap.tokenOut],
    queryFn: () => ftMetadata(chain, cfg!.swap.tokenOut),
    enabled,
    staleTime: Infinity,
  });

  const swap = useQuery({
    queryKey: [net, "intent-swap", cfg?.swap.signTxHash, cfg?.swap.executeTxHash, cfg?.swap.settleTxHash],
    queryFn: () => checkSwap(cfg!, (hash, sender) => archive.tx(hash, sender)),
    enabled,
    // Final transactions never change.
    staleTime: Infinity,
  });

  return { cfg, code, keysOnVerifier, derived, policy, accountKeys, tokenIn, tokenOut, swap };
}
