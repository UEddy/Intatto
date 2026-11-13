/** The vault contract's view methods and the NEP-141 views the UI needs, all typed from the ABI. */
import { z } from "zod";
import type { Chain, Sourced } from "../near/chain";
import {
  ExchangeLedgerSchema,
  PolicySchema,
  VaultViewSchema,
  accountId,
  uintString,
  type ExchangeLedger,
  type Policy,
  type VaultView,
} from "./abi.gen";

export function getVault(chain: Chain, vaultId: string, ownerId: string): Promise<Sourced<VaultView | null>> {
  return chain.view(vaultId, "get_vault", { owner_id: ownerId }, VaultViewSchema.nullable());
}

export function getPolicy(chain: Chain, vaultId: string, ownerId: string): Promise<Sourced<Policy | null>> {
  return chain.view(vaultId, "get_policy", { owner_id: ownerId }, PolicySchema.nullable());
}

export function getExchangeLedger(chain: Chain, vaultId: string, tokenId: string): Promise<Sourced<ExchangeLedger>> {
  return chain.view(vaultId, "get_exchange_ledger", { token_id: tokenId }, ExchangeLedgerSchema);
}

export function getExchangeId(chain: Chain, vaultId: string): Promise<Sourced<string>> {
  return chain.view(vaultId, "get_exchange_id", {}, accountId);
}

/** NEP-330 source metadata. `build_info` is null for a build that is not reproducible. */
export const SourceMetadataSchema = z.object({
  version: z.string().nullable().optional(),
  link: z.string().nullable().optional(),
  standards: z.array(z.object({ standard: z.string(), version: z.string() })).optional(),
  build_info: z
    .object({
      build_environment: z.string(),
      build_command: z.array(z.string()),
      contract_path: z.string(),
      source_code_snapshot: z.string(),
      output_wasm_path: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

export function contractSourceMetadata(chain: Chain, contractId: string): Promise<Sourced<SourceMetadata>> {
  return chain.view(contractId, "contract_source_metadata", {}, SourceMetadataSchema);
}

/** NEP-148. Only the fields the UI uses; `decimals` is what every amount is scaled by. */
export const FtMetadataSchema = z.object({
  spec: z.string(),
  name: z.string(),
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(38),
});
export type FtMetadata = z.infer<typeof FtMetadataSchema>;

// One ft_metadata read per token and Chain for the page load, shared by every reader: the intents
// panel's check, the token amounts in the attempt log, the console and the activity feed would
// otherwise each ask for the same token on their own. A failed read is forgotten, so a retry asks again.
const ftMetadataReads = new WeakMap<Chain, Map<string, Promise<Sourced<FtMetadata>>>>();

export function ftMetadata(chain: Chain, tokenId: string): Promise<Sourced<FtMetadata>> {
  let reads = ftMetadataReads.get(chain);
  if (!reads) {
    reads = new Map();
    ftMetadataReads.set(chain, reads);
  }
  const hit = reads.get(tokenId);
  if (hit) return hit;
  const read = chain.view(tokenId, "ft_metadata", {}, FtMetadataSchema);
  reads.set(tokenId, read);
  read.catch(() => reads.delete(tokenId));
  return read;
}

export function ftBalanceOf(chain: Chain, tokenId: string, accountIdValue: string): Promise<Sourced<string>> {
  return chain.view(tokenId, "ft_balance_of", { account_id: accountIdValue }, uintString);
}

/** NEP-145 storage balance; null if the account is not registered with the token. */
export const StorageBalanceSchema = z.object({ total: uintString, available: uintString }).nullable();

export function storageBalanceOf(chain: Chain, tokenId: string, accountIdValue: string): Promise<Sourced<z.infer<typeof StorageBalanceSchema>>> {
  return chain.view(tokenId, "storage_balance_of", { account_id: accountIdValue }, StorageBalanceSchema);
}
