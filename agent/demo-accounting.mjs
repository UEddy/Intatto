// Accounts for a demo run's change in the owner's vault balance: payments that went through to
// allowlisted receivers, the storage the contract charged for the spend records it keeps (or
// credited back when it pruned them), and whatever is left. That last part must be 0: any other
// decrease would be a flaw in the vault.
//
// The vault charges storage to the owner's balance whenever its record grows (src/storage.rs,
// settle_storage): agent_spend keeps one Spend per payment for 24 hours (src/spend.rs). The bytes
// are worked out from the record, not from the contract's total storage, which other vaults change.

/** Borsh size of one Spend (src/spend.rs): spend_id u64, timestamp u64, token_id Option<AccountId>, amount u128. */
export function spendRecordBytes(spend) {
  const token = spend.token_id;
  return 8 + 8 + 1 + (token == null ? 0 : 4 + Buffer.byteLength(token, "utf8")) + 16;
}

export function spendRecordsBytes(spends) {
  return spends.reduce((n, s) => n + spendRecordBytes(s), 0);
}

/**
 * The run's balance change, split: `lost` = before - after; `paid` to allowlisted receivers;
 * `storage` = byte cost x (record bytes after - before), negative when pruning freed more than the
 * new entries took; `unexplained` = lost - paid - storage. All in yoctoNEAR, as bigint.
 */
export function accountRun({ beforeBalance, afterBalance, beforeSpends, afterSpends, paid, byteCost }) {
  const lost = BigInt(beforeBalance) - BigInt(afterBalance);
  const storage = BigInt(spendRecordsBytes(afterSpends) - spendRecordsBytes(beforeSpends)) * BigInt(byteCost);
  const paidYocto = BigInt(paid);
  return { lost, paid: paidYocto, storage, unexplained: lost - paidYocto - storage };
}
