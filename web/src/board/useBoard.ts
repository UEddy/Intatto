/**
 * Every chain read the break-price board shows. React Query polls each on its own interval and
 * pauses while the tab is hidden; nothing here needs a wallet.
 */
import { useQuery } from "@tanstack/react-query";
import { useServices } from "../app/services";
import { attemptsFrom } from "../canary/attempts";
import { checkBaselineTx, checkRunStartTx, type BaselineCheck, type BaselineProblem, type RunStart, type RunStartProblem } from "../canary/board";
import { contractSourceMetadata, getVault } from "../contract/views";

export const BOARD_POLL_MS = 10_000;
export const ATTEMPTS_POLL_MS = 30_000;

export function useFinalBlock() {
  const { chain, config } = useServices();
  return useQuery({
    queryKey: [config.networkId, "final-block"],
    queryFn: () => chain.block("final"),
    refetchInterval: BOARD_POLL_MS,
  });
}

export function useBoard() {
  const { chain, archive, config, indexer } = useServices();
  const canary = config.canary;
  const vaultId = config.vaultId;
  const enabled = canary !== null && vaultId !== null;
  const net = config.networkId;

  const block = useFinalBlock();

  const vault = useQuery({
    queryKey: [net, "vault", vaultId, canary?.ownerId],
    queryFn: () => getVault(chain, vaultId!, canary!.ownerId),
    enabled,
    refetchInterval: BOARD_POLL_MS,
  });

  const code = useQuery({
    queryKey: [net, "account", vaultId],
    queryFn: () => chain.account(vaultId!),
    enabled,
    refetchInterval: BOARD_POLL_MS,
  });

  const sourceMeta = useQuery({
    queryKey: [net, "source-metadata", vaultId],
    queryFn: () => contractSourceMetadata(chain, vaultId!),
    enabled,
    staleTime: 5 * 60_000,
  });

  const baseline = useQuery({
    queryKey: [net, "baseline", canary?.baseline.txHash],
    enabled,
    // A final transaction never changes.
    staleTime: Infinity,
    queryFn: async (): Promise<{ ok: true; check: BaselineCheck } | { ok: false; problem: BaselineProblem }> => {
      const tx = await archive.tx(canary!.baseline.txHash, canary!.ownerId);
      const checked = checkBaselineTx(tx, canary!, vaultId!);
      if (!checked.ok) return checked;
      const b = await archive.block(checked.blockHash);
      return { ok: true, check: { lockedUntilNs: checked.lockedUntilNs, lockSetAtNs: b.timestampNs, lockSetBlockHeight: b.height, lockSetBlockHash: b.hash } };
    },
  });

  const run = useQuery({
    queryKey: [net, "run-start", canary?.run?.deployTxHash],
    enabled: enabled && canary?.run != null,
    // A final transaction never changes.
    staleTime: Infinity,
    queryFn: async (): Promise<{ ok: true; start: RunStart } | { ok: false; problem: RunStartProblem }> => {
      const tx = await archive.tx(canary!.run!.deployTxHash, vaultId!);
      const checked = checkRunStartTx(tx, vaultId!, canary!.run!.codeHash);
      if (!checked.ok) return checked;
      const b = await archive.block(checked.blockHash);
      return { ok: true, start: { atNs: b.timestampNs, blockHeight: b.height, blockHash: b.hash } };
    },
  });

  const agentKey = useQuery({
    queryKey: [net, "access-key", canary?.agentId, canary?.agentPublicKey],
    queryFn: () => chain.accessKey(canary!.agentId, canary!.agentPublicKey),
    enabled,
    refetchInterval: ATTEMPTS_POLL_MS,
  });

  const attempts = useQuery({
    queryKey: [net, "attempts", canary?.agentId],
    enabled: enabled && block.data !== undefined,
    refetchInterval: ATTEMPTS_POLL_MS,
    queryFn: async () => {
      const r = await indexer.activity(canary!.agentId, { limit: 50, signerOnly: true, finalBlockTimestampNs: block.data!.timestampNs });
      return { attempts: attemptsFrom(r.txs, canary!, vaultId!), sources: r.sources, more: r.next !== null };
    },
  });

  return { enabled, canary, vaultId, block, vault, code, sourceMeta, baseline, run, agentKey, attempts };
}
