/**
 * E2E builds only (VITE_E2E=1; the production build never includes this module). Connects as a
 * real testnet account whose vault has a policy and history, and "submits" by returning the hash
 * of a real earlier transaction, so everything after the wallet, reading the outcome over RPC,
 * runs against the chain exactly as it does for real.
 */
import type { SignerAdapter, SubmittedTx, TxPlan } from "./types";

export const E2E_ACCOUNT = "intatto-dev.testnet";
/** intatto-dev.testnet's `freeze` of 2026-11-06 on vault-v1. */
export const E2E_FREEZE_TX = "25eHak8ioMzwG1GUw9qbNkFnABAJDMSe7Y2MzAV46KN5";

export class FakeAdapter implements SignerAdapter {
  readonly id = "e2e";
  readonly label = "E2E";
  readonly capabilities = { batch: true };
  private connected = false;
  async accountId() {
    return this.connected ? E2E_ACCOUNT : null;
  }
  async connect() {
    this.connected = true;
    return E2E_ACCOUNT;
  }
  async disconnect() {
    this.connected = false;
  }
  async submit(_signerId: string, plans: readonly TxPlan[]): Promise<SubmittedTx[]> {
    // Every signing request, counted for the e2e checks that some views sign nothing.
    const w = window as unknown as { __e2eSubmits?: number };
    w.__e2eSubmits = (w.__e2eSubmits ?? 0) + 1;
    await new Promise((r) => setTimeout(r, 300));
    return plans.map((p) => ({ hash: E2E_FREEZE_TX, receiverId: p.receiverId }));
  }
}
